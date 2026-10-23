import { DECODE_DEADLINE_MS, MAX_INPUT_BYTES, type BudgetBranch, type MemoryLease } from "./budget";
import { previewKindFor, tierFor, type PreviewKind } from "./catalog";
import { decodeAttachment } from "./decode";
import { withTimeout } from "./decode/deadline";
import { downloadOnlySurface, type PreviewDocument, type PreviewInput, type ResourceScope } from "./document";
import { PreviewCanceled, PreviewFailure, failurePresentation, type FailureCode, type PreviewStateId } from "./failure";
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

/** The part of the drawer that outlives a single attempt. */
export type PreviewSessionState = {
  status: PreviewStateId;
  attachment: PreviewAttachment | null;
  document: PreviewDocument | null;
  failure: FailureCode | null;
  page: number;
  scope: ResourceScope | null;
  lease: MemoryLease | null;
};

export const initialState: PreviewSessionState = {
  status: "idle",
  attachment: null,
  document: null,
  failure: null,
  page: 1,
  scope: null,
  lease: null,
};

export type PreviewEvent =
  | { type: "open"; attachment: PreviewAttachment; scope: ResourceScope; lease: MemoryLease }
  | { type: "phase"; phase: PreviewPhase }
  | { type: "ready"; document: PreviewDocument }
  | { type: "failed"; code: FailureCode }
  | { type: "close" }
  | { type: "retry" }
  | { type: "set_page"; page: number };

const isActive = (status: PreviewStateId): boolean =>
  status === "loading" || status === "receiving" || status === "decoding" || status === "ready";

/**
 * Pure state machine over the 13 state ids.
 *
 * Two invariants live here rather than in the component: an `open` for the
 * attachment already being previewed is a no-op (one attachment, one lease), and
 * a failure always lands on the state its code maps to, so no branch can invent
 * an error state.
 */
export function previewReducer(state: PreviewSessionState, event: PreviewEvent): PreviewSessionState {
  switch (event.type) {
    case "open": {
      if (state.attachment?.partId === event.attachment.partId && isActive(state.status)) return state;
      return {
        ...state,
        status: "loading",
        attachment: event.attachment,
        document: null,
        failure: null,
        page: 1,
        scope: event.scope,
        lease: event.lease,
      };
    }
    case "phase":
      return { ...state, status: event.phase };
    case "ready":
      return { ...state, status: "ready", document: event.document, failure: null, page: 1 };
    case "failed":
      return { ...state, status: failurePresentation(event.code).state, failure: event.code, document: null };
    case "close":
      return { ...initialState };
    case "retry":
      if (state.attachment === null) return state;
      return { ...state, status: "loading", failure: null, document: null };
    case "set_page":
      if (state.status !== "ready" || state.document?.pdf === undefined) return state;
      if (event.page < 1 || event.page > state.document.pdf.pageCount) return state;
      return { ...state, page: event.page };
    default:
      return state;
  }
}

/** `retry` and `cancel` are the two transitions that also own resources. */
export function retry(state: PreviewSessionState): PreviewSessionState {
  return previewReducer(state, { type: "retry" });
}

export function cancel(state: PreviewSessionState): PreviewSessionState {
  state.scope?.dispose();
  return previewReducer(state, { type: "close" });
}
