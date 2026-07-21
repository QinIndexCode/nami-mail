import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  decryptOAuthRefreshToken,
  encryptAccountPassword,
  encryptOAuthRefreshToken,
  type AccountCredentialIdentity,
} from "../src/account-credentials.js";
import { openDatabase } from "../src/db.js";
import type { AccountRecord } from "../src/types.js";

const { testOAuthAccountConnection } = vi.hoisted(() => ({
  testOAuthAccountConnection: vi.fn(),
}));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, testOAuthAccountConnection };
});

const temporaryDirectories: string[] = [];
const temporaryDatabases: Array<ReturnType<typeof openDatabase>> = [];

function createTestDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-oauth-"));
  temporaryDirectories.push(directory);
  const db = openDatabase(path.join(directory, "nami-mail.db"));
  temporaryDatabases.push(db);
  return db;
}

function createGoogleOAuthAccount(masterKey: Buffer): { account: AccountRecord; db: ReturnType<typeof openDatabase> } {
  const db = createTestDatabase();
  const accountId = "google-oauth-account";
  const email = "oauth@example.test";
  const createdAt = "2026-07-19T00:00:00.000Z";
  const credentialIdentity: AccountCredentialIdentity = {
    id: accountId,
    email,
    provider: "gmail",
    auth_method: "oauth2",
    imap_host: "imap.gmail.com",
    imap_port: 993,
    imap_secure: 1,
    imap_transport: "tls",
    imap_username: email,
    smtp_host: "smtp.gmail.com",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: email,
    username_mode: "email",
  };
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
      provider_subject, tenant_id, granted_scopes,
      imap_host, imap_port, imap_secure, imap_transport, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
      username_mode, status, created_at
    ) VALUES (?, ?, 'gmail', 'Gmail', ?, ?, 'oauth2', ?, NULL, ?, ?, 993, 1, 'tls', ?, ?, 465, 1, 'tls', ?, 'email', 'connected', ?)
  `).run(
    accountId,
    email,
    encryptAccountPassword(credentialIdentity, "oauth-managed", masterKey),
    ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
    "google-subject",
    JSON.stringify(["openid", "email", "https://mail.google.com/"]),
    "imap.gmail.com",
    email,
    "smtp.gmail.com",
    email,
    createdAt,
  );
  db.prepare(`
    INSERT INTO account_credentials (account_id, credential_kind, encrypted_secret, crypto_version, updated_at)
    VALUES (?, 'oauth-refresh-token', ?, ?, ?)
  `).run(
    accountId,
    encryptOAuthRefreshToken(credentialIdentity, "refresh-original", masterKey),
    ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
    createdAt,
  );

  return {
    db,
    account: db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRecord,
  };
}

async function loadOAuthModule() {
  vi.resetModules();
  return import("../src/oauth.js");
}

beforeEach(() => {
  vi.stubEnv("NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID", "google-client-for-tests");
  vi.stubEnv("NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID", "microsoft-client-for-tests");
  vi.stubEnv("NAMI_MAIL_MICROSOFT_TENANT", "common");
  testOAuthAccountConnection.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const db of temporaryDatabases.splice(0)) {
    db.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OAuthService authorization-code flow", () => {
  it("builds a Google authorization-code URL with PKCE, state, nonce, and a loopback callback", async () => {
    const { OAuthService } = await loadOAuthModule();
    const db = createTestDatabase();
    const service = new OAuthService(db, randomBytes(32));

    const started = await service.start("google", "http://127.0.0.1:43125");
    const url = new URL(started.authorizationUrl);

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-client-for-tests");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43125/api/oauth/google/callback");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get("state")).not.toBe(url.searchParams.get("nonce"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("code_verifier")).toBe(false);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(new Date(started.expiresAt).getTime()).toBeGreaterThan(Date.now());

    await expect(service.start("google", "https://127.0.0.1:43125")).rejects.toMatchObject({ code: "oauth_failed" });
    await expect(service.start("google", "http://mail.example.test:43125")).rejects.toMatchObject({ code: "oauth_failed" });
  });

  it("builds a Microsoft authorization URL with the registered localhost callback", async () => {
    const { OAuthService } = await loadOAuthModule();
    const db = createTestDatabase();
    const service = new OAuthService(db, randomBytes(32));

    const started = await service.start("microsoft", "http://localhost:43125");
    const url = new URL(started.authorizationUrl);

    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("microsoft-client-for-tests");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:43125/api/oauth/microsoft/callback");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
  });

  it("marks the account error and preserves the classified SMTP configuration failure", async () => {
    const { OAuthService } = await loadOAuthModule();
    const masterKey = randomBytes(32);
    const db = createTestDatabase();
    const service = new OAuthService(db, masterKey);
    const started = await service.start("google", "http://127.0.0.1:43125");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    const internals = service as unknown as {
      callbackTokens: () => Promise<{ tokens: { access_token: string; refresh_token: string; expires_in: number } }>;
      identityFromTokens: () => { email: string; subject: string; scopes: string[] };
    };
    vi.spyOn(internals, "callbackTokens").mockResolvedValue({
      tokens: { access_token: "access-token-for-transport-check", refresh_token: "refresh-token-for-transport-check", expires_in: 3600 },
    });
    vi.spyOn(internals, "identityFromTokens").mockReturnValue({
      email: "transport-failure@gmail.com",
      subject: "google-subject-for-transport-check",
      scopes: ["openid", "email", "https://mail.google.com/"],
    });
    testOAuthAccountConnection.mockRejectedValueOnce(new Error("SMTP AUTH is disabled"));

    const callback = new URL("http://127.0.0.1:43125/api/oauth/google/callback");
    callback.searchParams.set("code", "authorization-code-for-transport-check");
    callback.searchParams.set("state", state!);

    await expect(service.finish("google", callback)).rejects.toMatchObject({ code: "provider_configuration" });
    expect(testOAuthAccountConnection).toHaveBeenCalledWith(
      expect.objectContaining({ email: "transport-failure@gmail.com", status: "connecting" }),
      masterKey,
      service,
    );

    const account = db.prepare("SELECT id, status, last_error, last_error_code FROM accounts WHERE email = ?").get("transport-failure@gmail.com") as {
      id: string;
      status: string;
      last_error: string | null;
      last_error_code: string | null;
    };
    expect(account).toMatchObject({ status: "error" });
    expect(account.last_error_code).toBe("provider_configuration");
    expect(account.last_error).toContain("协议或服务器配置");
    expect(account.last_error).not.toContain("SMTP AUTH is disabled");
    expect(service.getAttempt(started.attemptId)).toMatchObject({
      status: "error",
      code: "provider_configuration",
    });
  });

});

describe("OAuthService refresh tokens", () => {
  it("deduplicates concurrent refreshes and keeps a rotated token bound to the account endpoints", async () => {
    const { OAuthService } = await loadOAuthModule();
    const masterKey = randomBytes(32);
    const { account, db } = createGoogleOAuthAccount(masterKey);
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-original");
      return new Response(JSON.stringify({
        access_token: "access-token-after-refresh",
        refresh_token: "refresh-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new OAuthService(db, masterKey);

    await expect(Promise.all([service.getAccessToken(account), service.getAccessToken(account)])).resolves.toEqual([
      "access-token-after-refresh",
      "access-token-after-refresh",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = db.prepare("SELECT encrypted_secret, crypto_version FROM account_credentials WHERE account_id = ?").get(account.id) as { encrypted_secret: string; crypto_version: number };
    expect(stored.encrypted_secret).not.toContain("refresh-rotated");
    expect(stored.crypto_version).toBe(ACCOUNT_CREDENTIAL_CRYPTO_VERSION);
    expect(decryptOAuthRefreshToken(account, stored.encrypted_secret, masterKey)).toBe("refresh-rotated");

    db.prepare("UPDATE accounts SET smtp_host = ? WHERE id = ?").run("attacker.invalid", account.id);
    const tampered = db.prepare("SELECT * FROM accounts WHERE id = ?").get(account.id) as AccountRecord;
    await expect(service.getAccessToken(tampered)).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks the account reauth_required when the provider rejects its refresh token", async () => {
    const { OAuthError, OAuthService } = await loadOAuthModule();
    const masterKey = randomBytes(32);
    const { account, db } = createGoogleOAuthAccount(masterKey);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "refresh token revoked",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new OAuthService(db, masterKey);

    const refresh = service.getAccessToken(account);
    await expect(refresh).rejects.toBeInstanceOf(OAuthError);
    await expect(refresh).rejects.toMatchObject({ code: "reauth_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status, last_error, last_error_code FROM accounts WHERE id = ?").get(account.id)).toMatchObject({
      status: "reauth_required",
      last_error_code: "reauth_required",
    });
  });
});
