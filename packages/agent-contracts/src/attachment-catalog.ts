/**
 * The one attachment classification table.
 *
 * Why this lives in the contract package: the server decides SQL kind filters
 * from indexed columns, the renderer draws kind badges, the agent file reader
 * decides what it can read, and the preview gate decides what it can render.
 * Each of those used to carry its own copy of the extension table, and every
 * copy drifted independently (a `.mdx` added to one, a media extension to
 * another). Keeping the data here means "what is this attachment" has exactly
 * one answer, while each consumer keeps its own *policy* on top of it — which
 * formats the current model accepts, or which formats the preview can decode,
 * are separate questions that must not be answered by this table.
 *
 * Pure data and pure functions, no runtime imports: this module is imported by
 * the main process, the renderer and the browser test environment alike.
 */

/** The nine attachment families. Presentation order is also the filter order. */
export type AttachmentKind = "archive" | "code" | "document" | "image" | "media" | "pdf" | "spreadsheet" | "text" | "other";

export const attachmentKinds: readonly AttachmentKind[] = [
  "archive", "code", "document", "image", "media", "pdf", "spreadsheet", "text", "other",
];

/**
 * Server-side spelling of the same array (the SQL filter vocabulary).
 * A second name for one object, not a copy: tests assert `ATTACHMENT_KINDS ===
 * attachmentKinds`, so a future edit can never make the two lists disagree.
 */
export const ATTACHMENT_KINDS: readonly AttachmentKind[] = attachmentKinds;

/**
 * Programming-language and config source extensions.
 *
 * Shared by the text preview, the agent-side file reader and the kind badge:
 * a source file must be classified, previewable and readable from one list.
 */
export const codeTextExtensions: ReadonlySet<string> = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
  "py", "pyw", "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hh",
  "java", "kt", "kts", "cs", "rb", "php", "swift", "scala",
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "sql",
  "html", "htm", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "json", "jsonl", "yaml", "yml", "toml", "xml", "graphql", "gql", "proto",
  "dart", "lua", "r", "ex", "exs", "erl", "hs", "ml", "pl", "pm", "perl",
  "clj", "cljs", "nim", "zig",
]);

/**
 * Extensions whose bytes are text and can be shown verbatim.
 *
 * Deliberately *not* a classification list: `csv` is here (it is readable as
 * text) and also in the spreadsheet row of `extensionKinds` (it is presented
 * as a spreadsheet). Preview and kind answer different questions, so the two
 * sets overlap on purpose instead of being merged into one ambiguous list.
 */
export const plainTextExtensions: ReadonlySet<string> = new Set([
  "txt", "log", "csv", "tsv", "ini", "cfg", "conf",
]);

/** Markdown-flavoured text; rendered as text in this slice, never evaluated. */
export const markdownExtensions: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

/**
 * Everything the text reader can turn into a model-readable string.
 *
 * `rtf` is included for extraction only, never for preview: showing raw RTF
 * control words (`{\rtf1\ansi...`) is noise, so a preview gate that treats
 * "readable" as "displayable" would show garbage. The two lists stay separate.
 */
export const readableTextExtensions: ReadonlySet<string> = new Set([
  ...plainTextExtensions,
  ...markdownExtensions,
  "rtf",
]);

/**
 * Complete extension → kind table.
 *
 * Duplicate keys are impossible without a compile error, and `codeTextExtensions`
 * is expanded last so it can never silently shadow a curated entry — the
 * contract test pins the total key count, which is what a colliding key would
 * change.
 */
export const extensionKinds: Readonly<Record<string, AttachmentKind>> = {
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
  mpeg: "media",
  mpg: "media",
  oga: "media",
  ogg: "media",
  ogv: "media",
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
  // Text (non-code); markdown extensions are text too, see `markdownExtensions`
  md: "text",
  tsv: "text",
  txt: "text",
  // PDF
  pdf: "pdf",
  // Everything else with a known code/config extension
  ...Object.fromEntries([...codeTextExtensions].map((extension) => [extension, "code" as const])),
};

/** Coarse media family; the preview needs it to pick an audio or video player. */
export type MediaKind = "audio" | "video";

/** Audio members of the media row above; `mediaKind` must cover every row. */
const mediaAudioExtensions: ReadonlySet<string> = new Set([
  "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wma",
]);

/** Video members of the media row above; `mediaKind` must cover every row. */
const mediaVideoExtensions: ReadonlySet<string> = new Set([
  "3gp", "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv",
]);

/**
 * Audio or video? Extension first (it survives a wrong stored MIME type), then
 * the MIME prefix for extensionless attachments. Null for non-media input, so
 * callers can keep their existing fallback path instead of guessing.
 */
