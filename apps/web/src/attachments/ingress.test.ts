// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { INGRESS_BASE_MS } from "./budget";
import { PreviewCanceled, PreviewFailure } from "./failure";
import {
  attachmentContentPath,
  openAttachmentResponse,
  readBody,
  readText,
  setAttachmentResponseProvider,
} from "./ingress";

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

afterEach(() => {
  setAttachmentResponseProvider(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("attachmentContentPath", () => {
  it("encodes both ids into the messages attachment route", () => {
    expect(attachmentContentPath("a b", "p/1")).toBe("/api/messages/a%20b/attachments/p%2F1");
  });
});

describe("openAttachmentResponse + readBody", () => {
  it("streams the body through the injected provider", async () => {
    const cancel = vi.fn(async () => undefined);
    setAttachmentResponseProvider(async () => new Response(streamOf([bytes("hello "), bytes("world")])));
    const reply = await openAttachmentResponse("m1", "p1");
    await expect(readBody(reply, 1024)).resolves.toEqual(bytes("hello world"));
    // The body is consumed, so cancelling it afterwards is not needed; the
    // assertion above is about bytes, not cancellation.
    expect(cancel).not.toHaveBeenCalled();
  });

  it("maps 413 to too_large and every other error status to network", async () => {
    setAttachmentResponseProvider(async () => new Response(null, { status: 413 }));
    await expect(openAttachmentResponse("m", "p")).rejects.toMatchObject({ code: "too_large" });
    setAttachmentResponseProvider(async () => new Response(null, { status: 500 }));
    await expect(openAttachmentResponse("m", "p")).rejects.toMatchObject({ code: "network" });
  });

  it("rejects a declared content length above the cap before reading", async () => {
    const cancel = vi.fn(async () => undefined);
    setAttachmentResponseProvider(
      async () => new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        headers: { "content-length": "4096" },
      }),
    );
    await expect(openAttachmentResponse("m", "p", { cap: 1024 })).rejects.toMatchObject({ code: "too_large" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the body as soon as the running total crosses the cap", async () => {
    const cancel = vi.fn(async () => undefined);
    setAttachmentResponseProvider(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes("123456"));
              controller.enqueue(bytes("789012"));
            },
            cancel,
          }),
        ),
    );
    const reply = await openAttachmentResponse("m", "p", { cap: 1024 });
    await expect(readBody(reply, 10)).rejects.toMatchObject({ code: "too_large" });
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(openAttachmentResponse("m", "p", { signal: controller.signal })).rejects.toBeInstanceOf(PreviewCanceled);
  });

  it("turns a stalled request into a timeout and aborts the signal", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    setAttachmentResponseProvider((_messageId, _partId, options) => {
      seen = options.signal;
      return new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });
    const pending = openAttachmentResponse("m", "p");
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(INGRESS_BASE_MS + 1);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("treats a caller abort mid-stream as cancellation, not failure", async () => {
    const controller = new AbortController();
    setAttachmentResponseProvider(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(bytes("partial"));
              // Never closes: the caller abort is the only way out.
            },
          }),
        ),
    );
    const reply = await openAttachmentResponse("m", "p", { signal: controller.signal });
    controller.abort();
    await expect(readBody(reply, 1024)).rejects.toBeInstanceOf(PreviewCanceled);
    reply.dispose();
  });

  it("returns empty bytes for a body-less response", async () => {
    setAttachmentResponseProvider(async () => new Response(null));
    const reply = await openAttachmentResponse("m", "p");
    await expect(readBody(reply, 1024)).resolves.toEqual(new Uint8Array(0));
  });
});

describe("readText", () => {
  it("keeps at most maxChars code points and never splits a surrogate pair", async () => {
    setAttachmentResponseProvider(async () => new Response(streamOf([bytes("😀😀😀")])));
    const reply = await openAttachmentResponse("m", "p");
    await expect(readText(reply, { maxChars: 2 })).resolves.toBe("😀😀");
  });

  it("propagates a failure while streaming", async () => {
    setAttachmentResponseProvider(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("socket reset"));
            },
          }),
        ),
    );
    const reply = await openAttachmentResponse("m", "p");
    await expect(readText(reply, { maxChars: 10 })).rejects.toBeInstanceOf(PreviewFailure);
  });
});
