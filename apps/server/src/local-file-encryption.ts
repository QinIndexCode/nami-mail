import { createHmac } from "node:crypto";
import fs from "node:fs";
import {
  decryptBufferEnvelope,
  deriveEncryptionKey,
  encryptBufferEnvelope,
  encryptedBufferEnvelopeOverhead,
  isEncryptedBufferEnvelope,
} from "./crypto.js";

// ---------------------------------------------------------------------------
// The files that live outside the encrypted store
//
// Whole-file database encryption covers everything that goes through SQLite.
// It cannot cover the bytes the server writes with its own `fs` calls, so each
// of those surfaces is sealed here instead of being left as the one readable
// copy of user content in the data directory:
//
//   - the image cache: both the cached bytes and the index that describes them,
//     since the index is the one place that records which remote URLs the user's
//     mail actually pulled;
//   - the custom background image the user uploaded.
//
// Two independent derivations come out of the master key for each surface:
//
//   - a CONTENT key, which seals and opens the bytes;
//   - a LOOKUP key, which turns a value that is itself sensitive -- a remote
//     URL, including its query string and any signed token in it -- into a
//     stable, unguessable name, so the cache can be indexed by URL without
//     storing one.
//
// The purpose string is part of the derivation, so a sealed image-cache file
// can never be opened as a background image or as an `outbound-attachments`
// record. The AAD is not persisted: it binds each sealed file to the slot it
// was written for, so a file moved onto another name fails to open rather than
// silently decrypting as something else.
// ---------------------------------------------------------------------------

const HKDF_PURPOSE_PREFIX = "local-file:";

export const localFilePurposes = {
  imageCacheContent: "image-cache-content-v1",
  imageCacheIndex: "image-cache-index-v1",
  imageCacheName: "image-cache-name-v1",
  backgroundContent: "background-content-v1",
} as const;

/**
 * Derived keys are memoized per master-key object, matching the pattern the
 * per-field envelopes already use: HKDF is cheap but not free, the same key is
 * asked for on every image request, and the cache entry dies with the master
 * key it was derived from.
 */
const derivedKeys = new WeakMap<Buffer, Map<string, Buffer>>();

function derivedKey(masterKey: Buffer, purpose: string): Buffer {
  let purposes = derivedKeys.get(masterKey);
  if (!purposes) {
    purposes = new Map<string, Buffer>();
    derivedKeys.set(masterKey, purposes);
  }
  const cached = purposes.get(purpose);
  if (cached) return cached;
  const key = deriveEncryptionKey(masterKey, HKDF_PURPOSE_PREFIX + purpose);
  purposes.set(purpose, key);
  return key;
}

/** Whether these bytes are a sealed local file rather than a legacy plaintext one. */
export function isSealedLocalFile(payload: Buffer): boolean {
  return isEncryptedBufferEnvelope(payload);
}

/**
 * The same question asked of a file on disk, without pulling the whole payload
 * into memory: only the fixed-size header decides it, so a 10 MB cached image
 * costs one 36-byte read. Used where a directory is swept and the answer decides
 * whether bytes are ours to keep (`listUnindexedFiles`).
 *
 * An unreadable file answers "not sealed", which is the reclaim-friendly
 * direction: the alternative would let a file that cannot be opened at all
 * survive every sweep.
 */
export function isSealedLocalFileOnDisk(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(encryptedBufferEnvelopeOverhead);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    return isEncryptedBufferEnvelope(read === header.length ? header : header.subarray(0, read));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* nothing left to close */ }
    }
  }
}

/**
 * Whether the master key has been wiped. Teardown zeroes it in place, and a
 * seal that runs after that produces bytes no later run can open — which is
 * survivable for a cache file but not for the index, where it would displace a
 * readable one on the way out. Checking the key rather than tracking a "closing"
 * flag means every path that wipes the key is covered by construction, including
 * ones added later.
 */
export function isWipedMasterKey(masterKey: Buffer): boolean {
  return masterKey.length === 0 || masterKey.every((byte) => byte === 0);
}

export function sealLocalFile(masterKey: Buffer, purpose: string, aad: string, plaintext: Buffer): Buffer {
  return encryptBufferEnvelope(plaintext, derivedKey(masterKey, purpose), aad);
}

/**
 * Opens a sealed file. The envelope's AEAD tag is what refuses a payload that
 * was truncated, edited, or written for a different slot; callers treat a throw
 * as "unusable bytes", never as data to fall back on.
 */
export function openLocalFile(masterKey: Buffer, purpose: string, aad: string, payload: Buffer): Buffer {
  return decryptBufferEnvelope(payload, derivedKey(masterKey, purpose), aad);
}

/**
 * The opaque, path-safe name (and cache index key) for a sensitive lookup
 * value. HMAC rather than a bare hash: the input is often a URL, which an
 * attacker holding the file can guess, and a guessable name would let them
 * confirm which remote resources the cached bytes came from.
 */
export function opaqueLocalName(masterKey: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", derivedKey(masterKey, purpose)).update(value, "utf8").digest("hex");
}
