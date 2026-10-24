import { MAX_UNZIPPED_BYTES, MAX_ZIP_ENTRY_BYTES } from "../budget";
import { PreviewCanceled, PreviewFailure, type FailureCode } from "../failure";

/**
 * A read-only ZIP reader for preview attachments (plan §4.4 / §8).
 *
 * Two jobs, deliberately separated so each caller pays only for what it needs:
 *
 * - `open()` parses the end-of-central-directory record and the central
 *   directory. Nothing is inflated here, which is what lets an archive preview
 *   list a 200-entry package without ever constructing a `DecompressionStream`
 *   (a `zip_bomb` cannot hurt a caller that never decompresses).
 * - `readEntry()` inflates one named entry under three ceilings — the size the
 *   directory declares, the per-entry cap and the running total — and verifies
 *   the CRC. A stream that inflates past its declared size is the bomb case and
 *   stops at the first chunk that crosses the line instead of inflating to the
 *   end.
 *
 * `jszip` is not used on purpose: the whole point of the ceilings above is to
 * read less than the archive claims, and a general-purpose library owns its own
 * extraction loop (see the S3 lint rule).
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_FILE = 0x02014b50;
const LOCAL_FILE = 0x04034b50;
const END_RECORD_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
/** The EOCD record can be followed by at most this much archive comment. */
const MAX_COMMENT_BYTES = 65_535;

export type ZipEntry = {
  path: string;
  /** 0 = stored, 8 = deflate. Anything else is refused at open time. */
  method: 0 | 8;
  flags: number;
  encrypted: boolean;
  isDirectory: boolean;
  crc32: number;
  compressedBytes: number;
  /** What the central directory claims; `readEntry` holds the stream to it. */
  uncompressedBytes: number;
  localHeaderOffset: number;
};

export type ZipReaderOptions = {
  /** Entry-count ceiling: 200 for an archive listing, 2,000 for OOXML. */
  maxEntries: number;
  signal?: AbortSignal;
  now?: () => number;
  deadlineMs?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
};

const decoder = new TextDecoder("utf-8", { fatal: false });

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0)
      | ((bytes[offset + 1] ?? 0) << 8)
      | ((bytes[offset + 2] ?? 0) << 16)
      | ((bytes[offset + 3] ?? 0) << 24))
    >>> 0
  );
}

const crcTable: number[] = [];
for (let entry = 0; entry < 256; entry += 1) {
  let value = entry;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable.push(value >>> 0);
}

