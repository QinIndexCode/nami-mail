/**
 * Row-level access to `accounts` / `folders` for the HTTP layer.
 *
 * This module is a leaf (only type-only imports) so routes can depend on it
 * without inheriting the sync/agent graph. It exists because these queries
 * were duplicated across `routes/accounts.ts` (existence checks twice, the
 * 18-column password-account INSERT twice) and `routes/filter-rules.ts`, with
 * no shared place to fix a column or a collation once.
 */
import type { DatabaseHandle } from "./db.js";
import type { AccountRecord } from "./types.js";

const ACCOUNT_BY_ID_SQL = "SELECT * FROM accounts WHERE id = ?";
const ACCOUNT_EXISTS_SQL = "SELECT 1 FROM accounts WHERE id = ?";
type AccountStatement = ReturnType<DatabaseHandle["prepare"]>;

/**
 * One lazily-filled statement cache per connection, per statement.
 *
 * `accountById` is the account read every move, flag, attachment and send path
 * performs, and on the batch-move path it runs once per (account, mailbox)
 * group: a 2500-row selection compiled 25 byte-identical copies of the same SQL
 * (measured on the raw handle). Both SQL strings above are constant — the id is
 * always bound — so each is compiled once per connection and replayed.
 *
 * * Scope: the `DatabaseHandle` is the `WeakMap` key, so a statement can only
 *   ever be handed back to the connection it was compiled against, and the entry
 *   dies with that handle. A caller that wraps the handle in a proxy (the
 *   test-side `memoizingDb`) gets its own entry, which is the safe direction: a
 *   miss costs one compile, never a mismatch.
 * * Layering: the cache lives here rather than in the move-statement bundle
 *   because this module is a leaf — routes, the agent and sync all read
 *   accounts through these two functions, and reaching a cache through
 *   `sync-move-statements.ts` would give the HTTP layer the move graph.
 * * Laziness is per statement, not per handle: a deployment that only ever calls
 *   `accountById` never compiles the existence probe.
 * * Reads are untouched. `.get()` re-executes on every call, so each caller still
 *   sees the row as it is at that moment, and `undefined` still means "no such
 *   account" — only *when* the SQL is compiled changed, never *what it returns*.
 * * Nothing is interpolated: the id is a bound parameter.
 */
const statementCaches = new Map<string, WeakMap<DatabaseHandle, AccountStatement>>();

function accountStatement(db: DatabaseHandle, name: string, sql: string): AccountStatement {
  let perHandle = statementCaches.get(name);
  if (!perHandle) {
    perHandle = new WeakMap();
    statementCaches.set(name, perHandle);
  }
  const cached = perHandle.get(db);
  if (cached) return cached;
  const statement = db.prepare(sql);
  perHandle.set(db, statement);
  return statement;
}

export function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return accountStatement(db, "byId", ACCOUNT_BY_ID_SQL).get(id) as AccountRecord | undefined;
}

export function accountExists(db: DatabaseHandle, id: string): boolean {
  return accountStatement(db, "exists", ACCOUNT_EXISTS_SQL).get(id) !== undefined;
}

/** Case-insensitive lookup used to reject a duplicate mailbox before adding it. */
export function accountIdByEmail(db: DatabaseHandle, email: string): string | null {
  const row = db
    .prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
    .get(email) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listAccountRows(db: DatabaseHandle): AccountRecord[] {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRecord[];
}

export function listFolderRows(db: DatabaseHandle): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM folders ORDER BY account_id, name").all() as Array<Record<string, unknown>>;
}

/** Returns the number of updated rows, so the caller can turn 0 into a 404. */
export function updateAccountSignature(db: DatabaseHandle, id: string, signature: string): number {
  return db.prepare("UPDATE accounts SET signature = ? WHERE id = ?").run(signature, id).changes;
}

/** Returns the number of updated rows, so the caller can turn 0 into a 404. */
export function updateAccountDisplayName(db: DatabaseHandle, id: string, displayName: string | null): number {
  return db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(displayName, id).changes;
}

export type PasswordAccountInsert = {
  id: string;
  email: string;
  providerId: string;
  providerName: string;
  encryptedPassword: string;
  credentialCryptoVersion: number;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapTransport: string;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpTransport: string;
  smtpUsername: string;
  usernameMode: string;
  createdAt: string;
};

/** Inserts a password-authenticated mailbox row. OAuth flows use their own writer. */
export function insertPasswordAccountRow(db: DatabaseHandle, account: PasswordAccountInsert): void {
  db.prepare(
    `
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `,
  ).run(
    account.id,
    account.email,
    account.providerId,
    account.providerName,
    account.encryptedPassword,
    account.credentialCryptoVersion,
    account.imapHost,
    account.imapPort,
    account.imapSecure ? 1 : 0,
    account.imapTransport,
    account.imapUsername,
    account.smtpHost,
    account.smtpPort,
    account.smtpSecure ? 1 : 0,
    account.smtpTransport,
    account.smtpUsername,
    account.usernameMode,
    account.createdAt,
  );
}
