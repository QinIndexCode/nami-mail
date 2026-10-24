import fs from "node:fs";
import path from "node:path";
import { deriveEncryptionKey } from "./crypto.js";
import { loadDatabaseConstructor, type Database } from "./native-sqlite.js";

// Whole-file encryption of the store. Every plaintext mirror of mail text lives
// in this one file -- `messages`, the FTS5 shadow tables, the agent RAG postings
// and the auto-reply thread keys -- so sealing the file covers all of them at
// once. Surfaces that live outside it (the image cache, backgrounds, outbound
// attachments) are not covered here.
const PLAINTEXT_HEADER = Buffer.from("SQLite format 3\u0000", "latin1");
const STAGING_SUFFIX = ".encrypting";
// Where an unreadable staging copy is preserved when it is the only survivor:
// quarantine, not deletion, so the matching key (or a backup) can still reach it.
const UNREADABLE_STAGING_SUFFIX = ".unreadable";
// Distinct HKDF purpose so the file cipher never shares key material with the
// per-field envelopes in crypto.ts.
const FILE_KEY_PURPOSE = "sqlite-file-v1";
const zeroOverwriteChunkBytes = 64 * 1024;

export type DatabaseEncryptionOutcome =
  | { status: "absent" }
  | { status: "empty" }
  | { status: "already-encrypted" }
  | { status: "encrypted"; bytes: number; verifiedTables: number }
  // A previous conversion was killed after it destroyed the plaintext original
  // but before the sealed copy reached its final name. The staging file is the
  // only surviving database and was adopted.
  | { status: "recovered"; bytes: number; verifiedTables: number }
  // The only surviving copy of a killed conversion could not be opened with the
  // current master key, so it was preserved beside the store instead of deleted
  // and the app continues with a fresh database. The old copy is recoverable only
  // with the key that sealed it (or a backup of that key).
  | { status: "quarantined" };

/** Raw-hex key literal, quoted for `PRAGMA key = <literal>` interpolation. */
export function databaseKeyLiteral(masterKey: Buffer): string {
  const key = deriveEncryptionKey(masterKey, FILE_KEY_PURPOSE);
  return `"x'${key.toString("hex")}'"`;
}

function removeIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Windows can keep a just-closed file locked for a moment (indexer, AV).
    // The caller decides whether the leftover actually matters.
  }
}

function readHeader(filePath: string): Buffer {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(PLAINTEXT_HEADER.length);
    const read = fs.readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, read);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isPlaintextSqlite(header: Buffer): boolean {
  return header.length === PLAINTEXT_HEADER.length && header.equals(PLAINTEXT_HEADER);
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

function userTables(db: Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[];
}

/** Schema objects, so a copy that lost or altered a table is caught too. */
function objectFingerprint(db: Database): string {
  return JSON.stringify(
    db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
  );
}

function rowCounts(db: Database, tables: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    counts.set(table, db.prepare(`SELECT COUNT(*) FROM ${quoteIdentifier(table)}`).pluck().get() as number);
  }
  return counts;
}

function assertReadableWithKey(databasePath: string, masterKey: Buffer): void {
  const SqliteDatabase = loadDatabaseConstructor();
  const db = new SqliteDatabase(databasePath);
  try {
    db.prepare(`PRAGMA key = ${databaseKeyLiteral(masterKey)}`).run();
    // Without a key SQLite3MultipleCiphers opens lazily and only fails on the
    // first page read, so a connection that is merely constructed proves
    // nothing: this read is what actually validates the key.
    db.prepare("SELECT COUNT(*) FROM sqlite_master").pluck().get();
  } catch (error) {
    throw new Error(
      `${databasePath} is encrypted and could not be opened with the current master key. `
      + "The file was left untouched; restore the matching master key or move the file aside.",
      { cause: error },
    );
  } finally {
    db.close();
  }
}

/**
 * Tables of a store that opens with `masterKey`, or `undefined` when it does not.
 * Unlike {@link assertReadableWithKey} this never throws, because recovery has to
 * answer "is this file usable?" without aborting: the answer decides whether a
 * leftover staging copy or the main file is authoritative.
 */
function readableTablesWithKey(databasePath: string, masterKey: Buffer): string[] | undefined {
  if (!fs.existsSync(databasePath)) return undefined;
  const SqliteDatabase = loadDatabaseConstructor();
  let db: Database | undefined;
  try {
    db = new SqliteDatabase(databasePath);
    db.prepare(`PRAGMA key = ${databaseKeyLiteral(masterKey)}`).run();
    // Same reason as assertReadableWithKey: only a page read proves the key.
    db.prepare("SELECT COUNT(*) FROM sqlite_master").pluck().get();
    return userTables(db);
  } catch {
    return undefined;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Releasing a connection that already failed is not the caller's question.
      }
    }
  }
}

/**
 * Whether the main file is a store this key can use: intact plaintext (the
 * conversion has not run yet) or sealed for this key.
 */
