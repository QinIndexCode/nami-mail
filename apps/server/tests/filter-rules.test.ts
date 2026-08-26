import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mail.js")>();
  return { ...actual, imapClientForAccount };
});

import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  createFilterRule,
  deleteFilterRule,
  filterRuleCreateSchema,
  filterRuleUpdateSchema,
  listFilterRules,
  matchesFilterRuleConditions,
  updateFilterRule,
} from "../src/filter-rules.js";
import type { MessagePayload } from "../src/message-storage.js";
import { applyFilterRulesToNewMessages } from "../src/sync.js";

function demoPayload(overrides: Partial<MessagePayload> = {}): MessagePayload {
  return {
    messageId: null,
    subject: "Weekly Digest",
    fromName: "Newsletter",
    fromAddress: "newsletter@example.com",
    to: [{ name: "Demo", address: "demo@example.com" }],
    cc: null,
    inReplyTo: null,
    references: null,
    snippet: "",
    textBody: "",
    htmlBody: "",
    attachments: null,
    ...overrides,
  };
}

describe("filter rules", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 7);
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    connect: vi.fn(async () => undefined),
    getMailboxLock: vi.fn(async () => lock),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    messageMove: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
  const now = new Date().toISOString();

  function insertMessage(
    id: string,
    options: {
      subject?: string;
      fromAddress?: string;
      fromName?: string;
      toJson?: string;
      hasAttachments?: number;
      flagsJson?: string;
      mailbox?: string;
    } = {},
  ): void {
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
        sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "account-1",
      options.mailbox ?? "INBOX",
      42,
      options.subject ?? "Weekly Digest",
      options.fromName ?? "Newsletter",
      options.fromAddress ?? "newsletter@example.com",
      options.toJson ?? JSON.stringify([{ name: "Demo", address: "demo@example.com" }]),
      now,
      "",
      "",
      "",
      options.flagsJson ?? "[]",
      options.hasAttachments ?? 0,
      0,
      now,
    );
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    client.getMailboxLock.mockImplementation(async () => lock);
    client.messageMove.mockResolvedValue({ uidMap: new Map([[42, 100]]) });
    imapClientForAccount.mockReturnValue(client);
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 1, 1);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "[Gmail]/All Mail", "All Mail", "\\All", 0, 0);
  });

  afterEach(() => {
    db.close();
  });

  it("creates, lists, updates and deletes filter rules", () => {
    const created = createFilterRule(db, {
      name: "Newsletter archive",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "archive" }],
    });
    expect(created.enabled).toBe(true);
    expect(created.accountId).toBeNull();
    expect(listFilterRules(db)).toHaveLength(1);

    const updated = updateFilterRule(db, created.id, {
      enabled: false,
      conditions: [{ kind: "subject", value: "digest" }],
      actions: [{ kind: "mark_seen" }],
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.conditions).toEqual([{ kind: "subject", value: "digest" }]);

    const accountScoped = createFilterRule(db, {
      name: "Account only",
      accountId: "account-1",
      conditions: [{ kind: "has_attachments", value: true }],
      actions: [{ kind: "add_flag" }],
    });
    expect(listFilterRules(db, "account-1")).toHaveLength(2);
    expect(listFilterRules(db, "account-2")).toHaveLength(1);

    expect(deleteFilterRule(db, created.id)).toBe(true);
    expect(deleteFilterRule(db, created.id)).toBe(false);
    expect(listFilterRules(db)).toHaveLength(1);
    expect(listFilterRules(db).map((rule) => rule.id)).toContain(accountScoped.id);
  });

  it("rejects malformed rule conditions and actions through the strict schema", () => {
    expect(filterRuleCreateSchema.safeParse({
      name: "Bad condition",
      conditions: [{ kind: "from" }],
      actions: [{ kind: "archive" }],
    }).success).toBe(false);
    expect(filterRuleCreateSchema.safeParse({
      name: "Bad action",
      conditions: [{ kind: "from", value: "x" }],
      actions: [{ kind: "archive", folderPath: "Inbox" }],
    }).success).toBe(false);
    expect(filterRuleCreateSchema.safeParse({
      name: "",
      conditions: [{ kind: "from", value: "x" }],
      actions: [{ kind: "archive" }],
    }).success).toBe(false);
    expect(filterRuleCreateSchema.safeParse({
      name: "No actions",
      conditions: [{ kind: "from", value: "x" }],
      actions: [],
    }).success).toBe(false);
    expect(filterRuleUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(filterRuleUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("matches every condition kind against a message payload", () => {
    const payload = demoPayload({ attachments: [{ partId: "1", filename: "a.pdf", contentType: "application/pdf", size: 1, related: false, disposition: "attachment" }] });
    expect(matchesFilterRuleConditions([{ kind: "from", value: "NEWSLETTER" }], payload)).toBe(true);
    expect(matchesFilterRuleConditions([{ kind: "from", value: "no-match" }], payload)).toBe(false);
    expect(matchesFilterRuleConditions([{ kind: "to", value: "DEMO@example" }], payload)).toBe(true);
    expect(matchesFilterRuleConditions([{ kind: "subject", value: "Weekly" }], payload)).toBe(true);
    expect(matchesFilterRuleConditions([{ kind: "subject", value: "weekly" }], payload)).toBe(true);
    expect(matchesFilterRuleConditions([{ kind: "has_attachments", value: true }], payload)).toBe(true);
    expect(matchesFilterRuleConditions([{ kind: "has_attachments", value: false }], payload)).toBe(false);
    // All conditions are ANDed.
    expect(matchesFilterRuleConditions([
      { kind: "from", value: "other-sender" },
      { kind: "has_attachments", value: false },
    ], demoPayload())).toBe(false);
    expect(matchesFilterRuleConditions([
      { kind: "from", value: "newsletter" },
      { kind: "has_attachments", value: false },
    ], demoPayload())).toBe(true);
  });

  it("applies the first matching rule's actions to a new inbox message", async () => {
    insertMessage("message-1");
    createFilterRule(db, {
      name: "Flag digest",
      conditions: [{ kind: "subject", value: "digest" }],
      actions: [{ kind: "add_flag" }],
    });
    createFilterRule(db, {
      name: "Read newsletter",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "mark_seen" }],
    });

    const result = await applyFilterRulesToNewMessages(db, masterKey, "account-1", [{ id: "message-1" }], undefined, undefined);

    expect(result).toEqual({ matched: 1, failed: 0 });
    // Only the first matching rule (by position) runs.
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Flagged"], { uid: true });
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    const row = db.prepare("SELECT flags_json FROM messages WHERE id = ?").get("message-1") as { flags_json: string };
    expect(JSON.parse(row.flags_json)).toContain("\\Flagged");
  });

  it("does nothing when no rule matches or the message is missing", async () => {
    insertMessage("message-1", { fromAddress: "noreply@example.com", fromName: "NoReply" });
    createFilterRule(db, {
      name: "Newsletter only",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "mark_seen" }],
    });

    const result = await applyFilterRulesToNewMessages(db, masterKey, "account-1", [{ id: "message-1" }, { id: "missing" }], undefined, undefined);

    expect(result).toEqual({ matched: 0, failed: 0 });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("honors the rule account scope and enabled flag", async () => {
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("account-2", "other@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", now);
    insertMessage("message-1");
    createFilterRule(db, {
      name: "Disabled",
      enabled: false,
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "mark_seen" }],
    });
    createFilterRule(db, {
      name: "Other account",
      accountId: "account-2",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "add_flag" }],
    });

    const result = await applyFilterRulesToNewMessages(db, masterKey, "account-1", [{ id: "message-1" }], undefined, undefined);

    expect(result).toEqual({ matched: 0, failed: 0 });
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("moves a matched message to a specific folder", async () => {
    insertMessage("message-1");
    createFilterRule(db, {
      name: "Move to project",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "move_to_folder", folderPath: "[Gmail]/All Mail" }],
    });

    const result = await applyFilterRulesToNewMessages(db, masterKey, "account-1", [{ id: "message-1" }], undefined, undefined);

    expect(result).toEqual({ matched: 1, failed: 0 });
    expect(client.messageMove).toHaveBeenCalledWith(42, "[Gmail]/All Mail", { uid: true });
    const row = db.prepare("SELECT mailbox, uid FROM messages WHERE id = ?").get("message-1") as { mailbox: string; uid: number };
    expect(row.mailbox).toBe("[Gmail]/All Mail");
    expect(row.uid).toBe(100);
  });

  it("reports a failed action without rejecting the batch", async () => {
    insertMessage("message-1");
    client.messageFlagsAdd.mockRejectedValueOnce(new Error("IMAP rejected flag update"));
    createFilterRule(db, {
      name: "Flag all",
      conditions: [{ kind: "from", value: "newsletter" }],
      actions: [{ kind: "add_flag" }],
    });

    const result = await applyFilterRulesToNewMessages(db, masterKey, "account-1", [{ id: "message-1" }], undefined, undefined);

    expect(result).toEqual({ matched: 0, failed: 1 });
  });
});

