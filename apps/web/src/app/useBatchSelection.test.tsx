// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPinnedUnseenCorrections, createPendingLocalState, mergePendingLocalState } from "../mailListState";
import type * as apiModule from "../api";
import type { Account, Message, Stats } from "../types";
import { useBatchSelection, type BatchSelection } from "./useBatchSelection";

const mocks = vi.hoisted(() => ({ flags: vi.fn(), move: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return { ...actual, api: { ...actual.api, batchUpdateMessageFlags: mocks.flags, batchMoveMessages: mocks.move } };
});

const original: Message = {
  id: "m1", accountId: "a1", accountEmail: "a@example.test", providerName: "Test",
  mailbox: "INBOX", uid: 1, subject: "Test", from: { name: "Sender", address: "s@example.test" },
  to: [], cc: [], sentAt: "2026-10-15T00:00:00Z", snippet: "", textBody: "", htmlBody: "",
  flags: [], seen: false, flagged: false, hasAttachments: false, attachments: [], size: 1,
};
const initialAccounts: Account[] = [{
  id: "a1", email: "a@example.test", provider: "custom", authMethod: "password", providerName: "Test",
  status: "connected", lastError: null, lastSyncedAt: null, signature: "", createdAt: "2026-10-15T00:00:00Z",
  folders: [
    { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 1, unseen: 1 },
    { path: "Trash", name: "Trash", specialUse: "\\Trash", total: 0, unseen: 0 },
  ],
}];

let root: Root;
let host: HTMLDivElement;
let current: BatchSelection;
let displayed: Message[];
let displayedStats: Stats;
/** What the server would answer on the next reload — the authority the pins
 * are meant to shield, and the truth a failed write must fall back to. */
let server: Message[];
const toast = vi.fn();

function Harness() {
  const [messages, setMessages] = useState([original]);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [stats, setStats] = useState<Stats>({ accounts: 1, messages: 1, unread: 1 });
  const [selectAllPaged, setSelectAllPaged] = useState(false);
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  const [, setBatchJob] = useState(null);
  const [, setTotal] = useState(1);
  const messagesRef = useRef(messages);
  const pendingRef = useRef(createPendingLocalState());
  const loadRequestRef = useRef(0);
  const viewRef = useRef("inbox" as const);
  const load = async () => {
    loadRequestRef.current += 1;
    const merged = mergePendingLocalState(server, messagesRef.current, pendingRef.current);
    const corrected = applyPinnedUnseenCorrections(
      initialAccounts,
      { accounts: 1, messages: 1, unread: server.filter((message) => !message.seen).length },
      server,
      merged,
      pendingRef.current,
    );
    messagesRef.current = merged;
    setMessages(merged);
    setAccounts(corrected.accounts);
    setStats(corrected.stats);
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  current = useBatchSelection({
    isDemo: false, t: ((key: string) => key) as never, showToast: toast,
    sortOrder: "newest", filteredMessages: messages, messages, accounts, stats,
    loadedServerMessageCount: 1, currentMessageTotal: 1, searchScope: "view", debouncedQuery: "",
    selectedAccount: "all", selectedFolder: "", view: "inbox", attachmentKindFilter: undefined,
    dateBounds: { after: undefined, before: undefined }, load, loadRef, loadRequestRef,
    messagesRef, pendingLocalStateRef: pendingRef, viewRef, selectAllPaged, setSelectAllPaged,
    setBatchJob: setBatchJob as never, pendingBatchDelete, setPendingBatchDelete,
    pinMovedAway: (ids, destination) => { for (const id of ids) pendingRef.current.movedAway.set(id, destination); },
    unpinMovedAway: (ids) => { for (const id of ids) pendingRef.current.movedAway.delete(id); },
    setMessages, setAccounts, setStats, setMessageTotal: setTotal,
  });
  displayed = messages;
  displayedStats = stats;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  server = [original];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await act(async () => current.toggleMessageSelected("m1"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("restores the authoritative flags when the write is rejected", async () => {
  let reject!: (error: Error) => void;
  mocks.flags.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  let request!: Promise<void>;
  await act(async () => { request = current.batchUpdateFlags({ seen: true }, "success"); });
  expect(displayed[0].seen).toBe(true);

  await act(async () => { reject(new Error("offline")); await request; });

  // The optimistic value must not outlive the failure: the pin has to drop
  // before the reconciling reload, or the merge re-applies it over the
  // server's answer and the rejected write looks like it landed.
  expect(displayed[0].seen, "server rejected the write; the row must show unread").toBe(false);
  expect(displayedStats.unread).toBe(1);
});

it("drops every pin when a partial failure carries no per-id detail", async () => {
  let resolve!: (value: unknown) => void;
  mocks.flags.mockImplementationOnce(() => new Promise((resolvePromise) => { resolve = resolvePromise; }));
  let request!: Promise<void>;
  await act(async () => { request = current.batchUpdateFlags({ flagged: true }, "success"); });
  expect(displayed[0].flagged).toBe(true);

  await act(async () => { resolve({ ok: true, updated: 0, failed: 1 }); await request; });

  // Without per-id detail no row may keep an unconfirmed value, and a failure
  // must not be followed by a success toast that contradicts it.
  expect(displayed[0].flagged, "unreported failures still roll back").toBe(false);
  expect(toast.mock.calls.some((call) => call[0] === "success"), "a partial failure must not be followed by success").toBe(false);
});

it("keeps the busy flag and the selection for a newer batch when an older one finishes", async () => {
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  mocks.flags.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
  mocks.flags.mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => { first = current.batchUpdateFlags({ seen: true }, "read"); });
  await act(async () => { second = current.batchUpdateFlags({ seen: false }, "unread"); });

  try {
    await act(async () => { finishFirst({ ok: true, updated: 1, failed: 0 }); await first; });
    expect(current.batchBusy, "the reversing batch has not completed").toBe(true);
    expect(current.selectedMessageIds.size, "a newer action still owns the selection").toBe(1);
  } finally {
    await act(async () => { finishSecond({ ok: true, updated: 1, failed: 0 }); await second; });
  }
  expect(current.batchBusy).toBe(false);
});

it("does not release a pin an overlapping batch still holds", async () => {
  let finishFirst!: (value: unknown) => void;
  let finishSecond!: (value: unknown) => void;
  mocks.flags.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
  mocks.flags.mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
  let first!: Promise<void>;
  let second!: Promise<void>;
  // The two batches must touch DIFFERENT flags, and one of the optimistic
  // values must differ from the server's, or the assertion below could hold
  // either way: `seen` is the discriminating one (the server still reports
  // false while the first batch's own optimistic value is true).
  await act(async () => { first = current.batchUpdateFlags({ seen: true }, "read"); });
  await act(async () => { second = current.batchUpdateFlags({ flagged: true }, "star"); });
  expect(displayed[0].seen).toBe(true);

  try {
    await act(async () => { finishFirst({ ok: true, updated: 1, failed: 0 }); await first; });
    // Pins are counted holders: the finishing batch releases only its own, so
    // the snapshot it reloads cannot flip the row back under the batch that is
    // still in flight.
    expect(displayed[0].seen, "the newer batch's pin must survive the older one's unpin").toBe(true);
    expect(displayed[0].flagged, "the newer batch's own optimistic value is pinned by itself").toBe(true);
  } finally {
    await act(async () => { finishSecond({ ok: true, updated: 1, failed: 0 }); await second; });
  }
});

it("restores the rows of a failed move after its reconciling reload", async () => {
  let reject!: (error: Error) => void;
  mocks.move.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  let request!: Promise<void>;
  await act(async () => { request = current.batchMoveMessages("trash"); });
  expect(displayed).toHaveLength(0);

  await act(async () => { reject(new Error("offline")); await request; });

  // The rollback restores the row, and the reload that follows must keep it:
  // a destination pin still held over it would hide the row from a snapshot
  // that reports it at its old mailbox, re-removing what was just put back.
  expect(displayed, "a failed move must not leave messages apparently deleted").toHaveLength(1);
  expect(current.selectedMessageIds.has("m1")).toBe(true);
});
