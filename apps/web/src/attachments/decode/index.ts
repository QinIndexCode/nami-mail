import { sanitizeDisplayName } from "../catalog";
import {
  asDownloadOnly,
  ownObjectUrl,
  type DecodeContext,
  type PreviewDocument,
  type PreviewInput,
} from "../document";
import { PreviewFailure } from "../failure";
import { decodeArchive } from "./archive";
import { decodeImage, sniffImage } from "./image";
import { decodeMarkdown } from "./markdown";
import { decodeOffice } from "./office";
import { decodePdf } from "./pdf";
import { decodeText } from "./text";

export { decodeText } from "./text";
export { decodeImage, sniffImage } from "./image";
export { decodeMarkdown, countMarkdownBlocks } from "./markdown";
export { decodeOffice } from "./office";
export { decodeArchive } from "./archive";
export {
  decodePdf,
  buildPdfOptions,
  measureOperatorList,
  pageBudgetFailure,
  pdfAssetBase,
  releasePdfPage,
  AnnotationMode,
  OPS,
} from "./pdf";
export { withTimeout } from "./deadline";

function downloadOnly(input: PreviewInput): PreviewDocument {
  return asDownloadOnly(
    {
      kind: input.kind,
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      surface: { surface: "text", text: "", shown: 0, total: 0 },
    },
    "unsupported",
  );
}

/** Media has no decoder module on purpose: the element does the decoding. */
function decodeMedia(input: PreviewInput, ctx: DecodeContext): PreviewDocument {
  const url = ownObjectUrl(ctx.scope, input.blob);
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: {
      surface: "media",
      url,
      mediaKind: input.kind === "media-audio" ? "audio" : "video",
      filename: sanitizeDisplayName(input.filename),
    },
  };
}

/**
 * The single decode entry point. All ten kinds from the catalog are dispatched
 * here; the `default` branch is unreachable by construction and stays only so
 * that a future kind added to the union without a decoder degrades to the
 * download card instead of throwing.
 *
 * A surface mismatch (a `.svg` whose bytes are a JPEG) is `kind_mismatch` — the
 * content and the extension disagree, which is different from "browser has no
 * decoder for this container".
 */
export async function decodeAttachment(input: PreviewInput, ctx: DecodeContext): Promise<PreviewDocument> {
  switch (input.kind) {
    case "pdf":
      return decodePdf(input, ctx);
    case "image-raster": {
      const sniffed = sniffImage(input.bytes);
      if (!sniffed) throw new PreviewFailure("corrupt");
      if (sniffed.format === "svg") throw new PreviewFailure("kind_mismatch");
      return decodeImage(input, ctx);
    }
    case "image-vector": {
      const sniffed = sniffImage(input.bytes);
      if (!sniffed) throw new PreviewFailure("corrupt");
      if (sniffed.format !== "svg") throw new PreviewFailure("kind_mismatch");
      return decodeImage(input, ctx);
    }
    case "text":
    case "code":
      return decodeText(input, ctx);
    case "markdown":
      return decodeMarkdown(input, ctx);
    case "office-word":
    case "office-sheet":
    case "office-slides":
      return decodeOffice(input, ctx);
    case "archive":
      return decodeArchive(input, ctx);
    case "media-audio":
    case "media-video":
      return decodeMedia(input, ctx);
    default:
      return downloadOnly(input);
  }
}