const insertAccountStatement = `
  INSERT INTO accounts (
    id, email, provider, provider_name, encrypted_password,
    imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
    username_mode, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

describe("filter rules API routes", () => {
  let app: FastifyInstance;
  let routeDb: DatabaseHandle;
  const routeNow = new Date().toISOString();

  beforeEach(async () => {
    routeDb = openDatabase(":memory:");
    app = await buildApp({ db: routeDb, masterKey: Buffer.alloc(32, 7) });
    routeDb.prepare(insertAccountStatement)
      .run("account-1", "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", routeNow);
    routeDb.prepare("INSERT INTO folders (account_id, path, name, special_use, total, unseen) VALUES (?, ?, ?, ?, ?, ?)")
      .run("account-1", "INBOX", "Inbox", "\\Inbox", 1, 1);
  });

  afterEach(async () => {
    await app.close();
    routeDb.close();
  });

  it("lists, creates, updates and deletes rules over HTTP", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/filter-rules",
      payload: {
        name: "Newsletter archive",
        conditions: [{ kind: "from", value: "newsletter" }],
        actions: [{ kind: "archive" }],
      },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json() as { rule: { id: string; name: string; accountId: string | null } };
    expect(created.rule.name).toBe("Newsletter archive");
    expect(created.rule.accountId).toBeNull();

    const list = await app.inject({ method: "GET", url: "/api/filter-rules" });
    expect(list.statusCode).toBe(200);
    expect(list.json().rules).toHaveLength(1);

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/filter-rules/${created.rule.id}`,
      payload: { enabled: false, actions: [{ kind: "mark_seen" }] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().rule.enabled).toBe(false);
    expect(patch.json().rule.actions).toEqual([{ kind: "mark_seen" }]);

    const remove = await app.inject({ method: "DELETE", url: `/api/filter-rules/${created.rule.id}` });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().ok).toBe(true);

    const afterRemove = await app.inject({ method: "GET", url: "/api/filter-rules" });
    expect(afterRemove.json().rules).toHaveLength(0);
  });

  it("rejects malformed payloads and missing accounts over HTTP", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/filter-rules",
      payload: { name: "", conditions: [], actions: [] },
    });
    expect(malformed.statusCode).toBe(400);

    const unknownAccount = await app.inject({
      method: "POST",
      url: "/api/filter-rules",
      payload: {
        name: "Scoped",
        accountId: "account-missing",
        conditions: [{ kind: "from", value: "x" }],
        actions: [{ kind: "archive" }],
      },
    });
    expect(unknownAccount.statusCode).toBe(404);

    const missing = await app.inject({ method: "PATCH", url: "/api/filter-rules/missing-id", payload: { name: "Renamed" } });
    expect(missing.statusCode).toBe(404);

    const remove = await app.inject({ method: "DELETE", url: "/api/filter-rules/missing-id" });
    expect(remove.statusCode).toBe(404);
  });

  it("scopes listings by account while always including global rules", async () => {
    routeDb.prepare(insertAccountStatement)
      .run("account-2", "other@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", routeNow);
    for (const rule of [
      { name: "Global", conditions: [{ kind: "subject", value: "global" }], actions: [{ kind: "mark_seen" }] },
      { name: "Account one", accountId: "account-1", conditions: [{ kind: "subject", value: "one" }], actions: [{ kind: "add_flag" }] },
      { name: "Account two", accountId: "account-2", conditions: [{ kind: "subject", value: "two" }], actions: [{ kind: "archive" }] },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/filter-rules", payload: rule });
      expect(response.statusCode).toBe(200);
    }

    const all = await app.inject({ method: "GET", url: "/api/filter-rules" });
    expect(all.json().rules).toHaveLength(3);

    const scoped = await app.inject({ method: "GET", url: "/api/filter-rules?accountId=account-1" });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().rules.map((rule: { name: string }) => rule.name).sort()).toEqual(["Account one", "Global"]);
  });
});
