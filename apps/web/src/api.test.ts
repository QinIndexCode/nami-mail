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

  it("keeps renderer API requests free of a desktop token (injected by the main process)", async () => {
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

  it("downloads an EML export with the server-provided UTF-8 filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(["From: a@b.c\r\nSubject: 会议纪要\r\n\r\n内容"]), {
      status: 200,
      headers: {
        "content-type": "message/rfc822",
        "content-disposition": "attachment; filename*=UTF-8''%E4%BC%9A%E8%AE%AE%E7%BA%AA%E8%A6%81.eml",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.downloadMessageEml("11111111-1111-4111-8111-111111111111");

    expect(result.filename).toBe("会议纪要.eml");
    expect(await result.blob.text()).toContain("Subject: 会议纪要");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/messages/11111111-1111-4111-8111-111111111111/eml");
    expect(init.cache).toBe("no-store");
  });

  it("falls back to message.eml when the server omits the filename", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["x"]), {
      status: 200,
      headers: { "content-type": "message/rfc822" },
    })));

    const result = await api.downloadMessageEml("11111111-1111-4111-8111-111111111111");

    expect(result.filename).toBe("message.eml");
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

  it("cancels a pending scheduled send by submission id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      cancelled: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.cancelScheduledSend("submission / 1")).resolves.toEqual({ ok: true, cancelled: true });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/messages/send/submission%20%2F%201/cancel");
    expect(init.method).toBe("POST");
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

describe("agent stream seam validation", () => {
  const request = {
    content: "Summarize my inbox",
    providerId: "provider-1",
    mode: "agent" as const,
    scope: { mode: "all_accounts" as const, accountIds: [], messageIds: [] },
  };

  it("delivers events parsed by the UI stream schema", async () => {
    const events = [
      { type: "status", message: "Preparing context" },
      { type: "text_delta", delta: "Hello" },
      { type: "title", title: "Inbox summary" },
      { type: "completed", reason: "stop" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const received: string[] = [];
    await api.streamAgentMessage("conversation-1", request, (event) => received.push(event.type));
    expect(received).toEqual(["status", "text_delta", "title", "completed"]);
  });

  it("rejects an event that breaks the schema with agent_stream_invalid", async () => {
    const events = [
      { type: "status" },
      { type: "completed", reason: "banana" },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.streamAgentMessage("conversation-1", request, () => {})).rejects.toMatchObject({
      name: "ApiError",
      code: "agent_stream_invalid",
    });
  });

  it("validates along the SSE path and surfaces the same error", async () => {
    const body = [
      "data: " + JSON.stringify({ type: "text_delta", delta: "Hi" }),
      "",
      "data: " + JSON.stringify({ type: "unknown_variant" }),
      "",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.streamAgentMessage("conversation-1", request, () => {})).rejects.toMatchObject({
      name: "ApiError",
      code: "agent_stream_invalid",
    });
  });
});
