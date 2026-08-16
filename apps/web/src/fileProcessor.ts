import { codeTextExtensions } from "./attachmentPresentation";

/** Readable text formats on top of the shared code/format extensions. */
const readableFormatExtensions = new Set(["txt", "md", "markdown", "csv", "tsv", "log", "rtf", "ini", "cfg", "conf"]);

const textExtensions = new Set([...codeTextExtensions, ...readableFormatExtensions]);

const maxFileBytes = 10 * 1024 * 1024; // 10 MB
const maxExtractedChars = 32_000; // Keep extracted text within a reasonable LLM context budget.

export type ProcessedFile = {
  name: string;
  size: number;
  type: string;
  text: string;
  truncated: boolean;
  path?: string;
  /** Outbound attachment token when the file was uploaded as a mail attachment. */
  mailToken?: string;
  mailUploadState?: "uploading" | "ready" | "failed";
  /** Account the uploaded attachment is bound to (sender account). */
  mailAccountId?: string;
};

export function isSupportedFile(file: File): boolean {
  const ext = extensionOf(file.name);
  if (textExtensions.has(ext)) return true;
  return ext === "pdf" || ext === "docx" || ext === "pptx";
}

function filePathOf(file: File): string | undefined {
  // Electron exposes the absolute path on File objects; browsers do not.
  return (file as File & { path?: string }).path;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= maxExtractedChars) return { text, truncated: false };
  return { text: text.slice(0, maxExtractedChars), truncated: true };
}

async function extractFromText(file: File): Promise<string> {
  return file.text();
}

async function extractFromPdf(file: File): Promise<string> {
  // pdfjs-dist is large; load it (and its worker URL) only when a PDF is
  // actually processed so the Agent workspace chunk stays lean.
  const pdfjsLib = await import("pdfjs-dist");
  const { default: pdfWorkerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? (item as { str: string }).str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) parts.push(pageText);
  }
  await doc.cleanup();
  return parts.join("\n\n");
}

async function extractFromDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

async function extractFromPptx(file: File): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? "0", 10);
      return numA - numB;
    });
  const parts: string[] = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name]!.async("text");
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export async function processFile(file: File): Promise<ProcessedFile> {
  if (file.size > maxFileBytes) {
    throw new Error(`File exceeds the ${maxFileBytes / 1024 / 1024} MB limit.`);
  }
  const ext = extensionOf(file.name);
  let raw = "";
  if (textExtensions.has(ext)) {
    raw = await extractFromText(file);
  } else if (ext === "pdf") {
    raw = await extractFromPdf(file);
  } else if (ext === "docx") {
    raw = await extractFromDocx(file);
  } else if (ext === "pptx") {
    raw = await extractFromPptx(file);
  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }
  const { text, truncated } = truncate(raw.trim());
  return {
    name: file.name,
    size: file.size,
    type: ext,
    text,
    truncated,
    path: filePathOf(file),
  };
}
