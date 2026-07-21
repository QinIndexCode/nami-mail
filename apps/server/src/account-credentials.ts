import {
  decryptSecret,
  decryptTextEnvelope,
  deriveEncryptionKey,
  encryptTextEnvelope,
} from "./crypto.js";
import type { DatabaseHandle } from "./db.js";
import type { AccountRecord } from "./types.js";

export const ACCOUNT_CREDENTIAL_CRYPTO_VERSION = 2;

const ACCOUNT_CREDENTIAL_MIGRATION_ID = "account-credentials-bound-v2";
const ACCOUNT_PROTOCOL_USERNAME_MIGRATION_ID = "account-credentials-protocol-usernames-v1";
const BOUND_SECRET_PREFIX = "nami-v1.";
const LEGACY_SECRET_PREFIX = "v1.";
const passwordKeyPurpose = "account-password-bound-v2";
const refreshTokenKeyPurpose = "oauth-refresh-token-bound-v2";

export type AccountCredentialIdentity = Pick<
  AccountRecord,
  | "id"
  | "email"
  | "provider"
  | "auth_method"
  | "imap_host"
  | "imap_port"
  | "imap_secure"
  | "imap_transport"
  | "imap_username"
  | "smtp_host"
  | "smtp_port"
  | "smtp_secure"
  | "smtp_transport"
  | "smtp_username"
  | "username_mode"
>;

type CredentialKind = "password" | "oauth-refresh-token";

type StoredAccountCredential = AccountRecord & {
  credential_crypto_version: number;
};

type StoredOAuthCredential = {
  account_id: string;
  credential_kind: "oauth-refresh-token";
  encrypted_secret: string;
  crypto_version: number;
  updated_at: string;
};

type ProtocolUsernameUpdate = {
  id: string;
  imapUsername: string;
  smtpUsername: string;
  usernameMode: AccountCredentialIdentity["username_mode"];
  encryptedPassword: string;
};

type ProtocolUsernameTarget = {
  imap_username: string;
  smtp_username: string;
  username_mode: AccountCredentialIdentity["username_mode"];
};

export class AccountCredentialIntegrityError extends Error {
  readonly code = "local_data_invalid";

  constructor() {
    super("Stored account credential could not be authenticated.");
    this.name = "AccountCredentialIntegrityError";
  }
}

function credentialAad(account: AccountCredentialIdentity, kind: CredentialKind): string {
  // A JSON array has an explicit field order and cannot be confused by values
  // containing separators. Bind raw stored values because even an equivalent
  // endpoint rewrite must not silently authorize a changed database row.
  return JSON.stringify([
    "nami-account-credential-v2",
    kind,
    account.id,
    account.email,
    account.provider,
    account.auth_method,
    account.imap_host,
    account.imap_port,
    account.imap_secure,
    account.imap_transport,
    account.imap_username,
    account.smtp_host,
    account.smtp_port,
    account.smtp_secure,
    account.smtp_transport,
    account.smtp_username,
    account.username_mode,
  ]);
}

function withCredentialKey<T>(masterKey: Buffer, purpose: string, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, purpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

function encryptBoundSecret(
  account: AccountCredentialIdentity,
  plaintext: string,
  masterKey: Buffer,
  kind: CredentialKind,
  keyPurpose: string,
): string {
  return withCredentialKey(masterKey, keyPurpose, (key) =>
    encryptTextEnvelope(plaintext, key, credentialAad(account, kind)));
}

function decryptBoundSecret(
  account: AccountCredentialIdentity,
  payload: string,
  masterKey: Buffer,
  kind: CredentialKind,
  keyPurpose: string,
): string {
  try {
    if (!payload.startsWith(BOUND_SECRET_PREFIX)) throw new Error("Account credential is not identity-bound.");
    return withCredentialKey(masterKey, keyPurpose, (key) =>
      decryptTextEnvelope(payload, key, credentialAad(account, kind)));
  } catch {
    throw new AccountCredentialIntegrityError();
  }
}

export function encryptAccountPassword(
  account: AccountCredentialIdentity,
  plaintext: string,
  masterKey: Buffer,
): string {
  return encryptBoundSecret(account, plaintext, masterKey, "password", passwordKeyPurpose);
}

export function decryptAccountPassword(
  account: AccountCredentialIdentity,
  payload: string,
  masterKey: Buffer,
): string {
  return decryptBoundSecret(account, payload, masterKey, "password", passwordKeyPurpose);
}

export function encryptOAuthRefreshToken(
  account: AccountCredentialIdentity,
  plaintext: string,
  masterKey: Buffer,
): string {
  return encryptBoundSecret(account, plaintext, masterKey, "oauth-refresh-token", refreshTokenKeyPurpose);
}

export function decryptOAuthRefreshToken(
  account: AccountCredentialIdentity,
  payload: string,
  masterKey: Buffer,
): string {
  return decryptBoundSecret(account, payload, masterKey, "oauth-refresh-token", refreshTokenKeyPurpose);
}

function legacySecret(payload: string, masterKey: Buffer): string {
  if (!payload.startsWith(LEGACY_SECRET_PREFIX)) throw new AccountCredentialIntegrityError();
  try {
    return decryptSecret(payload, masterKey);
  } catch {
    throw new AccountCredentialIntegrityError();
  }
}

function localPartOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 && at < email.length - 1 ? email.slice(0, at) : null;
}

