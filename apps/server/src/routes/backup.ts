import type { FastifyInstance } from "fastify";
import type { EventEmitter } from "node:events";
import { ZipFile } from "yazl";
import { BackupTransferClosedError, collectMailBackup } from "../backup.js";
import { contentDispositionFilename } from "../helpers.js";
import { serverLog } from "../logging.js";
import type { RuntimeContext } from "../types.js";

/**
 * How much message source may be handed to yazl before the backup waits for the
 * archive to catch up.
 *
 * yazl's `addBuffer()` does no queueing of its own to wait on: it hands the
 * buffer to an async `zlib.deflateRaw` and returns, and its entries array is
 * unbounded, so every entry added before the previous one has been deflated and
 * written out is still resident. Nothing bounds that from the outside, because
 * yazl's `writeToOutputStream()` throws away the return value of
 * `outputStream.write()` — the one place Node would have said "stop".
 *
 * 32 MiB is a ceiling on that in-flight window, not a target. It is above the
 * whole archive of a small mailbox, so ordinary exports never suspend, and far
 * below the hundreds of megabytes a large mailbox reaches before the client
 * even starts reading — which is what the drain signal alone cannot prevent: the
 * first deflate of a chunk cannot finish before the loop that fills the chunk
 * has run, so a drain-only gate still lets a full BACKUP_FETCH_CHUNK_SIZE of
 * sources pile up in one turn. The burst overshoots the ceiling by at most the
 * entry that crossed it, so the window stays at "this ceiling plus one message".
 *
 * What the process actually holds is bounded by about twice that: the ceiling
 * here, plus the part of it yazl can still push into the output stream before
 * the drain wait takes effect, plus the largest single message. Measured over
 * 1000 x 512 KiB entries with nothing reading, the export parks at 32 MiB with
 * ~90 MiB of live buffers; with a client that reads, the same 500 MB finishes
 * with a ~90 MiB peak. The same run without these bounds peaks at 1 GB of live
 * buffers with 500 MB of it stranded inside the output stream.
 */
export const BACKUP_ZIP_INFLIGHT_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * yazl 3.3.1, read from its source (node_modules/yazl/index.js):
 *
 *   - `new ZipFile()` builds `outputStream` as `new PassThrough()` (line 15), a
 *     standard Duplex, so `writableNeedDrain` and `drain` behave exactly as they
 *     do on any writable. `writeToOutputStream()` (line 167) discards the result
 *     of `.write()`, which is why the back-pressure signal has to be observed
 *     from outside the pump.
 *   - `addBuffer()` (line 81) returns as soon as the entry is queued; the entry
 *     sits in `entries` in state 0 until `zlib.deflateRaw` calls back, and its
 *     `compressedSize` is null until then. `pumpEntries()` (line 206) writes
 *     entries strictly in order and sets state 3 only after the local header and
 *     the data have gone to the output stream, so that state is the exact signal
 *     for "this entry is no longer held by yazl".
 *
 * Neither field is in @types/yazl, so they are read through one narrow cast.
 * tests/backup-backpressure.test.ts pins the shape against the installed yazl,
 * so an upgrade that changes either fails the suite instead of quietly dropping
 * the ceiling.
 */
type YazlEntry = { state?: number; compressedSize?: number | null; doFileDataPump?: unknown };
type YazlZipInternals = { entries?: YazlEntry[] };
type YazlOutputStream = { writableNeedDrain: boolean; destroyed: boolean } & Pick<EventEmitter, "once" | "removeListener">;

/** Entry.WAITING_FOR_METADATA, the state between addBuffer() and the deflate. */
const ZIP_ENTRY_WAITING_FOR_METADATA = 0;
/** Entry.FILE_DATA_DONE: written to the output stream, no longer held by yazl. */
const ZIP_ENTRY_FILE_DATA_DONE = 3;

