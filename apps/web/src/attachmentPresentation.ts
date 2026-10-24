import { translate, type Translate } from "./i18n";
import {
  attachmentKinds,
  classifyAttachmentKind,
  codeTextExtensions,
  extensionKinds,
  type AttachmentKind,
} from "./attachments/catalog";

// The kind vocabulary and the extension table are single-sourced in
// @nami/agent-contracts via ./attachments/catalog. This module keeps the
// historical export surface because the UI imports the kind type from here;
// re-exporting the same objects (not copies) is what makes the consolidation
// visible at the import site.
export type { AttachmentKind } from "./attachments/catalog";
export { attachmentKinds, codeTextExtensions };

export type AttachmentPresentation = {
  kind: AttachmentKind;
  label: string;
};

function presentAttachmentKind(kind: AttachmentKind, t: Translate, extension = ""): AttachmentPresentation {
  if (kind === "other") {
    return { kind, label: extension && extension.length <= 5 ? extension.toUpperCase() : t("attachment.file") };
  }
  return { kind, label: t(`attachment.${kind}`) };
}

const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);

/** Lowercased extension without the dot, `""` when the name has none. */
function extensionOf(filename: string): string {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

export function presentAttachment(filename: string, contentType: string, t: Translate = defaultTranslate): AttachmentPresentation {
  const extension = extensionOf(filename);
  // A curated extension outranks the stored MIME type: servers hand us
  // application/octet-stream for things they do not recognize, and a
  // contradictory MIME type must not relabel a known extension.
  const byExtension: AttachmentKind | undefined = extensionKinds[extension];
  if (byExtension) return presentAttachmentKind(byExtension, t, extension);
  return presentAttachmentKind(classifyAttachmentKind(filename, contentType), t, extension);
}
