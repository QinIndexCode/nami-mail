import { createElement } from "react";
import { FileAudio, FileImage, FileText, FileVideo, type LucideIcon } from "lucide-react";
import type { ModelInputModalities } from "./agentTypes";
import { codeTextExtensions } from "./attachmentPresentation";

export const imageExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"]);
export const videoExtensions = new Set(["mp4", "webm", "mov", "avi", "mkv"]);
export const audioExtensions = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac"]);

/** Readable text formats on top of the shared code/format extensions. */
const readableFormatExtensions = new Set(["txt", "md", "markdown", "csv", "tsv", "log", "rtf", "ini", "cfg", "conf"]);

const textExtensions = new Set([...codeTextExtensions, ...readableFormatExtensions]);

const maxFileBytes = 10 * 1024 * 1024; // 10 MB
const maxExtractedChars = 32_000; // Keep extracted text within a reasonable LLM context budget.

const baseTextAccept = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm",
  ".py", ".js", ".ts", ".tsx", ".jsx", ".css", ".scss", ".less", ".yaml", ".yml",
  ".log", ".rtf", ".ini", ".cfg", ".conf", ".sh", ".bash", ".zsh", ".sql", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".vue", ".svelte",
  ".docx", ".pptx",
];

export function buildAcceptFilter(modalities?: ModelInputModalities): string {
  const parts = [...baseTextAccept];
  if (modalities?.pdf) {
    parts.push(".pdf", "application/pdf");
  }
  if (modalities?.image) {
    parts.push(".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", "image/*");
  }
  if (modalities?.video) {
    parts.push(".mp4", ".webm", ".mov", ".avi", ".mkv", "video/*");
  }
  if (modalities?.audio) {
    parts.push(".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", "audio/*");
  }
  return parts.join(",");
}

export type ProcessedFile = {
  name: string;
  size: number;
  type: string;
  text: string;
  truncated: boolean;
  path?: string;
  dataUrl?: string;
  mimeType?: string;
  /** Outbound attachment token when the file was uploaded as a mail attachment. */
  mailToken?: string;
  mailUploadState?: "uploading" | "ready" | "failed";
  /** Account the uploaded attachment is bound to (sender account). */
  mailAccountId?: string;
};

export function isSupportedFile(file: File, modalities?: ModelInputModalities): boolean {
  const ext = extensionOf(file.name);
  if (textExtensions.has(ext) || ext === "docx" || ext === "pptx") return true;
  if (ext === "pdf") return Boolean(modalities?.pdf);
  if (imageExtensions.has(ext)) return Boolean(modalities?.image);
  if (videoExtensions.has(ext)) return Boolean(modalities?.video);
  if (audioExtensions.has(ext)) return Boolean(modalities?.audio);
  return false;
}

export function attachmentIcon(type: string): LucideIcon {
  if (imageExtensions.has(type)) return FileImage;
  if (videoExtensions.has(type)) return FileVideo;
  if (audioExtensions.has(type)) return FileAudio;
  return FileText;
}

export function AttachmentFileIconBadge({ type }: { type: string }) {
  const Icon = attachmentIcon(type);
  return createElement(Icon, { size: 13 });
}

function filePathOf(file: File): string | undefined {
  // Electron exposes the absolute path on File objects; browsers do not.
  return (file as File & { path?: string }).path;
}

export async function fileToDataUrl(file: File): Promise<string> {
  const mime = file.type || "application/octet-stream";
  if (typeof Buffer !== "undefined") {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return `data:${mime};base64,${base64}`;
    } catch {
      // Fallback to FileReader
    }
  }
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read file as data URL"));
      reader.readAsDataURL(file);
    });
  }
  throw new Error("No data URL reader available");
}

const mimeByExt: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

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
    try {
      raw = await extractFromPdf(file);
    } catch {
      raw = `[PDF Document: ${file.name}]`;
    }
  } else if (ext === "docx") {
    raw = await extractFromDocx(file);
  } else if (ext === "pptx") {
    raw = await extractFromPptx(file);
  } else if (imageExtensions.has(ext)) {
    const sizeKb = Math.round(file.size / 1024);
    raw = `[Image: ${file.name} (${sizeKb} KB)]`;
  } else if (videoExtensions.has(ext)) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    raw = `[Video: ${file.name} (${sizeMb} MB)]`;
  } else if (audioExtensions.has(ext)) {
    const sizeKb = Math.round(file.size / 1024);
    raw = `[Audio: ${file.name} (${sizeKb} KB)]`;
  } else {
    throw new Error(`Unsupported file type: .${ext}`);
  }
  const { text, truncated } = truncate(raw.trim());
  let dataUrl: string | undefined;
  let mimeType: string | undefined;
  if (imageExtensions.has(ext) || videoExtensions.has(ext) || audioExtensions.has(ext) || ext === "pdf") {
    mimeType = file.type || mimeByExt[ext] || "application/octet-stream";
    try {
      dataUrl = await fileToDataUrl(file);
    } catch {
      // In non-browser environments or upon read failure, proceed without dataUrl.
    }
  }
  return {
    name: file.name,
    size: file.size,
    type: ext,
    text,
    truncated,
    path: filePathOf(file),
    ...(dataUrl ? { dataUrl } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

export function formatMessageAttachments(files: ProcessedFile[]) {
  return files.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.path ? { path: f.path } : {}),
    ...(f.mailToken ? { token: f.mailToken } : {}),
    ...(f.mailToken && f.mailAccountId ? { accountId: f.mailAccountId } : {}),
    ...(f.text ? { text: f.text } : {}),
    ...(f.dataUrl ? { dataUrl: f.dataUrl } : {}),
    ...(f.mimeType ? { mimeType: f.mimeType } : {}),
  }));
}
