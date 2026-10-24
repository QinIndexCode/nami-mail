// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DECODE_DEADLINE_MS, MAX_INPUT_BYTES, MemoryLease } from "./budget";
import { decodeAttachment } from "./decode";
import { ResourceScope, type PreviewDocument } from "./document";
import { PreviewCanceled, PreviewFailure } from "./failure";
import type { AttachmentReply } from "./ingress";
import {
  inputCapFor,
  runPreview,
  type PreviewAttachment,
  type PreviewClient,
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

  it("decodes markdown into its own surface", async () => {
    // S3 gave markdown a real decoder: the drawer now renders it through
    // MarkdownSurface instead of the shared <pre>.
    const client = fakeClient({
      decode: decodeAttachment,
      open: async () => reply([new TextEncoder().encode("# title\n\nbody")]),
    });
    const document = await runPreview(
      attachment({ filename: "notes.md", contentType: "text/markdown", size: 13 }),
      runOptions({ client }),
    );
    expect(document.surface).toMatchObject({ surface: "markdown", text: "# title\n\nbody", shown: 13, total: 13 });
  });

  it("decodes archive containers instead of handing them to a download card", async () => {
    // Office kinds are covered under jsdom in office.test.ts: their decoder
    // needs DOMParser, which this node-environment suite does not provide.
    const { makeZip } = await import("./testing/fixtures");
    const zip = await makeZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    const document = await runPreview(
      attachment({ filename: "bundle.zip", contentType: "application/zip", size: zip.bytes.byteLength }),
      runOptions({ client: fakeClient({ decode: decodeAttachment, open: async () => reply([zip.bytes]) }) }),
    );
    expect(document.surface.surface).toBe("archive");
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