/** Standard CRC-32 (ISO-HDLC), the checksum a ZIP central directory stores. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `../x` and `a/../../x` both escape; `..hidden` and `a..b` do not. */
export function escapesArchiveRoot(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

export class ZipReader {
  private readonly bytes: Uint8Array;
  private readonly options: ZipReaderOptions;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private active: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private halted = false;
  private stopReason: FailureCode | "canceled" | null = null;
  private cancelCount = 0;
  private inflatedBytes = 0;

  private constructor(bytes: Uint8Array, readonly entries: readonly ZipEntry[], options: ZipReaderOptions) {
    this.bytes = bytes;
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    this.startedAt = this.now();
  }

  static open(bytes: Uint8Array, options: ZipReaderOptions): ZipReader {
    const endOffset = locateEndRecord(bytes);
    const entryCount = readU16(bytes, endOffset + 10);
    const directoryBytes = readU32(bytes, endOffset + 12);
    const directoryOffset = readU32(bytes, endOffset + 16);

    // ZIP64 uses the marker values below; the preview never needs a 65,535-entry
    // archive, and guessing at the ZIP64 locator is how a reader ends up walking
    // offsets it never validated.
    if (entryCount === 0xffff || directoryOffset === 0xffffffff || directoryBytes === 0xffffffff) {
      throw new PreviewFailure("unsupported");
    }
    if (entryCount > options.maxEntries) throw new PreviewFailure("too_many_entries");
    if (directoryOffset + directoryBytes > bytes.length) throw new PreviewFailure("corrupt");

    const entries: ZipEntry[] = [];
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + CENTRAL_HEADER_BYTES > bytes.length) throw new PreviewFailure("corrupt");
      if (readU32(bytes, cursor) !== CENTRAL_DIRECTORY_FILE) throw new PreviewFailure("corrupt");
      const flags = readU16(bytes, cursor + 8);
      const method = readU16(bytes, cursor + 10);
      const crc = readU32(bytes, cursor + 16);
      const compressedBytes = readU32(bytes, cursor + 20);
      const uncompressedBytes = readU32(bytes, cursor + 24);
      const nameBytes = readU16(bytes, cursor + 28);
      const extraBytes = readU16(bytes, cursor + 30);
      const commentBytes = readU16(bytes, cursor + 32);
      const localHeaderOffset = readU32(bytes, cursor + 42);
      if (cursor + CENTRAL_HEADER_BYTES + nameBytes > bytes.length) throw new PreviewFailure("corrupt");
      if (method !== 0 && method !== 8) throw new PreviewFailure("unsupported");

      const path = decoder.decode(bytes.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameBytes));
      entries.push({
        path,
        method,
        flags,
        encrypted: (flags & 0x0001) === 0x0001,
        isDirectory: path.endsWith("/"),
        crc32: crc,
        compressedBytes,
        uncompressedBytes,
        localHeaderOffset,
      });
      cursor += CENTRAL_HEADER_BYTES + nameBytes + extraBytes + commentBytes;
    }
    return new ZipReader(bytes, entries, options);
  }

  get cancelled(): boolean {
    return this.halted;
  }

  /** How many times the in-flight stream had to be cancelled; tests pin this at 1. */
  get cancelCalls(): number {
    return this.cancelCount;
  }

  has(path: string): boolean {
    return this.entries.some((entry) => entry.path === path);
  }

  /**
   * Stops the reader for good: one cancellation of whatever stream is live, and
   * every later `readEntry` refuses without reading a byte.
   *
   * `reason` is what the next caller sees; cancellation from the user is not a
   * failure at all, so `null` means "stop, but no coded failure".
   */
  cancel(reason: FailureCode | null = "zip_bomb"): void {
    if (this.halted) return;
    this.halted = true;
    this.stopReason = reason ?? "canceled";
    this.cancelCount += 1;
    const active = this.active;
    this.active = null;
    if (active) {
      void active.cancel().catch(() => undefined);
    }
  }

  async readEntry(path: string): Promise<Uint8Array> {
    if (this.halted) throw this.stopped();
    this.checkLive();
    const entry = this.entries.find((candidate) => candidate.path === path);
    if (!entry) throw new PreviewFailure("corrupt");
    if (entry.isDirectory) return new Uint8Array(0);
    if (entry.encrypted) throw new PreviewFailure("encrypted");

    const dataStart = this.localDataOffset(entry);
    const declared = entry.uncompressedBytes;
    const maxEntry = this.options.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
    const maxTotal = this.options.maxTotalBytes ?? MAX_UNZIPPED_BYTES;

    let inflated: Uint8Array;
    if (entry.method === 0) {
      const dataEnd = dataStart + entry.compressedBytes;
      if (dataEnd > this.bytes.length) throw new PreviewFailure("corrupt");
      inflated = this.bytes.slice(dataStart, dataEnd);
      if (inflated.byteLength > declared) this.overBudget("zip_bomb");
    } else {
      inflated = await this.inflate(entry, dataStart, declared, maxEntry, maxTotal);
    }

    if (inflated.byteLength !== declared) throw new PreviewFailure("corrupt");
    if (inflated.byteLength > maxEntry) this.overBudget("decoded_too_large");
    this.inflatedBytes += inflated.byteLength;
    if (this.inflatedBytes > maxTotal) this.overBudget("decoded_too_large");
    if (crc32(inflated) !== entry.crc32) throw new PreviewFailure("corrupt");
    return inflated;
  }

  private stopped(): PreviewFailure | PreviewCanceled {
    const reason = this.stopReason;
    if (reason === null || reason === "canceled") return new PreviewCanceled();
    return new PreviewFailure(reason);
  }

  /** Shared by the stored and deflated paths: a stored entry still owes a clock check. */
  private checkLive(): void {
    if (this.options.signal?.aborted) {
      this.cancel(null);
      throw new PreviewCanceled();
    }
    if (this.now() - this.startedAt > this.deadlineMs) {
      this.cancel("timeout");
      throw new PreviewFailure("timeout");
    }
  }

  private overBudget(code: "zip_bomb" | "decoded_too_large"): never {
    this.cancel(code);
    throw new PreviewFailure(code);
  }

  private localDataOffset(entry: ZipEntry): number {
    const offset = entry.localHeaderOffset;
    if (offset + LOCAL_HEADER_BYTES > this.bytes.length) throw new PreviewFailure("corrupt");
    if (readU32(this.bytes, offset) !== LOCAL_FILE) throw new PreviewFailure("corrupt");
    const nameBytes = readU16(this.bytes, offset + 26);
    const extraBytes = readU16(this.bytes, offset + 28);
    const start = offset + LOCAL_HEADER_BYTES + nameBytes + extraBytes;
    if (start + entry.compressedBytes > this.bytes.length) throw new PreviewFailure("corrupt");
    return start;
  }

  private async inflate(
    entry: ZipEntry,
    dataStart: number,
    declared: number,
    maxEntry: number,
    maxTotal: number,
  ): Promise<Uint8Array> {
    const payload = this.bytes.slice(dataStart, dataStart + entry.compressedBytes);
    // `Response(...).body` rather than `Blob(...).stream()`: jsdom has no
    // `Blob.prototype.stream`, and the reader has to run under the same
    // environment as the rest of the preview tests.
    const body = new Response(payload).body;
    if (!body) throw new PreviewFailure("corrupt");
    const stream = body.pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    this.active = reader;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        // Every check happens *before* the next chunk is accepted, so a bomb
        // stops within one chunk of the declared size rather than after the
        // whole 8 MiB has been materialised.
        this.checkLive();
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > declared) this.overBudget("zip_bomb");
        if (total > maxEntry) this.overBudget("decoded_too_large");
        if (this.inflatedBytes + total > maxTotal) this.overBudget("decoded_too_large");
        chunks.push(value);
      }
    } finally {
      if (this.active === reader) this.active = null;
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  }
}

function locateEndRecord(bytes: Uint8Array): number {
  if (bytes.length < END_RECORD_BYTES) throw new PreviewFailure("corrupt");
  const earliest = Math.max(0, bytes.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let offset = bytes.length - END_RECORD_BYTES; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new PreviewFailure("corrupt");
}
