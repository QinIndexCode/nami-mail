import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@nami/agent-core";
import { EncryptedAgentMemoryStore } from "../src/agent/memory.js";
import { createMemoryTools } from "../src/agent/memory-tools.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { openDatabase } from "../src/db.js";

const timestamp = "2026-08-03T00:00:00.000Z";

function fixture() {
  const db = openDatabase(":memory:");
  applyAgentStoreSchema(db, timestamp);
  const masterKey = randomBytes(32);
  const store = new EncryptedAgentMemoryStore(db, masterKey, () => timestamp);
  const registry = createToolRegistry(createMemoryTools(store));
  const context = {
    requestId: "req-1",
    caller: {
      callerId: "test",
      kind: "test" as const,
      entryPoint: "test" as const,
      accessLevel: "full-access" as const,
      scopes: ["manage:memory"],
      accountScope: { mode: "none" as const },
      interactive: true,
      canRequestConfirmation: false,
    },
    accountIds: [],
  };
  return { db, masterKey, store, registry, context };
}

describe("memory tools", () => {
  it("registers list/save/update/delete with memory-only descriptors", () => {
    const { registry } = fixture();
    for (const name of ["memory.list", "memory.save", "memory.update", "memory.delete"]) {
      expect(registry.get(name)).toBeDefined();
    }
    expect(registry.get("memory.list")?.descriptor.executionMode).toBe("read");
    for (const name of ["memory.save", "memory.update", "memory.delete"]) {
      expect(registry.get(name)?.descriptor.executionMode).toBe("write");
    }
    for (const name of ["memory.list", "memory.save", "memory.update", "memory.delete"]) {
      expect(registry.get(name)?.descriptor.requiredScopes).toEqual(["manage:memory"]);
      expect(registry.get(name)?.descriptor.accountAccess).toBe("none");
      expect(registry.get(name)?.descriptor.confirmationPolicy).toBe("never");
      expect(registry.get(name)?.descriptor.availableToExternal).toBe(false);
    }
  });

  it("saves a note and returns the stored record", async () => {
    const { registry, context, store } = fixture();
    const saved = await registry.get("memory.save")!.execute(context, { note: "User prefers English replies", detail: "Noted on 2026-08-03" });
    expect(saved.ok).toBe(true);
    expect(saved).toMatchObject({
      ok: true,
      value: {
        saved: {
          kind: "note",
          summary: "User prefers English replies",
          detail: "Noted on 2026-08-03",
          createdAt: timestamp,
        },
      },
    });
    const record = store.get((saved as { value: { saved: { id: string } } }).value.saved.id);
    expect(record.summary).toBe("User prefers English replies");
  });

  it("lists notes and filters by query", async () => {
    const { registry, context, store } = fixture();
    store.create({ kind: "note", summary: "User prefers English replies" });
    store.create({ kind: "note", summary: "User manages invoices for Acme" });
    const all = await registry.get("memory.list")!.execute(context, {});
    expect(all.ok).toBe(true);
    expect((all as { value: { items: unknown[] } }).value.items).toHaveLength(2);
    const filtered = await registry.get("memory.list")!.execute(context, { query: "invoices" });
    const items = (filtered as { value: { items: Array<{ summary: string }> } }).value.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toBe("User manages invoices for Acme");
  });

  it("updates the summary, the detail, or both on an existing note", async () => {
    const { registry, context, store } = fixture();
    const record = store.create({ kind: "note", summary: "User prefers English replies", detail: "Old context" });
    const update = registry.get("memory.update")!;
    const summaryOnly = await update.execute(context, { id: record.id, summary: "User prefers concise English replies" });
    expect(summaryOnly.ok).toBe(true);
    expect((summaryOnly as { value: { updated: { summary: string; detail: string } } }).value.updated).toMatchObject({
      summary: "User prefers concise English replies",
      detail: "Old context",
    });
    const detailOnly = await update.execute(context, { id: record.id, detail: "Noted on 2026-08-03" });
    expect(detailOnly.ok).toBe(true);
    expect((detailOnly as { value: { updated: { summary: string; detail: string } } }).value.updated).toMatchObject({
      summary: "User prefers concise English replies",
      detail: "Noted on 2026-08-03",
    });
    const both = await update.execute(context, { id: record.id, summary: "User prefers Chinese", detail: "Switched on 2026-08-04" });
    expect(both.ok).toBe(true);
    const stored = store.get(record.id);
    expect(stored.summary).toBe("User prefers Chinese");
    expect(stored.detail).toBe("Switched on 2026-08-04");
  });

  it("rejects memory.update with a missing record or an empty patch", async () => {
    const { registry, context, store } = fixture();
    const update = registry.get("memory.update")!;
    const missing = await update.execute(context, { id: "does-not-exist", summary: "x" });
    expect(missing.ok).toBe(false);
    expect((missing as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    const record = store.create({ kind: "note", summary: "Keep me" });
    const empty = await update.execute(context, { id: record.id });
    expect(empty.ok).toBe(false);
    expect((empty as { error: { code: string } }).error.code).toBe("INVALID_ARGUMENT");
  });

  it("bounds the memory.update input schema", async () => {
    const { registry } = fixture();
    const update = registry.get("memory.update")!.inputSchema;
    expect(update.safeParse({ id: "1", summary: "" }).success).toBe(false);
    expect(update.safeParse({ id: "1", summary: "x".repeat(501) }).success).toBe(false);
    expect(update.safeParse({ id: "1", detail: "x".repeat(2_001) }).success).toBe(false);
    expect(update.safeParse({ id: "1", summary: "ok", extra: true }).success).toBe(false);
    expect(update.safeParse({ id: "", summary: "ok" }).success).toBe(false);
  });

  it("deletes a note by id and reports not found afterwards", async () => {
    const { registry, context, store } = fixture();
    const record = store.create({ kind: "note", summary: "Temp note" });
    const deleted = await registry.get("memory.delete")!.execute(context, { id: record.id });
    expect(deleted).toEqual({ ok: true, value: { deleted: true } });
    const missing = await registry.get("memory.delete")!.execute(context, { id: record.id });
    expect(missing.ok).toBe(false);
    expect((missing as { ok: false }).ok).toBe(false);
  });

  it("bounds inputs through the input schemas", async () => {
    const { registry, context } = fixture();
    const save = registry.get("memory.save")!;
    expect(save.inputSchema.safeParse({ note: "" }).success).toBe(false);
    expect(save.inputSchema.safeParse({ note: "x".repeat(501) }).success).toBe(false);
    expect(save.inputSchema.safeParse({ note: "ok", unknown: true }).success).toBe(false);
    const list = registry.get("memory.list")!;
    expect(list.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(list.inputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });
});
