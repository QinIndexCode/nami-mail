// @vitest-environment jsdom
import { act, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as apiModule from "../api";
import type { MoveTarget } from "../api";
import type { Account, Message } from "../types";
import { createMailStore, type MailStore, type SnapshotContext } from "./mailStore";
import { useQuickMessageActions, type QuickMessageActions } from "./useQuickMessageActions";

const mocks = vi.hoisted(() => ({ flags: vi.fn(), move: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      updateMessageFlags: mocks.flags,
      moveMessage: mocks.move,
    },
  };
});

function makeMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    accountId: "a1",
    accountEmail: "a@example.test",
    providerName: "Test",
    mailbox: "INBOX",
    uid: Number(id.replace(/\D/g, "")) || 1,
    subject: "Test",
    from: { name: "Sender", address: "s@example.test" },
    to: [],
    cc: [],
    sentAt: "2026-10-15T00:00:00Z",
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

const accounts: Account[] = [{
  id: "a1", email: "a@example.test", provider: "custom", authMethod: "password", providerName: "Test",
  status: "connected", lastError: null, lastSyncedAt: null, signature: "", createdAt: "2026-10-15T00:00:00Z",
  folders: [
    { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 3, unseen: 3 },
    { path: "Trash", name: "Trash", specialUse: "\\Trash", total: 0, unseen: 0 },
  ],
}];

let root: Root;
let host: HTMLDivElement;
let current: QuickMessageActions;
let displayed: Message[];
let store: MailStore;
/** Full list-load calls. A successful write must not take this page-resetting path. */
let loadCalls = 0;
/** Pagination-preserving reconcile calls. */
let reconcileCalls = 0;
const toast = vi.fn();

const snapshotContext = (): SnapshotContext => ({
  query: store.getQuery(),
  view: "inbox",
  recentlyReadIds: new Set(),
  pendingArchiveMoves: [],
});

function Harness() {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [messageFlagging, setMessageFlagging] = useState(false);
  const [messageAction, setMessageAction] = useState<MoveTarget | null>(null);
  const [selectedId] = useState("m1");
  const viewRef = useRef<"inbox">("inbox") as { current: "inbox" };
  const loadRequestRef = useRef(0);
  const load = async () => { loadCalls += 1; };
  const reconcile = async () => { reconcileCalls += 1; };
  current = useQuickMessageActions({
    selected: state.messages.find((message) => message.id === selectedId) ?? null,
    selectedRemoteActionsBlocked: false,
    isDemo: false,
    t: ((key: string) => key) as never,
    showToast: toast,
    store,
    viewRef,
    messageFlagging,
    messageAction,
    setMessageFlagging,
    setMessageAction,
    batchBusy: false,
    applyBatchFlaggedChange: (ids, flagged) => store.applyFlag(ids, flagged),
    loadRequestRef,
    load,
    reconcile,
    applyLocalSeenChange: (message, nextSeen) => store.applySeen([message.id], nextSeen),
    updateUnreadViewRecentlyRead: () => {},
    setSelectedId: () => {},
  });
  displayed = state.messages;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  loadCalls = 0;
  reconcileCalls = 0;
  // Two pages: m1/m2 are the first page, m3 was loaded behind the cursor.
  const firstPage = [makeMessage("m1"), makeMessage("m2")];
  const secondPage = [makeMessage("m3")];
  store = createMailStore({ reconcile: async () => undefined });
  store.adoptSnapshot({
    accounts,
    stats: { accounts: 1, messages: 3, unread: 3, starred: 0, snoozed: 0, attachments: 0 },
    items: firstPage,
    total: 3,
    nextCursor: "cursor-page-2",
  }, { query: store.getQuery(), view: "inbox", recentlyReadIds: new Set(), pendingArchiveMoves: [] });
  store.appendPage({ items: secondPage, total: 3, nextCursor: null }, snapshotContext());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("useQuickMessageActions", () => {
  it("restores Trash mail through the existing inbox API and rolls back a refused restore", async () => {
    await act(async () => { store.applyMove(["m1"], "Trash"); });
    mocks.move.mockResolvedValueOnce({ ok: true, destination: "INBOX" });
    await act(async () => { await current.quickMoveMessage(displayed[0]!, "inbox"); });
    expect(mocks.move).toHaveBeenLastCalledWith("m1", "inbox");
    expect(displayed[0]!.mailbox).toBe("INBOX");
    expect(reconcileCalls).toBe(1);

    await act(async () => { store.applyMove(["m1"], "Trash"); });
    mocks.move.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await current.quickMoveMessage(displayed[0]!, "inbox"); });
    expect(displayed[0]!.mailbox).toBe("Trash");
    expect(store.getState().pendingTargets.movedAway.size).toBe(0);
  });

  it("ignores a second star toggle while the first is still in flight", async () => {
    let rejectFirst!: (error: Error) => void;
    mocks.flags.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { rejectFirst = rejectPromise; }));
    let first!: Promise<void>;
    await act(async () => { first = current.quickToggleStar(displayed[0]!); });
    expect(displayed[0]!.flagged, "the optimistic value is on screen").toBe(true);

    // The row is pinned for the in-flight write; a second click must not start
    // a competing request whose rollback could clobber it.
    await act(async () => { await current.quickToggleStar(displayed[0]!); });
    expect(mocks.flags, "one in-flight mutation per row").toHaveBeenCalledTimes(1);

    await act(async () => { rejectFirst(new Error("offline")); await first; });
    expect(displayed[0]!.flagged, "the failed write rolls back once").toBe(false);
    expect(store.getState().pendingTargets.flagOverrides.size, "the pin is released").toBe(0);
  });

  it("rolls back to the row's current flag, not the caller's stale copy", async () => {
    // The row already holds a newer accepted value (e.g. a batch wrote it) while
    // the caller's `message` prop is an older object saying unflagged.
    await act(async () => { store.applyFlag(["m1"], true); });
    const staleRow = { ...displayed[0]!, flagged: false };
    mocks.flags.mockRejectedValueOnce(new Error("offline"));

    await act(async () => { await current.quickToggleStar(staleRow); });

    expect(displayed[0]!.flagged, "a stale captured row must not undo the newer state").toBe(true);
  });

  it("reconciles after a successful quick move instead of resetting the loaded pages", async () => {
    mocks.move.mockResolvedValueOnce({ ok: true, destination: "Trash" });
    const moved = displayed[0]!;

    await act(async () => { await current.quickMoveMessage(moved, "trash"); });

    expect(loadCalls, "the full list load would drop page two").toBe(0);
    expect(reconcileCalls, "the pagination-preserving refresh is used instead").toBe(1);
    expect(displayed.map((message) => message.id), "the pages the user loaded survive").toEqual(["m1", "m2", "m3"]);
    // The row is retargeted locally (the view's predicate is what hides it);
    // no full reload replaced the window underneath the user.
    expect(displayed[0]!.mailbox).toBe("Trash");
  });

  it("keeps the loaded pages after a successful read toggle", async () => {
    mocks.flags.mockResolvedValueOnce({ ok: true });
    const row = displayed[0]!;

    await act(async () => { await current.quickToggleSeen(row); });

    expect(loadCalls).toBe(0);
    expect(reconcileCalls).toBe(0);
    expect(displayed.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(displayed[0]!.seen).toBe(true);
  });
});
