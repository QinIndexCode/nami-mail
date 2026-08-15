import { describe, expect, it } from "vitest";
import {
  computeImportanceScore,
  NON_LETTER_INITIAL,
  senderDisplay,
  senderInitial,
  sortMessages,
  type ImportanceContext,
} from "./mailImportance";
import type { Message } from "./types";

const NOW = new Date("2026-07-25T00:00:00.000Z").getTime();

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    accountId: "account-1",
    accountEmail: "me@example.com",
    providerName: "Example Mail",
    mailbox: "INBOX",
    uid: 1,
    subject: "Subject",
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Me", address: "me@example.com" }],
    cc: [],
    sentAt: "2026-07-20T00:00:00.000Z",
    snippet: "",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 1,
    ...overrides,
  };
}

function ctx(messages: readonly Message[], overrides: Partial<ImportanceContext> = {}): ImportanceContext {
  return {
    messages,
    accountEmails: new Set(["me@example.com"]),
    now: NOW,
    ...overrides,
  };
}

describe("senderDisplay", () => {
  it("prefers the display name over the raw address", () => {
    expect(senderDisplay(message({ id: "a", from: { name: "Mira Studio", address: "notes@mira.studio" } }))).toBe("Mira Studio");
  });

  it("falls back to the address when the name is blank", () => {
    expect(senderDisplay(message({ id: "a", from: { name: "", address: "noah@atelier.example" } }))).toBe("noah@atelier.example");
  });
});

describe("senderInitial", () => {
  it("extracts the uppercase first letter of a Latin name", () => {
    expect(senderInitial(message({ id: "a", from: { name: "Alice", address: "alice@example.com" } }))).toBe("A");
    expect(senderInitial(message({ id: "b", from: { name: "mira", address: "mira@example.com" } }))).toBe("M");
  });

  it("uses the address when the name is empty and still buckets by its first letter", () => {
    expect(senderInitial(message({ id: "a", from: { name: "", address: "noah@atelier.example" } }))).toBe("N");
  });

  it("sorts digits, symbols and CJK names into the trailing non-letter bucket", () => {
    expect(senderInitial(message({ id: "a", from: { name: "123 Team", address: "x@example.com" } }))).toBe(NON_LETTER_INITIAL);
    expect(senderInitial(message({ id: "b", from: { name: "林澈", address: "lin@example.com" } }))).toBe(NON_LETTER_INITIAL);
  });
});

describe("computeImportanceScore", () => {
  it("ranks starred mail above identical unstarred mail", () => {
    const starred = message({ id: "starred" });
    const plain = message({ id: "plain" });
    const base = ctx([starred, plain]);
    expect(computeImportanceScore({ ...starred, flagged: true }, base)).toBeGreaterThan(computeImportanceScore(plain, base));
  });

  it("ranks unread mail above identical read mail", () => {
    const unread = message({ id: "unread" });
    const read = message({ id: "read", seen: true });
    const base = ctx([unread, read]);
    expect(computeImportanceScore(unread, base)).toBeGreaterThan(computeImportanceScore(read, base));
  });

  it("ranks a frequent sender above a one-off sender", () => {
    const aliceA = message({ id: "alice-a" });
    const aliceB = message({ id: "alice-b" });
    const bob = message({ id: "bob", from: { name: "Bob", address: "bob@example.com" } });
    const base = ctx([aliceA, aliceB, bob]);
    expect(computeImportanceScore(aliceA, base)).toBeGreaterThan(computeImportanceScore(bob, base));
  });

  it("ranks a direct To above being CC'd and above bulk mail", () => {
    const direct = message({ id: "direct", to: [{ name: "Me", address: "me@example.com" }], cc: [] });
    const cc = message({ id: "cc", to: [{ name: "Other", address: "other@example.com" }], cc: [{ name: "Me", address: "me@example.com" }] });
    const bulk = message({ id: "bulk", to: [{ name: "List", address: "list@example.com" }], cc: [] });
    const base = ctx([direct, cc, bulk]);
    const directScore = computeImportanceScore(direct, base);
    const ccScore = computeImportanceScore(cc, base);
    const bulkScore = computeImportanceScore(bulk, base);
    expect(directScore).toBeGreaterThan(ccScore);
    expect(ccScore).toBeGreaterThan(bulkScore);
  });

  it("boosts messages whose subject hits the importance keyword dictionary", () => {
    const flagged = message({ id: "hit", subject: "Invoice #42 — URGENT" });
    const plain = message({ id: "plain", subject: "Lunch menu" });
    const base = ctx([flagged, plain]);
    expect(computeImportanceScore(flagged, base)).toBeGreaterThan(computeImportanceScore(plain, base));
  });

  it("is deterministic for identical inputs", () => {
    const target = message({ id: "target", subject: "Invoice", flagged: true });
    const base = ctx([target, message({ id: "other" })]);
    expect(computeImportanceScore(target, base)).toBe(computeImportanceScore(target, base));
  });
});

