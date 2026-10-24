import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { updateAppSettings } from "../src/settings.js";
import { setServerLogger } from "../src/logging.js";
import { isSealedLocalFile } from "../src/local-file-encryption.js";
import { customBackgroundPath, hasStoredCustomBackground, migrateCustomBackground, openCustomBackground, readCustomBackground, sealCustomBackground, storeCustomBackground } from "../src/background-image.js";
import type { RuntimeContext } from "../src/types.js";

// The custom background is the one image the user picks by hand, and it used to
// be the one file in the data directory whose bytes anyone could read: whole-file
// database encryption covers SQLite and nothing else. It is now sealed like the
// image cache, and the properties that matter are the ones a route-level upload
// test cannot see, because a correct seal is invisible from the API:
//
//   1. the bytes on disk are a seal, not the image, and the target is reached by
//      a rename so a crash never leaves a half-written wallpaper to serve;
//   2. a background written before the seal existed is still served — refusing
//      it would replace the user's wallpaper with a blank one;
//   3. a sealed file that was edited, or renamed onto another slot, does not
//      open, and that is reported rather than passed off as "no background";
//   4. the one-time migration seals a legacy file, is idempotent, and reports a
//      failure instead of throwing one out of the startup path.

/** A name the store itself could have written: a UUID plus a known extension. */
function backgroundName(extension: "jpg" | "png" | "webp" = "png", suffix = "1"): string {
  return `custom-background-00000000-0000-4000-8000-00000000000${suffix}.${extension}`;
}

const BACKGROUND_NAME_RE = /^custom-background-[a-f0-9-]+\.(jpg|png|webp)$/;

/**
 * Resolve a fixture file this test owns inside its throwaway background
 * directory. The name has to be a plain basename and has to land on the direct
 * child it looks like — the containment `customBackgroundPath` is built around.
 * A fixture must not be able to write outside the directory it was handed,
 * however it came by the name.
 */
function fixturePath(directory: string, name: string): string {
  if (name.length === 0 || name !== path.basename(name)) {
    throw new Error(`not a plain file name: ${name}`);
  }
  const resolved = path.resolve(directory, name);
  if (resolved !== path.join(directory, name)) throw new Error(`escapes the background directory: ${name}`);
  return resolved;
}

/** Write a plaintext fixture — the shape an upload had before the seal. */
function writeFixture(directory: string, name: string, bytes: Buffer): void {
  fs.writeFileSync(fixturePath(directory, name), bytes);
}

/** Break an envelope's authentication tag, which is its last 16 bytes. */
function damageSealed(payload: Buffer): Buffer {
  const damaged = Buffer.from(payload);
  const last = damaged.length - 1;
  damaged.writeUInt8(damaged.readUInt8(last) ^ 0xff, last);
  return damaged;
}