function isLegacyLocalUsername(value: string | null, localPart: string): boolean {
  return !value?.trim() || value.trim().toLocaleLowerCase() === localPart.toLocaleLowerCase();
}

function hasExpectedLegacyEndpoints(account: StoredAccountCredential): boolean {
  // Match the complete historical automatic preset, rather than merely a
  // familiar hostname. That keeps manually adjusted transports out of this
  // migration even if a user retained the original provider identifier.
  if (account.provider === "icloud") {
    return account.imap_host === "imap.mail.me.com"
      && account.imap_port === 993
      && account.imap_secure === 1
      && account.imap_transport === "tls"
      && account.smtp_host === "smtp.mail.me.com"
      && account.smtp_port === 587
      && account.smtp_secure === 0
      && account.smtp_transport === "starttls";
  }
  if (account.provider === "yandex") {
    return account.imap_host === "imap.yandex.com"
      && account.imap_port === 993
      && account.imap_secure === 1
      && account.imap_transport === "tls"
      && account.smtp_host === "smtp.yandex.com"
      && account.smtp_port === 465
      && account.smtp_secure === 1
      && account.smtp_transport === "tls";
  }
  return false;
}

function legacyProtocolUsernameTarget(
  account: StoredAccountCredential,
): ProtocolUsernameTarget | null {
  if (account.auth_method !== "password" || !hasExpectedLegacyEndpoints(account)) return null;
  const localPart = localPartOfEmail(account.email);
  if (!localPart) return null;

  const imapUsername = account.imap_username?.trim();
  const smtpUsername = account.smtp_username?.trim();
  if (account.provider === "icloud") {
    const next = {
      imap_username: isLegacyLocalUsername(imapUsername ?? null, localPart) ? localPart : imapUsername ?? localPart,
      smtp_username: isLegacyLocalUsername(smtpUsername ?? null, localPart) ? account.email : smtpUsername ?? account.email,
      username_mode: account.username_mode,
    } as const;
    return next.imap_username === account.imap_username
      && next.smtp_username === account.smtp_username
      ? null
      : next;
  }

  const next = {
    imap_username: isLegacyLocalUsername(imapUsername ?? null, localPart) ? account.email : imapUsername ?? account.email,
    smtp_username: isLegacyLocalUsername(smtpUsername ?? null, localPart) ? account.email : smtpUsername ?? account.email,
    username_mode: "email" as const,
  };
  return next.imap_username === account.imap_username
    && next.smtp_username === account.smtp_username
    && next.username_mode === account.username_mode
    ? null
    : next;
}

/**
 * Rewraps legacy unbound credentials before the runtime creates OAuth or mail
 * network clients. Once the completion marker exists, legacy ciphertext is a
 * downgrade attempt and is never accepted again.
 */
