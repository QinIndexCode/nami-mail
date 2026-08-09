import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  externalCalendarCreateOutputSchema,
  externalCalendarDeleteOutputSchema,
  externalCalendarListOutputSchema,
  externalCalendarUpdateOutputSchema,
} from "@nami/agent-contracts";
import { createToolRegistry, type AgentToolExecutionContext } from "@nami/agent-core";
import { createCalendarTools } from "../src/agent/calendar-tools.js";
import {
  createCalendarEventConfirmationPreview,
  deleteCalendarEventConfirmationPreview,
  updateCalendarEventConfirmationPreview,
} from "../src/agent/confirmation-preview.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

const timestamp = "2026-07-27T12:00:00.000Z";

function caller() {
  return {
    callerId: "test-user",
    kind: "test" as const,
    entryPoint: "test" as const,
    accessLevel: "full-access" as const,
    scopes: ["read:calendar", "write:calendar"] as const,
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

describe("Agent calendar tools", () => {
  let db: DatabaseHandle;
  const masterKey = Buffer.alloc(32, 9);

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("registers the four calendar tools with desktop-only scoped descriptors", () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));

    for (const name of ["calendar.list", "calendar.create", "calendar.update", "calendar.delete"]) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect(tool?.descriptor.category).toBe("calendar");
      expect(tool?.descriptor.accountAccess).toBe("none");
      expect(tool?.descriptor.availableToExternal).toBe(false);
    }
    expect(registry.get("calendar.list")?.descriptor.executionMode).toBe("read");
    expect(registry.get("calendar.list")?.descriptor.requiredScopes).toEqual(["read:calendar"]);
    for (const name of ["calendar.create", "calendar.update", "calendar.delete"]) {
      const tool = registry.get(name);
      expect(tool?.descriptor.executionMode).toBe("write");
      expect(tool?.descriptor.requiredScopes).toEqual(["write:calendar"]);
      expect(tool?.descriptor.confirmationPolicy).toBe("required");
    }
  });

  it("creates, lists, updates and deletes events end-to-end through the registry", async () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));

    const created = await registry.get("calendar.create")!.execute(context(), {
      title: "Design review",
      description: "Monthly design sync",
      location: "Room 4",
      startAt: "2026-08-10T09:00:00+08:00",
      endAt: "2026-08-10T10:00:00+08:00",
      color: "purple",
    });
    expect(created.ok).toBe(true);
    const eventId = (created as { ok: true; value: z.infer<typeof externalCalendarCreateOutputSchema> }).value.event.id;

    const listed = await registry.get("calendar.list")!.execute(context(), {});
    expect(listed.ok).toBe(true);
    const events = (listed as { ok: true; value: z.infer<typeof externalCalendarListOutputSchema> }).value.events;
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("Design review");
    // Timestamps are normalized to UTC so the contract returns stable values.
    expect(events[0]?.startAt).toBe("2026-08-10T01:00:00.000Z");
    expect(events[0]?.color).toBe("purple");
    expect(events[0]?.description).toBe("Monthly design sync");

    const updated = await registry.get("calendar.update")!.execute(context(), { eventId, title: "Design review (moved)" });
    expect(updated.ok).toBe(true);
    expect((updated as { ok: true; value: z.infer<typeof externalCalendarUpdateOutputSchema> }).value.event.title).toBe("Design review (moved)");
    expect((updated as { ok: true; value: z.infer<typeof externalCalendarUpdateOutputSchema> }).value.event.description).toBe("Monthly design sync");

    const deleted = await registry.get("calendar.delete")!.execute(context(), { eventId });
    expect(deleted.ok).toBe(true);
    expect((deleted as { ok: true; value: z.infer<typeof externalCalendarDeleteOutputSchema> }).value.deleted).toBe(true);

    const listedAgain = await registry.get("calendar.list")!.execute(context(), {});
    expect(listedAgain.ok).toBe(true);
    expect((listedAgain as { ok: true; value: z.infer<typeof externalCalendarListOutputSchema> }).value.events).toHaveLength(0);
  });

  it("filters calendar.list by an exclusive after/before range", async () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));
    const createTool = registry.get("calendar.create")!;
    await createTool.execute(context(), { title: "Early", startAt: "2026-08-01T01:00:00Z", endAt: "2026-08-01T02:00:00Z" });
    await createTool.execute(context(), { title: "Middle", startAt: "2026-08-10T01:00:00Z", endAt: "2026-08-10T02:00:00Z" });
    await createTool.execute(context(), { title: "Late", startAt: "2026-08-20T01:00:00Z", endAt: "2026-08-20T02:00:00Z" });

    const listed = await registry.get("calendar.list")!.execute(context(), {
      after: "2026-08-01T02:00:00.000Z",
      before: "2026-08-20T01:00:00.000Z",
    });
    expect(listed.ok).toBe(true);
    const events = (listed as { ok: true; value: z.infer<typeof externalCalendarListOutputSchema> }).value.events;
    expect(events.map((event) => event.title)).toEqual(["Middle"]);
  });

  it("rejects invalid input at schema resolution before touching storage", () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));

    // Unknown keys are rejected by the strict schemas.
    expect(registry.resolve(call("calendar.create", {
      title: "x",
      startAt: "2026-08-10T09:00:00Z",
      endAt: "2026-08-10T10:00:00Z",
      unexpected: true,
    }))).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });

    // An event that ends before it starts is rejected.
    expect(registry.resolve(call("calendar.create", {
      title: "x",
      startAt: "2026-08-10T10:00:00Z",
      endAt: "2026-08-10T09:00:00Z",
    }))).toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });

    // An update must change at least one field beyond the event id.
    expect(registry.resolve(call("calendar.update", { eventId: "event-1" })))
      .toMatchObject({ ok: false, error: { code: "TOOL_INPUT_INVALID" } });
  });

  it("returns NOT_FOUND for unknown event ids", async () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));

    const updated = await registry.get("calendar.update")!.execute(context(), { eventId: "missing", title: "x" });
    expect(updated.ok).toBe(false);
    expect(updated.ok === false && updated.error.code).toBe("NOT_FOUND");

    const deleted = await registry.get("calendar.delete")!.execute(context(), { eventId: "missing" });
    expect(deleted.ok).toBe(false);
    expect(deleted.ok === false && deleted.error.code).toBe("NOT_FOUND");
  });

  it("reports a time conflict when an update moves the end before the start", async () => {
    const registry = createToolRegistry(createCalendarTools(db, masterKey));
    const created = await registry.get("calendar.create")!.execute(context(), {
      title: "Fixed window",
      startAt: "2026-08-10T09:00:00Z",
      endAt: "2026-08-10T10:00:00Z",
    });
    expect(created.ok).toBe(true);
    const eventId = (created as { ok: true; value: z.infer<typeof externalCalendarCreateOutputSchema> }).value.event.id;

    // The update schema only rejects a range when both bounds change together,
    // so a lone endAt change surfaces as a service-level conflict error.
    const updated = await registry.get("calendar.update")!.execute(context(), { eventId, endAt: "2026-08-10T08:00:00Z" });
    expect(updated.ok).toBe(false);
    expect(updated.ok === false && updated.error.code).toBe("INVALID_ARGUMENT");
  });

  it("localizes calendar confirmation previews for the zh-CN locale", () => {
    const preview = createCalendarEventConfirmationPreview("zh-CN", {
      title: "团队会议",
      description: "周会",
      startAt: "2026-08-10T01:00:00.000Z",
      endAt: "2026-08-10T02:00:00.000Z",
    });
    expect(preview.title).toBe("创建日历事件");
    expect(preview.summary).toContain("日历");
    expect(preview.fields.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["事件标题", "开始时间", "结束时间", "事件说明"]),
    );
    expect(preview.fields.find((entry) => entry.label === "事件标题")?.value).toBe("团队会议");

    expect(updateCalendarEventConfirmationPreview("zh-CN", {
      eventId: "event-1",
      title: "改期",
      startAt: "2026-08-11T01:00:00.000Z",
      endAt: "2026-08-11T02:00:00.000Z",
    }).title).toBe("更新日历事件");

    expect(deleteCalendarEventConfirmationPreview("zh-CN", { eventId: "event-1", title: "团队会议" }).title).toBe("删除日历事件");
  });
});
