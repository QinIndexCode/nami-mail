import fs from "node:fs";
import path from "node:path";

/**
 * Durable renderer preferences. The desktop renderer's origin is
 * http://127.0.0.1:<ephemeral port> (the local service binds PORT=0), which
 * changes on every launch, so per-origin browser storage (localStorage) is
 * wiped between sessions. Preferences that must survive a restart are
 * mirrored into this main-process JSON file under userData, following the
 * same pattern as the broker state and client profile files. This is
 * renderer preference data only: the local mail service never sees it and
 * nothing here enters the server's encrypted store.
 */
export const RENDERER_LOCAL_STORE_SCHEMA_VERSION = 1;
export const RENDERER_LOCAL_STORE_MAX_ENTRIES = 256;
export const RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH = 1_000_000;
export const RENDERER_LOCAL_STORE_MAX_KEY_LENGTH = 200;

const KEY_PREFIX = "nami-mail.";

export function rendererLocalStorePath(userDataPath: string): string {
  return path.join(userDataPath, "renderer-local-store.json");
}

/** Keys are renderer preference names ("nami-mail.<feature>[.<detail>]"). */
export function isValidRendererLocalStoreKey(key: unknown): key is string {
  return typeof key === "string"
    && key.startsWith(KEY_PREFIX)
    && key.length > KEY_PREFIX.length
    && key.length <= RENDERER_LOCAL_STORE_MAX_KEY_LENGTH
    && !hasControlCharacters(key);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseStoreFile(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("store is not an object");
  const { schemaVersion, entries } = parsed as { schemaVersion?: unknown; entries?: unknown };
  if (schemaVersion !== RENDERER_LOCAL_STORE_SCHEMA_VERSION) throw new Error("unsupported schema version");
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("entries missing");
  const result: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (!isValidRendererLocalStoreKey(key)) continue;
    if (typeof value !== "string" || value.length > RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH) continue;
    result[key] = value;
    count += 1;
    if (count > RENDERER_LOCAL_STORE_MAX_ENTRIES) throw new Error("too many entries");
  }
  return result;
}

/**
 * Reads the store. A missing file yields {}. A corrupt file (torn write, disk
 * full, killed process) is quarantined by renaming it out of the way and the
 * read degrades to an empty store — it never throws.
 */
export function readRendererLocalStore(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  try {
    return parseStoreFile(raw);
  } catch {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch {
      // Quarantine is best-effort; the empty store below is still safe.
    }
    return {};
  }
}

export type RendererLocalStoreWriteResult = {
  saved: boolean;
  reason?: "invalid-key" | "invalid-value" | "too-many-entries" | "write-failed";
};

/**
 * Upserts (value as string) or deletes (value as null) one entry. The write
 * is atomic: a temporary file is fully written, then renamed over the target
 * (atomic on POSIX rename(2) and on Windows MoveFileExW with
 * REPLACE_EXISTING), so a torn write can never produce a half-updated store.
 */
export function writeRendererLocalStoreEntry(filePath: string, key: unknown, value: unknown): RendererLocalStoreWriteResult {
  if (!isValidRendererLocalStoreKey(key)) return { saved: false, reason: "invalid-key" };
  if (value !== null && (typeof value !== "string" || value.length > RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH)) {
    return { saved: false, reason: "invalid-value" };
  }
  const entries = readRendererLocalStore(filePath);
  if (value === null) {
    delete entries[key];
  } else {
    if (!(key in entries) && Object.keys(entries).length >= RENDERER_LOCAL_STORE_MAX_ENTRIES) {
      return { saved: false, reason: "too-many-entries" };
    }
    entries[key] = value;
  }
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ schemaVersion: RENDERER_LOCAL_STORE_SCHEMA_VERSION, entries }), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up; the target file was never touched.
    }
    return { saved: false, reason: "write-failed" };
  }
  return { saved: true };
}
