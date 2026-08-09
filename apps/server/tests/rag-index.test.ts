import { describe, expect, it } from "vitest";
import {
  BM25_B,
  BM25_K1,
  SqliteRagIndex,
  bm25TermScore,
  effectiveTermFrequency,
  tokenCounts,
} from "../src/agent/rag-index.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { openDatabase } from "../src/db.js";

function term(term: string, tfBody = 1, tfSubject = 0, tfSender = 0) {
  return { term, tfBody, tfSubject, tfSender };
}

describe("RAG lexical token counts", () => {
  it("tokenizes CJK characters and multi-character words with occurrence counts", () => {
    const counts = tokenCounts("季度 report 季度 Report 项目预算");
    expect(counts.get("季")).toBe(2);
    expect(counts.get("度")).toBe(2);
    expect(counts.get("report")).toBe(2);
    expect(counts.get("项")).toBe(1);
    expect(counts.get("预算")).toBeUndefined();
  });

  it("caps the number of unique terms per page", () => {
    const counts = tokenCounts([...Array(20).keys()].map((index) => `word${index}`).join(" "), 10);
    expect(counts.size).toBe(10);
  });
});

describe("RAG BM25 scoring", () => {
  it("prefers terms with lower document frequency", () => {
    const rare = bm25TermScore(1, 100, 100, 1_000, 2);
    const common = bm25TermScore(1, 100, 100, 1_000, 500);
    expect(rare).toBeGreaterThan(common);
  });

  it("saturates term frequency", () => {
    const single = bm25TermScore(1, 100, 100, 1_000, 10);
    const repeated = bm25TermScore(8, 100, 100, 1_000, 10);
    expect(repeated).toBeGreaterThan(single);
    expect(repeated).toBeLessThan(single * 8);
  });

  it("normalizes by document length", () => {
    const short = bm25TermScore(1, 20, 100, 1_000, 10);
    const long = bm25TermScore(1, 500, 100, 1_000, 10);
    expect(short).toBeGreaterThan(long);
  });

  it("applies subject and sender field boosts", () => {
    const bodyOnly = effectiveTermFrequency({ tfBody: 1, tfSubject: 0, tfSender: 0 });
    const subjectHit = effectiveTermFrequency({ tfBody: 1, tfSubject: 1, tfSender: 0 });
    const senderHit = effectiveTermFrequency({ tfBody: 1, tfSubject: 0, tfSender: 1 });
    expect(subjectHit).toBeGreaterThan(bodyOnly);
    expect(senderHit).toBeGreaterThan(bodyOnly);
    expect(subjectHit).toBeGreaterThan(senderHit);
    expect(BM25_K1).toBeGreaterThan(0);
    expect(BM25_B).toBeGreaterThan(0);
  });
});

describe("SqliteRagIndex persistence", () => {
  it("keeps per-generation stats in sync across replace and remove", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    const index = new SqliteRagIndex(db);
    index.replacePage({
      accountId: "account-1",
      accountGeneration: 3,
      pageId: "page-1",
      pageRevision: 1,
      messageId: "message-1",
      terms: [term("季度", 2), term("report", 1, 1)],
      termCount: 5,
      sentAt: "2026-07-27T10:00:00.000Z",
    });
    expect(index.statsFor("account-1", 3)).toEqual({
      accountId: "account-1",
      accountGeneration: 3,
      docCount: 1,
      termTotal: 5,
    });
    index.replacePage({
      accountId: "account-1",
      accountGeneration: 3,
      pageId: "page-1",
      pageRevision: 2,
      messageId: "message-1",
      terms: [term("updated")],
      termCount: 3,
    });
    expect(index.statsFor("account-1", 3)?.termTotal).toBe(3);
    expect(index.distinctPagesFor("account-1", 3)).toEqual([{ pageId: "page-1", pageRevision: 2 }]);
    index.removePage("account-1", 3, "page-1");
    expect(index.statsFor("account-1", 3)).toEqual({
      accountId: "account-1",
      accountGeneration: 3,
      docCount: 0,
      termTotal: 0,
    });
    expect(index.distinctPagesFor("account-1", 3)).toEqual([]);
    db.close();
  });

  it("narrows postings to an authorized message set", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    const index = new SqliteRagIndex(db);
    for (const messageId of ["message-1", "message-2"]) {
      index.replacePage({
        accountId: "account-1",
        accountGeneration: 0,
        pageId: `message:${messageId}:chunk:0`,
        pageRevision: 1,
        messageId,
        terms: [term("report")],
        termCount: 1,
      });
    }
    const all = index.postingsFor("account-1", 0, "report");
    expect(all).toHaveLength(2);
    const scoped = index.postingsFor("account-1", 0, "report", new Set(["message-2"]));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.messageId).toBe("message-2");
    expect(index.postingsFor("account-1", 0, "report", new Set())).toEqual([]);
    db.close();
  });

  it("removes whole generations and batches purged pages", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    const index = new SqliteRagIndex(db);
    index.replacePage({
      accountId: "account-1",
      accountGeneration: 2,
      pageId: "page-old",
      pageRevision: 1,
      messageId: "message-old",
      terms: [term("old")],
      termCount: 2,
    });
    index.replacePage({
      accountId: "account-1",
      accountGeneration: 5,
      pageId: "page-new",
      pageRevision: 1,
      messageId: "message-new",
      terms: [term("new")],
      termCount: 2,
    });
    index.removeGeneration("account-1", 2);
    expect(index.distinctPagesFor("account-1", 2)).toEqual([]);
    expect(index.statsFor("account-1", 2)).toBeUndefined();
    expect(index.distinctPagesFor("account-1", 5)).toEqual([{ pageId: "page-new", pageRevision: 1 }]);
    index.removePages("account-1", 5, ["page-new"]);
    expect(index.statsFor("account-1", 5)).toEqual({
      accountId: "account-1",
      accountGeneration: 5,
      docCount: 0,
      termTotal: 0,
    });
    db.close();
  });

  it("reconciles stats after external drift", () => {
    const db = openDatabase(":memory:");
    applyAgentStoreSchema(db);
    const index = new SqliteRagIndex(db);
    index.replacePage({
      accountId: "account-1",
      accountGeneration: 0,
      pageId: "page-1",
      pageRevision: 1,
      messageId: "message-1",
      terms: [term("report", 2)],
      termCount: 4,
    });
    db.prepare("DELETE FROM agent_rag_index WHERE term = 'report'").run();
    index.reconcileStats("account-1", 0);
    expect(index.statsFor("account-1", 0)).toEqual({
      accountId: "account-1",
      accountGeneration: 0,
      docCount: 0,
      termTotal: 0,
    });
    db.close();
  });
});