function mainFileUsable(databasePath: string, masterKey: Buffer): boolean {
  if (!fs.existsSync(databasePath)) return false;
  if (fs.statSync(databasePath).size === 0) return false;
  if (isPlaintextSqlite(readHeader(databasePath))) return true;
  return readableTablesWithKey(databasePath, masterKey) !== undefined;
}

/**
 * Adopts an orphaned staging copy when a conversion died between destroying the
 * plaintext original and the final rename. Discarding it in that state (the
 * previous behaviour) deleted the only readable database and let the next open
 * create an empty one, turning a crash into silent total local data loss.
 *
 * Returns `undefined` when the caller should look at the main file instead:
 * either the main file is authoritative (the staging leftover has been removed),
 * or the main file is present but unreadable -- the staged copy is left in place
 * so the key that sealed it can still adopt it on a later boot, while the
 * caller's own readability assert refuses to boot on the destroyed original.
 * Returns `{ status: "quarantined" }` when the main file is gone AND the staged
 * copy will not open with this key: the copy is then the only survivor,
 * unreadable here, and is preserved under the `.unreadable` name rather than
 * deleted -- deleting it turned "a crash plus a changed key" into silent total
 * local data loss too, because the caller would have created a fresh store on
 * top of nothing.
 */
function recoverInterruptedConversion(
  databasePath: string,
  stagingPath: string,
  masterKey: Buffer,
): DatabaseEncryptionOutcome | undefined {
  if (!fs.existsSync(stagingPath)) return undefined;
  const stagingTables = readableTablesWithKey(stagingPath, masterKey);
  if (!stagingTables) {
    if (mainFileUsable(databasePath, masterKey)) {
      // Not a usable copy of this store, and the original is authoritative, so
      // this is dead weight from an attempt that never finished.
      removeIfExists(stagingPath);
      return undefined;
    }
    if (fs.existsSync(databasePath)) {
      // The main file is present but unreadable (a conversion already destroyed
      // it and died before the rename). The staged copy is the only copy that
      // still has the data -- even though this key cannot open it -- so it stays
      // under its own name: with the key that sealed it, a later boot reaches
      // the adoption branch below. This key gets the loud refusal instead of a
      // silent fresh store, via `assertReadableWithKey` in the caller.
      return undefined;
    }
    // The main file is gone: the staged copy is the only survivor, and this key
    // cannot open it. Quarantine it rather than delete, so the matching key (or
    // a backup) can still reach it, and let the app boot on a fresh store.
    const quarantinePath = `${databasePath}${UNREADABLE_STAGING_SUFFIX}`;
    removeIfExists(quarantinePath);
    try {
      fs.renameSync(stagingPath, quarantinePath);
    } catch {
      // The staging name is its own quarantine then; nothing may delete it.
    }
    return { status: "quarantined" };
  }
  if (readableTablesWithKey(databasePath, masterKey)) {
    // The sealed copy is already in place; this is dead weight from an attempt
    // that never finished.
    removeIfExists(stagingPath);
    return undefined;
  }
  if (fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0 && isPlaintextSqlite(readHeader(databasePath))) {
    // The original is still intact plaintext, so the conversion simply has not
    // run yet: seal it again rather than trusting a copy it never needed.
    removeIfExists(stagingPath);
    return undefined;
  }
  // The main file is missing, zero-byte, or already zero-overwritten: the staged
  // copy is all that is left.
  removeIfExists(`${databasePath}-wal`);
  removeIfExists(`${databasePath}-shm`);
  fs.renameSync(stagingPath, databasePath);
  return { status: "recovered", bytes: fs.statSync(databasePath).size, verifiedTables: stagingTables.length };
}

function assertKeylessReadRefused(databasePath: string): void {
  const SqliteDatabase = loadDatabaseConstructor();
  let db: Database | undefined;
  try {
    db = new SqliteDatabase(databasePath);
    db.prepare("SELECT COUNT(*) FROM sqlite_master").pluck().get();
    throw new Error(`${databasePath} was read without a key after encryption.`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("was read without a key")) throw error;
  } finally {
    // The unreadable handle still holds the file open on Windows.
    if (db) {
      try {
        db.close();
      } catch {
        // A connection that already failed to read still has to be released.
      }
    }
  }
}

function checkpointIntoMainFile(databasePath: string): void {
  // A copy of the main file alone would silently drop everything committed
  // after the last checkpoint, so the write-ahead log has to be folded back in
  // before the copy is taken.
  if (!fs.existsSync(`${databasePath}-wal`)) return;
  const SqliteDatabase = loadDatabaseConstructor();
  const db = new SqliteDatabase(databasePath);
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
    if (result && result.busy !== 0) {
      throw new Error(`${databasePath} is busy; refusing to copy a partially checkpointed database.`);
    }
  } finally {
    db.close();
  }
}

