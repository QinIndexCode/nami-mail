import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";

describe("account transport migration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades legacy non-secure records to mandatory STARTTLS", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-account-transport-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        provider TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL,
        imap_secure INTEGER NOT NULL,
        smtp_host TEXT NOT NULL,
        smtp_port INTEGER NOT NULL,
        smtp_secure INTEGER NOT NULL,
        username_mode TEXT NOT NULL DEFAULT 'email',
        status TEXT NOT NULL DEFAULT 'connected',
        last_error TEXT,
        last_synced_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Custom', 'encrypted', 'imap.example.test', 143, ?, 'smtp.example.test', 587, ?, 'email', 'connected', '2026-07-19T00:00:00.000Z')
    `);
    insert.run("starttls", "starttls@example.test", 0, 0);
    insert.run("tls", "tls@example.test", 1, 1);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      const rows = migrated.prepare("SELECT id, imap_transport, smtp_transport, last_error_code FROM accounts ORDER BY id").all();
      expect(rows).toEqual([
        { id: "starttls", imap_transport: "starttls", smtp_transport: "starttls", last_error_code: null },
        { id: "tls", imap_transport: "tls", smtp_transport: "tls", last_error_code: null },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("adds nullable recipient and threading cache fields so legacy messages are refreshed safely", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-message-cc-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        uid INTEGER NOT NULL,
        message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        from_name TEXT NOT NULL DEFAULT '',
        from_address TEXT NOT NULL DEFAULT '',
        to_json TEXT NOT NULL DEFAULT '[]',
        sent_at TEXT,
        snippet TEXT NOT NULL DEFAULT '',
        text_body TEXT NOT NULL DEFAULT '',
        html_body TEXT NOT NULL DEFAULT '',
        flags_json TEXT NOT NULL DEFAULT '[]',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, mailbox, uid)
      );
      INSERT INTO messages (id, account_id, mailbox, uid, created_at)
        VALUES ('legacy-message', 'account-1', 'INBOX', 1, '2026-07-20T00:00:00.000Z');
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      const columns = migrated.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "cc_json")).toBe(true);
      expect(columns.some((column) => column.name === "in_reply_to")).toBe(true);
      expect(columns.some((column) => column.name === "references_json")).toBe(true);
      expect(migrated.prepare("SELECT cc_json, in_reply_to, references_json FROM messages WHERE id = ?").get("legacy-message"))
        .toEqual({ cc_json: null, in_reply_to: null, references_json: null });
    } finally {
      migrated.close();
    }
  });

  it("adds an unknown UIDVALIDITY field to legacy folder caches", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-folder-uidvalidity-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "nami-mail.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE folders (
        account_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        special_use TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        unseen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, path)
      );
      INSERT INTO folders (account_id, path, name) VALUES ('account-1', 'INBOX', 'Inbox');
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    try {
      const columns = migrated.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "uid_validity")).toBe(true);
      expect(migrated.prepare("SELECT uid_validity FROM folders WHERE account_id = ? AND path = ?").get("account-1", "INBOX"))
        .toEqual({ uid_validity: null });
    } finally {
      migrated.close();
    }
  });
});
