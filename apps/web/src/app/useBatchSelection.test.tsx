// @vitest-environment jsdom
import { act, useCallback, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingLocalState } from "../mailListState";
import type * as apiModule from "../api";
import type { Account, Message, Stats } from "../types";
import { createMailStore, type MailStore, type SnapshotContext } from "./mailStore";
import { useBatchSelection, type BatchSelection } from "./useBatchSelection";

const mocks = vi.hoisted(() => ({ flags: vi.fn(), move: vi.fn(), create: vi.fn(), status: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      batchUpdateMessageFlags: mocks.flags,
      batchMoveMessages: mocks.move,
      batchJobCreate: mocks.create,
      batchJobStatus: mocks.status,
    },
  };
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
/** The store the harness renders from; re-created when a test swaps mailbox. */
let store: MailStore;
/** The rows the harness seeds itself with. It is read once, on the first render,
 *  so a test that needs a selection past the server's id cap has to swap it in
 *  and remount before it acts. */
let mailbox: Message[];
/** What the server would answer on the next reload — the authority the pins
 *  are meant to shield, and the truth a failed write must fall back to. */
let server: Message[];
/** How many full (`adoptSnapshot`) loads the hook ran. A successful batch must
 *  never take this path: it replaces the window with the first page. */
let loadCalls = 0;
/** How many pagination-preserving reconciles the hook ran. */
let reconcileCalls = 0;
/** The cursor the harness's simulated App keeps. A full load resets it to the
 *  first page's cursor; a reconcile leaves it where the user paged to. */
let loadedCursor: string | null = null;
/** What a freshly mounted harness seeds its cursor with (null = one page). */
let initialCursor: string | null = null;
const toast = vi.fn();
/** Every value the hook hands to `setSelectAllPaged`, in order. */
const pagedWrites: boolean[] = [];
/** The hook's pending-local-state registry, so a test can observe its pins
 *  (the rows a snapshot must keep out of the list until the server agrees). */
let pending: PendingLocalState;
/** Drives `currentMessageTotal`, i.e. how many rows a predicate-wide selection
 *  would cover. A page shorter than this is what arms "select all matching". */
let setMatchingTotalState: (value: number) => void = () => undefined;

const snapshotContext = (): SnapshotContext => ({
  query: store.getQuery(),
  view: "inbox",
  recentlyReadIds: new Set(),
  pendingArchiveMoves: [],
});

/** Seeds a store with a mailbox the way `load` seeds the real one. */
function seedStore(messages: Message[]): MailStore {
  const seeded = createMailStore({ reconcile: async () => undefined });
  seeded.adoptSnapshot({
    accounts: initialAccounts,
    stats: { accounts: 1, messages: messages.length, unread: messages.filter((message) => !message.seen).length },
    items: messages,
    total: messages.length,
    nextCursor: null,
  }, snapshotContextFor(seeded));
  return seeded;
}

/** `snapshotContext` reads the module-level store; seeding needs its own. */
function snapshotContextFor(target: MailStore): SnapshotContext {
  return { query: target.getQuery(), view: "inbox", recentlyReadIds: new Set(), pendingArchiveMoves: [] };
}

function Harness() {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [selectAllPaged, setSelectAllPagedState] = useState(false);
  const [matchingTotal, setMatchingTotal] = useState(mailbox.length);
  const setSelectAllPaged = useCallback((value: boolean) => {
    pagedWrites.push(value);
    setSelectAllPagedState(value);
  }, []);
  setMatchingTotalState = setMatchingTotal;
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  const loadRequestRef = useRef(0);
  const ref = useRef(store);
  ref.current = store;
  pending = state.pendingTargets;
  // A full load, shaped like App.load: it adopts the first page wholesale and
  // resets the cursor, so whatever pages the user had loaded are gone. A
  // successful batch must never use this path.
  const fullLoad = async () => {
    loadCalls += 1;
    loadRequestRef.current += 1;
    ref.current.adoptSnapshot({
      accounts: initialAccounts,
      stats: { accounts: 1, messages: server.length, unread: server.filter((message) => !message.seen).length },
      items: server,
      total: server.length,
      nextCursor: null,
    }, snapshotContext());
    loadedCursor = null;
  };
  const loadRef = useRef(fullLoad);
  loadRef.current = fullLoad;
  // The pagination-preserving reconcile, shaped like App.silentRefresh: merge
  // the server's first page into the loaded window and leave the cursor alone.
  // `total` is the server's count for the whole view (not the first page's row
  // count), which is what keeps the merge from slicing the loaded pages away.
  const reconcile = async () => {
    reconcileCalls += 1;
    ref.current.mergeSnapshot({
      accounts: initialAccounts,
      stats: { accounts: 1, messages: mailbox.length, unread: server.filter((message) => !message.seen).length },
      items: server,
      total: mailbox.length,
      nextCursor: initialCursor,
    }, snapshotContext());
  };
  const cursorRef = useRef(initialCursor);
  loadedCursor = cursorRef.current;
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  current = useBatchSelection({
    isDemo: false, t: ((key: string) => key) as never, showToast: toast,
    sortOrder: "newest", filteredMessages: state.messages, store,
    loadedServerMessageCount: mailbox.length, currentMessageTotal: matchingTotal, searchScope: "view", debouncedQuery: "",
    selectedAccount: "all", selectedFolder: "", view: "inbox", attachmentKindFilter: undefined,
    dateBounds: { after: undefined, before: undefined }, load: fullLoad, loadRef,
    reconcileRef, loadRequestRef,
    selectAllPaged, setSelectAllPaged, pendingBatchDelete, setPendingBatchDelete,
  });
  displayed = state.messages;
  displayedStats = state.stats;
  return null;
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  pagedWrites.length = 0;
  loadCalls = 0;
  reconcileCalls = 0;
  loadedCursor = null;
  initialCursor = null;
  mailbox = [original];
  server = [original];
  store = seedStore(mailbox);
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
  let rejectFirst!: (error: Error) => void;
  let finishSecond!: (value: unknown) => void;
  mocks.flags.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { rejectFirst = rejectPromise; }));
  mocks.flags.mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
  let first!: Promise<void>;
  let second!: Promise<void>;
  // The FAILING batch is the one that releases a pin twice — once before its
  // reconciling reload and once after it — so this is where an unconditional
  // release would take the holder of the batch still in flight with it. The two
  // batches must touch different flags: `flagged` is the only value the newer
  // batch ever wrote, so if its holder is dropped, the newer batch's own reload
  // overwrites it with the server's truth and the assertion below fails.
  await act(async () => { first = current.batchUpdateFlags({ seen: true }, "read"); });
  await act(async () => { second = current.batchUpdateFlags({ flagged: true }, "star"); });
  expect(displayed[0].seen, "the first batch applied its own patch optimistically").toBe(true);

  await act(async () => { rejectFirst(new Error("offline")); await first; });
  expect(current.batchBusy, "the newer batch is still in flight").toBe(true);

  await act(async () => { finishSecond({ ok: true, updated: 1, failed: 0 }); await second; });

  expect(displayed[0].flagged, "the newer batch's optimistic value must outlive its own reconciling reload").toBe(true);
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

