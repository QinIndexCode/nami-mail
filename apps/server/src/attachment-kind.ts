// Attachment-kind classification, mirrored from the renderer's
// attachmentPresentation.ts so the SQL kind filter and the in-app preview
// badges always agree. The map is duplicated on purpose: the server filter
// must decide a page query from indexed columns without decrypting payloads,
// while the renderer keeps its presentation labels and preview tooling.

export type AttachmentKind = "archive" | "code" | "document" | "image" | "media" | "pdf" | "spreadsheet" | "text" | "other";

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = [
  "archive", "code", "document", "image", "media", "pdf", "spreadsheet", "text", "other",
];

/** Programming-language and config source extensions (see the renderer copy). */
export const codeTextExtensions = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
  "py", "pyw", "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "java", "kt", "kts", "cs", "rb", "php", "swift", "scala",
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "sql",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "json", "jsonl", "yaml", "yml", "toml", "xml", "graphql", "gql", "proto",
  "dart", "lua", "r", "ex", "exs", "erl", "hs", "ml", "pl", "pm", "perl",
  "clj", "cljs", "nim", "zig",
]);

const extensionKinds: Record<string, AttachmentKind> = {
  // Archives
  "7z": "archive",
  "bz2": "archive",
  "gz": "archive",
  "rar": "archive",
  "tar": "archive",
  "tgz": "archive",
  "xz": "archive",
  "zip": "archive",
  // Documents
  doc: "document",
  docm: "document",
  docx: "document",
  dotm: "document",
  dotx: "document",
  eml: "document",
  key: "document",
  msg: "document",
  numbers: "document",
  odp: "document",
  odt: "document",
  one: "document",
  pages: "document",
  potm: "document",
  potx: "document",
  ppt: "document",
  pptm: "document",
  pptx: "document",
  rtf: "document",
  // Images
  avif: "image",
  bmp: "image",
  gif: "image",
  heic: "image",
  heif: "image",
  ico: "image",
  jpeg: "image",
  jpg: "image",
  png: "image",
  svg: "image",
  tif: "image",
  tiff: "image",
  webp: "image",
  // Audio / video
  "3gp": "media",
  aac: "media",
  avi: "media",
  flac: "media",
  flv: "media",
  m4a: "media",
  m4v: "media",
  mkv: "media",
  mov: "media",
  mp3: "media",
  mp4: "media",
  oga: "media",
  ogg: "media",
  opus: "media",
  wav: "media",
  webm: "media",
  wma: "media",
  wmv: "media",
  // Spreadsheets
  csv: "spreadsheet",
  ods: "spreadsheet",
  xls: "spreadsheet",
  xlsm: "spreadsheet",
  xlsx: "spreadsheet",
  // Text (non-code)
  md: "text",
  tsv: "text",
  txt: "text",
  // PDF
  pdf: "pdf",
  // Everything else with a known code/config extension
  ...Object.fromEntries([...codeTextExtensions].map((extension) => [extension, "code" as const])),
};

/** Classifies an attachment from its filename and stored MIME type. */
export function classifyAttachmentKind(filename: string, contentType: string): AttachmentKind {
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.at(1) ?? "";
  const byExtension = extensionKinds[extension];
  if (byExtension) return byExtension;

  const mime = contentType.trim().toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
  if (/zip|compressed|archive|tar|rar/.test(mime)) return "archive";
  if (/spreadsheet|excel|csv/.test(mime)) return "spreadsheet";
  if (mime.startsWith("text/")) {
    if (/javascript|typescript|json|xml|yaml|graphql/.test(mime)) return "code";
    return "text";
  }
  if (/document|word|presentation|powerpoint/.test(mime)) return "document";
  return "other";
}

/**
 * Serializes the deduplicated kind set of the given attachments as a JSON
 * array (the `attachment_kinds_json` column). An empty list serializes to
 * '[]' so LIKE filters never match placeholder rows.
 */
export function attachmentKindsJson(attachments: readonly { filename: string; contentType: string }[]): string {
  const kinds = [...new Set(attachments.map((attachment) => classifyAttachmentKind(attachment.filename, attachment.contentType)))];
  return JSON.stringify(kinds);
}