export function mediaKind(filename: string, contentType = ""): MediaKind | null {
  const extension = extensionOf(filename);
  if (mediaAudioExtensions.has(extension)) return "audio";
  if (mediaVideoExtensions.has(extension)) return "video";

  const mime = contentType.trim().toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/** Lowercased extension without the dot, `""` when the name has none. */
function extensionOf(filename: string): string {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

/**
 * Classifies an attachment from its filename and stored MIME type.
 *
 * Order matters and is load-bearing: a curated extension always wins over the
 * stored MIME type (mail servers routinely store `application/octet-stream`,
 * and a contradictory MIME type must not relabel a known extension).
 */
export function classifyAttachmentKind(filename: string, contentType: string): AttachmentKind {
  const extension = extensionOf(filename);
  const byExtension = extensionKinds[extension];
  if (byExtension) return byExtension;

  const mime = contentType.trim().toLowerCase();
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return "media";
  if (/zip|compressed|archive|tar|rar/.test(mime)) return "archive";
  if (/spreadsheet|excel|csv/.test(mime)) return "spreadsheet";
  if (mime.startsWith("text/")) {
    // text/javascript and application/x-* source formats are code, plain text stays text.
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

/** What the leading bytes say a blob actually is. */
export type AttachmentSignature = "pdf" | "png" | "jpeg" | "gif" | "webp" | "bmp" | "zip" | "ooxml";

/** Largest accepted offset of the `%PDF-` header; readers may be fed a junk prefix. */
const pdfHeaderWindowBytes = 1024;

/** `%PDF-` */
const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
/** 89 50 4E 47 0D 0A 1A 0A */
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** FF D8 FF */
const jpegSignature = [0xff, 0xd8, 0xff] as const;
/** BM */
const bmpSignature = [0x42, 0x4d] as const;
/** Local file header of a ZIP container; every OOXML part sits behind one. */
const zipLocalHeaderSignature = [0x50, 0x4b, 0x03, 0x04] as const;
/** End-of-central-directory record, i.e. a ZIP with no entries. */
const zipEmptySignature = [0x50, 0x4b, 0x05, 0x06] as const;

function startsWithBytes(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return false;
  }
  return true;
}

function containsPdfHeader(bytes: Uint8Array): boolean {
  const windowEnd = Math.min(bytes.length, pdfHeaderWindowBytes);
  for (let index = 0; index + pdfSignature.length <= windowEnd; index += 1) {
    if (startsWithBytes(bytes.subarray(index), pdfSignature)) return true;
  }
  return false;
}

const asciiDecoder = new TextDecoder();

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return asciiDecoder.decode(bytes.subarray(offset, offset + length));
}

function isGif(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a";
}

function isWebp(bytes: Uint8Array): boolean {
  // RIFF container with a WEBP fourcc; a bare RIFF is WAV/AVI and must not match.
  return asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP";
}

function isZip(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, zipLocalHeaderSignature) || startsWithBytes(bytes, zipEmptySignature);
}

/** Name of the first local entry, used only to tell OOXML apart from a plain ZIP. */
function firstZipEntryName(bytes: Uint8Array): string {
  // Fixed local-file-header layout: name length at 26, extra length at 28.
  if (bytes.length < 30) return "";
  const nameLength = (bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8);
  const extraLength = (bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8);
  if (nameLength === 0) return "";
  const nameStart = 30 + extraLength;
  const nameEnd = nameStart + nameLength;
  if (nameEnd > bytes.length) return "";
  return bytes.subarray(nameStart, nameEnd).reduce((name, byte) => name + String.fromCharCode(byte), "");
}

/** OOXML packages always lead with this part. */
const ooxmlFirstEntryName = "[Content_Types].xml";

/**
 * Identifies a blob from its leading bytes.
 *
 * This is the input to a "extension and bytes disagree" decision; it is not a
 * classifier by itself, because a signature only proves a container format,
 * not that its contents are safe to decode. Returning the container is enough
 * for the caller to decide, and `null` means "no known signature".
 */
export function sniffSignature(bytes: Uint8Array): AttachmentSignature | null {
  if (bytes.length === 0) return null;
  // PDF first: a PDF may carry a junk prefix, so it uses a window, not a prefix.
  if (containsPdfHeader(bytes)) return "pdf";
  if (startsWithBytes(bytes, pngSignature)) return "png";
  if (startsWithBytes(bytes, jpegSignature)) return "jpeg";
  if (isGif(bytes)) return "gif";
  if (isWebp(bytes)) return "webp";
  if (startsWithBytes(bytes, bmpSignature)) return "bmp";
  if (isZip(bytes)) return firstZipEntryName(bytes) === ooxmlFirstEntryName ? "ooxml" : "zip";
  return null;
}