/**
 * Stands in for the pump of an entry that has already been written.
 *
 * yazl's addBuffer() installs `entry.doFileDataPump = function() { ...compressed
 * buffer... }` and never clears it, and pumpEntries() cannot prune the entry
 * list because end() still walks it to write the central directory. The closure
 * therefore keeps every entry's compressed payload reachable from the ZipFile
 * for the whole export: measured over 1000 x 512 KiB entries, 500 MB stayed live
 * after the client had read all of it, with no back-pressure anywhere. Dropping
 * the reference once the entry is done is what makes the export's memory a
 * window rather than the archive. pumpEntries() only ever calls the pump of the
 * first entry that is not done yet, so a written entry's pump is dead code.
 *
 * It throws rather than returning quietly: if a future yazl ever pumped a
 * finished entry, a silent no-op would produce a corrupt archive, and a loud
 * failure in the archive writer is the better of the two.
 */
function releasedEntryPump(): never {
  throw new Error("yazl tried to pump a backup entry that had already been written.");
}

export type BackupZipWriterOptions = {
  /** Overrides the in-flight ceiling. Exported for tests, not for callers. */
  maxInFlightBytes?: number;
  /**
   * Asks whether the transfer is already gone. The output stream can outlive
   * the response it feeds — Fastify destroys the socket, not necessarily the
   * payload stream — and a stream with no reader never drains, so the socket is
   * the authoritative signal.
   */
  isAborted?: () => boolean;
};

export type BackupZipWriterStats = {
  /** Source bytes handed to yazl that it has not written out yet. */
  inFlightBytes: number;
  /** The largest inFlightBytes reached while the archive was produced. */
  peakInFlightBytes: number;
  /** Entries yazl accepted. */
  added: number;
  /** How often the writer had to suspend the backup. */
  waits: number;
};

export type BackupZipWriter = {
  /** Adds one entry, resolving once the archive is not running ahead of its reader. */
  add(source: Buffer, path: string): Promise<void>;
  /**
   * Waits for everything handed to yazl to be written out. Unlike add() this
   * never throws: it is the tail of the export, after the client may already
   * have gone.
   */
  flush(): Promise<void>;
  /** True once the client is gone; no further entry can be delivered. */
  readonly closed: boolean;
  stats(): BackupZipWriterStats;
};

/**
 * Wraps a yazl archive in the two bounds yazl does not provide, so the export
 * follows the speed of the client that is reading it.
 *
 * 1. The stream side. `writableNeedDrain` goes true as soon as the PassThrough
 *    is holding more than its 16 KiB high-water mark, and `drain` fires when the
 *    reader has taken it. Without this, a client that stops reading parks the
 *    whole archive inside that buffer.
 * 2. The yazl side. Entries are released as yazl writes them out, which is what
 *    keeps the deflate queue from growing to the size of the mailbox.
 *
 * The two are separate because each covers what the other cannot: drain only
 * says something once yazl has produced bytes, which cannot happen before the
 * loop that queues the entries has run; the ceiling only says something once
 * entries exist, which it does even when the reader keeps up perfectly.
 */
