import { translate, type Translate } from "./i18n";

export type AttachmentKind = "archive" | "document" | "image" | "pdf" | "spreadsheet" | "text" | "other";

export type AttachmentPresentation = {
  kind: AttachmentKind;
  label: string;
};

const extensionKinds: Record<string, AttachmentKind> = {
  "7z": "archive",
  csv: "spreadsheet",
  doc: "document",
  docx: "document",
  gif: "image",
  jpeg: "image",
  jpg: "image",
  md: "text",
  pdf: "pdf",
  png: "image",
  ppt: "document",
  pptx: "document",
  rar: "archive",
  rtf: "document",
  tar: "archive",
  txt: "text",
  webp: "image",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  zip: "archive",
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
  if (/zip|compressed|archive|tar|rar/.test(mime)) return presentAttachmentKind("archive", t, extension);
  if (/spreadsheet|excel|csv/.test(mime)) return presentAttachmentKind("spreadsheet", t, extension);
  if (mime.startsWith("text/")) return presentAttachmentKind("text", t, extension);
  if (/document|word|presentation|powerpoint/.test(mime)) return presentAttachmentKind("document", t, extension);
  return presentAttachmentKind("other", t, extension);
}
