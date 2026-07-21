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
});
