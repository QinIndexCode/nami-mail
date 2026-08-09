export type AttachmentPreviewKind = "pdf" | "image" | "text" | "office" | "unsupported";

/** Blob size cap for text extraction; PDFs and images render natively regardless. */
export const maxAttachmentPreviewBytes = 20 * 1024 * 1024; // 20 MB
export const maxPreviewTextChars = 64_000;

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const textExtensions = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm",
  "log", "rtf", "ini", "cfg", "conf", "yaml", "yml", "css", "js", "ts",
]);

/** Classifies an inbound attachment for the inline, read-only preview dialog. */
export function attachmentPreviewKind(filename: string, contentType: string): AttachmentPreviewKind {
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  const mime = contentType.trim().toLowerCase();
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (imageExtensions.has(extension) || mime.startsWith("image/")) return "image";
  if (textExtensions.has(extension) || mime.startsWith("text/")) return "text";
  if (extension === "docx" || extension === "pptx" || extension === "xlsx") return "office";
  return "unsupported";
}

export function canPreviewAttachment(filename: string, contentType: string): boolean {
  return attachmentPreviewKind(filename, contentType) !== "unsupported";
}

export type AttachmentPreviewText = {
  text: string;
  truncated: boolean;
};

function truncatePreviewText(value: string): { text: string; truncated: boolean } {
  if (value.length <= maxPreviewTextChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxPreviewTextChars), truncated: true };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function extractTextFile(blob: Blob): Promise<string> {
  return blob.text();
}

async function extractDocxText(blob: Blob): Promise<string> {
  const mammoth = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return result.value || "";
}

async function extractPptxText(blob: Blob): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
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

async function parseSharedStrings(xml: string): Promise<string[]> {
  const items: string[] = [];
  for (const match of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
    const text = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((item) => unescapeXml(item[1]))
      .join("");
    items.push(text);
  }
  return items;
}

async function extractXlsxText(blob: Blob): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const sharedFile = zip.files["xl/sharedStrings.xml"];
  const shared = sharedFile ? await parseSharedStrings(await sharedFile.async("text")) : [];
  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.match(/sheet(\d+)\.xml/)?.[1] ?? "0", 10);
      const numB = parseInt(b.match(/sheet(\d+)\.xml/)?.[1] ?? "0", 10);
      return numA - numB;
    });
  const parts: string[] = [];
  for (const name of sheetFiles) {
    const xml = await zip.files[name]!.async("text");
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c[^>]*>([\s\S]*?)<\/c>/g)) {
        const cellXml = cellMatch[1];
        const typeMatch = /<c[^>]*t="(\w+)"/.exec(cellMatch[0]);
        const inline = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        if (inline) {
          cells.push(unescapeXml(inline[1]));
          continue;
        }
        const valueMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (!valueMatch) continue;
        if (typeMatch?.[1] === "s") {
          const index = Number(valueMatch[1]);
          const text = Number.isInteger(index) ? shared[index] : undefined;
          if (text) cells.push(text);
        } else {
          cells.push(valueMatch[1]);
        }
      }
      const rowText = cells.join("\t").trim();
      if (rowText) rows.push(rowText);
    }
    if (rows.length) parts.push(rows.join("\n"));
  }
  return parts.join("\n\n");
}

function extensionOf(filename: string): string {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

/** Extracts a read-only text preview for text / Office attachments (PDF and images render natively). */
export async function extractAttachmentPreviewText(blob: Blob, filename: string): Promise<AttachmentPreviewText> {
  const extension = extensionOf(filename);
  let raw = "";
  if (textExtensions.has(extension)) {
    raw = await extractTextFile(blob);
  } else if (extension === "docx") {
    raw = await extractDocxText(blob);
  } else if (extension === "pptx") {
    raw = await extractPptxText(blob);
  } else if (extension === "xlsx") {
    raw = await extractXlsxText(blob);
  } else {
    throw new Error(`Unsupported preview extension: .${extension}`);
  }
  return truncatePreviewText(raw.trim());
}
