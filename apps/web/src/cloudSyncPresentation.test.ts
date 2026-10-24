import { describe, expect, it } from "vitest";
import type { DeliveryTask } from "./batchJobTypes";
import { cloudSyncAccountLabel, cloudSyncKindLabel, cloudSyncTaskDetail } from "./cloudSyncPresentation";
import type { Translate } from "./i18n";

/** Every string comes back as its key (plus the parameters), so an assertion
 *  reads as the sentence the panel will pick rather than its prose. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}${JSON.stringify(params)}` : key) as Translate;

function task(overrides: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: "t1",
    accountId: "acct-1",
    accountEmail: "me@example.com",
    kind: "flags",
    scope: "batch",
    status: "running",
    total: 10,
    updated: 0,
    failed: 0,
    createdAt: 1,
    completedAt: null,
    dueAt: null,
    ...overrides,
  };
}

/** The parameter object a rendered template carries. */
function paramsOf(rendered: string): Record<string, unknown> {
  return JSON.parse(rendered.slice(rendered.indexOf("{"))) as Record<string, unknown>;
}

describe("cloudSyncKindLabel", () => {
  it("names every kind the task layer knows", () => {
    for (const kind of ["move", "flags", "undo", "send", "draft-discard", "snooze", "filter", "agent-apply"]) {
      expect(cloudSyncKindLabel(kind, t)).toBe(`cloudSync.kind.${kind}`);
    }
  });

  it("labels a kind this bundle has never heard of instead of hiding the row", () => {
    // The server may legitimately be newer than the running bundle: it forwards
    // the kind verbatim so the panel can say "something else is syncing" rather
    // than list a task with no line at all.
    expect(cloudSyncKindLabel("reindex", t)).toBe("cloudSync.kind.other");
  });
});

describe("cloudSyncAccountLabel", () => {
  it("prefers the address and falls back to the id a removed account left behind", () => {
    expect(cloudSyncAccountLabel(task())).toBe("me@example.com");
    expect(cloudSyncAccountLabel(task({ accountEmail: null }))).toBe("acct-1");
  });
});

describe("cloudSyncTaskDetail", () => {
  it("describes a terminal row by what it failed to deliver, with counts when it has them", () => {
    expect(cloudSyncTaskDetail(task({ status: "failed", completedAt: 5, failed: 3 }), t, "zh-CN")).toBe(
      `cloudSync.failedDetail${JSON.stringify({ failed: 3, total: 10 })}`,
    );
    // A push refused before it touched a message reports zero per-message
    // failures; "0/10 failed" would read as nothing having failed.
    expect(cloudSyncTaskDetail(task({ status: "failed", completedAt: 5, failed: 0 }), t, "zh-CN")).toBe("cloudSync.failedWhole");
  });

  it("distinguishes 'the server refused' from 'nobody knows what happened'", () => {
    expect(cloudSyncTaskDetail(task({ status: "unknown_delivery", completedAt: 5, failed: 2 }), t, "zh-CN")).toBe(
      "cloudSync.unknownDetail",
    );
  });

  it("reports a not-yet-due task by its due time rather than its counters", () => {
    const dueAt = Date.UTC(2026, 9, 18, 9, 0, 0);
    const rendered = cloudSyncTaskDetail(task({ status: "pending", scope: "single", dueAt, updated: 2 }), t, "zh-CN", dueAt - 1);
    expect(rendered.startsWith("cloudSync.waitingUntil")).toBe(true);
    expect(typeof paramsOf(rendered).time).toBe("string");

    // Once the due time has passed the task is claimable, so the wait sentence
    // stops being true and progress is what is left to say.
    expect(cloudSyncTaskDetail(task({ dueAt, updated: 2 }), t, "zh-CN", dueAt + 1)).toBe(
      `cloudSync.progress${JSON.stringify({ updated: 2, total: 10 })}`,
    );
  });

  it("reads a terminal row before a pending wake-up", () => {
    // A terminal row's numbers are final; a stale dueAt must not turn it back
    // into a waiting task.
    expect(cloudSyncTaskDetail(task({ status: "cancelled", completedAt: 5, dueAt: 60_000 }), t, "zh-CN", 1)).toBe(
      "cloudSync.failedWhole",
    );
  });

  it("does not claim progress a push has not reported yet", () => {
    // The flags path reports its counters once, at the end, so a 1262-message
    // push shows updated:0 for its whole life. "0/1262" would describe a stuck
    // task; the scope sentence describes a busy one.
    expect(cloudSyncTaskDetail(task({ updated: 0, total: 1262 }), t, "zh-CN")).toBe(
      `cloudSync.queued${JSON.stringify({ count: 1262 })}`,
    );
    expect(cloudSyncTaskDetail(task({ scope: "single", updated: 0, total: 1 }), t, "zh-CN")).toBe("cloudSync.inFlight");
  });

  it("reports the counters once a push does report them", () => {
    expect(cloudSyncTaskDetail(task({ updated: 4 }), t, "zh-CN")).toBe(
      `cloudSync.progress${JSON.stringify({ updated: 4, total: 10 })}`,
    );
  });
});
