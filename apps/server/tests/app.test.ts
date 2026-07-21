import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, MAX_BACKGROUND_UPLOAD_BYTES } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import type { OAuthService } from "../src/oauth.js";

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

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject(patch);
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toMatchObject(patch);
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
});
