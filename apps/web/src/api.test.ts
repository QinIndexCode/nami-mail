import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api transport errors", () => {
  it("identifies an unavailable local API without treating it as mailbox authentication", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api.accounts()).rejects.toMatchObject({
      name: "ApiError",
      code: "local_service_unavailable",
    });
  });

  it("adds the restricted desktop capability to API requests without changing browser requests", async () => {
    vi.stubGlobal("window", {
      namiDesktop: {
        localApiRequestHeaders: vi.fn().mockResolvedValue({ "x-nami-api-token": "desktop-session-token" }),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.accounts()).resolves.toEqual([]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("x-nami-api-token")).toBe("desktop-session-token");
  });

  it("keeps the browser development request path free of a desktop token", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.accounts()).resolves.toEqual([]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("x-nami-api-token")).toBeNull();
  });

  it("preserves a server error code when an outbound attachment upload fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "连接邮箱服务器超时",
      code: "timeout",
    }), { status: 504, headers: { "content-type": "application/json" } })));
    const file = Object.assign(new Blob(["test"], { type: "text/plain" }), { name: "test.txt" }) as File;

    await expect(api.uploadOutboundAttachment("account-1", file)).rejects.toMatchObject({
      name: "ApiError",
      code: "timeout",
      status: 504,
    });
  });

  it("preserves a server error code when an attachment download fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: "TLS 证书验证未通过",
      code: "tls_certificate_failed",
    }), { status: 422, headers: { "content-type": "application/json" } })));

    await expect(api.downloadAttachment("message-1", "part-1")).rejects.toEqual(
      new ApiError("TLS 证书验证未通过", "tls_certificate_failed", 422),
    );
  });

  it("keeps the confirmed move destination, mapped UID, and pending refresh state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      destination: "Archive",
      uid: 42,
      refreshPending: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.moveMessage("message / 1", "archive")).resolves.toEqual({
      ok: true,
      destination: "Archive",
      uid: 42,
      refreshPending: true,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/messages/message%20%2F%201/move");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ target: "archive" }));
  });

  it("reads the authoritative move reconciliation state by local message ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "message / 1",
      mailbox: "Archive",
      movePending: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.message("message / 1")).resolves.toMatchObject({
      id: "message / 1",
      mailbox: "Archive",
      movePending: false,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/messages/message%20%2F%201");
    expect(init.body).toBeUndefined();
  });

  it("requests a selected message translation with the target locale only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      targetLocale: "en-US",
      translatedText: "Hello",
      detectedLanguage: "zh",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.translateMessage("message / 1", "en-US")).resolves.toMatchObject({
      translatedText: "Hello",
      targetLocale: "en-US",
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/messages/message%20%2F%201/translate");
    expect(init.body).toBe(JSON.stringify({ targetLocale: "en-US" }));
  });

  it("checks translation availability without requesting mail content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.translationStatus()).resolves.toEqual({ enabled: false });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/translation/status");
    expect(init.body).toBeUndefined();
  });

  it("reads and updates translation configuration without adding it to unrelated requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        enabled: true,
        endpoint: "https://translate.example.test/translate",
        timeoutMs: 25_000,
        apiKeyConfigured: true,
        source: "local",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        enabled: true,
        endpoint: "https://translate.example.test/translate",
        timeoutMs: 18_000,
        apiKeyConfigured: true,
        source: "local",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.translationConfiguration()).resolves.toMatchObject({ apiKeyConfigured: true });
    await expect(api.updateTranslationConfiguration({ timeoutMs: 18_000, apiKey: "new-key" }))
      .resolves.toMatchObject({ timeoutMs: 18_000 });

    const [readPath, readInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [writePath, writeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(readPath).toBe("/api/translation/configuration");
    expect(readInit.body).toBeUndefined();
    expect(writePath).toBe("/api/translation/configuration");
    expect(writeInit.method).toBe("PUT");
    expect(writeInit.body).toBe(JSON.stringify({ timeoutMs: 18_000, apiKey: "new-key" }));
  });

  it("removes a translation configuration through its dedicated endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      enabled: false,
      endpoint: "",
      timeoutMs: 25_000,
      apiKeyConfigured: false,
      source: "none",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.removeTranslationConfiguration()).resolves.toMatchObject({ enabled: false, source: "none" });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/translation/configuration");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});
