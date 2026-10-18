import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveEncryptionKey } from "../src/crypto.js";
import { MESSAGE_REMOTE_ID_LOOKUP_PURPOSE, remoteIdLookup } from "../src/message-remote-id.js";

/**
 * The claim key has to be one derivation, not two.
 *
 * `messages.remote_id_lookup` is only ever compared to itself. The sync pass
 * writes it from the provider's message id, and the optimistic Sent row writes
 * it from the RFC Message-ID it just minted, so the first sync after a send can
 * *claim* that row instead of inserting a second copy (design §4.7 B4 · D3b ③).
 * Two implementations of "the same" derivation differ by a purpose string or a
 * separator and then never match -- silently, because a row nobody claims just
 * sits in Sent looking ordinary.
 *
 * So this file pins the recipe rather than a run: the exact purpose, the exact
 * HMAC input layout, and the fact that the derivation exists in exactly one
 * module. The expected value is recomputed here from `deriveEncryptionKey` plus
 * the documented input layout instead of being copied out of a previous run --
 * that is what makes a purpose change fail here instead of being re-baselined
 * into agreement.
 */

const MASTER_KEY = Buffer.alloc(32, 0x3d);
const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts` file under `src/`, excluding the scanner's own baseline copies. */
function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}.mimosa${path.sep}`));
}

describe("message remote-id lookup: one derivation shared by every writer", () => {
  it("keeps the purpose string these columns are already keyed by", () => {
    // Spelled out rather than read from the constant: the test imports the
    // constant it is checking, so asserting only `remoteIdLookup(...) ===
    // recipe(MESSAGE_REMOTE_ID_LOOKUP_PURPOSE)` would move both sides together
    // and stay green through the one edit that matters. Every lookup value
    // already stored in `messages.remote_id_lookup` was derived under this
    // literal; changing it silently orphans all of them.
    expect(MESSAGE_REMOTE_ID_LOOKUP_PURPOSE).toBe("message-remote-id-lookup-v1");
  });

  it("derives the documented lookup value (the purpose and the input layout are the format)", () => {
    const key = deriveEncryptionKey(MASTER_KEY, MESSAGE_REMOTE_ID_LOOKUP_PURPOSE);
    const expected = `h1.${createHmac("sha256", key)
      .update("account-1", "utf8").update("\0").update("remote-42", "utf8")
      .digest("base64url")}`;
    expect(remoteIdLookup(MASTER_KEY, "account-1", "remote-42")).toBe(expected);
  });

  it("keys on the account as well as the id, so two accounts never share a value", () => {
    const first = remoteIdLookup(MASTER_KEY, "account-1", "remote-42");
    const second = remoteIdLookup(MASTER_KEY, "account-2", "remote-42");
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("answers null for an id it cannot key on rather than an unmatchable value", () => {
    expect(remoteIdLookup(MASTER_KEY, "account-1", undefined)).toBeNull();
    expect(remoteIdLookup(MASTER_KEY, "account-1", "")).toBeNull();
  });

  it("returns the key's value, not the key object's, so the dated cache cannot change it", () => {
    // The memoized HKDF key is cached per master-key *object*; an equal buffer
    // built fresh must still produce the same column value.
    expect(remoteIdLookup(Buffer.from(MASTER_KEY), "account-1", "remote-42")).toBe(
      remoteIdLookup(MASTER_KEY, "account-1", "remote-42"),
    );
  });

  it("is not re-derived inside sync.ts", () => {
    const syncSource = fs.readFileSync(fileURLToPath(new URL("../src/sync.ts", import.meta.url)), "utf8");
    expect(syncSource).toContain('from "./message-remote-id.js"');
    expect(syncSource).not.toContain(MESSAGE_REMOTE_ID_LOOKUP_PURPOSE);
    expect(syncSource).not.toContain("h1.");
  });

  it("mints the lookup value in exactly one module", () => {
    const owners = sourceFiles(SOURCE_ROOT)
      .filter((file) => fs.readFileSync(file, "utf8").includes(MESSAGE_REMOTE_ID_LOOKUP_PURPOSE))
      .map((file) => path.basename(file));
    expect(owners).toStrictEqual(["message-remote-id.ts"]);
  });
});
