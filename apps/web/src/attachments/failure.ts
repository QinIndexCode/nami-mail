/**
 * The failure vocabulary shared by every preview stage (plan §7/§10).
 *
 * Fourteen codes, one presentation table. Decoders throw `PreviewFailure` with
 * a code and never a message string: the user-facing text is a translation key
 * chosen by `failurePresentation`, so a decoder cannot invent copy and the 14
 * codes cannot drift away from the 16 locale keys.
 */

export const failureCodes = [
  "too_large",
  "decoded_too_large",
  "pixels_too_large",
  "too_many_pages",
  "too_many_entries",
  "zip_bomb",
  "encrypted",
  "corrupt",
  "empty",
  "timeout",
  "network",
  "unsupported",
  "kind_mismatch",
  "image_budget_exceeded",
] as const;

export type FailureCode = (typeof failureCodes)[number];

/** The 13 drawer states (plan §10.1). `idle` is the resting state, never an error. */
export const previewStates = [
  "idle",
  "loading",
  "receiving",
  "decoding",
  "ready",
  "download_only",
  "error_too_large",
  "error_too_many_entries",
  "error_unsupported",
  "error_encrypted",
  "error_corrupt",
  "error_timeout",
  "error_network",
] as const;

export type PreviewStateId = (typeof previewStates)[number];

/**
 * A page-scoped failure (PDF): it is shown inside the page slot and never
 * escalates to the drawer. Only the four codes a single page can hit are
 * accepted — a page cannot be "encrypted" or "network".
 */
export const pageFailureCodes = ["pixels_too_large", "image_budget_exceeded", "corrupt", "timeout"] as const;

export type PageFailureCode = (typeof pageFailureCodes)[number];

export class PreviewFailure extends Error {
  constructor(readonly code: FailureCode, options?: { cause?: unknown }) {
    super(`attachment preview failed: ${code}`, options);
    this.name = "PreviewFailure";
  }
}

export class PageFailure extends Error {
  constructor(readonly code: PageFailureCode, options?: { cause?: unknown }) {
    super(`attachment preview page failed: ${code}`, options);
    this.name = "PageFailure";
  }
}

/**
 * Deliberate cancellation (drawer closed, another attachment opened, request
 * superseded). It is not an error state: the drawer goes back to `idle` and no
 * telemetry is written.
 */
export class PreviewCanceled extends Error {
  constructor() {
    super("attachment preview cancelled");
    this.name = "PreviewCanceled";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Normalises anything a stage can throw into the two things the drawer cares
 * about: cancellation, or a coded failure.
 *
 * An `AbortError` is a cancellation, never a `timeout` — the ingress deadline
 * arms its own timer and reports `timeout` explicitly, so an abort can only
 * mean the caller walked away. Anything unrecognised is reported as `corrupt`
 * rather than leaking an English engine message into the UI.
 */
export function failureFromUnknown(error: unknown): PreviewFailure | PreviewCanceled {
  if (error instanceof PreviewCanceled) return error;
  if (error instanceof PreviewFailure) return error;
  if (isAbortError(error)) return new PreviewCanceled();
  return new PreviewFailure("corrupt", { cause: error });
}

type FailurePresentation = { state: PreviewStateId; messageKey: string };

/**
 * Code → drawer state → translation key. The record is exhaustive by
 * construction (`satisfies Record<FailureCode, …>`): adding a fifteenth code
 * fails to compile instead of rendering a bare key.
 *
 * No interpolation values live here: `{seconds}` / `{max}` are supplied by the
 * view that knows the number, so the key and its arguments cannot contradict
 * each other.
 */
export const previewFailurePresentations = {
  too_large: { state: "error_too_large", messageKey: "mail.attachment.previewTooLarge" },
  decoded_too_large: { state: "error_too_large", messageKey: "mail.attachment.previewTooLarge" },
  pixels_too_large: { state: "error_too_large", messageKey: "mail.attachment.previewImageTooLarge" },
  too_many_pages: { state: "error_too_large", messageKey: "mail.attachment.previewTooManyPages" },
  too_many_entries: { state: "error_too_many_entries", messageKey: "mail.attachment.previewTooManyEntries" },
  zip_bomb: { state: "error_corrupt", messageKey: "mail.attachment.previewZipBomb" },
  encrypted: { state: "error_encrypted", messageKey: "mail.attachment.previewEncrypted" },
  corrupt: { state: "error_corrupt", messageKey: "mail.attachment.previewCorrupt" },
  empty: { state: "error_corrupt", messageKey: "mail.attachment.previewCorrupt" },
  timeout: { state: "error_timeout", messageKey: "mail.attachment.previewTimeout" },
  network: { state: "error_network", messageKey: "mail.attachment.previewFailed" },
  unsupported: { state: "error_unsupported", messageKey: "mail.attachment.previewUnsupported" },
  kind_mismatch: { state: "error_unsupported", messageKey: "mail.attachment.previewKindMismatch" },
  // Reuses the page-level copy: a first page over the image budget degrades the
  // whole document to "too large", and there is no 17th key for it.
  image_budget_exceeded: { state: "error_too_large", messageKey: "mail.attachment.previewPageTooLarge" },
} satisfies Record<FailureCode, FailurePresentation>;

export function failurePresentation(code: FailureCode): FailurePresentation {
  return previewFailurePresentations[code];
}
