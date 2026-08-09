import { describe, expect, it, vi } from "vitest";
import { BuiltinTranslationService } from "../src/builtin-translation.js";
import { MAX_TRANSLATION_TEXT_LENGTH, TranslationServiceError } from "../src/translation.js";

function googleResponse(segments: [string, string][], detectedLanguage?: string): Response {
  const data = [segments, null, detectedLanguage ?? null];
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function myMemoryResponse(translatedText: string): Response {
  return new Response(JSON.stringify({ responseData: { translatedText } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response("", { status });
}

function abortingFetch(): typeof fetch {
  return vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
    if (init?.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
}

function inputUrl(input: URL | RequestInfo): string {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

describe("BuiltinTranslationService", () => {
  it("is always available without configuration", () => {
    const service = new BuiltinTranslationService();
    expect(service.isAvailable()).toBe(true);
  });

  it("translates using Google Translate and returns detected language", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      googleResponse([["Hello", "你好"], [" world", "世界"]], "zh"),
    );
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("你好世界", "en-US")).resolves.toEqual({
      translatedText: "Hello world",
      detectedLanguage: "zh",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(inputUrl(url)).toBe("https://translate.googleapis.com/translate_a/single");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    const body = init?.body as string;
    expect(body).toContain("client=gtx");
    expect(body).toContain("sl=auto");
    expect(body).toContain("tl=en");
    expect(body).toContain("dt=t");
    expect(body).toContain("q=");
  });

  it("translates using Google Translate without detected language", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      googleResponse([["Bonjour", "Hello"]]),
    );
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("Hello", "fr-FR")).resolves.toEqual({
      translatedText: "Bonjour",
    });
  });

  it("falls back to MyMemory when Google returns an HTTP error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) return errorResponse(503);
      if (url.includes("mymemory.translated.net")) return myMemoryResponse("Hello");
      return errorResponse(404);
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("你好", "en-US")).resolves.toEqual({
      translatedText: "Hello",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to MyMemory when Google throws a network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) throw new TypeError("fetch failed");
      if (url.includes("mymemory.translated.net")) return myMemoryResponse("Hello");
      return errorResponse(404);
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("你好", "en-US")).resolves.toEqual({
      translatedText: "Hello",
    });
  });

  it("throws the last error when both engines fail", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) return errorResponse(503);
      if (url.includes("mymemory.translated.net")) return errorResponse(429);
      return errorResponse(404);
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("Hello", "zh-CN")).rejects.toMatchObject({
      code: "translation_rate_limited",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("passes the Google-detected source language to MyMemory on fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) {
        // Google detects the language but returns no translation segments.
        return new Response(JSON.stringify([[], null, "zh"]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("mymemory.translated.net")) return myMemoryResponse("Hello");
      return errorResponse(404);
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("你好", "en-US")).resolves.toEqual({
      translatedText: "Hello",
    });

    const myMemoryCall = fetchImpl.mock.calls[1]!;
    const myMemoryUrl = inputUrl(myMemoryCall[0]);
    expect(myMemoryUrl).toContain("langpair=zh%7Cen");
  });

  it("defaults the MyMemory source language to en when Google did not detect one", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) return errorResponse(503);
      if (url.includes("mymemory.translated.net")) return myMemoryResponse("Hello");
      return errorResponse(404);
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await service.translate("Hello", "zh-CN");

    const myMemoryCall = fetchImpl.mock.calls[1]!;
    const myMemoryUrl = inputUrl(myMemoryCall[0]);
    expect(myMemoryUrl).toContain("langpair=en%7Czh");
  });

  it("rejects text exceeding the maximum length", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new BuiltinTranslationService({ fetchImpl });
    const oversized = "a".repeat(MAX_TRANSLATION_TEXT_LENGTH + 1);
    await expect(service.translate(oversized, "zh-CN")).rejects.toMatchObject({
      code: "translation_request_too_large",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects empty text", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new BuiltinTranslationService({ fetchImpl });
    await expect(service.translate("   ", "zh-CN")).rejects.toMatchObject({
      code: "translation_content_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid target locale", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new BuiltinTranslationService({ fetchImpl });
    await expect(service.translate("Hello", "invalid-locale!")).rejects.toMatchObject({
      code: "translation_invalid_target",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when the Google response is not valid JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = inputUrl(input);
      if (url.includes("translate.googleapis.com")) {
        return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return myMemoryResponse("Hello");
    });
    const service = new BuiltinTranslationService({ fetchImpl });

    await expect(service.translate("Hello", "zh-CN")).resolves.toEqual({
      translatedText: "Hello",
    });
  });

  it("aborts when the external signal is already aborted", async () => {
    const fetchImpl = abortingFetch();
    const service = new BuiltinTranslationService({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(service.translate("Hello", "zh-CN", controller.signal)).rejects.toMatchObject({
      code: "translation_service_unavailable",
    });
  });

  it("returns TranslationServiceError instances from all failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(503));
    const service = new BuiltinTranslationService({ fetchImpl });

    try {
      await service.translate("Hello", "zh-CN");
      throw new Error("Expected translate to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationServiceError);
    }
  });
});
