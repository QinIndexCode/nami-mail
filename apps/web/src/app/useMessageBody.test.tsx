// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureFullMessage, useMessageBody } from "./useMessageBody";
import type { Message, MessageDetail } from "../types";
import type { ThreadSnapshot } from "../threads";
import type * as apiModule from "../api";

const { message } = vi.hoisted(() => ({ message: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return { ...actual, api: { ...actual.api, message } };
});

import { api } from "../api";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
let messages: Message[];
let threadExtras: ThreadSnapshot | null;
let renders = 0;
let phases: string[] = [];
let lastReload: () => void = () => undefined;

function detailFixture(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: "message-1",
    accountId: "account-1",
    accountEmail: "demo@example.com",
    providerName: "Demo",
    mailbox: "INBOX",
    uid: 1,
    subject: "Subject",
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    messageId: null,
    inReplyTo: null,
    references: [],
    sentAt: "2026-07-20T03:04:05.000Z",
    snippet: "snippet",
    textBody: "full body",
    htmlBody: "<p>full body</p>",
    flags: [],
    seen: true,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 10,
    ...overrides,
  } as MessageDetail;
}

/** A row as the list endpoint serves it: a text preview, no HTML key. */
function listRowFixture(overrides: Partial<Message> = {}): Message {
  const { htmlBody: _omitted, ...rest } = detailFixture();
  return { ...rest, textBody: "preview", ...overrides } as Message;
}

function Harness({ isDemo, openMessage }: { isDemo: boolean; openMessage: Message | null }) {
  renders += 1;
  const { phase, reload } = useMessageBody(isDemo, openMessage, (update) => { messages = update(messages); }, (update) => { threadExtras = update(threadExtras); });
  phases.push(phase);
  lastReload = reload;
  return null;
}

