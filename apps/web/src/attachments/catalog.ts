/**
 * Web-side derivation of the attachment contract.
 *
 * The classification table itself lives in `@nami/agent-contracts`; everything
 * here answers a *renderer* question on top of it — which surface can show
 * these bytes, how much privilege that surface gets (tier), and how the name
 * is allowed to be displayed. Keeping the derivation here (instead of inside
 * the drawer) means the preview gate, the surface registry and the tests all
 * read the same table, and a new kind cannot be added without the exhaustive
 * maps below failing to compile.
 */
import {
  classifyAttachmentKind,
  codeTextExtensions,
  markdownExtensions,
  mediaKind,
  plainTextExtensions,
} from "@nami/agent-contracts";

/**
 * Re-exported rather than redefined: six UI modules import the kind type from
 * `attachmentPresentation`, and the two names below are the same objects the
 * server classifies with — identity, not a copy.
 */
export {
  attachmentKinds,
  classifyAttachmentKind,
  codeTextExtensions,
  extensionKinds,
  mediaKind,
} from "@nami/agent-contracts";
export type { AttachmentKind } from "@nami/agent-contracts";

/**
 * The renderer-level shape. One kind can be shown by several surfaces and vice
 * versa — `kind` is what the file *is*, `PreviewKind` is how it is shown.
 */
export type PreviewKind =
  | "pdf"
  | "image-raster"
  | "image-vector"
  | "text"
  | "code"
  | "markdown"
  | "office-word"
  | "office-sheet"
  | "office-slides"
  | "archive"
  | "media-audio"
  | "media-video"
  | "fallback";

/** Every preview kind, in the order the drawer picker shows them. */
export const previewKinds: readonly PreviewKind[] = [
  "pdf",
  "image-raster",
  "image-vector",
  "text",
  "code",
  "markdown",
  "office-word",
  "office-sheet",
  "office-slides",
  "archive",
  "media-audio",
  "media-video",
  "fallback",
];

/**
 * The concrete rendering surface. `download_only` is a surface, not an error:
 * an unsupported file still has a valid drawer with a download card.
 */
export type PreviewSurfaceName =
  | "pdf"
  | "raster"
  | "vector"
  | "text"
  | "markdown"
  | "blocks"
  | "sheet"
  | "archive"
  | "media"
  | "download_only";

/** Every surface, so the S2 registry can be checked for completeness. */
export const previewSurfaceNames: readonly PreviewSurfaceName[] = [
  "pdf",
  "raster",
  "vector",
  "text",
  "markdown",
  "blocks",
  "sheet",
  "archive",
  "media",
  "download_only",
];

/**
 * Privilege tier. A: the bytes are decoded in-process by a hardened worker.
 * B: decoded in a sandbox-by-contract parser (archive listing only). C: no
 * bytes fetched at all, download card only.
 */
export type PreviewTier = "A" | "B" | "C";

/** Attachment fields the preview needs; wider DTOs are structurally assignable. */
export type AttachmentMetadata = { filename: string; contentType: string };

const surfaces: Record<PreviewKind, PreviewSurfaceName> = {
  pdf: "pdf",
  "image-raster": "raster",
  "image-vector": "vector",
  text: "text",
  code: "text",
  markdown: "markdown",
  "office-word": "blocks",
  "office-sheet": "sheet",
  "office-slides": "blocks",
  archive: "archive",
  "media-audio": "media",
  "media-video": "media",
  fallback: "download_only",
};

/**
 * Media is tier A: the drawer fetches the bytes once and hands the resulting
 * object URL to `<audio>`/`<video>` — no autoplay, no `<source>` children, no
 * `track`, and an `onError` fallback to the download card. The only decoder
 * involved is Chromium's own demuxer, the same class of trust as the raster
 * path; leaving audio and video on "download only" was a product gap (voice
 * mail, short clips are ordinary mail attachments), not a safety boundary.
 */
const tiers: Record<PreviewKind, PreviewTier> = {
  pdf: "A",
  "image-raster": "A",
  "image-vector": "A",
  text: "A",
  code: "A",
  markdown: "A",
  "office-word": "A",
  "office-sheet": "A",
  "office-slides": "A",
  archive: "B",
  "media-audio": "A",
  "media-video": "A",
  fallback: "C",
};