/**
 * The server's per-request id cap, restated here on purpose: the renderer has to
 * split an explicit selection at exactly this boundary, and a request one id
 * longer is refused outright (`batchMessageIdsSchema` in apps/server/src/schemas.ts,
 * pinned by "refuses a selection past its id cap in one piece" in
 * apps/server/tests/app.test.ts). If either side moves, one of the two tests
 * fails instead of the mismatch reaching a user as an unactionable error.
 */
const SERVER_BATCH_ID_LIMIT = 5000;

/** A mailbox of `count` distinct unread INBOX rows. */
function mailboxOf(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({ ...original, id: `m${index + 1}`, uid: index + 1 }));
}

/** Re-seeds the harness with another mailbox: its rows are read on the first
 *  render, so a selection past the id cap has to be mounted before it is acted
 *  on. The beforeEach render is discarded. */
async function remountWithMailbox(messages: Message[]) {
  await act(async () => { root.unmount(); });
  host.remove();
  mailbox = messages;
  server = messages;
  store = seedStore(mailbox);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
}

/**
 * Mounts the harness on a list the user already paged into: page one is the
 * server's first page, page two is loaded behind `cursor` and is only reachable
 * through the cursor chain. A full load (`adoptSnapshot`) drops page two and
 * resets the cursor; a reconcile (`mergeSnapshot`) must leave both alone.
 */
