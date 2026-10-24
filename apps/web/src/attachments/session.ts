import { DECODE_DEADLINE_MS, MAX_INPUT_BYTES, type BudgetBranch, type MemoryLease } from "./budget";
import { previewKindFor, tierFor, type PreviewKind } from "./catalog";
import { decodeAttachment } from "./decode";
import { withTimeout } from "./decode/deadline";
import { downloadOnlySurface, type PreviewDocument, type PreviewInput, type ResourceScope } from "./document";
import { PreviewCanceled, PreviewFailure } from "./failure";
import { openAttachmentResponse, readBody, type AttachmentReply } from "./ingress";

export type PreviewAttachment = {
  messageId: string;
  partId: string;
  filename: string;
  contentType: string;
  size: number;
};

export type PreviewClient = {
  open: (attachment: PreviewAttachment, options: { signal: AbortSignal; cap: number }) => Promise<AttachmentReply>;
  decode: (input: PreviewInput, context: Parameters<typeof decodeAttachment>[1]) => Promise<PreviewDocument>;
};

export const defaultPreviewClient: PreviewClient = {
  open: (attachment, options) =>
    openAttachmentResponse(attachment.messageId, attachment.partId, { signal: options.signal, cap: options.cap }),
  decode: decodeAttachment,
};

const CAP_BRANCH: Record<PreviewKind, BudgetBranch> = {
  pdf: "pdf",
  "office-word": "office",
  "office-sheet": "office",
  "office-slides": "office",
  "image-raster": "image",
  "image-vector": "image",
  text: "text",
  code: "code",
  markdown: "markdown",
  archive: "archive",
  "media-audio": "media",
  "media-video": "media",
  fallback: "text",
};

/** Input ceiling for one classification; the drawer never chooses it itself. */
export function inputCapFor(kind: PreviewKind): number {
  return MAX_INPUT_BYTES[CAP_BRANCH[kind]];
}

export type PreviewPhase = "receiving" | "decoding";

export type RunPreviewOptions = {
  signal: AbortSignal;
  scope: ResourceScope;
  lease: MemoryLease;
  client?: PreviewClient;
  onPhase?: (phase: PreviewPhase) => void;
};

/**
 * One attachment, end to end: classify → fetch under the input ceiling → decode
 * under the cooperative deadline.
 *
 * The lease takes the input bytes before the decoder starts allocating, so the
 * ledger already holds the whole payload when the first working set appears.
 */
export async function runPreview(attachment: PreviewAttachment, options: RunPreviewOptions): Promise<PreviewDocument> {
  const kind = previewKindFor({ filename: attachment.filename, contentType: attachment.contentType });
  // Tier C is a contract, not an optimisation: an unsupported file must cost
  // zero network requests, so it becomes a download card before any fetch.
  if (tierFor(kind) === "C") {
    return {
      kind,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      surface: downloadOnlySurface("unsupported"),
    };
  }
  const cap = inputCapFor(kind);
  if (attachment.size > cap) throw new PreviewFailure("too_large");
  if (options.signal.aborted) throw new PreviewCanceled();

  const client = options.client ?? defaultPreviewClient;
  options.onPhase?.("receiving");
  const reply = await client.open(attachment, { signal: options.signal, cap });
  const bytes = await readBody(reply, cap);
  if (options.signal.aborted) throw new PreviewCanceled();
  if (bytes.byteLength === 0) throw new PreviewFailure("empty");

  options.lease.charge(bytes.byteLength, "attachment bytes");
  options.onPhase?.("decoding");

  const input: PreviewInput = {
    kind,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    bytes,
    blob: new Blob([bytes], { type: attachment.contentType }),
  };
  return withTimeout(
    client.decode(input, {
      scope: options.scope,
      lease: options.lease,
      signal: options.signal,
      now: () => Date.now(),
      deadlineMs: DECODE_DEADLINE_MS,
    }),
    DECODE_DEADLINE_MS,
    () => undefined,
    { signal: options.signal },
  );
}
