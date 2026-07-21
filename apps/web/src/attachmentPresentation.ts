export type AttachmentKind = "archive" | "document" | "image" | "pdf" | "spreadsheet" | "other";

export type AttachmentPresentation = {
  kind: AttachmentKind;
  label: string;
};

const extensionKinds: Record<string, AttachmentPresentation> = {
  "7z": { kind: "archive", label: "压缩文件" },
  csv: { kind: "spreadsheet", label: "表格" },
  doc: { kind: "document", label: "文档" },
  docx: { kind: "document", label: "文档" },
  gif: { kind: "image", label: "图片" },
  jpeg: { kind: "image", label: "图片" },
  jpg: { kind: "image", label: "图片" },
  md: { kind: "document", label: "文本" },
  pdf: { kind: "pdf", label: "PDF" },
  png: { kind: "image", label: "图片" },
  ppt: { kind: "document", label: "演示文稿" },
  pptx: { kind: "document", label: "演示文稿" },
  rar: { kind: "archive", label: "压缩文件" },
  rtf: { kind: "document", label: "文档" },
  tar: { kind: "archive", label: "压缩文件" },
  txt: { kind: "document", label: "文本" },
  webp: { kind: "image", label: "图片" },
  xls: { kind: "spreadsheet", label: "表格" },
  xlsx: { kind: "spreadsheet", label: "表格" },
  zip: { kind: "archive", label: "压缩文件" },
};

export function presentAttachment(filename: string, contentType: string): AttachmentPresentation {
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  const byExtension = extensionKinds[extension];
  if (byExtension) return byExtension;

  const mime = contentType.trim().toLowerCase();
  if (mime === "application/pdf") return { kind: "pdf", label: "PDF" };
  if (mime.startsWith("image/")) return { kind: "image", label: "图片" };
  if (/zip|compressed|archive|tar|rar/.test(mime)) return { kind: "archive", label: "压缩文件" };
  if (/spreadsheet|excel|csv/.test(mime)) return { kind: "spreadsheet", label: "表格" };
  if (/document|word|presentation|powerpoint|text\//.test(mime)) return { kind: "document", label: "文档" };
  return { kind: "other", label: extension && extension.length <= 5 ? extension.toUpperCase() : "文件" };
}