export function migrateAccountCredentialStorage(
  db: DatabaseHandle,
  masterKey: Buffer,
): { migrated: number; vacuumed: boolean } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(ACCOUNT_CREDENTIAL_MIGRATION_ID);
  const accounts = db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all() as StoredAccountCredential[];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const oauthCredentials = db.prepare(`
    SELECT account_id, credential_kind, encrypted_secret, crypto_version, updated_at
    FROM account_credentials ORDER BY account_id
  `).all() as StoredOAuthCredential[];
  const accountUpdates: Array<{ id: string; encryptedPassword: string }> = [];
  const oauthUpdates: Array<{ accountId: string; encryptedSecret: string }> = [];

  for (const account of accounts) {
    if (account.credential_crypto_version === ACCOUNT_CREDENTIAL_CRYPTO_VERSION) {
      decryptAccountPassword(account, account.encrypted_password, masterKey);
      continue;
    }
    if (account.encrypted_password.startsWith(BOUND_SECRET_PREFIX)) {
      decryptAccountPassword(account, account.encrypted_password, masterKey);
      accountUpdates.push({ id: account.id, encryptedPassword: account.encrypted_password });
      continue;
    }
    if (marker) throw new AccountCredentialIntegrityError();
    const plaintext = legacySecret(account.encrypted_password, masterKey);
    accountUpdates.push({
      id: account.id,
      encryptedPassword: encryptAccountPassword(account, plaintext, masterKey),
    });
  }

  for (const credential of oauthCredentials) {
    const account = accountById.get(credential.account_id);
    if (!account || account.auth_method !== "oauth2") throw new AccountCredentialIntegrityError();
    if (credential.crypto_version === ACCOUNT_CREDENTIAL_CRYPTO_VERSION) {
      decryptOAuthRefreshToken(account, credential.encrypted_secret, masterKey);
      continue;
    }
    if (credential.encrypted_secret.startsWith(BOUND_SECRET_PREFIX)) {
      decryptOAuthRefreshToken(account, credential.encrypted_secret, masterKey);
      oauthUpdates.push({ accountId: account.id, encryptedSecret: credential.encrypted_secret });
      continue;
    }
    if (marker) throw new AccountCredentialIntegrityError();
    const plaintext = legacySecret(credential.encrypted_secret, masterKey);
    oauthUpdates.push({
      accountId: account.id,
      encryptedSecret: encryptOAuthRefreshToken(account, plaintext, masterKey),
    });
  }

  db.transaction(() => {
    const updateAccount = db.prepare(`
      UPDATE accounts SET encrypted_password = ?, credential_crypto_version = ? WHERE id = ?
    `);
    for (const update of accountUpdates) {
      updateAccount.run(update.encryptedPassword, ACCOUNT_CREDENTIAL_CRYPTO_VERSION, update.id);
    }
    const updateOAuth = db.prepare(`
      UPDATE account_credentials SET encrypted_secret = ?, crypto_version = ? WHERE account_id = ?
    `);
    for (const update of oauthUpdates) {
      updateOAuth.run(update.encryptedSecret, ACCOUNT_CREDENTIAL_CRYPTO_VERSION, update.accountId);
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(ACCOUNT_CREDENTIAL_MIGRATION_ID, new Date().toISOString());
  })();

  const protectedAccounts = db.prepare("SELECT * FROM accounts ORDER BY created_at, id").all() as StoredAccountCredential[];
  const protectedById = new Map(protectedAccounts.map((account) => [account.id, account]));
  for (const account of protectedAccounts) {
    if (account.credential_crypto_version !== ACCOUNT_CREDENTIAL_CRYPTO_VERSION) throw new AccountCredentialIntegrityError();
    decryptAccountPassword(account, account.encrypted_password, masterKey);
  }
  const protectedOAuth = db.prepare(`
    SELECT account_id, credential_kind, encrypted_secret, crypto_version, updated_at
    FROM account_credentials ORDER BY account_id
  `).all() as StoredOAuthCredential[];
  for (const credential of protectedOAuth) {
    const account = protectedById.get(credential.account_id);
    if (!account || credential.crypto_version !== ACCOUNT_CREDENTIAL_CRYPTO_VERSION) throw new AccountCredentialIntegrityError();
    decryptOAuthRefreshToken(account, credential.encrypted_secret, masterKey);
  }

  const migrated = accountUpdates.length + oauthUpdates.length;
  let vacuumed = false;
  if (migrated > 0) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }
  return { migrated, vacuumed };
}

/**
 * Rewraps only the two old automatic provider defaults that used one shared
 * username for both transports. Manual endpoints and custom usernames stay
 * untouched; changing an AAD-bound identity always requires re-encryption.
 */
export function migrateKnownProviderUsernameCredentials(
  db: DatabaseHandle,
  masterKey: Buffer,
): { migrated: number; vacuumed: boolean } {
  const marker = db.prepare("SELECT 1 FROM data_migrations WHERE id = ?").get(ACCOUNT_PROTOCOL_USERNAME_MIGRATION_ID);
  if (marker) return { migrated: 0, vacuumed: false };

  const accounts = db.prepare("SELECT * FROM accounts WHERE auth_method = 'password' ORDER BY created_at, id")
    .all() as StoredAccountCredential[];
  const updates: ProtocolUsernameUpdate[] = [];
  for (const account of accounts) {
    const target = legacyProtocolUsernameTarget(account);
    if (!target) continue;
    const plaintext = decryptAccountPassword(account, account.encrypted_password, masterKey);
    const identity: AccountCredentialIdentity = { ...account, ...target };
    updates.push({
      id: account.id,
      imapUsername: target.imap_username,
      smtpUsername: target.smtp_username,
      usernameMode: target.username_mode,
      encryptedPassword: encryptAccountPassword(identity, plaintext, masterKey),
    });
  }

  db.transaction(() => {
    const updateAccount = db.prepare(`
      UPDATE accounts
      SET encrypted_password = ?, credential_crypto_version = ?, imap_username = ?, smtp_username = ?, username_mode = ?
      WHERE id = ?
    `);
    for (const update of updates) {
      updateAccount.run(
        update.encryptedPassword,
        ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        update.imapUsername,
        update.smtpUsername,
        update.usernameMode,
        update.id,
      );
    }
    db.prepare(`
      INSERT INTO data_migrations (id, completed_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at
    `).run(ACCOUNT_PROTOCOL_USERNAME_MIGRATION_ID, new Date().toISOString());
  })();

  for (const update of updates) {
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(update.id) as StoredAccountCredential | undefined;
    if (!account
      || account.imap_username !== update.imapUsername
      || account.smtp_username !== update.smtpUsername
      || account.username_mode !== update.usernameMode
      || account.credential_crypto_version !== ACCOUNT_CREDENTIAL_CRYPTO_VERSION) {
      throw new AccountCredentialIntegrityError();
    }
    decryptAccountPassword(account, account.encrypted_password, masterKey);
  }

  const migrated = updates.length;
  let vacuumed = false;
  if (migrated > 0) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }
  return { migrated, vacuumed };
}
