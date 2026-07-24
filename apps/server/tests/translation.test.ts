import { describe, expect, it, vi } from "vitest";
import {
  MAX_TRANSLATION_TEXT_LENGTH,
  MAX_TRANSLATION_RESPONSE_BYTES,
  TranslationService,
  TranslationServiceError,
  translationErrorStatus,
  translationLanguageForLocale,
} from "../src/translation.js";

describe("translation service", () => {
  it("sends an explicit LibreTranslate-compatible request without retaining source text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      translatedText: "Hello from Nami Mail",
      detectedLanguage: { language: "zh" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(service.translate("来自 Nami Mail 的问候", "en-US")).resolves.toEqual({
      translatedText: "Hello from Nami Mail",
      detectedLanguage: "zh",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://translate.example.test/translate"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({
          q: "来自 Nami Mail 的问候",
          source: "auto",
          target: "en",
          format: "text",
          api_key: "test-key",
        }),
      }),
    );
  });

  it("keeps external translation opt-in and fails with a stable error code when unavailable", async () => {
    const service = new TranslationService();
    await expect(service.translate("Hello", "zh-CN")).rejects.toMatchObject({ code: "translation_not_configured" });
    expect(translationLanguageForLocale("zh-CN")).toBe("zh");
    expect(translationErrorStatus(new TranslationServiceError("translation_timeout", "Timed out"))).toBe(504);
  });

  it("refuses plaintext transport endpoints outside local loopback and oversized mail bodies", async () => {
    const unsafe = new TranslationService({ endpoint: "http://translate.example.test/translate" });
    await expect(unsafe.translate("Hello", "zh-CN")).rejects.toMatchObject({ code: "translation_not_configured" });

    const lookalike = new TranslationService({ endpoint: "http://127.example.test/translate" });
    await expect(lookalike.translate("Hello", "zh-CN")).rejects.toMatchObject({ code: "translation_not_configured" });

    const service = new TranslationService({ endpoint: "https://translate.example.test/translate" });
    await expect(service.translate("x".repeat(MAX_TRANSLATION_TEXT_LENGTH + 1), "zh-CN"))
      .rejects.toMatchObject({ code: "translation_request_too_large" });
  });

  it("refuses oversized or malformed provider responses before they reach the reader", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_TRANSLATION_RESPONSE_BYTES + 1) },
    }));
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl,
    });

    await expect(service.translate("Hello", "zh-CN"))
      .rejects.toMatchObject({ code: "translation_response_too_large" });

    const streamingService = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
        status: 200,
        headers: { "content-length": String(MAX_TRANSLATION_RESPONSE_BYTES + 1) },
      })),
    });
    await expect(streamingService.translate("Hello", "zh-CN"))
      .rejects.toMatchObject({ code: "translation_response_too_large" });
    expect(cancelled).toBe(true);
  });

  it.each([
    ["ERR_TLS_CERT_ALTNAME_INVALID", "certificate verify failed", "translation_tls_certificate_failed"],
    ["EPROTO", "TLS handshake failure", "translation_tls_handshake_failed"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND", "translation_server_not_found"],
    ["EAI_AGAIN", "temporary DNS failure", "translation_network_unavailable"],
    ["ENETUNREACH", "network is unreachable", "translation_network_unavailable"],
    ["ECONNREFUSED", "connection refused", "translation_connection_refused"],
    ["ECONNRESET", "socket hang up", "translation_connection_failed"],
  ])("classifies nested %s transport failures", async (nodeCode, message, expectedCode) => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(message), { code: nodeCode }),
    });
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(fetchError),
    });

    await expect(service.translate("Hello", "zh-CN")).rejects.toMatchObject({ code: expectedCode });
  });

  it.each([
    [401, "translation_service_authentication_failed"],
    [403, "translation_service_authentication_failed"],
    [429, "translation_rate_limited"],
    [400, "translation_service_rejected"],
    [503, "translation_service_unavailable"],
  ])("classifies translation service HTTP %i without exposing its response", async (status, expectedCode) => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status })),
    });

    await expect(service.translate("Hello", "zh-CN")).rejects.toMatchObject({ code: expectedCode });
    expect(cancelled).toBe(true);
  });

  it("aborts an active translation when the owning runtime begins shutdown", async () => {
    const shutdown = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl,
    });

    const translation = service.translate("Hello", "zh-CN", shutdown.signal);
    shutdown.abort();

    await expect(translation).rejects.toMatchObject({ code: "translation_service_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a slow translation response body when the owning runtime begins shutdown", async () => {
    const shutdown = new AbortController();
    let cancelCalled = false;
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releasePull: (() => void) | undefined;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        markReadStarted?.();
        return pullGate;
      },
      cancel() {
        cancelCalled = true;
        releasePull?.();
      },
    });
    const service = new TranslationService({
      endpoint: "https://translate.example.test/translate",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 })),
    });

    const translation = service.translate("Hello", "zh-CN", shutdown.signal);
    await readStarted;
    shutdown.abort();

    await expect(translation).rejects.toMatchObject({ code: "translation_service_unavailable" });
    expect(cancelCalled).toBe(true);
  });
});
