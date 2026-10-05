// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageBody } from "./useMessageBody";
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
  useMessageBody(isDemo, openMessage, (update) => { messages = update(messages); }, (update) => { threadExtras = update(threadExtras); });
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
  });
});