async function remountWithPages(first: Message[], second: Message[], cursor: string) {
  await act(async () => { root.unmount(); });
  host.remove();
  mailbox = [...first, ...second];
  server = first;
  initialCursor = cursor;
  store = createMailStore({ reconcile: async () => undefined });
  store.adoptSnapshot({
    accounts: initialAccounts,
    stats: { accounts: 1, messages: mailbox.length, unread: mailbox.filter((message) => !message.seen).length },
    items: first,
    total: mailbox.length,
    nextCursor: cursor,
  }, snapshotContextFor(store));
  store.appendPage({
    items: second,
    total: mailbox.length,
    nextCursor: null,
  }, snapshotContextFor(store));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
  await act(async () => { current.toggleMessageSelected(first[0]!.id); });
}

function loadedIds(): string[] {
  return displayed.map((message) => message.id);
}

it("keeps the loaded pages and the cursor after a successful flag batch", async () => {
  const firstPage = mailboxOf(2);
  const secondPage: Message[] = [{ ...original, id: "m3", uid: 3 }];
  await remountWithPages(firstPage, secondPage, "cursor-page-2");
  expect(loadedIds(), "the harness starts with both pages loaded").toEqual(["m1", "m2", "m3"]);
  mocks.flags.mockResolvedValue({ ok: true, updated: 1, failed: 0 });

  await act(async () => { await current.batchUpdateFlags({ seen: true }, "success"); });

  expect(loadCalls, "a successful batch must not run the full, page-resetting load").toBe(0);
  expect(reconcileCalls, "it reconciles the loaded window instead").toBe(1);
  expect(loadedIds(), "page two survives the reconcile").toEqual(["m1", "m2", "m3"]);
  expect(loadedCursor, "the cursor still points at page two").toBe("cursor-page-2");
  expect(displayed[0]!.seen, "the committed flag is on screen").toBe(true);
});

it("keeps the loaded pages and the cursor after a successful explicit move", async () => {
  const firstPage = mailboxOf(2);
  const secondPage: Message[] = [{ ...original, id: "m3", uid: 3 }];
  await remountWithPages(firstPage, secondPage, "cursor-page-2");
  // The route commits the destination before answering, so the server's next
  // first page no longer holds the moved row.
  server = [firstPage[1]!];
  mocks.move.mockResolvedValue({ ok: true, updated: 1, failed: 0 });

  await act(async () => { await current.batchMoveMessages("trash"); });

  expect(loadCalls, "a successful move must not run the full, page-resetting load").toBe(0);
  expect(reconcileCalls, "it reconciles the loaded window instead").toBe(1);
  expect(loadedIds(), "the moved row is gone and page two survives").toEqual(["m2", "m3"]);
  expect(loadedCursor, "the cursor still points at page two").toBe("cursor-page-2");
});

it("splits an explicit selection at the server's id cap instead of sending a request it refuses", async () => {
  const rows = mailboxOf(SERVER_BATCH_ID_LIMIT + 1);
  await remountWithMailbox(rows);
  await act(async () => { current.selectMessageRange(rows.map((row) => row.id)); });
  expect(current.selectedMessageIds.size).toBe(SERVER_BATCH_ID_LIMIT + 1);

  mocks.flags.mockImplementation(async (ids: string[]) => ({ ok: true, updated: ids.length, failed: 0 }));
  await act(async () => { await current.batchUpdateFlags({ seen: true }, "success"); });

  // Two requests, each at or under the cap — not one refused request, and not a
  // hundred-id walking pace that would reacquire the write slot 51 times.
  const chunks = mocks.flags.mock.calls.map((call) => call[0] as string[]);
  expect(chunks.map((chunk) => chunk.length)).toEqual([SERVER_BATCH_ID_LIMIT, 1]);
  // Membership too, not just sizes: every row exactly once, in order, so a chunk
  // boundary cannot duplicate one row and drop another and still read as right.
  expect(chunks.flat()).toEqual(rows.map((row) => row.id));
  expect(displayed.every((message) => message.seen), "the whole selection committed").toBe(true);
  expect(toast.mock.calls.some((call) => call[0] === "success"), "no chunk boundary may read as a partial failure").toBe(true);
});

