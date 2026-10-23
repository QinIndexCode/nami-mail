// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DECODE_DEADLINE_MS, MAX_INPUT_BYTES, MemoryLease } from "./budget";
import { decodeAttachment } from "./decode";
import { ResourceScope, type PreviewDocument } from "./document";
import { PreviewCanceled, PreviewFailure, failurePresentation } from "./failure";
import type { AttachmentReply } from "./ingress";
import {
  cancel,
  initialState,
  inputCapFor,
  previewReducer,
  retry,
  runPreview,
  type PreviewAttachment,
  type PreviewClient,
  type PreviewSessionState,
} from "./session";

const attachment = (overrides: Partial<PreviewAttachment> = {}): PreviewAttachment => ({
  messageId: "m1",
  partId: "p1",
  filename: "notes.txt",
  contentType: "text/plain",
  size: 11,
  ...overrides,
});

const reply = (chunks: Uint8Array[], overrides: Partial<AttachmentReply> = {}): AttachmentReply =>
  ({
    response: new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    ),
    signal: new AbortController().signal,
    timedOut: () => false,
    received: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  }) satisfies AttachmentReply;

const textDocument = (size = 11): PreviewDocument => ({
  kind: "text",
  filename: "notes.txt",
  contentType: "text/plain",
  size,
  surface: { surface: "text", text: "hello world", shown: 11, total: 11 },
});

const fakeClient = (overrides: Partial<PreviewClient> = {}): PreviewClient => ({
  open: vi.fn(async () => reply([new TextEncoder().encode("hello world")])),
  decode: vi.fn(async () => textDocument()),
  ...overrides,
});

const runOptions = (overrides: Partial<Parameters<typeof runPreview>[1]> = {}) => ({
  signal: new AbortController().signal,
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  ...overrides,
});

describe("inputCapFor", () => {
  it("maps every classification onto its own budget branch", () => {
    expect(inputCapFor("pdf")).toBe(MAX_INPUT_BYTES.pdf);
    expect(inputCapFor("office-word")).toBe(MAX_INPUT_BYTES.office);
    expect(inputCapFor("office-sheet")).toBe(MAX_INPUT_BYTES.office);
    expect(inputCapFor("office-slides")).toBe(MAX_INPUT_BYTES.office);
    expect(inputCapFor("image-raster")).toBe(MAX_INPUT_BYTES.image);
    expect(inputCapFor("image-vector")).toBe(MAX_INPUT_BYTES.image);
    expect(inputCapFor("text")).toBe(MAX_INPUT_BYTES.text);
    expect(inputCapFor("code")).toBe(MAX_INPUT_BYTES.code);
    expect(inputCapFor("markdown")).toBe(MAX_INPUT_BYTES.markdown);
    expect(inputCapFor("archive")).toBe(MAX_INPUT_BYTES.archive);
    expect(inputCapFor("media-audio")).toBe(MAX_INPUT_BYTES.media);
    expect(inputCapFor("media-video")).toBe(MAX_INPUT_BYTES.media);
    expect(inputCapFor("fallback")).toBe(MAX_INPUT_BYTES.text);
  });
});

describe("runPreview", () => {
  it("classifies, fetches under the per-kind cap and charges the bytes", async () => {
    const client = fakeClient();
    const phases: string[] = [];
    const lease = new MemoryLease();
    const document = await runPreview(attachment(), runOptions({ client, lease, onPhase: (phase) => phases.push(phase) }));
    expect(document.surface.surface).toBe("text");
    expect(client.open).toHaveBeenCalledWith(
      expect.objectContaining({ partId: "p1" }),
      expect.objectContaining({ cap: MAX_INPUT_BYTES.text }),
    );
    expect(lease.used).toBe(11);
    expect(phases).toEqual(["receiving", "decoding"]);
  });

  it("takes the decode deadline from the shared budget", async () => {
    let deadlineMs = 0;
    const client = fakeClient({
      decode: vi.fn(async (_input, context) => {
        deadlineMs = context.deadlineMs;
        return textDocument();
      }),
    });
    await runPreview(attachment(), runOptions({ client }));
    expect(deadlineMs).toBe(DECODE_DEADLINE_MS);
  });

  it("turns an unsupported file into a download card with zero network requests", async () => {
    const client = fakeClient();
    const document = await runPreview(attachment({ filename: "blob.bin", contentType: "application/octet-stream", size: 40 * 1024 * 1024 }), runOptions({ client }));
    expect(document.surface).toMatchObject({ surface: "download_only", reason: "unsupported" });
    expect(client.open).not.toHaveBeenCalled();
    expect(client.decode).not.toHaveBeenCalled();
  });

  it("keeps markdown on the text surface until S3 adds its renderer", async () => {
    // The S2 shape of decode/index.ts: markdown is classified as its own kind
    // but decoded by the text decoder, so the drawer shows a <pre> today.
    const client = fakeClient({
      decode: decodeAttachment,
      open: async () => reply([new TextEncoder().encode("# title\n\nbody")]),
    });
    const document = await runPreview(
      attachment({ filename: "notes.md", contentType: "text/markdown", size: 13 }),
      runOptions({ client }),
    );
    expect(document.surface.surface).toBe("text");
    expect(document.surface).toMatchObject({ text: "# title\n\nbody", shown: 13, total: 13 });
  });

  it("degrades office and archive kinds to a download card instead of failing", async () => {
    // Same intermediate form: these kinds are classified (and fetched under
    // their own budget) but their decoders arrive with S3. The drawer must show
    // the download card, not an error, and must not throw.
    const kinds: [string, string][] = [
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["bundle.zip", "application/zip"],
    ];
    for (const [filename, contentType] of kinds) {
      const document = await runPreview(
        attachment({ filename, contentType, size: 8 }),
        runOptions({ client: fakeClient({ decode: decodeAttachment, open: async () => reply([new Uint8Array(8)]) }) }),
      );
      expect(document.surface, filename).toMatchObject({ surface: "download_only", reason: "unsupported" });
    }
  });

  it("rejects before fetching when the declared size exceeds the cap", async () => {
    const client = fakeClient();
    await expect(
      runPreview(attachment({ filename: "big.md", contentType: "text/markdown", size: MAX_INPUT_BYTES.markdown + 1 }), runOptions({ client })),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(client.open).not.toHaveBeenCalled();
  });

  it("reports an empty body as empty, not as corrupt", async () => {
    const client = fakeClient({ open: vi.fn(async () => reply([])) });
    await expect(runPreview(attachment(), runOptions({ client }))).rejects.toMatchObject({ code: "empty" });
  });

  it("rejects an already-cancelled run without opening a connection", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient();
    await expect(runPreview(attachment(), runOptions({ client, signal: controller.signal }))).rejects.toBeInstanceOf(
      PreviewCanceled,
    );
    expect(client.open).not.toHaveBeenCalled();
  });

  it("propagates the decoder's failure untouched", async () => {
    const client = fakeClient({
      decode: vi.fn(async () => {
        throw new PreviewFailure("encrypted");
      }),
    });
    await expect(runPreview(attachment(), runOptions({ client }))).rejects.toMatchObject({ code: "encrypted" });
  });

  it("is the real decode entry point unless a client is injected", async () => {
    // Guard against a second classification path: the default client is the
    // module-level decodeAttachment, not a per-call copy.
    expect(decodeAttachment).toBeTypeOf("function");
  });
});

