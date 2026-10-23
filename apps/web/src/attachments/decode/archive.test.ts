// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_ARCHIVE_DECLARED_BYTES, MAX_ARCHIVE_ENTRIES, MemoryLease } from "../budget";
import type { DecodeContext, PreviewInput } from "../document";
import { ResourceScope } from "../document";
import {
  encodeFixtureText,
  makeZipBomb,
  makeZipEncrypted,
  makeZipManyEntries,
  makeZipWithTraversal,
  makeZip,
} from "../testing/fixtures";
import { decodeArchive } from "./archive";

const context = (): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
});

const input = (bytes: Uint8Array): PreviewInput => ({
  kind: "archive",
  filename: "bundle.zip",
  contentType: "application/zip",
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

describe("decodeArchive", () => {
  it("lists 200 entries without inflating anything", async () => {
    const fixture = await makeZipManyEntries({ count: MAX_ARCHIVE_ENTRIES });
    const document = await decodeArchive(input(fixture.bytes), context());
    expect(document.surface.surface).toBe("archive");
    if (document.surface.surface !== "archive") return;
    expect(document.surface.entries).toHaveLength(MAX_ARCHIVE_ENTRIES);
    expect(document.surface.entries[0]?.path).toBe("file-001.txt");
  });

  it("refuses the 201st entry", async () => {
    const fixture = await makeZipManyEntries({ count: MAX_ARCHIVE_ENTRIES + 1 });
    await expect(decodeArchive(input(fixture.bytes), context())).rejects.toMatchObject({ code: "too_many_entries" });
  });

  it("lists a bomb instead of exploding it", async () => {
    const fixture = await makeZipBomb({ declaredBytes: 1024 * 1024, actualBytes: 8 * 1024 * 1024 });
    const document = await decodeArchive(input(fixture.bytes), context());
    if (document.surface.surface !== "archive") throw new Error("expected archive surface");
    expect(document.surface.entries).toEqual([{ path: fixture.entryName, bytes: fixture.declaredBytes }]);
  });

  it("refuses a declared total over 256 MiB", async () => {
    const fixture = await makeZip([
      {
        name: "huge.bin",
        data: encodeFixtureText("x"),
        declaredUncompressedBytes: MAX_ARCHIVE_DECLARED_BYTES + 1,
      },
    ]);
    await expect(decodeArchive(input(fixture.bytes), context())).rejects.toMatchObject({ code: "too_large" });
  });

  it("lists encrypted entries because the listing never decrypts", async () => {
    const fixture = await makeZipEncrypted();
    const document = await decodeArchive(input(fixture.bytes), context());
    if (document.surface.surface !== "archive") throw new Error("expected archive surface");
    expect(document.surface.entries.map((entry) => entry.path)).toEqual(["secret.txt"]);
  });

  it("keeps traversal paths verbatim so the surface owns the redaction", async () => {
    const fixture = await makeZipWithTraversal();
    const document = await decodeArchive(input(fixture.bytes), context());
    if (document.surface.surface !== "archive") throw new Error("expected archive surface");
    expect(document.surface.entries.map((entry) => entry.path)).toEqual([
      "../escape.txt",
      "folder/../../escape.txt",
      "safe/file.txt",
    ]);
  });
});
