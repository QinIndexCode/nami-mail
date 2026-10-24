import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { isSealedLocalFile, localFilePurposes, openLocalFile, sealLocalFile } from "./local-file-encryption.js";
import { serverLog } from "./logging.js";
import { getAppSettings } from "./settings.js";
import type { RuntimeContext } from "./types.js";

// ---------------------------------------------------------------------------
// The custom background image
//
// The one user-supplied image the server keeps in its data directory, and the
// only file there whose contents the user picked by hand rather than received in
// mail. It is sealed like the image cache (see local-file-encryption.ts) so that
// the data directory holds no readable user content at all.
//
// The FILENAME stays as it was, extension included, because the read path
// derives the content-type from it and the stored setting already points at it.
// Nothing about a random UUID plus an extension is sensitive, and the AAD binds
// the sealed bytes to that name, so a file cannot be renamed into another slot
// and still open.
// ---------------------------------------------------------------------------

export const customBackgroundPattern = /^custom-background-[a-f0-9-]+\.(jpg|png|webp)$/;

export function customBackgroundDirectory(context: Pick<RuntimeContext, "backgroundDirectory">): string {
  return context.backgroundDirectory ?? path.join(path.dirname(config.databasePath), "backgrounds");
}

export function customBackgroundPath(
  context: Pick<RuntimeContext, "backgroundDirectory">,
  filename: string | null,
): string | undefined {
  if (!filename || !customBackgroundPattern.test(filename)) return undefined;
  return path.join(customBackgroundDirectory(context), filename);
}

function customBackgroundAad(filename: string): string {
  return `custom-background\0${filename}`;
}

const backgroundContentTypes: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** The content type to serve a stored background under, from its extension. */
export function customBackgroundContentType(filename: string): string {
  return backgroundContentTypes[path.extname(filename).toLowerCase()] ?? "image/jpeg";
}

/** Whether the given setting names a background that is actually on disk. */
export function hasStoredCustomBackground(
  context: Pick<RuntimeContext, "backgroundDirectory">,
  filename: string | null,
): boolean {
  const filePath = customBackgroundPath(context, filename);
  return Boolean(filePath && fs.existsSync(filePath));
}

/**
 * The background the settings currently point at: the validated filename (which
 * the AAD needs) together with the path it resolves to, or `undefined` when
 * there is none — no setting, a filename from an older format, or no directory.
 */
function storedCustomBackground(
  context: Pick<RuntimeContext, "db" | "backgroundDirectory">,
): { filename: string; filePath: string } | undefined {
  const { customBackgroundFilename } = getAppSettings(context.db);
  const filePath = customBackgroundPath(context, customBackgroundFilename);
  if (!customBackgroundFilename || !filePath) return undefined;
  return { filename: customBackgroundFilename, filePath };
}

export function sealCustomBackground(masterKey: Buffer, filename: string, bytes: Buffer): Buffer {
  return sealLocalFile(masterKey, localFilePurposes.backgroundContent, customBackgroundAad(filename), bytes);
}

/**
 * Read the background image back, or `undefined` when the bytes cannot be
 * trusted (a sealed file that will not open: the wrong key, or an edited file).
 *
 * An UNSEALED payload is returned as it is. That is the file the user uploaded
 * before this existed, and refusing to serve it would replace their chosen
 * background with a blank one until the next start migrated it — a visible
 * regression for a privacy fix that is meant to be invisible.
 */
export function openCustomBackground(masterKey: Buffer, filename: string, payload: Buffer): Buffer | undefined {
  if (!isSealedLocalFile(payload)) return payload;
  try {
    return openLocalFile(masterKey, localFilePurposes.backgroundContent, customBackgroundAad(filename), payload);
  } catch {
    return undefined;
  }
}

/**
 * Write a freshly normalized background upload and report where it landed. The
 * seal happens here rather than at the call site so there is no way to write
 * this file in the clear, and the rename keeps a half-written image from ever
 * being the file the read path serves.
 */
export function storeCustomBackground(
  context: Pick<RuntimeContext, "backgroundDirectory">,
  masterKey: Buffer,
  bytes: Buffer,
  extension: string,
): { filename: string; filePath: string } {
  const directory = customBackgroundDirectory(context);
  fs.mkdirSync(directory, { recursive: true });
  const filename = `custom-background-${randomUUID()}.${extension}`;
  const filePath = path.join(directory, filename);
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, sealCustomBackground(masterKey, filename, bytes), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  return { filename, filePath };
}

/**
 * The background image the settings point at, ready to serve, or `undefined`
 * when there is nothing to serve: no setting, no file, or a sealed file that
 * will not open. A file that will not open is reported rather than passed off
 * as a missing one, because it means tampering or a replaced master key, not an
 * empty slot.
 */
export function readCustomBackground(
  context: RuntimeContext,
  masterKey: Buffer,
): { bytes: Buffer; contentType: string } | undefined {
  const stored = storedCustomBackground(context);
  if (!stored) return undefined;
  let payload: Buffer;
  try {
    payload = fs.readFileSync(stored.filePath);
  } catch {
    return undefined;
  }
  const bytes = openCustomBackground(masterKey, stored.filename, payload);
  if (!bytes) {
    serverLog.warn({}, "Stored custom background image could not be decrypted and was not served");
    return undefined;
  }
  return { bytes, contentType: customBackgroundContentType(stored.filename) };
}

/**
 * Seal a background image that is still stored in the clear. Runs once on the
 * startup path, next to the other storage migrations; it is idempotent (a sealed
 * file is left alone), it is a no-op when no custom background is set, and a
 * failure is reported and skipped rather than thrown — a locked or unreadable
 * wallpaper must not stop mail from starting.
 */
export function migrateCustomBackground(context: RuntimeContext, masterKey: Buffer): boolean {
  const stored = storedCustomBackground(context);
  if (!stored) return false;
  const { filename, filePath } = stored;
  let payload: Buffer;
  try {
    payload = fs.readFileSync(filePath);
  } catch {
    // Nothing stored (the setting and the file drifted apart), or a lock. Either
    // way there is nothing to migrate and the read path already treats the
    // background as absent.
    return false;
  }
  if (isSealedLocalFile(payload)) return false;
  const temporaryPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, sealCustomBackground(masterKey, filename, payload), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* nothing staged */ }
    serverLog.warn({ error }, "Custom background image could not be encrypted and stays readable on disk");
    return false;
  }
}