function sealStagingCopy(stagingPath: string, masterKey: Buffer): void {
  const SqliteDatabase = loadDatabaseConstructor();
  const db = new SqliteDatabase(stagingPath);
  try {
    // `rekey` ALONE is what encrypts a plaintext database. Issuing `PRAGMA key`
    // first makes the connection treat the plaintext pages as ciphertext, and
    // the rekey then fails with "unsupported file format". (To re-encrypt an
    // already-encrypted database the opposite holds: the old key must be set
    // before the rekey.)
    db.prepare(`PRAGMA rekey = ${databaseKeyLiteral(masterKey)}`).run();
  } finally {
    db.close();
  }
}

function verifySealedCopy(
  stagingPath: string,
  masterKey: Buffer,
  tables: string[],
  expectedObjects: string,
  expectedCounts: Map<string, number>,
): void {
  if (isPlaintextSqlite(readHeader(stagingPath))) {
    throw new Error("The encrypted copy still has a plaintext SQLite header.");
  }
  const SqliteDatabase = loadDatabaseConstructor();
  const db = new SqliteDatabase(stagingPath);
  try {
    db.prepare(`PRAGMA key = ${databaseKeyLiteral(masterKey)}`).run();
    const integrity = db.prepare("PRAGMA integrity_check").pluck().get() as string;
    if (integrity !== "ok") throw new Error(`The encrypted copy failed integrity_check: ${integrity}`);
    if (objectFingerprint(db) !== expectedObjects) {
      throw new Error("The encrypted copy does not contain the same schema objects as the original.");
    }
    const actualCounts = rowCounts(db, tables);
    for (const table of tables) {
      const expected = expectedCounts.get(table);
      if (actualCounts.get(table) !== expected) {
        throw new Error(
          `The encrypted copy lost rows in ${table}: expected ${String(expected)}, found ${String(actualCounts.get(table))}.`,
        );
      }
    }
  } finally {
    db.close();
  }
  assertKeylessReadRefused(stagingPath);
}

/** Overwrites the file in place so plaintext mail does not survive in freed blocks. */
function zeroOverwrite(filePath: string): void {
  const { size } = fs.statSync(filePath);
  if (size === 0) return;
  const descriptor = fs.openSync(filePath, "r+");
  try {
    const zeros = Buffer.alloc(Math.min(zeroOverwriteChunkBytes, size));
    let offset = 0;
    while (offset < size) {
      offset += fs.writeSync(descriptor, zeros, 0, Math.min(zeros.length, size - offset), offset);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function encryptPlaintextStore(
  databasePath: string,
  stagingPath: string,
  masterKey: Buffer,
): DatabaseEncryptionOutcome {
  checkpointIntoMainFile(databasePath);

  const SqliteDatabase = loadDatabaseConstructor();
  const source = new SqliteDatabase(databasePath, { readonly: true });
  let tables: string[];
  let expectedObjects: string;
  let expectedCounts: Map<string, number>;
  try {
    tables = userTables(source);
    expectedObjects = objectFingerprint(source);
    expectedCounts = rowCounts(source, tables);
  } finally {
    source.close();
  }

  fs.copyFileSync(databasePath, stagingPath);
  try {
    sealStagingCopy(stagingPath, masterKey);
    verifySealedCopy(stagingPath, masterKey, tables, expectedObjects, expectedCounts);
  } catch (error) {
    // The original is untouched, so a failed conversion is not data loss.
    removeIfExists(stagingPath);
    throw error;
  }

  // Nothing is destroyed until the encrypted copy is proven readable. From here
  // the plaintext original is spent: overwrite it, drop the stale write-ahead
  // log, then move the sealed copy into place.
  zeroOverwrite(databasePath);
  fs.rmSync(databasePath, { force: true });
  removeIfExists(`${databasePath}-wal`);
  removeIfExists(`${databasePath}-shm`);
  fs.renameSync(stagingPath, databasePath);

  return { status: "encrypted", bytes: fs.statSync(databasePath).size, verifiedTables: tables.length };
}

/**
 * Leaves `databasePath` encrypted with the key derived from `masterKey`.
 * Idempotent: an already-encrypted file is only verified, never rewritten.
 */
export function ensureDatabaseEncrypted(databasePath: string, masterKey: Buffer): DatabaseEncryptionOutcome {
  const stagingPath = `${databasePath}${STAGING_SUFFIX}`;
  // A crashed conversion can leave a staging copy behind. It is normally dead
  // weight, but when the main file was already destroyed the staged copy is the
  // only readable database left, so it gets adopted instead of deleted.
  const recovered = recoverInterruptedConversion(databasePath, stagingPath, masterKey);
  if (recovered) return recovered;

  if (!fs.existsSync(databasePath)) return { status: "absent" };
  // A database created with a key but nothing written yet is a zero-byte file,
  // not a plaintext one; there is nothing to convert.
  if (fs.statSync(databasePath).size === 0) return { status: "empty" };

  if (!isPlaintextSqlite(readHeader(databasePath))) {
    assertReadableWithKey(databasePath, masterKey);
    return { status: "already-encrypted" };
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  return encryptPlaintextStore(databasePath, stagingPath, masterKey);
}