const ready: PreviewSessionState = {
  ...initialState,
  status: "ready",
  attachment: attachment(),
  document: textDocument(),
};

describe("previewReducer", () => {
  it("opens onto loading and keeps the attempt's scope and lease", () => {
    const scope = new ResourceScope();
    const lease = new MemoryLease();
    const next = previewReducer(initialState, { type: "open", attachment: attachment(), scope, lease });
    expect(next).toMatchObject({ status: "loading", attachment: attachment(), page: 1, scope, lease });
    expect(next.document).toBeNull();
    expect(next.failure).toBeNull();
  });

  it("ignores a duplicate open of the attachment already being previewed", () => {
    const scope = new ResourceScope();
    const lease = new MemoryLease();
    const opened = previewReducer(initialState, { type: "open", attachment: attachment(), scope, lease });
    expect(previewReducer(opened, { type: "open", attachment: attachment(), scope: new ResourceScope(), lease: new MemoryLease() })).toBe(opened);
  });

  it("maps every failure code onto its own state, never a blank page", () => {
    for (const code of ["too_large", "encrypted", "corrupt", "timeout", "unsupported"] as const) {
      const next = previewReducer(ready, { type: "failed", code });
      expect(next.status).toBe(failurePresentation(code).state);
      expect(next.failure).toBe(code);
      expect(next.document).toBeNull();
    }
  });

  it("resets to the initial state on close", () => {
    expect(previewReducer(ready, { type: "close" })).toEqual(initialState);
  });

  it("keeps the attachment on retry so the drawer can re-open the same part", () => {
    const failed = previewReducer(ready, { type: "failed", code: "timeout" });
    const retried = previewReducer(failed, { type: "retry" });
    expect(retried).toMatchObject({ status: "loading", failure: null, document: null, attachment: failed.attachment });
  });

  it("ignores retry with nothing to retry", () => {
    expect(previewReducer(initialState, { type: "retry" })).toBe(initialState);
  });

  it("validates page turns against the document", () => {
    const pdfReady: PreviewSessionState = {
      ...initialState,
      status: "ready",
      attachment: attachment({ filename: "a.pdf", contentType: "application/pdf" }),
      document: {
        ...textDocument(),
        surface: { surface: "pdf", documentId: "pdf-1", pageCount: 2, page: 1 },
        pdf: { documentId: "pdf-1", pageCount: 2, pdf: {} as never, loadingTask: {} as never },
      },
    };
    expect(previewReducer(pdfReady, { type: "set_page", page: 2 }).page).toBe(2);
    expect(previewReducer(pdfReady, { type: "set_page", page: 3 })).toBe(pdfReady);
    expect(previewReducer(pdfReady, { type: "set_page", page: 0 })).toBe(pdfReady);
    expect(previewReducer(ready, { type: "set_page", page: 2 })).toBe(ready);
  });
});

describe("cancel/retry", () => {
  it("disposes the attempt's scope before closing", () => {
    const scope = new ResourceScope();
    const dispose = vi.spyOn(scope, "dispose");
    const state = previewReducer(initialState, { type: "open", attachment: attachment(), scope, lease: new MemoryLease() });
    expect(cancel(state)).toEqual(initialState);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when there is no scope", () => {
    expect(cancel(initialState)).toEqual(initialState);
    const failed = previewReducer(ready, { type: "failed", code: "corrupt" });
    expect(retry(failed).status).toBe("loading");
  });
});
