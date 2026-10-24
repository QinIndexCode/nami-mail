import { apiError, requestResponse } from "../apiTransport";
import { MAX_INPUT_BYTES, attachmentTimeoutMsFor } from "./budget";
import { PreviewCanceled, PreviewFailure } from "./failure";

/**
 * Ingress: fetch one attachment body under a size ceiling and a deadline that
 * follows the number of bytes actually received.
 *
 * There is no production `Content-Length` to rely on — IMAP hands the server a
 * stream — so the precheck below is a mock/dev convenience; the real guard is
 * the running total in `readBody`, which cancels the body the moment it crosses
 * the cap.
 */

export type AttachmentResponseProvider = (
  messageId: string,
  partId: string,
  options: { signal?: AbortSignal },
) => Promise<Response>;

let responseProvider: AttachmentResponseProvider | null = null;

/** Demo mode and tests supply bytes here; everything else is unchanged. */
export function setAttachmentResponseProvider(provider: AttachmentResponseProvider | null): void {
  responseProvider = provider;
}

export function attachmentContentPath(messageId: string, partId: string): string {
  return `/api/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`;
}

export type AttachmentReply = {
  response: Response;
  /** Aborted either by the caller (cancel) or by the deadline. */
  signal: AbortSignal;
  timedOut: () => boolean;
  /** Re-arms the deadline from the bytes received so far. */
  received: (bytes: number) => void;
  dispose: () => void;
};

export type OpenAttachmentOptions = {
  signal?: AbortSignal;
  /** Input ceiling for this kind; the caller takes it from `MAX_INPUT_BYTES`. */
  cap?: number;
};

export async function openAttachmentResponse(
  messageId: string,
  partId: string,
  options: OpenAttachmentOptions = {},
): Promise<AttachmentReply> {
  const cap = options.cap ?? MAX_INPUT_BYTES.pdf;
  if (options.signal?.aborted) throw new PreviewCanceled();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  // The first deadline is the fixed base; every chunk replaces it with a budget
  // proportional to what has actually arrived.
  const arm = (bytesReceived: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attachmentTimeoutMsFor(bytesReceived));
  };
  arm(0);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  try {
    const response = responseProvider
      ? await responseProvider(messageId, partId, { signal: controller.signal })
      : await requestResponse(attachmentContentPath(messageId, partId), { signal: controller.signal });
    if (!response.ok) {
      throw new PreviewFailure(response.status === 413 ? "too_large" : "network", { cause: await apiError(response) });
    }
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > cap) {
      await response.body?.cancel().catch(() => undefined);
      throw new PreviewFailure("too_large");
    }
    return {
      response,
      signal: controller.signal,
      timedOut: () => timedOut,
      received: arm,
      dispose,
    };
  } catch (error) {
    dispose();
    if (timedOut) throw new PreviewFailure("timeout", { cause: error });
    if (controller.signal.aborted) throw new PreviewCanceled();
    if (error instanceof PreviewFailure) throw error;
    // An ApiError and any other transport failure share the vocabulary's one
    // word for them; the response's own detail rides along as the cause.
    throw new PreviewFailure("network", { cause: error });
  }
}

function bytesOf(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Streams the body, aborting as soon as the running total crosses `cap`. */
export async function readBody(reply: AttachmentReply, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const body = reply.response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (reply.timedOut()) throw new PreviewFailure("timeout");
      if (reply.signal.aborted) throw new PreviewCanceled();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        throw new PreviewFailure("too_large");
      }
      chunks.push(value);
      reply.received(total);
    }
  } catch (error) {
    if (reply.timedOut()) throw new PreviewFailure("timeout", { cause: error });
    if (reply.signal.aborted) throw new PreviewCanceled();
    if (error instanceof PreviewFailure || error instanceof PreviewCanceled) throw error;
    // A body stream that fails mid-read is a transport failure: the vocabulary
    // has no more specific word for it, and "network" keeps the drawer honest.
    throw new PreviewFailure("network", { cause: error });
  } finally {
    reply.dispose();
  }
  return bytesOf(chunks, total);
}
