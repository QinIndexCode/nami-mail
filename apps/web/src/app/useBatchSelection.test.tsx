// @vitest-environment jsdom
import { act, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPinnedUnseenCorrections, createPendingLocalState, mergePendingLocalState } from "../mailListState";
import type * as apiModule from "../api";
import type { BatchJobSnapshot } from "../api";
import type { Account, Message, Stats } from "../types";
import { useBatchSelection, type BatchSelection } from "./useBatchSelection";

const mocks = vi.hoisted(() => ({ flags: vi.fn(), move: vi.fn(), create: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      ...actual.api,
      batchUpdateMessageFlags: mocks.flags,
      batchMoveMessages: mocks.move,
      batchJobCreate: mocks.create,
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
/** The rows the harness seeds itself with. It is read once, on the first render,
 *  so a test that needs a selection past the server's id cap has to swap it in
 *  and remount before it acts. */
let mailbox: Message[];
/** What the server would answer on the next reload — the authority the pins
 * are meant to shield, and the truth a failed write must fall back to. */
let server: Message[];
const toast = vi.fn();
/** Every value the hook hands to `setBatchJob`, in order. */
const jobWrites: Array<BatchJobSnapshot | null> = [];
/** Every value the hook hands to `setSelectAllPaged`, in order. */
const pagedWrites: boolean[] = [];
/** Drives `currentMessageTotal`, i.e. how many rows a predicate-wide selection
 *  would cover. A page shorter than this is what arms "select all matching". */
let setMatchingTotalState: (value: number) => void = () => undefined;

function Harness() {
  const [messages, setMessages] = useState(() => mailbox);
  const [accounts, setAccounts] = useState(initialAccounts);
  const [stats, setStats] = useState<Stats>({ accounts: 1, messages: 1, unread: 1 });
  const [selectAllPaged, setSelectAllPagedState] = useState(false);
  const [matchingTotal, setMatchingTotal] = useState(mailbox.length);
  const setSelectAllPaged = useCallback((value: boolean) => {
    pagedWrites.push(value);
    setSelectAllPagedState(value);
  }, []);
  setMatchingTotalState = setMatchingTotal;
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false);
  const [, setBatchJob] = useState<BatchJobSnapshot | null>(null);
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
    loadedServerMessageCount: mailbox.length, currentMessageTotal: matchingTotal, searchScope: "view", debouncedQuery: "",
    selectedAccount: "all", selectedFolder: "", view: "inbox", attachmentKindFilter: undefined,
    dateBounds: { after: undefined, before: undefined }, load, loadRef,
    reconcileRef: { current: () => undefined }, loadRequestRef,
    messagesRef, pendingLocalStateRef: pendingRef, viewRef, selectAllPaged, setSelectAllPaged,
    setBatchJob: ((job: BatchJobSnapshot | null) => { jobWrites.push(job); setBatchJob(job); }) as never, pendingBatchDelete, setPendingBatchDelete,
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
  jobWrites.length = 0;
  pagedWrites.length = 0;
  mailbox = [original];
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness />); });
}

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
 *  than the matching total) and asks for the batch job it implies. The create
 *  never settles, so the job sits exactly where the bar is most exposed: in
 *  flight, with only the placeholder snapshot holding the actions back. Returns
 *  the snapshot the hook was handed for that job. */
async function startPredicateJob(): Promise<BatchJobSnapshot | null> {
  await act(async () => { setMatchingTotalState(mailbox.length + 9); });
  await act(async () => { current.selectAllVisibleMessages(); });
  mocks.create.mockImplementation(() => new Promise(() => {}));
  await act(async () => { await current.batchUpdateFlags({ seen: true }, "success"); });
  return jobWrites.at(-1) ?? null;
}

it("closes the bar without disarming a job that is still running", async () => {
  // The job snapshot is the only thing keeping the bar's actions inert, and a job
  // does not stop when the user closes the bar. Clearing it here would re-arm the
  // actions — a second batch over the rows the job is still working through — so
  // the poll loop, which clears it on every terminal path, owns its lifetime.
  const armed = await startPredicateJob();
  expect(armed, "a predicate selection starts a job, and the bar is inert for it").not.toBeNull();

  await act(async () => { current.exitSelectionMode(); });

  expect(current.selectionMode).toBe(false);
  expect(jobWrites.at(-1), "closing the bar must not clear the running job").toBe(armed);
});

it("drops the predicate selection on a full load without disarming the running job", async () => {
  // A full load (folder/account switch, a sync, an account change) replaces the
  // list wholesale. The predicate selection was scoped to the view that just
  // went away, while the job it started keeps running — so the reset takes the
  // selection and must leave the bar inert. `load` calls exactly this policy.
  const armed = await startPredicateJob();
  expect(pagedWrites.at(-1), "the predicate selection is armed").toBe(true);

  await act(async () => { current.resetSelectionOnFullLoad(); });

  expect(pagedWrites.at(-1), "the selection of the replaced view is gone").toBe(false);
  expect(jobWrites.at(-1), "a full load must not clear the running job").toBe(armed);
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
