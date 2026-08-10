import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, MAX_BACKGROUND_UPLOAD_BYTES } from "../src/app.js";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";
import type { OAuthService } from "../src/oauth.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

function readyMailClient() {
  const lock = { release: vi.fn() };
  return {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    messageMove: vi.fn(async () => ({ uidMap: new Map<number, number>() })),
    logout: vi.fn(async () => undefined),
  };
}

async function createValidPng() {
  return sharp({
    create: {
      width: 16,
      height: 9,
      channels: 3,
      background: { r: 45, g: 119, b: 172 },
    },
  }).png().toBuffer();
}

function uploadBackground(app: FastifyInstance, payload: Buffer, contentType = "image/png") {
  return app.inject({
    method: "POST",
    url: "/api/settings/background",
    headers: {
      "content-type": "application/octet-stream",
      "x-nami-file-name": encodeURIComponent("wallpaper.png"),
      "x-nami-file-content-type": encodeURIComponent(contentType),
    },
    payload,
  });
}

describe("local API", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let backgroundDirectory: string;
  let refreshIntervalChanges: number[];

  beforeEach(async () => {
    db = openDatabase(":memory:");
    backgroundDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-settings-"));
    refreshIntervalChanges = [];
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      backgroundDirectory,
      onRefreshIntervalChanged: (refreshIntervalSeconds) => refreshIntervalChanges.push(refreshIntervalSeconds),
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(backgroundDirectory, { recursive: true, force: true });
  });

  it("reports a healthy local service", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, service: "nami-mail" });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("keeps Agent confirmation decisions off the HTTP surface", async () => {
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/agent/confirmations/confirmation-1",
      payload: { decision: "approve" },
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agent/confirmations/confirmation-1",
      payload: { decision: "approved" },
    });

    expect(unavailable.statusCode).toBe(501);
    expect(unavailable.json()).toMatchObject({ ok: false, code: "not_supported" });
    expect(malformed.statusCode).toBe(400);
  });

