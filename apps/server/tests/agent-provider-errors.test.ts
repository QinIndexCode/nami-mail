import assert from "node:assert/strict";
import { it, vi } from "vitest";
import {
  boundedErrorDetail,
  providerErrorFromResponse,
  providerRequest,
  ProviderReportedError,
  ProviderTimeoutError,
  safeMessage,
} from "../src/agent/provider-common.js";

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

it("keeps a provider's own rejection message as a bounded suggestion", async () => {
  const error = await providerErrorFromResponse(response(400, JSON.stringify({
    error: { message: "Invalid 'tools[0].function.name': string does not match pattern '^[a-zA-Z0-9_-]+'." },
  })));

  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(error.retryable, false);
  assert.match(String(error.suggestion), /tools\[0\]\.function\.name/);
});

it("classifies auth and rate-limit statuses without dropping the detail", async () => {
  const auth = await providerErrorFromResponse(response(401, JSON.stringify({
    error: { message: "Incorrect API key provided." },
  })));
  assert.equal(auth.code, "PROVIDER_AUTH_FAILED");
  assert.equal(auth.retryable, false);
  assert.match(String(auth.suggestion), /Incorrect API key provided/);

  const limited = await providerErrorFromResponse(response(429, JSON.stringify({
    error: { message: "Rate limit reached for requests." },
  })));
  assert.equal(limited.code, "PROVIDER_RATE_LIMITED");
  assert.match(String(limited.suggestion), /Rate limit reached/);
});

it("ignores plain-text and HTML error pages", async () => {
  const plain = await providerErrorFromResponse(response(502, "upstream exploded"));
  assert.equal(plain.code, "PROVIDER_UNAVAILABLE");
  assert.equal(plain.suggestion, undefined);

  const html = await providerErrorFromResponse(response(502, "<html><body>Bad gateway</body></html>"));
  assert.equal(html.suggestion, undefined);
});

it("bounds a provider message that is larger than the read cap", async () => {
  const error = await providerErrorFromResponse(response(400, JSON.stringify({
    error: { message: "x".repeat(1_000_000) },
  })));

  assert.notEqual(error.suggestion, undefined);
  assert.ok(String(error.suggestion).length <= 501);
});

it("settles a fetch that ignores its abort signal as a timeout", async () => {
  vi.useFakeTimers();
  try {
    // Native fetch rejects when its signal aborts, so this fake is the only
    // way to pin the wrapper's own guarantee: a non-conforming implementation
    // must not leave the request hanging past the timeout.
    const pending = providerRequest(
      new URL("https://api.example.test/v1"),
      "chat/completions",
      { method: "POST", timeoutMs: 1_000 },
      undefined,
      () => new Promise<Response>(() => undefined),
    );
    const settled = assert.rejects(pending, ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  } finally {
    vi.useRealTimers();
  }
});

it("maps a provider-reported SSE error to a diagnosable provider error", () => {
  const mapped = safeMessage(new ProviderReportedError("400 invalid_request_error: tools must be an array"));

  assert.equal(mapped.code, "PROVIDER_ERROR");
  assert.match(String(mapped.suggestion), /tools must be an array/);
  assert.equal(boundedErrorDetail("a\n\nb"), "a b");
  assert.equal(boundedErrorDetail("   "), undefined);
});
