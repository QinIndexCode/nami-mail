import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { resolveMoveDestination, type MessageMoveTarget } from "../src/sync-moves.js";
import { accountById, accountExists } from "../src/account-store.js";

/**
 * `resolveMoveDestination` and `accountById` compile their SQL once per
 * connection instead of once per call. That is only sound if the *text* a
 * compiled statement carries is decided by the cache key alone, and if the
 * reuse changes no result — so these cases pin the target precedence, the
 * bound special-use values, the `null` a missing folder returns, and the exact
 * set of statements the two readers compile, against the real driver.
 */
describe("move destination and account lookups", () => {
  let db: DatabaseHandle;
  const now = new Date().toISOString();

  const addFolder = (path: string, specialUse: string | null, accountId = "account-1") =>
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, 0, 0)")
      .run(accountId, path, path, specialUse);

  const addAccount = (id: string) =>
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
    `).run(id, `${id}@example.com`, now);

  beforeEach(() => {
    db = openDatabase(":memory:");
    addAccount("account-1");
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("prefers \\Archive over \\All regardless of row order", () => {
    // The provider lists \All before \Archive for some accounts, so the physical
    // archive is the *second* matching row. The CASE ordering is the only reason
    // \Archive wins: without it SQLite returns the first row it scans.
    addFolder("[Gmail]/All Mail", "\\All");
    addFolder("Archive", "\\Archive");

    expect(resolveMoveDestination(db, "account-1", "archive"))
      .toEqual({ path: "Archive", special_use: "\\Archive" });
  });

  it("resolves every target to its own special-use folder, or null when absent", () => {
    addFolder("Archive", "\\Archive");
    addFolder("Trash", "\\Trash");
    addFolder("Junk", "\\Junk");
    addFolder("INBOX", "\\Inbox");

    const expected: Record<MessageMoveTarget, { path: string; special_use: string } | null> = {
      archive: { path: "Archive", special_use: "\\Archive" },
      trash: { path: "Trash", special_use: "\\Trash" },
      junk: { path: "Junk", special_use: "\\Junk" },
      inbox: { path: "INBOX", special_use: "\\Inbox" },
    };
    for (const [target, want] of Object.entries(expected)) {
      expect(resolveMoveDestination(db, "account-1", target as MessageMoveTarget)).toEqual(want);
    }
  });

  it("returns null for a target the account has no folder for", () => {
    // Also the cross-account case: a folder that exists is not a destination
    // when it belongs to somebody else.
    addFolder("Archive", "\\Archive");
    addAccount("account-2");
    addFolder("Trash", "\\Trash", "account-2");

    expect(resolveMoveDestination(db, "account-1", "trash")).toBeNull();
    expect(resolveMoveDestination(db, "account-2", "trash")).toEqual({ path: "Trash", special_use: "\\Trash" });
  });

  it("falls back to \\All when the account has no \\Archive", () => {
    addFolder("[Gmail]/All Mail", "\\All");
    expect(resolveMoveDestination(db, "account-1", "archive"))
      .toEqual({ path: "[Gmail]/All Mail", special_use: "\\All" });
  });

  it("compiles the destination lookup once per special-use width, never per target", () => {
    addFolder("Archive", "\\Archive");
    addFolder("Trash", "\\Trash");
    addFolder("Junk", "\\Junk");
    addFolder("INBOX", "\\Inbox");
    const prepare = db.prepare.bind(db);
    const compiled: string[] = [];
    const bound: unknown[][] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!sql.replace(/\s+/g, " ").includes("SELECT path, special_use FROM folders WHERE account_id = ? AND special_use IN (")) return statement;
      compiled.push(sql);
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "get") {
            return (...params: unknown[]) => {
              bound.push(params);
              return (target.get as (...args: unknown[]) => unknown)(...params);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    const targets: MessageMoveTarget[] = ["archive", "trash", "junk", "inbox", "archive", "inbox"];
    for (const target of targets) expect(resolveMoveDestination(db, "account-1", target)).not.toBeNull();

    // Two widths, two compiles: `archive` carries two special uses and the
    // other three targets share the single-placeholder statement. Six lookups,
    // two compiles. The counts below are the `?` inside the `IN` list — the
    // statement also binds `account_id`, hence one more each.
    expect(compiled).toHaveLength(2);
    expect(compiled.map((sql) => (sql.match(/special_use IN \(([^)]*)\)/)?.[1]?.match(/\?/g)?.length ?? 0)).sort()).toEqual([1, 2]);
    // The `?` count must match the bindings that are handed to it. A cache
    // keyed on anything but the width — the target name, a single shared
    // bucket — hands `trash` a two-placeholder statement and the driver throws
    // `RangeError: Too many parameter values were provided`.
    expect(bound).toEqual([
      ["account-1", "\\Archive", "\\All"],
      ["account-1", "\\Trash"],
      ["account-1", "\\Junk"],
      ["account-1", "\\Inbox"],
      ["account-1", "\\Archive", "\\All"],
      ["account-1", "\\Inbox"],
    ]);
    // Nothing is interpolated: the special-use names are values, never text.
    for (const sql of compiled) expect(sql).not.toContain("\\\\Trash");
  });

  it("reads the folders row on every call, so a later folder change is seen", () => {
    // The cache holds the compiled statement, never a result: caching the row
    // instead would freeze the destination for the life of the connection.
    expect(resolveMoveDestination(db, "account-1", "trash")).toBeNull();
    addFolder("Later Trash", "\\Trash");
    expect(resolveMoveDestination(db, "account-1", "trash"))
      .toEqual({ path: "Later Trash", special_use: "\\Trash" });
  });

  it("compiles each account read once per connection and keeps the handles apart", () => {
    const other = openDatabase(":memory:");
    try {
      other.prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password,
          imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
          username_mode, status, created_at
        ) VALUES ('account-1', 'other@example.com', 'custom', 'Demo', 'encrypted', 'imap.example.com', 993, 1, 'smtp.example.com', 465, 1, 'email', 'connected', ?)
      `).run(now);
      const prepare = db.prepare.bind(db);
      const compiled: string[] = [];
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("FROM accounts WHERE id = ?")) compiled.push(sql);
        return prepare(sql);
      });

      for (let i = 0; i < 5; i += 1) expect(accountById(db, "account-1")?.id).toBe("account-1");
      expect(accountExists(db, "account-1")).toBe(true);
      expect(accountExists(db, "missing")).toBe(false);
      expect(accountById(db, "missing")).toBeUndefined();
      // Two statements, however many reads.
      expect(compiled).toEqual([
        "SELECT * FROM accounts WHERE id = ?",
        "SELECT 1 FROM accounts WHERE id = ?",
      ]);
      // The other connection's rows are reachable: a cache that leaked across
      // handles would hand this a statement bound to the first connection.
      expect(accountById(other, "account-1")?.email).toBe("other@example.com");
      expect(accountById(db, "account-1")?.email).toBe("account-1@example.com");
    } finally {
      other.close();
    }
  });

  it("reads the account row on every call, so a later change is seen", () => {
    const before = accountById(db, "account-1");
    expect(before?.email).toBe("account-1@example.com");
    db.prepare("UPDATE accounts SET email = ? WHERE id = ?").run("renamed@example.com", "account-1");
    expect(accountById(db, "account-1")?.email).toBe("renamed@example.com");
    db.prepare("DELETE FROM accounts WHERE id = ?").run("account-1");
    expect(accountById(db, "account-1")).toBeUndefined();
    expect(accountExists(db, "account-1")).toBe(false);
  });
});