/** Lowercased extension without the dot, `""` when the name has none. */
function extensionOf(filename: string): string {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

/**
 * Maps an attachment to its renderer kind.
 *
 * The textual checks come first because "can be shown as text" is a property
 * of the extension, independent of the kind: `.csv` is a spreadsheet by kind
 * but must be shown as text, and `.mdx` is markdown despite being classified
 * as text. Only after those does the kind decide, which keeps the two
 * vocabularies from being merged into one ambiguous list.
 */
export function previewKindFor(attachment: AttachmentMetadata): PreviewKind {
  const extension = extensionOf(attachment.filename);
  if (markdownExtensions.has(extension)) return "markdown";
  if (plainTextExtensions.has(extension)) return "text";
  if (codeTextExtensions.has(extension)) return "code";

  const kind = classifyAttachmentKind(attachment.filename, attachment.contentType);
  switch (kind) {
    case "pdf":
      return "pdf";
    case "image":
      // SVG is markup, not raster bytes: it must never reach the image decoder.
      return extension === "svg" ? "image-vector" : "image-raster";
    case "media": {
      const media = mediaKind(attachment.filename, attachment.contentType);
      if (media === "audio") return "media-audio";
      if (media === "video") return "media-video";
      return "fallback";
    }
    case "document":
      if (extension === "docx") return "office-word";
      if (extension === "pptx") return "office-slides";
      return "fallback";
    case "spreadsheet":
      return extension === "xlsx" ? "office-sheet" : "fallback";
    case "archive":
      return extension === "zip" ? "archive" : "fallback";
    case "text":
      return "text";
    case "code":
      return "code";
    case "other":
      return "fallback";
  }
}

/** Which surface renders this preview kind. */
export function surfaceFor(previewKind: PreviewKind): PreviewSurfaceName {
  return surfaces[previewKind];
}

/** Which privilege tier this preview kind runs in. */
export function tierFor(previewKind: PreviewKind): PreviewTier {
  return tiers[previewKind];
}

/**
 * Every kind opens *something* now — the drawer exists for all of them and
 * falls back to a download card, so the gate never hides a file from the user.
 * The parameter stays part of the signature because the S2 gate asks per kind.
 */
export function canOpenPreview(kind: PreviewKind): boolean {
  return previewKinds.includes(kind);
}

/** Display-name fallback when nothing printable survives sanitization. */
const fallbackDisplayName = "attachment";

/** Longest display name in code points; names longer than this are truncated. */
const maxDisplayNameCodePoints = 255;

/**
 * Characters that can forge a different name in a UI (control characters,
 * bidi overrides/isolates, zero-width separators). They are invisible to the
 * eye but not to the file system, so they must never reach a rendered label.
 */
function isInvisibleOrBidi(codePoint: number): boolean {
  return (
    codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function stripInvisible(text: string): string {
  let visible = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isInvisibleOrBidi(codePoint)) visible += character;
  }
  return visible;
}

/** `.pdf` for `a.pdf`, `""` when the trailing segment is not an extension. */
function extensionSuffixOf(filename: string): string {
  return filename.match(/\.[A-Za-z0-9]{1,16}$/)?.[0] ?? "";
}

/** Caps by code points (not UTF-16 units) so split emoji/surrogates cannot occur. */
function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  // Reserve one code point for the ellipsis: a cap that the ellipsis pushes
  // past 255 would not be a cap.
  return `${codePoints.slice(0, limit - 1).join("")}…`;
}

/**
 * Turns a stored filename into something safe to render.
 *
 * Pure and total: never throws, never returns an empty label, and never
 * touches the filename used for classification — sanitizing before classifying
 * would let a crafted name change what kind of file the server stores.
 *
 * The NUL case deserves its own rule: a stored `a\u0000b.pdf` is classified as
 * a PDF but truncation alone would display "a", i.e. a name that hides the
 * real type. Re-attaching the original extension keeps the label honest.
 */
export function sanitizeDisplayName(filename: string): string {
  const nulIndex = filename.indexOf("\u0000");
  const beforeNul = nulIndex === -1 ? filename : filename.slice(0, nulIndex);
  const stripped = stripInvisible(beforeNul).trim();
  if (!stripped) return fallbackDisplayName;

  const display = nulIndex === -1 || stripped.includes(".")
    ? stripped
    : `${stripped}${extensionSuffixOf(filename)}`;
  return truncateCodePoints(display || fallbackDisplayName, maxDisplayNameCodePoints);
}
