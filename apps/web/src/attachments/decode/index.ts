import { sanitizeDisplayName } from "../catalog";
import {
  asDownloadOnly,
  ownObjectUrl,
  type DecodeContext,
  type PreviewDocument,
  type PreviewInput,
} from "../document";
import { PreviewFailure } from "../failure";
import { decodeImage, sniffImage } from "./image";
import { decodePdf } from "./pdf";
import { decodeText } from "./text";

export { decodeText } from "./text";
export { decodeImage, sniffImage } from "./image";
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
 * The single decode entry point. S2 covers PDF, both image kinds, the three text
 * kinds and media; Office/archive/fallback degrade to a download card until S3
 * adds their decoders.
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
    case "markdown":
      // Markdown keeps S2's text surface: rendering it as Markdown arrives with
      // its own decoder and surface in S3.
      return decodeText(input, ctx);
    case "media-audio":
    case "media-video":
      return decodeMedia(input, ctx);
    default:
      return downloadOnly(input);
  }
}