/** Arms a predicate-wide selection ("select all matching", over a page smaller
 *  than the matching total) and starts the batch it implies. The create never
 *  settles, so the hook sits exactly where the bar is most exposed: inside the
 *  create round trip, the only window that holds the actions back. */
async function startPredicateBatch(): Promise<void> {
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockImplementation(() => new Promise(() => {}));
  await act(async () => { await current.batchUpdateFlags({ seen: true }, "success"); });
}

it("keeps the create round trip armed when the bar is closed", async () => {
  // The in-flight create is the one thing keeping the bar's actions inert, and
  // closing the bar does not end it. Clearing the busy flag here would re-arm
  // the actions the moment the user selects a row again — a second batch over
  // rows the server is still resolving. The runner, which clears it on every
  // terminal path, owns its lifetime.
  await startPredicateBatch();
  expect(current.batchBusy, "a predicate selection starts a create, and the bar is inert for it").toBe(true);

  await act(async () => { current.exitSelectionMode(); });

  expect(current.selectionMode).toBe(false);
  expect(current.batchBusy, "closing the bar must not release the create").toBe(true);
});

it("drops the selection on a load for a different list without releasing the create", async () => {
  // A navigation (folder/account/view/search change) replaces the list
  // wholesale. The ids were chosen in a view that just went away, while the
  // create they started is still in flight — so the reset takes the selection
  // and must leave the bar inert.
  await startPredicateBatch();
  expect(pagedWrites.at(-1), "the predicate selection is armed").toBe(true);

  await act(async () => { current.resetSelectionOnFullLoad(true); });

  expect(pagedWrites.at(-1), "the selection of the replaced view is gone").toBe(false);
  expect(current.batchBusy, "a full load must not release the create").toBe(true);
});

it("keeps an explicit selection across a refresh of the same list", async () => {
  // A manual refresh reloads the same query. The rows are still on screen and
  // still mean the same thing, so the selection must survive; only the
  // predicate (scoped to the result set being replaced) is dropped.
  expect(current.selectionMode, "the harness starts with one row selected").toBe(true);
  expect(current.selectedMessageIds.has("m1")).toBe(true);

  await act(async () => { current.resetSelectionOnFullLoad(false); });

  expect(current.selectionMode, "a same-list refresh leaves multi-select armed").toBe(true);
  expect(current.selectedMessageIds.has("m1"), "the chosen row is still chosen").toBe(true);
});

it("drops explicit ids as well when the list itself changes", async () => {
  expect(current.selectionMode).toBe(true);

  await act(async () => { current.resetSelectionOnFullLoad(true); });

  expect(current.selectionMode).toBe(false);
  expect(current.selectedMessageIds.size).toBe(0);
});

it("takes a predicate move's rows out of the view at acceptance, not at settlement", async () => {
  // The complaint this covers: "select all matching" + delete used to leave the
  // rows sitting in the list until IMAP confirmed each chunk, because only the
  // explicit-id path touched local state. The job row's acceptance commits every
  // matching id's destination locally, so the loaded rows can leave at once —
  // and the pin is what keeps a refresh racing the acceptance from putting them
  // back while the server still reports them in the source folder.
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  // Accepted but never settled: the assertion below is about the acceptance.
  mocks.create.mockImplementation(() => new Promise(() => {}));

  await act(async () => { await current.batchMoveMessages("trash"); });

  expect(displayed, "the accepted move leaves the source view immediately").toHaveLength(0);
  expect(pending.movedAway.get("m1"), "the row is held out until the server agrees it arrived").toBe("Trash");
});

