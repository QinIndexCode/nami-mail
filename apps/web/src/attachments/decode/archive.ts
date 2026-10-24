import {
  ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_DECLARED_BYTES,
  MAX_ARCHIVE_ENTRIES,
} from "../budget";
import type { ArchiveEntry, DecodeContext, PreviewDocument, PreviewInput } from "../document";
import { PreviewFailure } from "../failure";
import { ZipReader } from "../zip/reader";

/**
 * Archive preview (plan §4.4): the index and nothing else.
 *
 * `ZipReader.open` only walks the central directory, so this decoder never
 * constructs a `DecompressionStream`. That is the whole safety argument for
 * archives: the listing cannot be turned into a bomb because no entry is ever
 * inflated, and the 200-entry / 256 MiB-declared ceilings bound the sheet.
 *
 * The path is returned verbatim; escaping it is a render-time decision
 * (`ArchiveSurface` keeps `..` out of the DOM) so the decoder does not silently
 * rewrite what the archive actually says.
 */
export async function decodeArchive(input: PreviewInput, context: DecodeContext): Promise<PreviewDocument> {
  const reader = ZipReader.open(input.bytes, {
    maxEntries: MAX_ARCHIVE_ENTRIES,
    signal: context.signal,
    now: context.now,
    deadlineMs: context.deadlineMs,
  });
  const declaredBytes = reader.entries.reduce((total, entry) => total + entry.uncompressedBytes, 0);
  if (declaredBytes > MAX_ARCHIVE_DECLARED_BYTES) throw new PreviewFailure("too_large");

  const entries: ArchiveEntry[] = reader.entries.map((entry) => ({ path: entry.path, bytes: entry.uncompressedBytes }));
  context.lease.charge(entries.length * ARCHIVE_ENTRY_BYTES, "archive-index");

  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    surface: { surface: "archive", entries, declaredBytes },
  };
}