describe("custom background at rest", () => {
  let directory: string;
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const warns: Array<{ meta: object; message: string }> = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-background-"));
    db = openDatabase(":memory:");
    warns.length = 0;
    setServerLogger({
      info: () => undefined,
      warn: (meta, message) => warns.push({ meta, message }),
      error: () => undefined,
    });
  });

  afterEach(() => {
    setServerLogger(undefined);
    vi.restoreAllMocks();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Only the two fields the background paths read. Everything else on the
   * runtime context belongs to surfaces these functions never touch, and
   * stubbing it would suggest they do.
   */
  function context(): RuntimeContext {
    return { db, backgroundDirectory: directory } as unknown as RuntimeContext;
  }

  /** Point the stored setting at a filename, as the upload route does. */
  function pointSettingsAt(filename: string | null): void {
    updateAppSettings(db, { customBackgroundFilename: filename });
  }

  it("writes the upload as a seal, staged and renamed into place", () => {
    const plaintext = Buffer.from("the wallpaper the user picked, as bytes", "utf8");
    const { filename, filePath } = storeCustomBackground(context(), masterKey, plaintext, "png");

    expect(BACKGROUND_NAME_RE.test(filename)).toBe(true);
    const onDisk = fs.readFileSync(filePath);
    expect(isSealedLocalFile(onDisk)).toBe(true);
    expect(onDisk.equals(plaintext)).toBe(false);

    // Staging was renamed onto the target, not left beside it: the directory
    // holds the one file the setting points at and nothing else.
    expect(fs.readdirSync(directory)).toEqual([filename]);
  });

  it("round-trips the sealed upload through the read path", () => {
    const plaintext = Buffer.from("a jpeg body, in the clear, for the length of one call", "utf8");
    const { filename } = storeCustomBackground(context(), masterKey, plaintext, "jpg");
    pointSettingsAt(filename);

    const background = readCustomBackground(context(), masterKey);
    expect(background?.bytes.equals(plaintext)).toBe(true);
    expect(background?.contentType).toBe("image/jpeg");
    expect(warns).toEqual([]);
  });

  it("serves a background left in the clear instead of blanking it", () => {
    // The file a user uploaded before this existed. Returning nothing here would
    // be the privacy fix showing up as a lost wallpaper until the next start
    // migrated it, which is the regression the read path deliberately avoids.
    const plaintext = Buffer.from("a legacy wallpaper nobody sealed", "utf8");
    const filename = backgroundName("png");
    writeFixture(directory, filename, plaintext);
    pointSettingsAt(filename);

    const background = readCustomBackground(context(), masterKey);
    expect(background?.bytes.equals(plaintext)).toBe(true);
    expect(warns).toEqual([]);
  });

  it("refuses a sealed background whose bytes were edited, and says so", () => {
    const { filename } = storeCustomBackground(context(), masterKey, Buffer.from("wallpaper"), "png");
    pointSettingsAt(filename);
    const file = fixturePath(directory, filename);
    fs.writeFileSync(file, damageSealed(fs.readFileSync(file)));

    expect(readCustomBackground(context(), masterKey)).toBeUndefined();
    // Reported, not silently treated as an absent background: a file that will
    // not open means tampering or a replaced master key, not an empty slot.
    expect(warns).toEqual([{ meta: {}, message: "Stored custom background image could not be decrypted and was not served" }]);
  });

  it("binds the seal to the filename it was written for", () => {
    const { filename } = storeCustomBackground(context(), masterKey, Buffer.from("wallpaper"), "png");
    const other = backgroundName("png", "2");
    // A valid background name the bytes were never sealed under: the AAD stops
    // the file from being moved into another slot and served from there.
    fs.renameSync(fixturePath(directory, filename), fixturePath(directory, other));
    pointSettingsAt(other);

    expect(readCustomBackground(context(), masterKey)).toBeUndefined();
    expect(warns).toHaveLength(1);
  });

  it("answers an unsealed payload with those bytes and a sealed one only through its key", () => {
    const bytes = Buffer.from("wallpaper");
    const filename = backgroundName("webp");
    const sealed = sealCustomBackground(masterKey, filename, bytes);

    expect(isSealedLocalFile(sealed)).toBe(true);
    expect(openCustomBackground(masterKey, filename, sealed)?.equals(bytes)).toBe(true);
    // Unsealed is the legacy path, passed through untouched.
    expect(openCustomBackground(masterKey, filename, bytes)?.equals(bytes)).toBe(true);
    // A different master key opens nothing; the seal answers to the key alone.
    expect(openCustomBackground(Buffer.alloc(32, 9), filename, sealed)).toBeUndefined();
  });

  it("accepts only the names the store itself writes", () => {
    const valid = backgroundName("webp");
    expect(customBackgroundPath(context(), valid)).toBe(fixturePath(directory, valid));

    for (const name of [
      "../../evil.png", // traversal
      "custom-background-1.png/../../evil.png", // traversal behind a valid prefix
      "custom-background-nope.svg", // extension the read path cannot type
      "wallpaper.png", // not a name this store ever produced
      "custom-background-00000000-0000-4000-8000-000000000001.png.bak", // a staged leftover
    ]) {
      expect(customBackgroundPath(context(), name), name).toBeUndefined();
    }
    expect(customBackgroundPath(context(), null)).toBeUndefined();
  });

  it("reports a stored background only when the file is really there", () => {
    const filename = backgroundName("png");
    expect(hasStoredCustomBackground(context(), filename)).toBe(false);

    writeFixture(directory, filename, Buffer.from("wallpaper"));
    expect(hasStoredCustomBackground(context(), filename)).toBe(true);

    expect(hasStoredCustomBackground(context(), null)).toBe(false);
    expect(hasStoredCustomBackground(context(), "../../evil.png")).toBe(false);
  });

  it("seals a background left in the clear, and only once", () => {
    const plaintext = Buffer.from("a legacy wallpaper nobody sealed", "utf8");
    const filename = backgroundName("webp");
    writeFixture(directory, filename, plaintext);
    pointSettingsAt(filename);

    expect(migrateCustomBackground(context(), masterKey)).toBe(true);
    const sealedOnce = fs.readFileSync(fixturePath(directory, filename));
    expect(isSealedLocalFile(sealedOnce)).toBe(true);
    expect(openCustomBackground(masterKey, filename, sealedOnce)?.equals(plaintext)).toBe(true);

    // The second start of the same install: already sealed, so nothing is
    // rewritten — the bytes stay put, and the answer says no work was done.
    expect(migrateCustomBackground(context(), masterKey)).toBe(false);
    expect(fs.readFileSync(fixturePath(directory, filename))).toEqual(sealedOnce);
    expect(warns).toEqual([]);
  });

  it("leaves an already sealed background alone, and does nothing when none is set", () => {
    const { filename } = storeCustomBackground(context(), masterKey, Buffer.from("wallpaper"), "png");
    pointSettingsAt(filename);
    expect(migrateCustomBackground(context(), masterKey)).toBe(false);

    pointSettingsAt(null);
    expect(migrateCustomBackground(context(), masterKey)).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([filename]);
  });

  it("reports a failed migration instead of throwing, and leaves the readable file", () => {
    const plaintext = Buffer.from("a legacy wallpaper nobody sealed", "utf8");
    const filename = backgroundName("jpg");
    writeFixture(directory, filename, plaintext);
    pointSettingsAt(filename);

    const error = Object.assign(new Error("EACCES: injected write failure"), { code: "EACCES" });
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw error;
    });

    // A locked or unreadable wallpaper must not stop mail from starting.
    expect(migrateCustomBackground(context(), masterKey)).toBe(false);
    expect(warns).toEqual([{ meta: { error }, message: "Custom background image could not be encrypted and stays readable on disk" }]);
    // Nothing was staged behind the failure, and the file the user picked is
    // still served from the clear rather than dropped.
    expect(fs.readdirSync(directory)).toEqual([filename]);
    expect(readCustomBackground(context(), masterKey)?.bytes.equals(plaintext)).toBe(true);
  });
});