export function createBackupZipWriter(zip: ZipFile, options: BackupZipWriterOptions = {}): BackupZipWriter {
  const limit = Math.max(1, options.maxInFlightBytes ?? BACKUP_ZIP_INFLIGHT_LIMIT_BYTES);
  const isAborted = options.isAborted ?? (() => false);
  const output = zip.outputStream as unknown as YazlOutputStream;
  const entries = (): YazlEntry[] | undefined => (zip as unknown as YazlZipInternals).entries;

  // One record per entry yazl accepted, in the order it will write them. Only
  // the window between the oldest unwritten entry and the newest is kept, so
  // this is bounded by the ceiling rather than by the size of the mailbox.
  const records: Array<{ entry: YazlEntry; held: number }> = [];
  let head = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let added = 0;
  let waits = 0;
  let closed = false;
  // Cleared if yazl stops exposing the entry bookkeeping read below: the
  // stream-side bound still holds, but the ceiling cannot be measured.
  let tracksYazl = true;

  const closedError = (cause?: unknown): BackupTransferClosedError =>
    new BackupTransferClosedError(cause instanceof Error
      ? `The backup download was closed before the archive was written: ${cause.message}`
      : undefined);

  const markClosed = (): void => { closed = true; };

  /**
   * Gives up on the yazl-side ceiling after a yazl upgrade changed the private
   * entry bookkeeping this reads. The stream-side bound still holds, so the
   * export stays correct — but it loses the in-flight cap, which is exactly
   * the regression that would otherwise show up only as mailbox-sized memory.
   */
  const stopTrackingYazl = (): void => {
    if (!tracksYazl) return;
    tracksYazl = false;
    serverLog.warn(
      { limitBytes: limit },
      "Backup zip writer lost yazl entry tracking; the in-flight byte ceiling is inactive",
    );
  };

  const checkOpen = (): void => {
    if (!closed && (output.destroyed || isAborted())) markClosed();
    if (closed) throw closedError();
  };

  /** Releases the bytes yazl has finished with. */
  const settle = (): void => {
    if (!tracksYazl) return;
    while (head < records.length) {
      const record = records[head] as { entry: YazlEntry; held: number };
      const state = record.entry?.state;
      if (typeof state !== "number") { stopTrackingYazl(); return; }
      if (state >= ZIP_ENTRY_FILE_DATA_DONE) {
        inFlight -= record.held;
        // yazl is done with this entry, but the entry list is not, and the pump
        // it still carries closes over the compressed payload. Handing the entry
        // back its memory is what keeps a long export bounded.
        record.entry.doFileDataPump = releasedEntryPump;
        head += 1;
        continue;
      }
      // Still deflating: the source buffer is what is held, which is exactly
      // what record.held already reserves. Once deflated, the compressed buffer
      // is all that is left of the entry, so the reservation follows the
      // compression ratio — a mailbox of compressible mail frees its window
      // sooner, and the counter never drifts, because a settled entry is
      // released by its own state and not by a running total.
      if (state === ZIP_ENTRY_WAITING_FOR_METADATA) break;
      const compressed = record.entry?.compressedSize;
      if (typeof compressed === "number") { inFlight += compressed - record.held; record.held = compressed; }
      // yazl writes entries strictly in order, so nothing behind this one can
      // have been written yet either.
      break;
    }
    // Drop the settled prefix once it is the bulk of the array, so a long export
    // does not accumulate one record per message of a mailbox already written.
    if (head > 32 && head * 2 > records.length) { records.splice(0, head); head = 0; }
  };

  /**
   * Waits for the stream to fall back below its high-water mark.
   *
   * Listeners are attached by hand rather than through events.once() because a
   * Promise.race over three event promises leaves the two losers pending: a
   * stream error arriving after the drain won the race would then reject a
   * promise nobody is listening to, which is an unhandled rejection.
   */
  const waitForDrain = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearInterval(abortPoll);
        output.removeListener("drain", onDrain);
        output.removeListener("error", onError);
        output.removeListener("close", onClose);
      };
      const onDrain = (): void => { cleanup(); resolve(); };
      // A write to a destroyed PassThrough returns false without ever setting
      // writableNeedDrain, so a broken stream is only visible as an event.
      const onError = (error: Error): void => { cleanup(); markClosed(); reject(closedError(error)); };
      const onClose = (): void => { cleanup(); markClosed(); reject(closedError()); };
      output.once("drain", onDrain);
      output.once("error", onError);
      output.once("close", onClose);
      // An open stream that nobody reads never drains, so a response that died
      // without taking the payload stream with it would park the export here.
      // Nothing else in the loop runs while this wait is outstanding, so the
      // socket has to be re-checked from inside it.
      const abortPoll = setInterval(() => {
        if (!isAborted()) return;
        cleanup();
        markClosed();
        reject(closedError());
      }, 250);
    });

  /**
   * Lets zlib's threadpool and yazl's pump make progress.
   *
   * Nothing is readable from the stream yet — the entries are still being
   * deflated — so there is no event to wait on. The first completions land
   * within a turn or two; after that a timer keeps a large deflate from being
   * polled at full CPU speed.
   */
  const yieldTurn = (turn: number): Promise<void> =>
    new Promise<void>((resolve) => { if (turn < 8) setImmediate(resolve); else setTimeout(resolve, 1); });

  const gate = async (): Promise<void> => {
    for (let turn = 0; ; turn += 1) {
      checkOpen();
      settle();
      if (output.writableNeedDrain) { waits += 1; await waitForDrain(); continue; }
      if (!tracksYazl || inFlight <= limit) return;
      waits += 1;
      await yieldTurn(turn);
    }
  };

  const add = async (source: Buffer, path: string): Promise<void> => {
    checkOpen();
    const before = entries()?.length;
    zip.addBuffer(source, path);
    if (tracksYazl) {
      const list = entries();
      // yazl ignores an entry once its own error state is set; then nothing was
      // queued and nothing is in flight for it.
      if (!list) stopTrackingYazl();
      else if (typeof before === "number" && list.length === before + 1) {
        records.push({ entry: list[list.length - 1] as YazlEntry, held: source.length });
        inFlight += source.length;
        added += 1;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
      }
    }
    await gate();
  };

  const flush = async (): Promise<void> => {
    for (let turn = 0; ; turn += 1) {
      settle();
      if (closed || output.destroyed || isAborted()) { markClosed(); return; }
      if (output.writableNeedDrain) {
        try { await waitForDrain(); } catch { markClosed(); return; }
        continue;
      }
      if (!tracksYazl || inFlight === 0) return;
      waits += 1;
      await yieldTurn(turn);
    }
  };

  return {
    add,
    flush,
    get closed() { return closed; },
    stats: () => ({ inFlightBytes: inFlight, peakInFlightBytes: peakInFlight, added, waits }),
  };
}

