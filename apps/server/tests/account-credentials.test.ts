import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mailClients = vi.hoisted(() => ({
  ImapFlow: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("imapflow", () => ({ ImapFlow: mailClients.ImapFlow }));
vi.mock("nodemailer", () => ({ default: { createTransport: mailClients.createTransport } }));

import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  AccountCredentialIntegrityError,
  decryptAccountPassword,
  decryptOAuthRefreshToken,
  encryptAccountPassword,
  encryptOAuthRefreshToken,
  migrateAccountCredentialStorage,
  migrateKnownProviderUsernameCredentials,
} from "../src/account-credentials.js";
import { encryptSecret } from "../src/crypto.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { imapClientForAccount, sendMail } from "../src/mail.js";
import type { AccountRecord } from "../src/types.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseHandle[] = [];

function testDatabase(): DatabaseHandle {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-account-credentials-"));
  temporaryDirectories.push(directory);
  const db = openDatabase(path.join(directory, "nami-mail.db"));
  databases.push(db);
  return db;
}

function account(
  id: string,
  email: string,
  authMethod: AccountRecord["auth_method"] = "password",
): AccountRecord {
  return {
    id,
    email,
    provider: authMethod === "oauth2" ? "gmail" : "custom",
    provider_name: authMethod === "oauth2" ? "Gmail" : "Custom",
    encrypted_password: "pending",
    auth_method: authMethod,
    provider_subject: authMethod === "oauth2" ? `${id}-subject` : null,
    tenant_id: null,
    granted_scopes: authMethod === "oauth2" ? "[]" : null,
    imap_host: authMethod === "oauth2" ? "imap.gmail.com" : "imap.example.test",
    imap_port: 993,
    imap_secure: 1,
    imap_transport: "tls",
    imap_username: email,
    smtp_host: authMethod === "oauth2" ? "smtp.gmail.com" : "smtp.example.test",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: email,
    username_mode: "email",
    status: "connected",
    last_error: null,
    last_error_code: null,
    last_synced_at: null,
    created_at: "2026-07-21T00:00:00.000Z",
  };
}

function insertLegacyAccount(db: DatabaseHandle, row: AccountRecord, plaintext: string, masterKey: Buffer): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password, auth_method,
      provider_subject, tenant_id, granted_scopes,
      imap_host, imap_port, imap_secure, imap_transport, imap_username,
      smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
      username_mode, status, last_error, last_error_code, last_synced_at, created_at
    ) VALUES (
      @id, @email, @provider, @providerName, @encryptedPassword, @authMethod,
      @providerSubject, @tenantId, @grantedScopes,
      @imapHost, @imapPort, @imapSecure, @imapTransport, @imapUsername,
      @smtpHost, @smtpPort, @smtpSecure, @smtpTransport, @smtpUsername,
      @usernameMode, @status, NULL, NULL, NULL, @createdAt
    )
  `).run({
    id: row.id,
    email: row.email,
    provider: row.provider,
    providerName: row.provider_name,
    encryptedPassword: encryptSecret(plaintext, masterKey),
    authMethod: row.auth_method,
    providerSubject: row.provider_subject,
    tenantId: row.tenant_id,
    grantedScopes: row.granted_scopes,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure,
    imapTransport: row.imap_transport,
    imapUsername: row.imap_username,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure,
    smtpTransport: row.smtp_transport,
    smtpUsername: row.smtp_username,
    usernameMode: row.username_mode,
    status: row.status,
    createdAt: row.created_at,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("account-bound credential storage", () => {
  it("migrates legacy password and OAuth secrets once, then rejects a legacy downgrade", () => {
    const db = testDatabase();
    const masterKey = randomBytes(32);
    const passwordAccount = account("password-account", "password@example.test");
    const oauthAccount = account("oauth-account", "oauth@gmail.com", "oauth2");
    insertLegacyAccount(db, passwordAccount, "password-secret", masterKey);
    insertLegacyAccount(db, oauthAccount, "oauth-managed", masterKey);
    db.prepare(`
      INSERT INTO account_credentials (account_id, credential_kind, encrypted_secret, updated_at)
      VALUES (?, 'oauth-refresh-token', ?, ?)
    `).run(oauthAccount.id, encryptSecret("refresh-secret", masterKey), oauthAccount.created_at);

    expect(migrateAccountCredentialStorage(db, masterKey)).toEqual({ migrated: 3, vacuumed: true });
    const storedPassword = db.prepare("SELECT * FROM accounts WHERE id = ?").get(passwordAccount.id) as AccountRecord & { credential_crypto_version: number };
    const storedOAuth = db.prepare("SELECT * FROM accounts WHERE id = ?").get(oauthAccount.id) as AccountRecord & { credential_crypto_version: number };
    const storedRefresh = db.prepare("SELECT encrypted_secret, crypto_version FROM account_credentials WHERE account_id = ?")
      .get(oauthAccount.id) as { encrypted_secret: string; crypto_version: number };
    expect(storedPassword.credential_crypto_version).toBe(ACCOUNT_CREDENTIAL_CRYPTO_VERSION);
    expect(storedOAuth.credential_crypto_version).toBe(ACCOUNT_CREDENTIAL_CRYPTO_VERSION);
    expect(storedRefresh.crypto_version).toBe(ACCOUNT_CREDENTIAL_CRYPTO_VERSION);
    expect(storedPassword.encrypted_password).toMatch(/^nami-v1\./);
    expect(storedRefresh.encrypted_secret).toMatch(/^nami-v1\./);
    expect(decryptAccountPassword(storedPassword, storedPassword.encrypted_password, masterKey)).toBe("password-secret");
    expect(decryptOAuthRefreshToken(storedOAuth, storedRefresh.encrypted_secret, masterKey)).toBe("refresh-secret");
    expect(migrateAccountCredentialStorage(db, masterKey)).toEqual({ migrated: 0, vacuumed: false });

    db.prepare("UPDATE accounts SET encrypted_password = ?, credential_crypto_version = 0 WHERE id = ?")
      .run(encryptSecret("password-secret", masterKey), passwordAccount.id);
    expect(() => migrateAccountCredentialStorage(db, masterKey)).toThrow(AccountCredentialIntegrityError);
  });

  it("rewraps only known legacy iCloud and Yandex username defaults", () => {
    const db = testDatabase();
    const masterKey = randomBytes(32);
    const icloud = account("icloud-account", "nami@icloud.com");
    Object.assign(icloud, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: "nami",
      smtp_username: "nami",
      username_mode: "local" as const,
    });
    const yandex = account("yandex-account", "nami@yandex.com");
    Object.assign(yandex, {
      provider: "yandex",
      provider_name: "Yandex Mail",
      imap_host: "imap.yandex.com",
      smtp_host: "smtp.yandex.com",
      imap_username: "nami",
      smtp_username: "nami",
      username_mode: "local" as const,
    });
    const missingIcloudUsernames = account("missing-icloud-usernames", "missing@icloud.com");
    Object.assign(missingIcloudUsernames, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: null,
      smtp_username: null,
      username_mode: "local" as const,
    });
    const missingYandexUsernames = account("missing-yandex-usernames", "missing@yandex.com");
    Object.assign(missingYandexUsernames, {
      provider: "yandex",
      provider_name: "Yandex Mail",
      imap_host: "imap.yandex.com",
      smtp_host: "smtp.yandex.com",
      imap_username: null,
      smtp_username: null,
      username_mode: "local" as const,
    });
    const manual = account("manual-account", "manual@icloud.com");
    Object.assign(manual, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: "manual",
      smtp_username: "alternate@me.com",
      username_mode: "local" as const,
    });
    const customTransport = account("custom-transport-account", "transport@icloud.com");
    Object.assign(customTransport, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 465,
      smtp_secure: 1,
      smtp_transport: "tls" as const,
      imap_username: "transport",
      smtp_username: "transport",
      username_mode: "local" as const,
    });
    const customProvider = account("custom-provider-account", "custom@icloud.com");
    Object.assign(customProvider, {
      provider: "custom",
      provider_name: "Manual iCloud transport",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: "custom",
      smtp_username: "custom",
      username_mode: "local" as const,
    });
    const oauth = account("oauth-icloud-account", "oauth@icloud.com", "oauth2");
    Object.assign(oauth, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: "oauth",
      smtp_username: "oauth",
      username_mode: "local" as const,
    });
    insertLegacyAccount(db, icloud, "icloud-secret", masterKey);
    insertLegacyAccount(db, yandex, "yandex-secret", masterKey);
    insertLegacyAccount(db, missingIcloudUsernames, "missing-icloud-secret", masterKey);
    insertLegacyAccount(db, missingYandexUsernames, "missing-yandex-secret", masterKey);
    insertLegacyAccount(db, manual, "manual-secret", masterKey);
    insertLegacyAccount(db, customTransport, "custom-transport-secret", masterKey);
    insertLegacyAccount(db, customProvider, "custom-provider-secret", masterKey);
    insertLegacyAccount(db, oauth, "oauth-secret", masterKey);
    migrateAccountCredentialStorage(db, masterKey);
    const oldIcloud = db.prepare("SELECT * FROM accounts WHERE id = ?").get(icloud.id) as AccountRecord;

    expect(migrateKnownProviderUsernameCredentials(db, masterKey)).toEqual({ migrated: 4, vacuumed: true });
    const storedIcloud = db.prepare("SELECT * FROM accounts WHERE id = ?").get(icloud.id) as AccountRecord;
    const storedYandex = db.prepare("SELECT * FROM accounts WHERE id = ?").get(yandex.id) as AccountRecord;
    const storedMissingIcloud = db.prepare("SELECT * FROM accounts WHERE id = ?").get(missingIcloudUsernames.id) as AccountRecord;
    const storedMissingYandex = db.prepare("SELECT * FROM accounts WHERE id = ?").get(missingYandexUsernames.id) as AccountRecord;
    const storedManual = db.prepare("SELECT * FROM accounts WHERE id = ?").get(manual.id) as AccountRecord;
    const storedCustomTransport = db.prepare("SELECT * FROM accounts WHERE id = ?").get(customTransport.id) as AccountRecord;
    const storedCustomProvider = db.prepare("SELECT * FROM accounts WHERE id = ?").get(customProvider.id) as AccountRecord;
    const storedOauth = db.prepare("SELECT * FROM accounts WHERE id = ?").get(oauth.id) as AccountRecord;
    expect(storedIcloud).toMatchObject({ imap_username: "nami", smtp_username: "nami@icloud.com", username_mode: "local" });
    expect(storedYandex).toMatchObject({ imap_username: "nami@yandex.com", smtp_username: "nami@yandex.com", username_mode: "email" });
    expect(storedMissingIcloud).toMatchObject({ imap_username: "missing", smtp_username: "missing@icloud.com", username_mode: "local" });
    expect(storedMissingYandex).toMatchObject({ imap_username: "missing@yandex.com", smtp_username: "missing@yandex.com", username_mode: "email" });
    expect(storedManual).toMatchObject({ imap_username: "manual", smtp_username: "alternate@me.com", username_mode: "local" });
    expect(storedCustomTransport).toMatchObject({ imap_username: "transport", smtp_username: "transport", username_mode: "local" });
    expect(storedCustomProvider).toMatchObject({ imap_username: "custom", smtp_username: "custom", username_mode: "local" });
    expect(storedOauth).toMatchObject({ imap_username: "oauth", smtp_username: "oauth", username_mode: "local" });
    expect(storedIcloud.encrypted_password).not.toBe(oldIcloud.encrypted_password);
    expect(decryptAccountPassword(storedIcloud, storedIcloud.encrypted_password, masterKey)).toBe("icloud-secret");
    expect(decryptAccountPassword(storedYandex, storedYandex.encrypted_password, masterKey)).toBe("yandex-secret");
    expect(decryptAccountPassword(storedMissingIcloud, storedMissingIcloud.encrypted_password, masterKey)).toBe("missing-icloud-secret");
    expect(decryptAccountPassword(storedMissingYandex, storedMissingYandex.encrypted_password, masterKey)).toBe("missing-yandex-secret");
    expect(decryptAccountPassword(storedManual, storedManual.encrypted_password, masterKey)).toBe("manual-secret");
    expect(decryptAccountPassword(storedCustomTransport, storedCustomTransport.encrypted_password, masterKey)).toBe("custom-transport-secret");
    expect(decryptAccountPassword(storedCustomProvider, storedCustomProvider.encrypted_password, masterKey)).toBe("custom-provider-secret");
    expect(decryptAccountPassword(storedOauth, storedOauth.encrypted_password, masterKey)).toBe("oauth-secret");
    expect(() => decryptAccountPassword({ ...storedIcloud, smtp_username: "nami" }, storedIcloud.encrypted_password, masterKey))
      .toThrow(AccountCredentialIntegrityError);
    expect(migrateKnownProviderUsernameCredentials(db, masterKey)).toEqual({ migrated: 0, vacuumed: false });
  });

  it("does not commit a partial protocol-username migration when one old AAD cannot be authenticated", () => {
    const db = testDatabase();
    const masterKey = randomBytes(32);
    const icloud = account("atomic-icloud", "atomic@icloud.com");
    Object.assign(icloud, {
      provider: "icloud",
      provider_name: "iCloud Mail",
      imap_host: "imap.mail.me.com",
      smtp_host: "smtp.mail.me.com",
      smtp_port: 587,
      smtp_secure: 0,
      smtp_transport: "starttls" as const,
      imap_username: "atomic",
      smtp_username: "atomic",
      username_mode: "local" as const,
    });
    const yandex = account("atomic-yandex", "atomic@yandex.com");
    Object.assign(yandex, {
      provider: "yandex",
      provider_name: "Yandex Mail",
      imap_host: "imap.yandex.com",
      smtp_host: "smtp.yandex.com",
      imap_username: "atomic",
      smtp_username: "atomic",
      username_mode: "local" as const,
    });
    insertLegacyAccount(db, icloud, "icloud-secret", masterKey);
    insertLegacyAccount(db, yandex, "yandex-secret", masterKey);
    migrateAccountCredentialStorage(db, masterKey);
    const beforeIcloud = db.prepare("SELECT * FROM accounts WHERE id = ?").get(icloud.id) as AccountRecord;

    const unrelated = account("unrelated-account", "unrelated@example.test");
    db.prepare("UPDATE accounts SET encrypted_password = ? WHERE id = ?")
      .run(encryptAccountPassword(unrelated, "unrelated-secret", masterKey), yandex.id);

    expect(() => migrateKnownProviderUsernameCredentials(db, masterKey)).toThrow(AccountCredentialIntegrityError);

    const afterIcloud = db.prepare("SELECT * FROM accounts WHERE id = ?").get(icloud.id) as AccountRecord;
    expect(afterIcloud).toMatchObject({ imap_username: "atomic", smtp_username: "atomic", username_mode: "local" });
    expect(afterIcloud.encrypted_password).toBe(beforeIcloud.encrypted_password);
    expect(decryptAccountPassword(afterIcloud, afterIcloud.encrypted_password, masterKey)).toBe("icloud-secret");
    expect(db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get("account-credentials-protocol-usernames-v1"))
      .toBeUndefined();
  });

  it("rejects endpoint changes before constructing an IMAP or SMTP client", async () => {
    const masterKey = randomBytes(32);
    const original = account("endpoint-account", "endpoint@example.test");
    original.encrypted_password = encryptAccountPassword(original, "endpoint-secret", masterKey);

    await expect(imapClientForAccount({ ...original, imap_host: "attacker.invalid" }, masterKey))
      .rejects.toMatchObject({ code: "local_data_invalid" });
    await expect(sendMail({ ...original, smtp_port: 587 }, masterKey, {
      to: ["recipient@example.test"],
      subject: "must not connect",
      text: "body",
    })).rejects.toMatchObject({ code: "local_data_invalid" });
    expect(mailClients.ImapFlow).not.toHaveBeenCalled();
    expect(mailClients.createTransport).not.toHaveBeenCalled();
  });

  it("rejects password and refresh-token ciphertext exchanged between accounts", () => {
    const masterKey = randomBytes(32);
    const firstPassword = account("first-password", "first@example.test");
    const secondPassword = account("second-password", "second@example.test");
    const passwordCiphertext = encryptAccountPassword(firstPassword, "first-password-secret", masterKey);
    expect(() => decryptAccountPassword(secondPassword, passwordCiphertext, masterKey))
      .toThrow(AccountCredentialIntegrityError);

    const firstOAuth = account("first-oauth", "first@gmail.com", "oauth2");
    const secondOAuth = account("second-oauth", "second@gmail.com", "oauth2");
    const refreshCiphertext = encryptOAuthRefreshToken(firstOAuth, "first-refresh-token", masterKey);
    expect(() => decryptOAuthRefreshToken(secondOAuth, refreshCiphertext, masterKey))
      .toThrow(AccountCredentialIntegrityError);
  });
});
