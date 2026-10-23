import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRAVATAR_MAX_BYTES,
  fetchGravatar,
  gravatarUrl,
  isAllowedGravatarUrl,
} from "../src/avatars/gravatar.js";
import { setServerLogger } from "../src/logging.js";

/**
 * The proxy refuses before it reads, so most cases here assert two things at
 * once: the status the route will map, and that the bytes were never consumed.
 */

const HASH = "0123456789abcdef0123456789abcdef";

type LogEntry = { meta: Record<string, unknown>; message: string };

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  setServerLogger({
    info: () => undefined,
    warn: (meta, message) => entries.push({ meta: meta as Record<string, unknown>, message }),
    error: () => undefined,
  });
  return entries;
}

function imageResponse(options: { bytes?: Uint8Array; contentType?: string; headers?: Record<string, string> } = {}): Response {
  const bytes = options.bytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": options.contentType ?? "image/jpeg", ...options.headers },
  });
}

/** Any read of the body throws, so a "refuse without reading" branch is provable. */
function untouchableBody(response: Response): Response {
  Object.defineProperty(response, "body", {
    configurable: true,
    get() {
      throw new Error("body must not be read");
    },
  });
  return response;
}

function countingStream(chunkSize: number, chunks: number): { stream: ReadableStream<Uint8Array>; reads: () => number; cancelled: () => boolean } {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads > chunks) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, reads: () => reads, cancelled: () => cancelled };
}

afterEach(() => {
  setServerLogger(undefined);
});

describe("gravatarUrl", () => {
  it("builds the fixed upstream URL from a 32-character lowercase hex digest", () => {
    expect(gravatarUrl(HASH)).toBe(`https://www.gravatar.com/avatar/${HASH}?d=404&s=96`);
  });

  it("returns null for anything that is not exactly that", () => {
    for (const bad of [HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, "g".repeat(32), "../../etc/passwd", ""]) {
      expect(gravatarUrl(bad), bad).toBeNull();
    }
  });
});

describe("isAllowedGravatarUrl", () => {
  it("accepts only the exact https origin it builds itself", () => {
    expect(isAllowedGravatarUrl(gravatarUrl(HASH)!)).toBe(true);
    for (const url of [
      `http://www.gravatar.com/avatar/${HASH}`,
      `https://www.gravatar.com.evil.example/avatar/${HASH}`,
      `https://evil.example/avatar/${HASH}`,
      `https://www.gravatar.com:8443/avatar/${HASH}`,
      "not a url",
    ]) {
      expect(isAllowedGravatarUrl(url), url).toBe(false);
    }
  });

  it("logs one ssrf rejection with the host and no address", () => {
    const logs = captureLogs();
    isAllowedGravatarUrl("https://www.gravatar.com.evil.example/avatar/abc");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("gravatar_ssrf_blocked");
    expect(logs[0]?.meta).toEqual({ host: "www.gravatar.com.evil.example", reason: "origin" });
  });
});

describe("fetchGravatar", () => {
  it("returns the bytes and content type on success", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return imageResponse({ bytes, contentType: "image/png; charset=binary" });
    });
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, bytes, contentType: "image/png; charset=binary" });
    expect(seen!.url).toBe(gravatarUrl(HASH));
    expect(seen!.init?.redirect).toBe("manual");
    expect(seen!.init?.headers).toEqual({ accept: "image/*" });
    expect(seen!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an invalid hash before calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchGravatar("NOT-A-HASH", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "invalid_hash", status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    const logs = captureLogs();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "redirect", status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logs.map((entry) => entry.meta.reason)).toEqual(["redirect"]);
  });

  it("treats 404 as the documented negative answer without logging a refusal", async () => {
    const logs = captureLogs();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "not_found", status: 404 });
    expect(logs).toEqual([]);
  });

  it("refuses a non-image content type without touching the body", async () => {
    const logs = captureLogs();
    const fetchImpl = vi.fn(async () => untouchableBody(imageResponse({ contentType: "text/html" })));
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "content_type", status: 415 });
    expect(logs[0]?.meta).toEqual({ hash: HASH.slice(0, 8), reason: "content_type" });
  });

  it("refuses an SVG dressed as an image", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
    );
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "content_type", status: 415 });
  });

  it("refuses a declared length over the ceiling without touching the body", async () => {
    const fetchImpl = vi.fn(async () =>
      untouchableBody(
        imageResponse({ contentType: "image/png", headers: { "content-length": String(GRAVATAR_MAX_BYTES * 2) } }),
      ),
    );
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "too_large", status: 413 });
  });

  it("stops a stream that crosses the ceiling and cancels it", async () => {
    const logs = captureLogs();
    const body = countingStream(600_000, 4);
    const fetchImpl = vi.fn(async () => new Response(body.stream, { status: 200, headers: { "content-type": "image/png" } }));
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 1_048_576 });
    expect(result).toEqual({ ok: false, rejection: "too_large", status: 413 });
    expect(body.cancelled()).toBe(true);
    expect(logs[0]?.meta.reason).toBe("too_large");
  });

  it("maps a timed-out fetch to 504", async () => {
    const logs = captureLogs();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "timeout", status: 504 });
    expect(logs[0]?.meta.reason).toBe("timeout");
  });

  it("maps a transport failure to 502", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await fetchGravatar(HASH, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: false, rejection: "upstream", status: 502 });
  });

  it("never puts an address in a log line", async () => {
    const logs = captureLogs();
    const fetchImpl = vi.fn(async () => imageResponse({ contentType: "text/html" }));
    await fetchGravatar("fedcba9876543210fedcba9876543210", { fetchImpl: fetchImpl as unknown as typeof fetch });
    isAllowedGravatarUrl("https://evil.example/avatar/fedcba9876543210fedcba9876543210");
    expect(JSON.stringify(logs)).not.toContain("@");
  });
});