async function render(props: { isDemo: boolean; openMessage: Message | null }): Promise<void> {
  await act(async () => { root.render(<Harness {...props} />); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  messages = [listRowFixture()];
  threadExtras = { anchorId: "message-1", members: [listRowFixture()] };
  renders = 0;
  phases = [];
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("useMessageBody", () => {
  it("loads the open message's body and merges it into both reader sources", async () => {
    message.mockResolvedValue(detailFixture());

    await render({ isDemo: false, openMessage: messages[0] });

    expect(api.message).toHaveBeenCalledWith("message-1");
    expect(messages[0]).toMatchObject({ textBody: "full body", htmlBody: "<p>full body</p>" });
    expect(threadExtras?.members[0]).toMatchObject({ textBody: "full body", htmlBody: "<p>full body</p>" });
  });

  it("does not refetch a row that already carries a body, and never in demo mode", async () => {
    await render({ isDemo: false, openMessage: detailFixture() });
    await render({ isDemo: true, openMessage: listRowFixture() });
    await render({ isDemo: false, openMessage: null });

    expect(message).not.toHaveBeenCalled();
  });

  it("stops after one request per body-less row instead of looping on an empty body", async () => {
    // A genuinely empty message comes back with both keys present and empty;
    // a list row has no htmlBody key at all. Treating "empty" as "missing"
    // would refetch forever.
    message.mockResolvedValue(detailFixture({ textBody: "", htmlBody: "" }));

    await render({ isDemo: false, openMessage: listRowFixture() });
    const afterFirst = renders;
    await act(async () => { await Promise.resolve(); });
    await render({ isDemo: false, openMessage: messages[0] });

    expect(message).toHaveBeenCalledTimes(1);
    expect(messages[0]).toMatchObject({ textBody: "", htmlBody: "" });
    expect(renders).toBeGreaterThan(afterFirst);
  });

  it("keeps the reader on its row when the request fails", async () => {
    message.mockRejectedValue(new Error("offline"));

    await render({ isDemo: false, openMessage: listRowFixture() });

    expect(messages[0]).toMatchObject({ textBody: "preview" });
    expect(messages[0].htmlBody).toBeUndefined();
    expect(phases.at(-1)).toBe("error");
  });

  // R10: the reader must be able to show loading/error and retry, and the
  // merge must never let an older detail response overwrite flags the user
  // just changed while the request was in flight.
  it("reports loading and then loaded phases", async () => {
    let resolveDetail: (detail: MessageDetail) => void = () => undefined;
    message.mockReturnValue(new Promise<MessageDetail>((resolve) => { resolveDetail = resolve; }));

    await render({ isDemo: false, openMessage: listRowFixture() });
    expect(phases.at(-1)).toBe("loading");

    await act(async () => { resolveDetail(detailFixture()); await Promise.resolve(); });
    expect(phases.at(-1)).toBe("loaded");
    expect(messages[0]).toMatchObject({ textBody: "full body" });
  });

  it("an empty-body success still counts as loaded", async () => {
    message.mockResolvedValue(detailFixture({ textBody: "", htmlBody: "" }));

    await render({ isDemo: false, openMessage: listRowFixture() });

    expect(phases.at(-1)).toBe("loaded");
  });

  it("reload retries after a failure and recovers", async () => {
    let attempts = 0;
    message.mockImplementation(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(detailFixture());
    });

    await render({ isDemo: false, openMessage: listRowFixture() });
    expect(phases.at(-1)).toBe("error");

    await act(async () => {
      lastReload();
      await Promise.resolve();
    });

    expect(attempts).toBe(2);
    expect(phases.at(-1)).toBe("loaded");
    expect(messages[0]).toMatchObject({ textBody: "full body" });
  });

  it("a late detail response preserves flags the user changed while it was in flight", async () => {
    let resolveDetail: (detail: MessageDetail) => void = () => undefined;
    message.mockReturnValue(new Promise<MessageDetail>((resolve) => { resolveDetail = resolve; }));

    await render({ isDemo: false, openMessage: listRowFixture({ seen: false, flagged: true }) });

    // The user toggles seen and un-flags while the detail is loading — the
    // optimistic local state is newer than the wire row.
    await act(async () => {
      messages = messages.map((item) => (item.id === "message-1" ? { ...item, seen: true, flagged: false } : item));
    });

    await act(async () => { resolveDetail(detailFixture({ seen: false, flagged: true })); await Promise.resolve(); });

    // The body arrives, the flags stay local-newer.
    expect(messages[0]).toMatchObject({ textBody: "full body", seen: true, flagged: false });
    expect(threadExtras?.members[0]).toMatchObject({ textBody: "full body", seen: true, flagged: false });
  });
});

/**
 * R10 action assembly: reply/reply-all/forward resolve the FULL message for
 * the pinned id through this seam before building compose content, instead
 * of quoting the 4000-character list preview.
 */
describe("ensureFullMessage", () => {
  it("resolves a row that already carries a body without a request", async () => {
    const merge = vi.fn();
    const result = await ensureFullMessage(false, detailFixture(), merge);
    expect(result?.textBody).toBe("full body");
    expect(message).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it("fetches, merges, and returns the full detail for a body-less row", async () => {
    message.mockResolvedValue(detailFixture({ textBody: "full body with trailing canary END-CANARY" }));
    const merge = vi.fn();

    const result = await ensureFullMessage(false, listRowFixture(), merge);

    expect(result?.textBody).toContain("END-CANARY");
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("returns null on failure without merging, so the caller keeps the current mail", async () => {
    message.mockRejectedValue(new Error("offline"));
    const merge = vi.fn();

    const result = await ensureFullMessage(false, listRowFixture(), merge);

    expect(result).toBeNull();
    expect(merge).not.toHaveBeenCalled();
  });

  it("never merges a detail into another message's row (switch-safe)", async () => {
    message.mockResolvedValue(detailFixture({ id: "message-old", textBody: "old body" }));
    const merge = vi.fn();

    await ensureFullMessage(false, listRowFixture({ id: "message-old" }), merge);
    const mergedDetail = merge.mock.calls[0]![0] as MessageDetail;

    // The merge names the detail's own id; the caller's by-id merge can
    // therefore never touch the row that is open now.
    expect(mergedDetail.id).toBe("message-old");
  });
});