it("releases a predicate move's pin before the reload that must restore the refused rows", async () => {
  // A job that settles with failures reports them in the source folder again.
  // The pin has to be gone before the job's reconciling reload, not after it:
  // a row the server still reports in the source folder is DROPPED by its own
  // pin, so a late release leaves the list missing exactly the messages the
  // partial-failure toast is talking about.
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockResolvedValue({ ok: true, jobId: "j1" });
  mocks.status.mockResolvedValue({
    job: { id: "j1", kind: "move", status: "completed", total: 1, done: 1, updated: 1, failed: 0, createdAt: 0 },
  });

  await act(async () => { await current.batchMoveMessages("trash"); });

  await act(async () => {
    await vi.waitFor(() => expect(pending.movedAway.size).toBe(0));
  });
  // The harness's server still reports the row in INBOX, which is the same shape
  // a refused chunk comes back as. Releasing the pin only after the reload would
  // leave this list empty: the reload would have merged the row through a pin
  // that still expected it in Trash, and nothing re-reads it afterwards.
  expect(displayed.map((message) => message.id)).toEqual(["m1"]);
});

it("shows a predicate unread batch on the loaded rows before the create answers", async () => {
  // The unified inbox's own scenario: everything is read, select all, mark
  // unread. The rows on screen must go unread the moment the action is taken —
  // the create round trip is the server's, and the user's own state cannot wait
  // for it. The create never settles here, so nothing but the optimistic apply
  // can have changed what is on screen.
  await remountWithMailbox(mailboxOf(3).map((message) => ({ ...message, seen: true, flags: ["\\Seen"] })));
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockImplementation(() => new Promise(() => {}));

  await act(async () => { await current.batchUpdateFlags({ seen: false }, "unread"); });

  expect(displayed.map((message) => message.seen)).toEqual([false, false, false]);
  expect(pending.flagOverrides.size, "and the values are pinned against a racing refresh").toBe(3);
});

it("releases a predicate flag batch's pin before the reload that must show the rollback", async () => {
  // The push was refused: the server rolled its flags back and reports the row
  // unread. The acceptance applied the target optimistically, so the pin is the
  // only thing keeping that value on screen — and it has to be gone before the
  // job's reconciling reload, or the merge re-applies the optimistic value over
  // the rollback and nothing re-reads the row afterwards.
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockResolvedValue({ ok: true, jobId: "jf" });
  // Hold the first status read so the optimistic state and the rollback are
  // observed separately, in the order a real push produces them.
  let settleStatus!: (value: unknown) => void;
  mocks.status.mockImplementation(() => new Promise<unknown>((resolve) => { settleStatus = resolve; }));

  await act(async () => { await current.batchUpdateFlags({ seen: true }, "success"); });
  expect(displayed[0].seen, "the acceptance applied the target at once").toBe(true);

  await act(async () => {
    settleStatus({
      job: { id: "jf", kind: "flags", status: "failed", total: 1, done: 0, updated: 0, failed: 1, createdAt: 0 },
    });
  });
  await act(async () => {
    await vi.waitFor(() => expect(pending.flagOverrides.size).toBe(0));
  });
  expect(displayed[0].seen, "the rolled-back row must come back unread").toBe(false);
});

it("forwards a predicate move's target as asked, junk included", async () => {
  // The toolbar's report-spam action is the one that exercised this: the job
  // endpoint's move vocabulary was spelled out per schema and had fallen two
  // members short of the explicit route's, so `junk` came back as a 400 and no
  // job ever existed. The target travels to the create call unchanged, and the
  // predicate path never degrades into an id list of the loaded page.
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockResolvedValue({ ok: true, jobId: "j1" });

  await act(async () => { await current.batchMoveMessages("junk"); });

  expect(mocks.create, "one job for the whole matching selection").toHaveBeenCalledTimes(1);
  expect(mocks.create.mock.calls[0]![0]).toMatchObject({ kind: "move", target: "junk" });
  expect(mocks.move, "a predicate move is not a page of ids").not.toHaveBeenCalled();
});
