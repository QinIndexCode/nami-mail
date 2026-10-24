// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { encodeFixtureText, makeZip, makeZipBomb, makeZipEncrypted, makeZipManyEntries } from "../testing/fixtures";
import { escapesArchiveRoot, ZipReader } from "./reader";

const open = (fixture: { bytes: Uint8Array }, options: Partial<Parameters<typeof ZipReader.open>[1]> = {}) =>
  ZipReader.open(fixture.bytes, { maxEntries: 10, ...options });

describe("ZipReader", () => {
  it("lists 200 entries straight from the central directory", async () => {
    const fixture = await makeZipManyEntries({ count: 200 });
    const reader = open(fixture, { maxEntries: 200 });
    expect(reader.entries).toHaveLength(200);
    expect(reader.entries[0]).toMatchObject({ path: "file-001.txt", isDirectory: false, encrypted: false });
  });

  it("refuses the 201st entry before reading any of them", async () => {
    const fixture = await makeZipManyEntries({ count: 201 });
    expect(() => open(fixture, { maxEntries: 200 })).toThrow(expect.objectContaining({ code: "too_many_entries" }));
  });

  it("round-trips a stored entry and holds it to the declared size", async () => {
    const data = encodeFixtureText("stored payload");
    const fixture = await makeZip([{ name: "note.txt", data }]);
    const reader = open(fixture);
    expect(new TextDecoder().decode(await reader.readEntry("note.txt"))).toBe("stored payload");
    expect(reader.entries[0].uncompressedBytes).toBe(data.byteLength);
  });

  it("round-trips a deflated entry", async () => {
    const data = encodeFixtureText("deflate me ".repeat(200));
    const fixture = await makeZip([{ name: "note.txt", data, compression: 8 }]);
    const reader = open(fixture);
    expect(await reader.readEntry("note.txt")).toEqual(data);
  });

  it("stops a bomb at the first chunk past the declared size and cancels exactly once", async () => {
    const fixture = await makeZipBomb({ declaredBytes: 1024 * 1024, actualBytes: 8 * 1024 * 1024 });
    const reader = open(fixture);
    const cancel = vi.spyOn(reader, "cancel");

    await expect(reader.readEntry(fixture.entryName)).rejects.toMatchObject({ code: "zip_bomb" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(reader.cancelled).toBe(true);

    // A cancelled reader refuses the next entry without touching the stream.
    await expect(reader.readEntry(fixture.entryName)).rejects.toMatchObject({ code: "zip_bomb" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an entry that inflates past the per-entry ceiling even when it is honest", async () => {
    const bytes = 2 * 1024;
    const fixture = await makeZip([{ name: "big.bin", data: new Uint8Array(bytes), compression: 8 }]);
    const reader = open(fixture, { maxEntryBytes: 1024 });
    await expect(reader.readEntry("big.bin")).rejects.toMatchObject({ code: "decoded_too_large" });
    expect(reader.cancelCalls).toBe(1);
  });

  it("refuses an encrypted entry without decrypting", async () => {
    const fixture = await makeZipEncrypted();
    const reader = open(fixture);
    expect(reader.entries[0].encrypted).toBe(true);
    await expect(reader.readEntry("secret.txt")).rejects.toMatchObject({ code: "encrypted" });
  });

  it("verifies the CRC instead of trusting the directory", async () => {
    const data = encodeFixtureText("checksum target");
    const fixture = await makeZip([{ name: "note.txt", data }]);
    const index = fixture.bytes.indexOf(data[0] as number, 30);
    fixture.bytes[index] = (fixture.bytes[index] ^ 0xff) & 0xff;
    const reader = open(fixture);
    await expect(reader.readEntry("note.txt")).rejects.toMatchObject({ code: "corrupt" });
  });

  it("stops at the wall clock, cancels once, and never reads a second entry", async () => {
    const fixture = await makeZip([
      { name: "one.txt", data: encodeFixtureText("one") },
      { name: "two.txt", data: encodeFixtureText("two") },
    ]);
    let clock = 1_000;
    const reader = open(fixture, { now: () => clock, deadlineMs: 500 });
    const cancel = vi.spyOn(reader, "cancel");

    clock = 2_000;
    await expect(reader.readEntry("one.txt")).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);

    await expect(reader.readEntry("two.txt")).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted signal as cancellation, not a failure", async () => {
    const fixture = await makeZip([{ name: "note.txt", data: encodeFixtureText("abort") }]);
    const controller = new AbortController();
    const reader = open(fixture, { signal: controller.signal });
    controller.abort();
    await expect(reader.readEntry("note.txt")).rejects.toMatchObject({ name: "PreviewCanceled" });
  });

  it("finds only real parent segments in archive paths", () => {
    expect(escapesArchiveRoot("../escape.txt")).toBe(true);
    expect(escapesArchiveRoot("folder/../../escape.txt")).toBe(true);
    expect(escapesArchiveRoot("safe/file.txt")).toBe(false);
    expect(escapesArchiveRoot("..hidden/file.txt")).toBe(false);
    expect(escapesArchiveRoot("a..b/file.txt")).toBe(false);
  });
});