export type BackupRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const { context, log } = deps;

  app.get("/api/backup", async (_request, reply) => {
    // Streams every stored message's provider source as .eml entries inside
    // one zip. Entries are appended as they arrive so memory stays bounded
    // regardless of mailbox size; per-message failures land in the report.
    const zip = new ZipFile();
    // A client disconnect will emit on the output stream; swallow it — the
    // socket error is already handled by Fastify and a crash here would only
    // take the process down with an already-aborted transfer.
    zip.outputStream.on("error", () => undefined);
    // The producer follows the consumer: it suspends while the archive is ahead
    // of the socket, instead of queueing entries into yazl and into the output
    // stream until the whole mailbox is in memory.
    const writer = createBackupZipWriter(zip, { isAborted: () => reply.raw.destroyed === true });
    const backupDate = new Date().toISOString().slice(0, 10);
    reply
      .type("application/zip")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${contentDispositionFilename(`nami-mail-backup-${backupDate}.zip`)}`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    reply.send(zip.outputStream);
    try {
      const report = await collectMailBackup(context.db, context.masterKey, {
        accessTokenProvider: context.oauthService,
        // Awaited by the collector, which is what lets this suspend: without a
        // wait here the fetch loop would keep feeding yazl while the client is
        // stalled, and the archive would buffer in the output stream instead.
        emit: (entry) => writer.add(entry.source, entry.path),
      });
      await writer.add(Buffer.from(`${JSON.stringify(report, null, 2)}\n`), "export-report.json");
    } catch (error) {
      if (!writer.closed) {
        // There is still a client to read it; a client that is gone has already
        // been reported through the log below.
        try {
          await writer.add(
            Buffer.from(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)),
            "export-error.json",
          );
        } catch {
          // The transfer died while the error entry was being queued. The zip is
          // finished either way, so this cannot be allowed to escape.
        }
      }
      log.warn({ err: error }, "backup export did not complete");
    } finally {
      // Let the archive drain before the central directory is appended, so the
      // tail of the export does not land as one last unbounded burst. This never
      // throws, so it is safe on the disconnected path too.
      await writer.flush();
      zip.end();
    }
    return reply;
  });
}