describe("sortMessages", () => {
  const old = message({ id: "old", from: { name: "Alice", address: "alice@example.com" }, sentAt: "2026-07-20T00:00:00.000Z" });
  const mid = message({ id: "mid", from: { name: "Bob", address: "bob@example.com" }, sentAt: "2026-07-21T00:00:00.000Z" });
  const fresh = message({ id: "fresh", from: { name: "Carol", address: "carol@example.com" }, sentAt: "2026-07-22T00:00:00.000Z" });

  it("keeps newest-first and oldest-first time ordering", () => {
    const base = ctx([old, fresh, mid]);
    expect(sortMessages(base.messages, "newest", base).map((item) => item.id)).toEqual(["fresh", "mid", "old"]);
    expect(sortMessages(base.messages, "oldest", base).map((item) => item.id)).toEqual(["old", "mid", "fresh"]);
  });

  it("groups by sender initial A-Z with newest first inside each bucket", () => {
    const zed = message({ id: "zed", from: { name: "Zoe", address: "zoe@example.com" }, sentAt: "2026-07-24T00:00:00.000Z" });
    const zedOlder = message({ id: "zed-older", from: { name: "Zoe", address: "zoe@example.com" }, sentAt: "2026-07-18T00:00:00.000Z" });
    const base = ctx([fresh, old, mid, zed, zedOlder]);
    const ids = sortMessages(base.messages, "sender", base).map((item) => item.id);
    expect(ids.indexOf("old")).toBeLessThan(ids.indexOf("fresh"));
    expect(ids.indexOf("zed")).toBeLessThan(ids.indexOf("zed-older"));
    expect(ids).toEqual(["old", "mid", "fresh", "zed", "zed-older"]);
  });

  it("places non-letter senders after every letter bucket", () => {
    const cjk = message({ id: "cjk", from: { name: "林澈", address: "lin@example.com" }, sentAt: "2026-07-24T00:00:00.000Z" });
    const base = ctx([cjk, old, fresh]);
    const ids = sortMessages(base.messages, "sender", base).map((item) => item.id);
    expect(ids).toEqual(["old", "fresh", "cjk"]);
  });

  it("ranks by importance descending and breaks ties by newest first", () => {
    const starredOld = message({ id: "starred-old", flagged: true, sentAt: "2026-07-18T00:00:00.000Z" });
    const starredFresh = message({ id: "starred-fresh", flagged: true, sentAt: "2026-07-23T00:00:00.000Z" });
    const plainFresh = message({ id: "plain-fresh", sentAt: "2026-07-24T00:00:00.000Z" });
    const base = ctx([starredOld, starredFresh, plainFresh]);
    const ids = sortMessages(base.messages, "importance", base).map((item) => item.id);
    expect(ids.indexOf("starred-fresh")).toBeLessThan(ids.indexOf("starred-old"));
    expect(ids.indexOf("starred-old")).toBeLessThan(ids.indexOf("plain-fresh"));
  });
});
