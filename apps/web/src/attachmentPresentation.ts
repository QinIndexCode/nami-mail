import { translate, type Translate } from "./i18n";

export type AttachmentKind = "archive" | "code" | "document" | "image" | "media" | "pdf" | "spreadsheet" | "text" | "other";

/** Every kind in presentation order, for filter segments and pickers. */
export const attachmentKinds: readonly AttachmentKind[] = [
  "archive", "code", "document", "image", "media", "pdf", "spreadsheet", "text", "other",
];

export type AttachmentPresentation = {
  kind: AttachmentKind;
  label: string;
};

/** Programming-language and config source extensions (single source of truth).
 * Shared with the text preview and the agent-side file reader so a code file is
 * classified, previewable and readable in one place. */
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

function presentAttachmentKind(kind: AttachmentKind, t: Translate, extension = ""): AttachmentPresentation {
  if (kind === "other") {
    return { kind, label: extension && extension.length <= 5 ? extension.toUpperCase() : t("attachment.file") };
  }
  return { kind, label: t(`attachment.${kind}`) };
}

const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);

export function presentAttachment(filename: string, contentType: string, t: Translate = defaultTranslate): AttachmentPresentation {
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  const byExtension = extensionKinds[extension];
  if (byExtension) return presentAttachmentKind(byExtension, t, extension);

  const mime = contentType.trim().toLowerCase();
  if (mime === "application/pdf") return presentAttachmentKind("pdf", t, extension);
  if (mime.startsWith("image/")) return presentAttachmentKind("image", t, extension);
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return presentAttachmentKind("media", t, extension);
  if (/zip|compressed|archive|tar|rar/.test(mime)) return presentAttachmentKind("archive", t, extension);
  if (/spreadsheet|excel|csv/.test(mime)) return presentAttachmentKind("spreadsheet", t, extension);
  if (mime.startsWith("text/")) {
    // text/javascript and application/x-* source formats are code, plain text stays text.
    if (/javascript|typescript|json|xml|yaml|graphql/.test(mime)) return presentAttachmentKind("code", t, extension);
    return presentAttachmentKind("text", t, extension);
  }
  if (/document|word|presentation|powerpoint/.test(mime)) return presentAttachmentKind("document", t, extension);
  return presentAttachmentKind("other", t, extension);
}