import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { TranslationService } from "../src/translation.js";

describe("selected message translation route", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let outboundDirectory: string;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    outboundDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-translation-"));
    fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      translatedText: "A translated private message.",
      detectedLanguage: { language: "en" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "account-translation",
      "reader@example.test",
      "custom",
      "Example Mail",
      "encrypted",
      "imap.example.test",
      993,
      1,
      "smtp.example.test",
      465,
      1,
      "email",
      "connected",
      new Date().toISOString(),
    );
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "message-translation",
      "account-translation",
      "INBOX",
      1,
      "Do not send this subject",
      "Sender",
      "sender@example.test",
      "[]",
      new Date().toISOString(),
      "Do not send this snippet",
      "Only this private body is eligible for translation.",
      "<p>Do not send raw HTML.</p>",
      "[]",
      0,
      1,
      new Date().toISOString(),
    );

    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
      translationService: new TranslationService({
        endpoint: "https://translate.example.test/translate",
        fetchImpl,
      }),
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(outboundDirectory, { recursive: true, force: true });
  });

  it("translates only the selected message plain-text body after an explicit request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "zh-CN" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      targetLocale: "zh-CN",
      translatedText: "A translated private message.",
      detectedLanguage: "en",
    });
    expect(response.body).not.toContain("Only this private body");
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      q: "Only this private body is eligible for translation.",
      source: "auto",
      target: "zh",
      format: "text",
    });
    expect(String(request?.body)).not.toContain("Do not send this subject");
    expect(String(request?.body)).not.toContain("Do not send this snippet");
    expect(String(request?.body)).not.toContain("Do not send raw HTML");
  });

  it("reports whether translation is available without disclosing service configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/api/translation/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true });
    expect(response.body).not.toContain("translate.example.test");
  });

  it("does not call a provider when the selected message is unavailable", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/messages/not-stored/translate",
      payload: { targetLocale: "zh-CN" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, code: "translation_content_unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("protects translation status and requests with the desktop session capability", async () => {
    await app.close();
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
      translationService: new TranslationService({
        endpoint: "https://translate.example.test/translate",
        fetchImpl,
      }),
    }, { localApiAccessToken: "translation-session-token" });

    const unauthorizedStatus = await app.inject({ method: "GET", url: "/api/translation/status" });
    const unauthorizedTranslate = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "zh-CN" },
    });
    const authorizedStatus = await app.inject({
      method: "GET",
      url: "/api/translation/status",
      headers: { "x-nami-api-token": "translation-session-token" },
    });
    const authorizedTranslate = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      headers: { "x-nami-api-token": "translation-session-token" },
      payload: { targetLocale: "zh-CN" },
    });

    expect(unauthorizedStatus.statusCode).toBe(401);
    expect(unauthorizedTranslate.statusCode).toBe(401);
    expect(unauthorizedTranslate.body).not.toContain("translation-session-token");
    expect(authorizedStatus.json()).toEqual({ enabled: true });
    expect(authorizedTranslate.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("protects translation configuration requests and allows the PUT preflight", async () => {
    await app.close();
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
    }, { localApiAccessToken: "translation-configuration-token" });

    const unauthorizedRead = await app.inject({ method: "GET", url: "/api/translation/configuration" });
    const authorizedRead = await app.inject({
      method: "GET",
      url: "/api/translation/configuration",
      headers: { "x-nami-api-token": "translation-configuration-token" },
    });
    const unauthorizedWrite = await app.inject({
      method: "PUT",
      url: "/api/translation/configuration",
      payload: { endpoint: "https://translate.example.test/translate" },
    });
    const authorizedWrite = await app.inject({
      method: "PUT",
      url: "/api/translation/configuration",
      headers: { "x-nami-api-token": "translation-configuration-token" },
      payload: { endpoint: "https://translate.example.test/translate" },
    });
    const unauthorizedDelete = await app.inject({ method: "DELETE", url: "/api/translation/configuration" });
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/translation/configuration",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "PUT",
      },
    });

    expect(unauthorizedRead.statusCode).toBe(401);
    expect(authorizedRead.statusCode).toBe(200);
    expect(unauthorizedWrite.statusCode).toBe(401);
    expect(authorizedWrite.statusCode).toBe(200);
    expect(unauthorizedDelete.statusCode).toBe(401);
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("rejects unsupported target languages before the translation service is called", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "fr-FR" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, code: "translation_invalid_target" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a stable setup error without exposing mail text when translation is disabled", async () => {
    await app.close();
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
      translationService: new TranslationService(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "en-US" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, code: "translation_not_configured" });
    expect(response.body).not.toContain("Only this private body");

    const status = await app.inject({ method: "GET", url: "/api/translation/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: false });
  });

  it("stores translation service configuration without returning an API key", async () => {
    await app.close();
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
    });
    const apiKey = "reader-configuration-secret";
    const endpoint = "https://translate.example.test/translate";

    const saved = await app.inject({
      method: "PUT",
      url: "/api/translation/configuration",
      payload: { endpoint, apiKey, timeoutMs: 18_000 },
    });
    const loaded = await app.inject({ method: "GET", url: "/api/translation/configuration" });
    const status = await app.inject({ method: "GET", url: "/api/translation/status" });
    const blankEndpoint = await app.inject({
      method: "PUT",
      url: "/api/translation/configuration",
      payload: { endpoint: "" },
    });
    const unchanged = await app.inject({ method: "GET", url: "/api/translation/configuration" });
    const removed = await app.inject({ method: "DELETE", url: "/api/translation/configuration" });
    const row = db.prepare("SELECT translation_configuration FROM app_settings WHERE id = 1").get() as {
      translation_configuration: string | null;
    };

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      ok: true,
      endpoint,
      timeoutMs: 18_000,
      apiKeyConfigured: true,
      source: "local",
    });
    expect(saved.body).not.toContain(apiKey);
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ ok: true, endpoint, apiKeyConfigured: true });
    expect(loaded.body).not.toContain(apiKey);
    expect(status.json()).toEqual({ enabled: true });
    expect(blankEndpoint.statusCode).toBe(400);
    expect(blankEndpoint.json()).toMatchObject({ ok: false, code: "translation_configuration_invalid" });
    expect(unchanged.json()).toMatchObject({ ok: true, endpoint, apiKeyConfigured: true, source: "local" });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({
      ok: true,
      enabled: false,
      endpoint: "",
      timeoutMs: 25_000,
      apiKeyConfigured: false,
      source: "none",
    });
    expect(row.translation_configuration).toBeNull();
  });

  it("returns a classified transport failure without exposing the selected mail body", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    });
    fetchImpl.mockRejectedValueOnce(fetchError);

    const response = await app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "zh-CN" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, code: "translation_connection_refused" });
    expect(response.body).not.toContain("Only this private body");
  });

  it("aborts an in-flight translation before Fastify waits for route handlers to close", async () => {
    await app.close();
    let resolveFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      resolveFetchStarted = resolve;
    });
    let aborted = false;
    const slowFetch = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      resolveFetchStarted?.();
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }));
    app = await buildApp({
      db,
      masterKey: Buffer.alloc(32, 9),
      outboundAttachmentDirectory: outboundDirectory,
      translationService: new TranslationService({
        endpoint: "https://translate.example.test/translate",
        fetchImpl: slowFetch,
      }),
    });

    const pendingRequest = app.inject({
      method: "POST",
      url: "/api/messages/message-translation/translate",
      payload: { targetLocale: "zh-CN" },
    });
    await fetchStarted;
    const close = app.close();
    const response = await pendingRequest;
    await close;

    expect(aborted).toBe(true);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, code: "translation_service_unavailable" });
    expect(response.body).not.toContain("Only this private body");
  });
});