it("keeps an Agent stream running after the client closes its response", async () => {
    let markComplete!: () => void;
    const streamCompleted = new Promise<void>((resolve) => { markComplete = resolve; });
    const agentService = {
      start: () => undefined,
      close: async () => undefined,
      async *streamMessage(_conversationId: string, _input: unknown, signal?: AbortSignal) {
        // Outlives the client: yield once, wait longer than the client stays
        // connected, then finish. If the route cancelled the run on close,
        // this generator would never reach the final events.
        signal?.addEventListener("abort", () => undefined);
        yield { type: "status", message: "Streaming" };
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        yield { type: "text_delta", delta: "still working" };
        yield { type: "completed", reason: "stop" };
        markComplete();
      },
    };
    const streamingApp = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      backgroundDirectory,
      agentService: agentService as never,
    });
    await streamingApp.listen({ host: "127.0.0.1", port: 0 });
    const address = streamingApp.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");

    try {
      await new Promise<void>((resolve, reject) => {
        const client = httpRequest({
          hostname: "127.0.0.1",
          port: address.port,
          method: "POST",
          path: "/api/agent/conversations/conversation-1/messages",
          headers: { "content-type": "application/json" },
        }, (response) => {
          response.once("data", () => {
            client.destroy();
            resolve();
          });
        });
        client.on("error", () => undefined);
        client.once("error", reject);
        client.end(JSON.stringify({
          content: "Stream this request",
          providerId: "provider-1",
          mode: "agent",
          scope: { mode: "selected_account", accountIds: ["account-1"], messageIds: [] },
          context: {},
        }));
      });
      await Promise.race([
        streamCompleted,
        new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Closing the response stopped the Agent stream.")), 1_000)),
      ]);
    } finally {
      await streamingApp.close();
    }
  });

  it("persists the completed Agent turn when the client closes mid-stream", async () => {
    const serviceMasterKey = Buffer.alloc(32, 7);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run("agent-disconnect", "disconnect@example.test", now);
    applyAgentStoreSchema(db, "2026-08-10T00:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, serviceMasterKey);
    const sourceEvents = new AgentSourceEventOutbox(db, serviceMasterKey, lifecycle);
    const agentService = new AgentService({ db, masterKey: serviceMasterKey, lifecycle, sourceEvents });
    try {
      const provider = agentService.createProvider({
        label: "Local test provider",
        kind: "ollama",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "test-model",
        timeoutMs: 30_000,
        allowCloudMailContent: false,
        makeDefault: true,
      });
      const conversation = agentService.createConversation({
        providerId: provider.id,
        scope: { mode: "selected_account", accountIds: ["agent-disconnect"], messageIds: [] },
      });
      const internals = agentService as unknown as {
        rag: { search: (...arguments_: unknown[]) => Promise<unknown[]> };
        runtime: { streamChat: (input: unknown) => AsyncIterable<unknown> };
      };
      vi.spyOn(internals.rag, "search").mockResolvedValue([]);
      vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
        yield { type: "text_delta", delta: "First half. " };
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        yield { type: "text_delta", delta: "Second half." };
        yield { type: "completed", reason: "stop" };
      });

      const streamingApp = await buildApp({ db, masterKey: serviceMasterKey, backgroundDirectory, agentService });
      await streamingApp.listen({ host: "127.0.0.1", port: 0 });
      const address = streamingApp.server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");

      try {
        await new Promise<void>((resolve, reject) => {
          const client = httpRequest({
            hostname: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: `/api/agent/conversations/${conversation.id}/messages`,
            headers: { "content-type": "application/json" },
          }, (response) => {
            response.once("data", () => {
              // The user moved away from the assistant panel mid-generation.
              client.destroy();
              resolve();
            });
          });
          client.on("error", () => undefined);
          client.once("error", reject);
          client.end(JSON.stringify({
            content: "Keep going",
            providerId: provider.id,
            mode: "agent",
            scope: conversation.scope,
            context: {},
          }));
        });

        const deadline = Date.now() + 10_000;
        let lastMessage: { role: string; content: string } | undefined;
        let roles: string[] = [];
        while (Date.now() < deadline) {
          const response = await streamingApp.inject({ method: "GET", url: `/api/agent/conversations/${conversation.id}` });
          const conversationSnapshot = response.json();
          roles = conversationSnapshot.messages.map((message: { role: string }) => message.role);
          lastMessage = conversationSnapshot.messages[conversationSnapshot.messages.length - 1];
          if (roles[roles.length - 1] === "assistant") break;
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
        }

        expect(roles).toEqual(["user", "assistant"]);
        expect(lastMessage).toMatchObject({ role: "assistant", content: "First half. Second half." });
      } finally {
        await streamingApp.close();
      }
    } finally {
      agentService.close();
      vi.restoreAllMocks();
    }
  });

  it("requires a desktop capability token for local API routes while preserving health and OAuth callbacks", async () => {
    const protectedApp = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      backgroundDirectory,
    }, { localApiAccessToken: "desktop-session-token" });
    try {
      const health = await protectedApp.inject({ method: "GET", url: "/api/health" });
      const unauthorized = await protectedApp.inject({ method: "GET", url: "/api/accounts" });
      const wrongToken = await protectedApp.inject({
        method: "GET",
        url: "/api/accounts",
        headers: { "x-nami-api-token": "wrong-token" },
      });
      const authorized = await protectedApp.inject({
        method: "GET",
        url: "/api/accounts",
        headers: { "x-nami-api-token": "desktop-session-token" },
      });
      const oauthCallback = await protectedApp.inject({
        method: "GET",
        url: "/api/oauth/google/callback?state=untrusted",
      });

      expect(health.statusCode).toBe(200);
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toMatchObject({ ok: false, code: "local_api_unauthorized" });
      expect(unauthorized.body).not.toContain("desktop-session-token");
      expect(wrongToken.statusCode).toBe(401);
      expect(authorized.statusCode).toBe(200);
      expect(oauthCallback.statusCode).not.toBe(401);
    } finally {
      await protectedApp.close();
    }
  });

  it("starts with no accounts and never exposes credentials", async () => {
    const response = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(response.body).not.toContain("password");
  });

  it("returns complete provider onboarding metadata without adding form fields", async () => {
    const response = await app.inject({ method: "GET", url: "/api/providers" });
    const providers = response.json() as Array<Record<string, unknown>>;
    const gmail = providers.find((provider) => provider.id === "gmail");

    expect(response.statusCode).toBe(200);
    expect(gmail).toMatchObject({
      family: "google",
      priority: "P0",
      authMethods: ["oauth2", "app-password"],
      recommendedAuthMethod: "oauth2",
      credentialName: "16 位应用专用密码",
      usernameMode: "email",
      oauthProvider: "google",
      oauthAvailable: false,
      capabilities: { imap: true, smtp: true, apis: ["gmail-api"] },
      imap: { host: "imap.gmail.com", port: 993, transport: "tls" },
      smtp: { host: "smtp.gmail.com", port: 465, transport: "tls" },
    });
    expect(gmail?.setupSteps).toHaveLength(3);
    expect(gmail?.helpUrl).toMatch(/^https:\/\//);
  });

  it("rejects malformed account input before any network connection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { email: "not-an-email", password: "secret" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });
  });

  it("discovers Microsoft OAuth capability without treating a password as a login path", async () => {
    const discovery = await app.inject({
      method: "POST",
      url: "/api/accounts/discover",
      payload: { email: "person@outlook.com" },
    });
    const passwordTest = await app.inject({
      method: "POST",
      url: "/api/accounts/test",
      payload: { email: "person@outlook.com", password: "not-a-real-password" },
    });
    const addAccount = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { email: "person@outlook.com", password: "not-a-real-password" },
    });
    const discoveryBody = discovery.json() as Record<string, unknown>;

    expect(discovery.statusCode).toBe(200);
    expect(discoveryBody).toMatchObject({
      ok: true,
      oauthProvider: "microsoft",
      provider: { family: "microsoft", recommendedAuthMethod: "oauth2" },
    });
    expect(typeof discoveryBody.oauthAvailable).toBe("boolean");
    expect(passwordTest.statusCode).toBe(422);
    expect(passwordTest.json()).toMatchObject({ ok: false, code: "oauth_required" });
    expect(addAccount.statusCode).toBe(422);
    expect(addAccount.json()).toMatchObject({ ok: false, code: "oauth_required" });
  });

  it("treats a Microsoft 365 tenant default domain as an OAuth-only mailbox", async () => {
    const email = "member@contoso.onmicrosoft.com";
    const discovery = await app.inject({
      method: "POST",
      url: "/api/accounts/discover",
      payload: { email },
    });
    const passwordTest = await app.inject({
      method: "POST",
      url: "/api/accounts/test",
      payload: { email, password: "not-a-real-password" },
    });

    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      ok: true,
      oauthProvider: "microsoft",
      provider: {
        name: "Microsoft 365",
        family: "microsoft",
        source: "preset",
        confidence: "high",
        smtp: { host: "smtp.office365.com", port: 587, transport: "starttls" },
      },
    });
    expect(passwordTest.statusCode).toBe(422);
    expect(passwordTest.json()).toMatchObject({ ok: false, code: "oauth_required" });
  });

  it("keeps OAuth start requests bodyless and exposes safe unavailable states", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/oauth/google/start",
      payload: { email: "untrusted@example.com" },
    });
    const unavailable = await app.inject({
      method: "POST",
      url: "/api/oauth/google/start",
      payload: {},
    });
    const invalidAttempt = await app.inject({ method: "GET", url: "/api/oauth/attempts/not-a-uuid" });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ ok: false, code: "invalid_request" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ ok: false, code: "oauth_not_configured" });
    expect(invalidAttempt.statusCode).toBe(400);
    expect(invalidAttempt.json()).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("does not issue a Microsoft authorization URL when its IPv6 callback bridge is unavailable", async () => {
    let startCalled = false;
    const oauthService = {
      isConfigured: () => true,
      start: async () => {
        startCalled = true;
        return { attemptId: "attempt-id", authorizationUrl: "https://login.microsoftonline.com/example", expiresAt: new Date().toISOString() };
      },
    } as unknown as OAuthService;
    const unavailableApp = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      backgroundDirectory,
      oauthService,
      microsoftOAuthCallbackUnavailable: "Microsoft 安全登录暂不可用：无法启动本机 IPv6 授权回调。",
    });

    try {
      const response = await unavailableApp.inject({ method: "POST", url: "/api/oauth/microsoft/start", payload: {} });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, code: "oauth_callback_unavailable" });
      expect(startCalled).toBe(false);
    } finally {
      await unavailableApp.close();
    }
  });

  it("rejects manual plaintext transport before any mailbox connection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/manual",
      payload: {
        email: "person@example.com",
        password: "secret",
        imap: { host: "imap.example.com", port: 143, transport: "plain" },
        smtp: { host: "smtp.example.com", port: 25, transport: "plain" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "invalid_request" });
  });

  it("returns JSON for unknown API routes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, message: "接口不存在。" });
  });

  it("returns complete default settings without exposing local storage details", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings" });
    const settings = response.json();

    expect(response.statusCode).toBe(200);
    expect(settings).toMatchObject({
      theme: "system",
      locale: "zh-CN",
      backgroundPreset: "coast",
      backgroundIntensity: 68,
      notificationsEnabled: true,
      notifyWhenFocused: false,
      notificationSound: "soft",
      refreshIntervalSeconds: 60,
      closeBehavior: "ask",
      customBackgroundUrl: null,
    });
    expect(settings).not.toHaveProperty("customBackgroundFilename");
    expect(response.body).not.toContain(backgroundDirectory);
    expect(Number.isNaN(Date.parse(settings.updatedAt))).toBe(false);
  });

  it("persists a valid settings patch", async () => {
    const patch = {
      theme: "dark",
      locale: "en-us",
      backgroundPreset: "night",
      backgroundIntensity: 72,
      notificationsEnabled: false,
      notifyWhenFocused: true,
      notificationSound: "bright",
      refreshIntervalSeconds: 180,
      closeBehavior: "tray",
    } as const;
    const update = await app.inject({ method: "PATCH", url: "/api/settings", payload: patch });
    const persisted = await app.inject({ method: "GET", url: "/api/settings" });
    const expected = { ...patch, locale: "en-US" };

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject(expected);
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toMatchObject(expected);
    expect(refreshIntervalChanges).toEqual([180]);
  });

  it("notifies the embedded runtime only after a successful refresh interval update", async () => {
    const themeOnly = await app.inject({ method: "PATCH", url: "/api/settings", payload: { theme: "dark" } });
    const invalid = await app.inject({ method: "PATCH", url: "/api/settings", payload: { refreshIntervalSeconds: 45 } });
    const interval = await app.inject({ method: "PATCH", url: "/api/settings", payload: { refreshIntervalSeconds: 30 } });

    expect(themeOnly.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
    expect(interval.statusCode).toBe(200);
    expect(refreshIntervalChanges).toEqual([30]);
  });

  it("rejects invalid settings enums, ranges, and unconfigured custom backgrounds", async () => {
    const invalidPatches = [
      { theme: "sepia" },
      { locale: "not a locale" },
      { locale: "fr-FR" },
      { backgroundPreset: "aurora" },
      { backgroundIntensity: -1 },
      { backgroundIntensity: 81 },
      { notificationSound: "chime" },
      { refreshIntervalSeconds: 45 },
      { closeBehavior: "minimize" },
      { unknownSetting: true },
      { backgroundPreset: "custom" },
    ];

    for (const payload of invalidPatches) {
      const response = await app.inject({ method: "PATCH", url: "/api/settings", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false });
    }

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json()).toMatchObject({
      theme: "system",
      backgroundPreset: "coast",
      backgroundIntensity: 68,
      notificationSound: "soft",
      refreshIntervalSeconds: 60,
      closeBehavior: "ask",
    });
  });

  it("uses the persisted interface locale for OAuth callback pages without rendering callback values", async () => {
    const localeUpdate = await app.inject({ method: "PATCH", url: "/api/settings", payload: { locale: "en-US" } });
    const failedCallback = await app.inject({
      method: "GET",
      url: "/api/oauth/unsupported/callback?code=authorization-code-secret&state=oauth-state-secret",
    });
    const oauthService = {
      finish: async () => ({ status: "success" }),
    } as unknown as OAuthService;
    const successfulCallbackApp = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 7),
      backgroundDirectory,
      oauthService,
      oauthCallbackOrigin: "http://127.0.0.1:43125",
    });

    try {
      const successfulCallback = await successfulCallbackApp.inject({
        method: "GET",
        url: "/api/oauth/google/callback?code=authorization-code-secret&state=oauth-state-secret",
      });

      expect(localeUpdate.statusCode).toBe(200);
      expect(failedCallback.statusCode).toBe(404);
      expect(failedCallback.headers["content-type"]).toContain("text/html");
      expect(failedCallback.body).toContain('lang="en-US"');
      expect(failedCallback.body).toContain("Nami Mail authorization not completed");
      expect(successfulCallback.statusCode).toBe(200);
      expect(successfulCallback.body).toContain('lang="en-US"');
      expect(successfulCallback.body).toContain("Nami Mail authorization complete");
      for (const response of [failedCallback, successfulCallback]) {
        expect(response.body).not.toContain("authorization-code-secret");
        expect(response.body).not.toContain("oauth-state-secret");
      }
    } finally {
      await successfulCallbackApp.close();
    }
  });

  it("stores a binary PNG as WebP behind a fixed API route without exposing the file path", async () => {
    const validPng = await createValidPng();
    const upload = await uploadBackground(app, validPng);
    const settings = upload.json();

    expect(upload.statusCode).toBe(201);
    expect(settings).toMatchObject({ backgroundPreset: "custom" });
    expect(settings.customBackgroundUrl).toMatch(/^\/api\/settings\/background-image\?v=.+/);
    expect(JSON.stringify(settings)).not.toContain(backgroundDirectory);
    expect(JSON.stringify(settings)).not.toContain("custom-background-");
    expect(fs.readdirSync(backgroundDirectory)).toEqual([expect.stringMatching(/^custom-background-[a-f0-9-]+\.webp$/)]);

    const image = await app.inject({ method: "GET", url: settings.customBackgroundUrl });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/webp");
    expect(image.headers["cache-control"]).toBe("no-store");
    const metadata = await sharp(image.rawPayload).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 16, height: 9 });

    const persisted = await app.inject({ method: "GET", url: "/api/settings" });
    expect(persisted.json()).toMatchObject({
      backgroundPreset: "custom",
      customBackgroundUrl: settings.customBackgroundUrl,
    });
    expect(persisted.body).not.toContain(backgroundDirectory);
  });

  it("resizes large background images while preserving their aspect ratio", async () => {
    const source = await sharp({
      create: {
        width: 5000,
        height: 1000,
        channels: 3,
        background: { r: 45, g: 119, b: 172 },
      },
    }).png().toBuffer();

    const upload = await uploadBackground(app, source);
    const settings = upload.json();
    const image = await app.inject({ method: "GET", url: settings.customBackgroundUrl });
    const metadata = await sharp(image.rawPayload).metadata();

    expect(upload.statusCode).toBe(201);
    expect(image.headers["content-type"]).toContain("image/webp");
    expect(metadata).toMatchObject({ format: "webp", width: 3840, height: 768 });
  });

  it("accepts a wallpaper larger than the legacy 20 MB limit and normalizes it", async () => {
    const source = await sharp({
      create: {
        width: 3200,
        height: 2400,
        channels: 3,
        background: { r: 45, g: 119, b: 172 },
      },
    }).png({ compressionLevel: 0 }).toBuffer();

    expect(source.byteLength).toBeGreaterThan(20 * 1024 * 1024);
    expect(source.byteLength).toBeLessThan(MAX_BACKGROUND_UPLOAD_BYTES);

    const upload = await uploadBackground(app, source);
    const settings = upload.json();
    const image = await app.inject({ method: "GET", url: settings.customBackgroundUrl });
    const metadata = await sharp(image.rawPayload).metadata();

    expect(upload.statusCode).toBe(201);
    expect(image.headers["content-type"]).toContain("image/webp");
    expect(metadata).toMatchObject({ format: "webp", width: 3200, height: 2400 });
  });

  it("rejects invalid, mismatched, and oversized binary background uploads without replacing a saved background", async () => {
    const validPng = await createValidPng();
    const initialUpload = await uploadBackground(app, validPng);
    const settingsBefore = initialUpload.json();
    const filesBefore = fs.readdirSync(backgroundDirectory);
    const fake = await uploadBackground(app, Buffer.from("not an image"));
    const mismatchedType = await uploadBackground(app, validPng, "image/jpeg");
    const oversized = await uploadBackground(app, Buffer.alloc(MAX_BACKGROUND_UPLOAD_BYTES + 1));

    expect(initialUpload.statusCode).toBe(201);
    expect(fake.statusCode).toBe(400);
    expect(fake.json()).toMatchObject({ ok: false });
    expect(mismatchedType.statusCode).toBe(400);
    expect(mismatchedType.json()).toMatchObject({ ok: false });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({ ok: false, message: "背景图片不能超过 50 MB。" });
    expect(fs.readdirSync(backgroundDirectory)).toEqual(filesBefore);

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.json()).toEqual(settingsBefore);
  });

  it("validates message move requests before attempting an IMAP connection", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/messages/missing-message/move",
      payload: { target: "sent" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/messages/missing-message/move",
      payload: { target: "archive" },
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ ok: false });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ ok: false, message: "Message not found." });
  });

  it("strictly validates message flag updates before reaching IMAP and accepts the flagged path", async () => {
    const malformedPayloads = [
      {},
      { flagged: "true" },
      { seen: true, unexpected: false },
    ];
    for (const payload of malformedPayloads) {
      const response = await app.inject({ method: "PATCH", url: "/api/messages/missing-message", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false });
    }

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/messages/missing-message",
      payload: { flagged: true },
    });

    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ ok: false, message: "Message not found." });
  });

  it("validates batch message flag updates before touching any message", async () => {
    const malformedPayloads = [
      {},
      { ids: [] },
      { ids: ["a", "a"], patch: { seen: true } },
      { ids: ["a"], patch: {} },
      { ids: ["a"], patch: { seen: true, unexpected: false } },
    ];
    for (const payload of malformedPayloads) {
      const response = await app.inject({ method: "PATCH", url: "/api/messages/batch/flags", payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ ok: false });
    }
  });

  it("reports per-message outcomes for batch flag updates", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/messages/batch/flags",
      payload: { ids: ["missing-message", "also-missing"], patch: { seen: true } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, updated: 0, failed: 2, changedIds: [] });
  });

  it("validates batch message moves and reports per-message outcomes", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: ["a"], target: "sent" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ ok: false });

    const empty = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: [], target: "archive" },
    });
    expect(empty.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/batch/move",
      payload: { ids: ["missing-message", "also-missing"], target: "trash" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, updated: 0, failed: 2 });
  });

  function seedJobAccount(accountId: string, archiveFolder = false) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, `${accountId}@example.com`, "custom", "Job provider", "encrypted", "127.0.0.1", 1, 1, "127.0.0.1", 1, 1, "email", "connected", now);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(accountId, "INBOX", "INBOX", "\\Inbox", 0, 0);
    if (archiveFolder) {
      db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
        .run(accountId, "Archive", "Archive", "\\Archive", 0, 0);
    }
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return { now, insertMessage };
  }

  async function waitForJob(jobId: string, tries = 120) {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/batch-jobs/${jobId}` });
      expect(response.statusCode).toBe(200);
      const job = response.json().job;
      if (job.status !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`batch job ${jobId} did not finish`);
  }

  it("resolves a predicate flag job server-side with real outcome counts", async () => {
    imapClientForAccount.mockReturnValue(readyMailClient());
    const { now, insertMessage } = seedJobAccount("job-flags");
    insertMessage.run("job-inbox-1", "job-flags", "INBOX", 11, "Unread one", "Demo", "demo@example.com", "[]", now, "u1", "u1", "", "[]", 0, 10, now);
    insertMessage.run("job-inbox-2", "job-flags", "INBOX", 12, "Unread two", "Demo", "demo@example.com", "[]", now, "u2", "u2", "", "[]", 0, 10, now);
    insertMessage.run("job-read", "job-flags", "INBOX", 13, "Already read", "Demo", "demo@example.com", "[]", now, "r", "r", "", '["\\\\Seen"]', 0, 10, now);
    indexMessageFts(db, "job-inbox-1", { subject: "Unread one", fromName: "Demo", fromAddress: "demo@example.com", textBody: "u1" });
    indexMessageFts(db, "job-inbox-2", { subject: "Unread two", fromName: "Demo", fromAddress: "demo@example.com", textBody: "u2" });

    const created = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: { kind: "flags", patch: { seen: true }, query: { accountId: "job-flags", unread: true, q: "Unread" } },
    });
    expect(created.statusCode).toBe(200);
    const { jobId } = created.json();

    const job = await waitForJob(jobId);
    // The predicate is resolved server-side to exactly the two unread
    // messages, the remote STORE succeeds, and both are persisted + reported.
    expect(job).toEqual({
      id: jobId,
      kind: "flags",
      status: "completed",
      total: 2,
      done: 2,
      updated: 2,
      failed: 0,
      createdAt: expect.any(Number),
      changedIds: ["job-inbox-1", "job-inbox-2"],
      undoWindowMs: expect.any(Number),
    });
    const inboxFlagged = (db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("job-inbox-1") as { flags_json: string }).flags_json;
    expect(JSON.parse(inboxFlagged)).toContain("\\Seen");
    const untouched = (db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("job-read") as { flags_json: string }).flags_json;
    expect(JSON.parse(untouched)).toEqual(["\\Seen"]);
  });

  it("counts every message as failed when the provider is unreachable", async () => {
    imapClientForAccount.mockReturnValue(undefined as never);
    const { now, insertMessage } = seedJobAccount("job-dead");
    insertMessage.run("job-dead-1", "job-dead", "INBOX", 21, "Stuck", "Demo", "demo@example.com", "[]", now, "s", "s", "", "[]", 0, 10, now);
    insertMessage.run("job-dead-2", "job-dead", "INBOX", 22, "Stuck too", "Demo", "demo@example.com", "[]", now, "s2", "s2", "", "[]", 0, 10, now);

    const created = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: { kind: "flags", patch: { seen: true }, query: { accountId: "job-dead" } },
    });
    const { jobId } = created.json();

    const job = await waitForJob(jobId);
    // Nothing reached the server, so nothing may be persisted or counted as
    // "updated" — every message must surface as failed instead.
    expect(job).toMatchObject({ status: "completed", total: 2, done: 2, updated: 0, failed: 2 });
    const stale = (db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("job-dead-1") as { flags_json: string }).flags_json;
    expect(JSON.parse(stale)).toEqual([]);
  });

  it("rejects malformed job payloads and unknown job ids", async () => {
    for (const payload of [
      { kind: "flags", patch: { seen: true }, query: { accountId: "x", unknown: true } },
      { kind: "move", target: "sent", query: {} },
      { kind: "flags", patch: {}, query: {} },
      { kind: "nope", query: {} },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/batch-jobs", payload });
      expect(response.statusCode).toBe(400);
    }
    const missing = await app.inject({ method: "GET", url: "/api/batch-jobs/does-not-exist" });
    expect(missing.statusCode).toBe(404);
  });

  it("supports exactly one undo per job and refuses double undo", async () => {
    imapClientForAccount.mockReturnValue(readyMailClient());
    const { now, insertMessage } = seedJobAccount("job-undo");
    insertMessage.run("job-undo-1", "job-undo", "INBOX", 31, "Unread", "Demo", "demo@example.com", "[]", now, "u", "u", "", "[]", 0, 10, now);

    const created = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: { kind: "flags", patch: { seen: true }, query: { accountId: "job-undo" } },
    });
    const { jobId } = created.json();
    await waitForJob(jobId);

    const firstUndo = await app.inject({ method: "POST", url: `/api/batch-jobs/${jobId}/undo`, payload: {} });
    expect(firstUndo.statusCode).toBe(200);
    expect(firstUndo.json()).toMatchObject({ ok: true });
    const undoJobId = firstUndo.json().jobId;
    await waitForJob(undoJobId);
    const reverted = (db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("job-undo-1") as { flags_json: string }).flags_json;
    expect(JSON.parse(reverted)).toEqual([]);

    const secondUndo = await app.inject({ method: "POST", url: `/api/batch-jobs/${jobId}/undo`, payload: {} });
    expect(secondUndo.statusCode).toBe(409);
    expect(secondUndo.json()).toMatchObject({ ok: false, reason: "already_undone" });
  });

  it("moves every message matching a view predicate behind one job", async () => {
    const mailClient = readyMailClient();
    mailClient.messageMove.mockImplementation(async () => ({ uidMap: new Map([[41, 101]]) }));
    imapClientForAccount.mockReturnValue(mailClient);
    const { now, insertMessage } = seedJobAccount("job-move", true);
    insertMessage.run("job-move-1", "job-move", "INBOX", 41, "Move me", "Demo", "demo@example.com", "[]", now, "m", "m", "", "[]", 0, 10, now);

    const created = await app.inject({
      method: "POST",
      url: "/api/batch-jobs",
      payload: { kind: "move", target: "archive", query: { accountId: "job-move", unread: true } },
    });
    expect(created.statusCode).toBe(200);
    const { jobId } = created.json();

    const job = await waitForJob(jobId);
    // The predicate is resolved server-side and the UIDPLUS-confirmed move is
    // persisted locally and counted as updated.
    expect(job).toMatchObject({ status: "completed", total: 1, done: 1, updated: 1, failed: 0 });
    expect(job.changedIds).toEqual([]);
    const moved = db.prepare("SELECT mailbox, uid FROM messages WHERE id = ?").get("job-move-1") as { mailbox: string; uid: number };
    expect(moved).toEqual({ mailbox: "Archive", uid: 101 });
  });

  it("updates and exposes an account signature", async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-signature", "signature@example.com", "custom", "Signature provider", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/accounts/account-signature/signature",
      payload: { signature: "——\n测试签名" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ ok: true });

    const accounts = await app.inject({ method: "GET", url: "/api/accounts" });
    const target = accounts.json().find((account: { id: string }) => account.id === "account-signature");
    expect(target).toMatchObject({ email: "signature@example.com", signature: "——\n测试签名" });
  });

  it("rejects oversized or malformed account signature updates and missing accounts", async () => {
    const tooLong = await app.inject({
      method: "PATCH",
      url: "/api/accounts/account-signature/signature",
      payload: { signature: "x".repeat(2001) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ ok: false });

    const extraField = await app.inject({
      method: "PATCH",
      url: "/api/accounts/account-signature/signature",
      payload: { signature: "ok", unexpected: true },
    });
    expect(extraField.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/accounts/does-not-exist/signature",
      payload: { signature: "ok" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("keeps the unified inbox scoped to inbox folders while exposing explicit folders", async () => {
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 2, 1);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "Sent", "Sent", "\\Sent", 1, 0);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run("message-inbox", "account-1", "INBOX", 1, "Inbox message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "inbox", "inbox", "", "[]", 0, 10, new Date().toISOString());
    insertMessage.run("message-seen-inbox", "account-1", "INBOX", 2, "Seen inbox message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "seen inbox", "seen inbox", "", '["\\\\Seen"]', 0, 10, new Date().toISOString());
    insertMessage.run("message-sent", "account-1", "Sent", 1, "Sent message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "sent", "sent", "", '["\\\\Seen"]', 0, 10, new Date().toISOString());
    insertMessage.run("message-starred-sent", "account-1", "Sent", 2, "Starred sent message", "Demo", "demo@example.com", "[]", new Date().toISOString(), "starred", "starred", "", '["\\\\Seen", "\\\\Flagged"]', 0, 10, new Date().toISOString());
    db.prepare("UPDATE messages SET cc_json = ?, message_id = ?, in_reply_to = ?, references_json = ? WHERE id = ?").run(
      JSON.stringify([{ name: "Copy", address: "copy@example.com" }]),
      "<message@example.com>",
      "<parent@example.com>",
      JSON.stringify(["<root@example.com>", "<parent@example.com>"]),
      "message-inbox",
    );
    // These rows are written after buildApp (whose one-time FTS migration
    // already ran), so mirror the sync write path into the search index.
    const ftsRows: Array<[string, string, string, string, string]> = [
      ["message-inbox", "Inbox message", "Demo", "demo@example.com", "inbox"],
      ["message-seen-inbox", "Seen inbox message", "Demo", "demo@example.com", "seen inbox"],
      ["message-sent", "Sent message", "Demo", "demo@example.com", "sent"],
      ["message-starred-sent", "Starred sent message", "Demo", "demo@example.com", "starred"],
    ];
    for (const [id, subject, fromName, fromAddress, textBody] of ftsRows) {
      indexMessageFts(db, id, { subject, fromName, fromAddress, textBody });
    }

    const inbox = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1" });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().items).toHaveLength(2);
    expect(inbox.json().items.every((message: { mailbox: string }) => message.mailbox === "INBOX")).toBe(true);
    expect(inbox.json().items.find((message: { id: string }) => message.id === "message-inbox")).toMatchObject({
      cc: [{ name: "Copy", address: "copy@example.com" }],
      messageId: "<message@example.com>",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
    });

    const unread = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&unread=1" });
    expect(unread.statusCode).toBe(200);
    expect(unread.json()).toMatchObject({ total: 1 });
    expect(unread.json().items[0]).toMatchObject({ id: "message-inbox", seen: false });

    const sent = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&folder=Sent" });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().items).toHaveLength(2);
    expect(sent.json().items.every((message: { mailbox: string }) => message.mailbox === "Sent")).toBe(true);

    const starred = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&starred=1" });
    expect(starred.statusCode).toBe(200);
    expect(starred.json()).toMatchObject({ total: 1 });
    expect(starred.json().items[0]).toMatchObject({ id: "message-starred-sent", flagged: true, mailbox: "Sent" });

    const search = await app.inject({ method: "GET", url: "/api/messages?accountId=account-1&q=Inbox" });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({ total: 2, page: 1 });

    const stats = await app.inject({ method: "GET", url: "/api/stats" });
    expect(stats.json()).toMatchObject({ accounts: 1, messages: 2, unread: 1 });
  });

  it("lists direct Archive mail and only confirmed Gmail All Mail archives", async () => {
    const now = new Date().toISOString();
    const insertAccount = db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAccount.run("account-archive", "archive@example.com", "custom", "Archive provider", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    insertAccount.run("account-gmail", "gmail@example.com", "gmail", "Gmail", "encrypted", "imap.gmail.com", 993, 1, "smtp.gmail.com", 465, 1, "email", "connected", now);
    const insertFolder = db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)");
    insertFolder.run("account-archive", "Archive", "Archive", "\\Archive", 1, 0);
    insertFolder.run("account-archive", "All Mail", "All Mail", "\\All", 1, 0);
    insertFolder.run("account-gmail", "INBOX", "Inbox", "\\Inbox", 1, 0);
    insertFolder.run("account-gmail", "[Gmail]/All Mail", "All Mail", "\\All", 3, 0);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, all_mail_archived, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run("direct-archive", "account-archive", "Archive", 1, 0, "Stored in Archive", "Archive", "archive@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("archive-account-all", "account-archive", "All Mail", 2, 1, "All Mail duplicate", "Archive", "archive@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("gmail-archived", "account-gmail", "[Gmail]/All Mail", 10, 1, "Archived Gmail mail", "Gmail", "gmail@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("gmail-all-inbox", "account-gmail", "[Gmail]/All Mail", 11, 0, "Inbox Gmail mail", "Gmail", "gmail@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("gmail-all-unknown", "account-gmail", "[Gmail]/All Mail", 12, null, "Unknown Gmail mail", "Gmail", "gmail@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("gmail-inbox", "account-gmail", "INBOX", 13, null, "Current inbox mail", "Gmail", "gmail@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);

    const archived = await app.inject({ method: "GET", url: "/api/messages?archived=1" });

    expect(archived.statusCode).toBe(200);
    expect(archived.json().items.map((message: { id: string }) => message.id).sort())
      .toEqual(["direct-archive", "gmail-archived"]);
    expect(archived.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "direct-archive", archived: false }),
      expect.objectContaining({ id: "gmail-archived", archived: true }),
    ]));

    const allMail = await app.inject({
      method: "GET",
      url: "/api/messages?accountId=account-gmail&folder=%5BGmail%5D%2FAll%20Mail",
    });
    expect(allMail.statusCode).toBe(200);
    expect(allMail.json().items
      .map((message: { id: string; archived: boolean }) => ({ id: message.id, archived: message.archived }))
      .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)))
      .toEqual([
        { id: "gmail-all-inbox", archived: false },
        { id: "gmail-all-unknown", archived: false },
        { id: "gmail-archived", archived: true },
      ]);
  });

  it("lists a pending move in its effective destination without leaving it in the inbox", async () => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("pending-account", "pending@example.com", "custom", "Pending", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    const insertFolder = db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)");
    insertFolder.run("pending-account", "INBOX", "Inbox", "\\Inbox", 3, 0);
    insertFolder.run("pending-account", "Archive", "Archive", "\\Archive", 1, 0);
    insertFolder.run("pending-account", "Trash", "Trash", "\\Trash", 1, 0);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run("pending-archive", "pending-account", "INBOX", -1, "Archive", "Archive after confirmation", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("pending-trash", "pending-account", "INBOX", -2, "Trash", "Trash after confirmation", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    insertMessage.run("remaining-inbox", "pending-account", "INBOX", 3, null, "Still in inbox", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now);
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, pending_move_special_use,
        subject, from_name, from_address, to_json, sent_at, snippet, text_body, html_body,
        flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pending-unlisted-archive", "pending-account", "INBOX", -4, "Archive/2026", "\\Archive",
      "Archive while folder list refreshes", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, pending_move_state, pending_move_special_use,
        subject, from_name, from_address, to_json, sent_at, snippet, text_body, html_body,
        flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "pending-intent", "pending-account", "INBOX", 2, "Archive", "intent", "\\Archive",
      "Archive request still being confirmed", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, pending_move_destination, pending_move_state, pending_move_special_use,
        subject, from_name, from_address, to_json, sent_at, snippet, text_body, html_body,
        flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "unverified-archive", "pending-account", "INBOX", -5, "Archive", "confirmed", "\\Archive",
      "Archive retained without a stable remote identifier", "Demo", "demo@example.com", "[]", now, "", "", "", "[\"\\\\Seen\"]", 0, 0, now,
    );

    const inbox = await app.inject({ method: "GET", url: "/api/messages?accountId=pending-account" });
    const sourceFolder = await app.inject({ method: "GET", url: "/api/messages?accountId=pending-account&folder=INBOX" });
    const archive = await app.inject({ method: "GET", url: "/api/messages?accountId=pending-account&folder=Archive" });
    const trash = await app.inject({ method: "GET", url: "/api/messages?accountId=pending-account&folder=Trash" });
    const archived = await app.inject({ method: "GET", url: "/api/messages?accountId=pending-account&archived=1" });
    const detail = await app.inject({ method: "GET", url: "/api/messages/pending-archive" });
    const intentDetail = await app.inject({ method: "GET", url: "/api/messages/pending-intent" });

    expect(inbox.json().items.map((message: { id: string }) => message.id).sort()).toEqual(["pending-intent", "remaining-inbox"]);
    expect(sourceFolder.json().items.map((message: { id: string }) => message.id).sort()).toEqual(["pending-intent", "remaining-inbox"]);
    expect(archive.json()).toMatchObject({
      total: 2,
      items: expect.arrayContaining([
        expect.objectContaining({ id: "pending-archive", mailbox: "Archive", movePending: true }),
        expect.objectContaining({ id: "unverified-archive", mailbox: "Archive", movePending: false, moveLocationUnverified: true }),
      ]),
    });
    expect(trash.json()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: "pending-trash", mailbox: "Trash", movePending: true })],
    });
    expect(archived.json()).toMatchObject({
      total: 3,
      items: expect.arrayContaining([
        expect.objectContaining({ id: "pending-archive", mailbox: "Archive", movePending: true }),
        expect.objectContaining({ id: "pending-unlisted-archive", mailbox: "Archive/2026", movePending: true, archived: true }),
        expect.objectContaining({ id: "unverified-archive", mailbox: "Archive", movePending: false, moveLocationUnverified: true }),
      ]),
    });
    expect(detail.json()).toMatchObject({ id: "pending-archive", mailbox: "Archive", movePending: true });
    expect(intentDetail.json()).toMatchObject({ id: "pending-intent", mailbox: "INBOX", movePending: true, archived: false });
  });
});
