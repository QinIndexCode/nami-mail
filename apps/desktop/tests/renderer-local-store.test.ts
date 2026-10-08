import { mkdtempSync, existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  RENDERER_LOCAL_STORE_MAX_ENTRIES,
  RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH,
  readRendererLocalStore,
  rendererLocalStorePath,
  writeRendererLocalStoreEntry,
} from "../src/renderer-local-store.mjs";

function tempStorePath(): string {
  return rendererLocalStorePath(mkdtempSync(path.join(tmpdir(), "nami-mail-renderer-local-store-")));
}

function cleanup(filePath: string): void {
  rmSync(path.dirname(filePath), { recursive: true, force: true });
}

test("round-trips entries through the store file", () => {
  const filePath = tempStorePath();
  try {
    assert.deepEqual(readRendererLocalStore(filePath), {});
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "en-US").saved);
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.avatar.alice@example.com", "data:image/jpeg;base64,abc").saved);
    assert.equal(readRendererLocalStore(filePath)["nami-mail.locale-preference"], "en-US");
    assert.equal(readRendererLocalStore(filePath)["nami-mail.avatar.alice@example.com"], "data:image/jpeg;base64,abc");
  } finally {
    cleanup(filePath);
  }
});

test("deletes an entry when the value is null and persists the deletion", () => {
  const filePath = tempStorePath();
  try {
    writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "en-US");
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", null).saved);
    assert.deepEqual(readRendererLocalStore(filePath), {});
  } finally {
    cleanup(filePath);
  }
});

test("rejects keys outside the nami-mail preference namespace", () => {
  const filePath = tempStorePath();
  try {
    assert.equal(writeRendererLocalStoreEntry(filePath, "other-app.key", "x").reason, "invalid-key");
    assert.equal(writeRendererLocalStoreEntry(filePath, "nami-mail.", "x").reason, "invalid-key");
    assert.equal(writeRendererLocalStoreEntry(filePath, `nami-mail.${"k".repeat(200)}`, "x").reason, "invalid-key");
    assert.equal(writeRendererLocalStoreEntry(filePath, "nami-mail.bad\u0000key", "x").reason, "invalid-key");
    assert.equal(writeRendererLocalStoreEntry(filePath, 42, "x").reason, "invalid-key");
    assert.deepEqual(readRendererLocalStore(filePath), {});
  } finally {
    cleanup(filePath);
  }
});

test("rejects values that are not strings or exceed the length cap", () => {
  const filePath = tempStorePath();
  try {
    assert.equal(writeRendererLocalStoreEntry(filePath, "nami-mail.key", 12345).reason, "invalid-value");
    assert.equal(
      writeRendererLocalStoreEntry(filePath, "nami-mail.key", "v".repeat(RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH + 1)).reason,
      "invalid-value",
    );
    // A value exactly at the cap is accepted.
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.key", "v".repeat(RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH)).saved);
  } finally {
    cleanup(filePath);
  }
});

test("enforces the entry-count cap for new keys", () => {
  const filePath = tempStorePath();
  try {
    for (let index = 0; index < RENDERER_LOCAL_STORE_MAX_ENTRIES; index += 1) {
      assert.ok(writeRendererLocalStoreEntry(filePath, `nami-mail.key-${index}`, "v").saved);
    }
    assert.equal(writeRendererLocalStoreEntry(filePath, "nami-mail.key-new", "v").reason, "too-many-entries");
    // Updating an existing entry stays within the cap.
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.key-0", "updated").saved);
    assert.equal(readRendererLocalStore(filePath)["nami-mail.key-0"], "updated");
  } finally {
    cleanup(filePath);
  }
});

test("quarantines a corrupt store file instead of throwing", () => {
  const filePath = tempStorePath();
  try {
    writeFileSync(filePath, "{ not json", "utf8");
    assert.deepEqual(readRendererLocalStore(filePath), {});
    assert.ok(!existsSync(filePath), "the corrupt file must be renamed out of the way");
    // The store remains writable after the quarantine and heals itself.
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "zh-CN").saved);
    assert.equal(readRendererLocalStore(filePath)["nami-mail.locale-preference"], "zh-CN");
  } finally {
    cleanup(filePath);
  }
});

test("degrades to an empty store for structurally invalid JSON payloads", () => {
  const filePath = tempStorePath();
  try {
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, entries: {} }), "utf8");
    assert.deepEqual(readRendererLocalStore(filePath), {});
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 1 }), "utf8");
    assert.deepEqual(readRendererLocalStore(filePath), {});
    writeFileSync(filePath, "[]", "utf8");
    assert.deepEqual(readRendererLocalStore(filePath), {});
  } finally {
    cleanup(filePath);
  }
});

test("drops invalid entries from a hand-edited file while keeping valid ones", () => {
  const filePath = tempStorePath();
  try {
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      entries: {
        "nami-mail.locale-preference": "en-US",
        "foreign.key": "dropped",
        "nami-mail.too-long": "v".repeat(RENDERER_LOCAL_STORE_MAX_VALUE_LENGTH + 1),
      },
    }), "utf8");
    const entries = readRendererLocalStore(filePath);
    assert.deepEqual(Object.keys(entries), ["nami-mail.locale-preference"]);
  } finally {
    cleanup(filePath);
  }
});

test("the write is atomic: no temp file survives and the payload is the documented shape", () => {
  const filePath = tempStorePath();
  try {
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "zh-CN").saved);
    assert.ok(!existsSync(`${filePath}.tmp`));
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { schemaVersion: number; entries: Record<string, string> };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.entries["nami-mail.locale-preference"], "zh-CN");
  } finally {
    cleanup(filePath);
  }
});

test("a write whose rename target is a directory reports saved:false and keeps the store readable", () => {
  const filePath = tempStorePath();
  try {
    assert.ok(writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "en-US").saved);
    rmSync(filePath);
    mkdirSync(filePath);
    const result = writeRendererLocalStoreEntry(filePath, "nami-mail.locale-preference", "zh-CN");
    assert.equal(result.saved, false);
    assert.equal(result.reason, "write-failed");
    assert.ok(!existsSync(`${filePath}.tmp`));
    rmSync(filePath, { recursive: true, force: true });
    assert.deepEqual(readRendererLocalStore(filePath), {});
  } finally {
    cleanup(filePath);
  }
});
