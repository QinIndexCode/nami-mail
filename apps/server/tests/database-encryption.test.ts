import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseKeyLiteral, ensureDatabaseEncrypted } from "../src/database-encryption.js";
import { openDatabase } from "../src/db.js";
import { loadDatabaseConstructor } from "../src/native-sqlite.js";

const PLAINTEXT_HEADER = "SQLite format 3\u0000";
// A distinctive string whose only purpose is to be searched for in the raw bytes
// of the file, so that "encrypted at rest" stays a falsifiable claim.
const CANARY = "CANARY-SUBJECT-9f2c41d7-plaintext-mail-text";

function headerOf(filePath: string): string {
  return fs.readFileSync(filePath).subarray(0, PLAINTEXT_HEADER.length).toString("latin1");
}

function masterKey(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

describe("database encryption at rest", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      // A failing test can leave a connection open, and Windows then refuses to
      // remove the directory for a moment. Retry briefly so one real failure is
      // not reported as a second, unrelated cleanup error.
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 5) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
      }
    }
  });

  function storePath(label: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `nami-mail-enc-${label}-`));
    temporaryDirectories.push(directory);
    return path.join(directory, "nami-mail.db");
  }

  /** A plaintext store: exactly what the previous build left on disk. */
  function writePlaintextStore(filePath: string, subject: string): void {
    const SqliteDatabase = loadDatabaseConstructor();
    const db = new SqliteDatabase(filePath);
    try {
      db.prepare("CREATE TABLE messages (id INTEGER PRIMARY KEY, subject TEXT NOT NULL)").run();
      db.prepare("INSERT INTO messages (subject) VALUES (?)").run(subject);
    } finally {
      db.close();
    }
  }

  function readWithKey(filePath: string, key: Buffer): unknown {
    const SqliteDatabase = loadDatabaseConstructor();
    const db = new SqliteDatabase(filePath);
    try {
      db.prepare(`PRAGMA key = ${databaseKeyLiteral(key)}`).run();
      return db.prepare("SELECT subject FROM messages").pluck().get();
    } finally {
      db.close();
    }
  }

  it("reports an absent store instead of creating one", () => {
    const databasePath = storePath("absent");
    expect(ensureDatabaseEncrypted(databasePath, masterKey(1))).toEqual({ status: "absent" });
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("treats a zero-byte store as empty rather than plaintext", () => {
    const databasePath = storePath("empty");
    fs.writeFileSync(databasePath, Buffer.alloc(0));
    expect(ensureDatabaseEncrypted(databasePath, masterKey(1))).toEqual({ status: "empty" });
  });

  it("creates a fresh store already encrypted", () => {
    const databasePath = storePath("fresh");
    const db = openDatabase(databasePath, { encryptionKey: masterKey(2) });
    try {
      // A write is required: a keyed connection that never writes leaves a
      // zero-byte file behind, which would make this test vacuous.
      db.prepare("CREATE TABLE encryption_probe (id INTEGER PRIMARY KEY)").run();
      db.prepare("INSERT INTO encryption_probe (id) VALUES (1)").run();
    } finally {
      db.close();
    }

    expect(headerOf(databasePath)).not.toBe(PLAINTEXT_HEADER);
    expect(ensureDatabaseEncrypted(databasePath, masterKey(2))).toEqual({ status: "already-encrypted" });
  });

  it("converts a plaintext store and keeps every row readable with the key", () => {
    const databasePath = storePath("convert");
    writePlaintextStore(databasePath, CANARY);
    expect(headerOf(databasePath)).toBe(PLAINTEXT_HEADER);

    const outcome = ensureDatabaseEncrypted(databasePath, masterKey(3));
    expect(outcome.status).toBe("encrypted");
    expect(headerOf(databasePath)).not.toBe(PLAINTEXT_HEADER);
    // No staging copy is left behind for the next launch to trip over.
    expect(fs.existsSync(`${databasePath}.encrypting`)).toBe(false);
    expect(readWithKey(databasePath, masterKey(3))).toBe(CANARY);

    // Without the key the file has to be unreadable, not merely inconvenient.
    expect(() => {
      const SqliteDatabase = loadDatabaseConstructor();
      const keyless = new SqliteDatabase(databasePath);
      try {
        keyless.prepare("SELECT COUNT(*) FROM sqlite_master").pluck().get();
      } finally {
        keyless.close();
      }
    }).toThrow();
  });

  it("leaves no plaintext mail text in the file after conversion", () => {
    const databasePath = storePath("canary");
    writePlaintextStore(databasePath, CANARY);
    expect(fs.readFileSync(databasePath).includes(CANARY)).toBe(true);

    ensureDatabaseEncrypted(databasePath, masterKey(4));

    expect(fs.readFileSync(databasePath).includes(CANARY)).toBe(false);
  });

  it("is idempotent and never rewrites a store that is already sealed", () => {
    const databasePath = storePath("idempotent");
    writePlaintextStore(databasePath, CANARY);
    ensureDatabaseEncrypted(databasePath, masterKey(5));
    const sealed = fs.readFileSync(databasePath);

    expect(ensureDatabaseEncrypted(databasePath, masterKey(5))).toEqual({ status: "already-encrypted" });
    expect(fs.readFileSync(databasePath).equals(sealed)).toBe(true);
  });

  it("refuses a store sealed with a different key and leaves the bytes untouched", () => {
    const databasePath = storePath("wrongkey");
    writePlaintextStore(databasePath, CANARY);
    ensureDatabaseEncrypted(databasePath, masterKey(6));
    const sealed = fs.readFileSync(databasePath);

    expect(() => ensureDatabaseEncrypted(databasePath, masterKey(7))).toThrow(
      /could not be opened with the current master key/u,
    );
    expect(fs.readFileSync(databasePath).equals(sealed)).toBe(true);
    // The real key still works: a failed attempt must not damage the store.
    expect(readWithKey(databasePath, masterKey(6))).toBe(CANARY);
  });
});
