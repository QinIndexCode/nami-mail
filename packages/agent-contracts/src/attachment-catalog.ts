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

