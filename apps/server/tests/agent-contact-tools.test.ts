import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  externalContactCreateOutputSchema,
  externalContactDeleteOutputSchema,
  externalContactsSearchOutputSchema,
  externalContactUpdateOutputSchema,
  CallerContext,
} from "@nami/agent-contracts";
import { createToolRegistry, type AgentToolExecutionContext } from "@nami/agent-core";
import { createContactTools } from "../src/agent/contact-tools.js";
import {
  createContactConfirmationPreview,
  deleteContactConfirmationPreview,
  updateContactConfirmationPreview,
} from "../src/agent/confirmation-preview.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller(): CallerContext {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:contacts", "write:contacts"] as const,
    accountScope: { mode: "none" as const },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function context(): AgentToolExecutionContext {
  return {
    requestId: "9d65af5e-b4d2-4b31-9131-f1e3c3b93d20",
    caller: caller(),
    accountIds: [],
  };
}

function call(toolName: string, input: unknown) {
  return {
    id: "call-1",
    toolName,
    input,
    requestedAt: timestamp,
  };
}

describe("Agent contact tools", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("registers the four contact tools with desktop-only scoped descriptors", () => {
    const registry = createToolRegistry(createContactTools(db, masterKey));

    for (const name of ["contacts.search", "contacts.create", "contacts.update", "contacts.delete"]) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor.category).toBe("contacts");
      expect(tool?.descriptor.accountAccess).toBe("none");
      expect(tool?.descriptor.availableToExternal).toBe(false);
    }
    expect(registry.get("contacts.search")?.descriptor.executionMode).toBe("read");
    expect(registry.get("contacts.search")?.descriptor.requiredScopes).toEqual(["read:contacts"]);
    for (const name of ["contacts.create", "contacts.update", "contacts.delete"]) {
      const tool = registry.get(name);
      expect(tool?.descriptor.executionMode).toBe("write");
      expect(tool?.descriptor.requiredScopes).toEqual(["write:contacts"]);
      expect(tool?.descriptor.confirmationPolicy).toBe("required");
    }
    expect(registry.get("contacts.create")?.descriptor.confirmationAction).toBe("create-contact");
    expect(registry.get("contacts.update")?.descriptor.confirmationAction).toBe("update-contact");
    expect(registry.get("contacts.delete")?.descriptor.confirmationAction).toBe("delete-contact");
  });

  it("creates, searches, updates and deletes contacts end-to-end through the registry", async () => {
    const registry = createToolRegistry(createContactTools(db, masterKey));

    const created = await registry.get("contacts.create")!.execute(context(), {
      email: "alice@example.com",
      name: "Alice Smith",
      notes: "Project lead for Nami Mail",
    });
    expect(created.ok).toBe(true);
    const contactId = (created as { ok: true; value: z.infer<typeof externalContactCreateOutputSchema> }).value.contact.id;

    const searchedAll = await registry.get("contacts.search")!.execute(context(), {});
    expect(searchedAll.ok).toBe(true);
    const contacts = (searchedAll as { ok: true; value: z.infer<typeof externalContactsSearchOutputSchema> }).value.contacts;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.name).toBe("Alice Smith");
    expect(contacts[0]?.email).toBe("alice@example.com");
    expect(contacts[0]?.notes).toBe("Project lead for Nami Mail");
    expect(contacts[0]?.autoCollected).toBe(false);

    // Substring query filtering
    const searchByName = await registry.get("contacts.search")!.execute(context(), { query: "smith" });
    expect(searchByName.ok).toBe(true);
    expect((searchByName as { ok: true; value: z.infer<typeof externalContactsSearchOutputSchema> }).value.contacts).toHaveLength(1);

    const searchNoMatch = await registry.get("contacts.search")!.execute(context(), { query: "bob" });
    expect(searchNoMatch.ok).toBe(true);
    expect((searchNoMatch as { ok: true; value: z.infer<typeof externalContactsSearchOutputSchema> }).value.contacts).toHaveLength(0);

    // Update
    const updated = await registry.get("contacts.update")!.execute(context(), {
      contactId,
      name: "Alice Johnson",
      notes: "Senior Project Lead",
    });
    expect(updated.ok).toBe(true);
    expect((updated as { ok: true; value: z.infer<typeof externalContactUpdateOutputSchema> }).value.contact.name).toBe("Alice Johnson");
    expect((updated as { ok: true; value: z.infer<typeof externalContactUpdateOutputSchema> }).value.contact.notes).toBe("Senior Project Lead");

    // Delete
    const deleted = await registry.get("contacts.delete")!.execute(context(), { contactId });
    expect(deleted.ok).toBe(true);
    expect((deleted as { ok: true; value: z.infer<typeof externalContactDeleteOutputSchema> }).value.deleted).toBe(true);

    const searchedAgain = await registry.get("contacts.search")!.execute(context(), {});
    expect(searchedAgain.ok).toBe(true);
    expect((searchedAgain as { ok: true; value: z.infer<typeof externalContactsSearchOutputSchema> }).value.contacts).toHaveLength(0);
  });

  it("rejects invalid input at schema resolution before touching storage", () => {
    const registry = createToolRegistry(createContactTools(db, masterKey));

    // Unknown keys are rejected by strict schemas.
    expect(registry.resolve(call("contacts.create", {
      email: "test@example.com",
      unexpected: true,
    }))).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });

    // Invalid email format is rejected.
    expect(registry.resolve(call("contacts.create", {
      email: "not-an-email",
    }))).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });

    // An update must change at least one field beyond the contact id.
    expect(registry.resolve(call("contacts.update", { contactId: "contact-1" })))
      .toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });
  });

  it("returns NOT_FOUND for unknown contact ids", async () => {
    const registry = createToolRegistry(createContactTools(db, masterKey));

    const updated = await registry.get("contacts.update")!.execute(context(), { contactId: "missing", name: "Bob" });
    expect(updated.ok).toBe(false);
    expect(updated.ok === false && updated.error.code).toBe("NOT_FOUND");

    const deleted = await registry.get("contacts.delete")!.execute(context(), { contactId: "missing" });
    expect(deleted.ok).toBe(false);
    expect(deleted.ok === false && deleted.error.code).toBe("NOT_FOUND");
  });

  it("reports a CONFLICT when creating a contact with an already registered email", async () => {
    const registry = createToolRegistry(createContactTools(db, masterKey));
    const created = await registry.get("contacts.create")!.execute(context(), {
      email: "shared@example.com",
      name: "First Contact",
    });
    expect(created.ok).toBe(true);

    const conflict = await registry.get("contacts.create")!.execute(context(), {
      email: "shared@example.com",
      name: "Duplicate Contact",
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.ok === false && conflict.error.code).toBe("CONFLICT");
  });

  it("localizes contact confirmation previews for the zh-CN locale", () => {
    const preview = createContactConfirmationPreview("zh-CN", {
      name: "张三",
      email: "zhangsan@example.com",
      notes: "项目负责人",
    });
    expect(preview.title).toBe("创建联系人");
    expect(preview.summary).toContain("联系人");
    expect(preview.fields.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["姓名", "邮箱", "备注"]),
    );
    expect(preview.fields.find((entry) => entry.label === "姓名")?.value).toBe("张三");

    expect(updateContactConfirmationPreview("zh-CN", {
      contactId: "contact-1",
      name: "李四",
    }).title).toBe("更新联系人");

    expect(deleteContactConfirmationPreview("zh-CN", {
      contactId: "contact-1",
      name: "张三",
      email: "zhangsan@example.com",
    }).title).toBe("删除联系人");
  });
});
