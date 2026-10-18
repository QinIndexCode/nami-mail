import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

/**
 * The provider is the only collaborator replaced. Everything else is the
 * production object: the acceptance, the local statements, `prepareLocalFlags`,
 * `pushFlagsRemote`, the sealing envelope, the scheduler, the registry, the
 * database. Mocking `pushFlagsRemote` would pin the legacy executor's shape and
 * prove nothing about this port -- the socket is the one thing a test cannot
 * have.
 */
const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { openDatabase, type DatabaseHandle } from "../src/db.js";
import {
  acceptFlagsTask,
  createFlagsRunner,
  type FlagsTaskPayload,
  type FrozenFlagsPayload,
} from "../src/tasks/kinds/flags.js";
import { jobSnapshot } from "../src/tasks/jobs.js";
import { createTaskRegistry } from "../src/tasks/registry.js";
import { startTaskScheduler } from "../src/tasks/scheduler.js";
import { openTaskPayload, recordTask, reportTaskProgress, taskItems, taskRow } from "../src/tasks/store.js";
import type { TaskRow, TaskSpec } from "../src/tasks/types.js";

/**
 * The `flags` kind: what the acceptance commits, what the runner sends, and how
 * the two spellings a migrated row can hold are served.
 *
 * Five claims carry the port, each with a test that fails for its own reason:
 *
 *   1. the local target state, the push marker and the durable task are one
 *      commit, and they are in place before the provider is ever contacted;
 *   2. an entry whose message left the cache is counted rather than dropped
 *      silently -- the share `pushFlagsRemote` used to lose in both directions;
 *   3. a retried attempt replays the frozen payload and still counts each entry
 *      once, which is why this runner reports at the end of an attempt instead of
 *      per chunk (the mirror image of the move runner);
 *   4. the historical `{ids|messageId, patch}` spelling is served by accepting it
 *      afresh, so the failure semantics of the two legacy paths collapse into one
 *      and the row drains onto the new pipeline;
 *   5. a payload that is neither spelling, and a missing payload, fail on the
 *      first sighting with a code -- never eight backoff rounds.
 *
 * Plus two accounting claims that are easy to get wrong in opposite directions:
 * the blocked share is counted once (the legacy `commitLocalFlags` subtracted it
 * twice), and a patch that changes nothing records no task and no marker.
 */

const ACCOUNT = "acc-1";
const MASTER_KEY = Buffer.alloc(32, 0x5a);
const MAILBOX = "INBOX";
const SEEN = "\\Seen";

// ---------------------------------------------------------------------------
// The socket: what was sent, and how the provider answers.
// ---------------------------------------------------------------------------

const lock = { release: vi.fn() };
const connect = vi.fn(async () => undefined);
const logout = vi.fn(async () => undefined);
let addCalls: number[][];
let removeCalls: number[][];
/**
 * `refuse-once` answers the first STORE with `false` (the provider's "not
 * confirmed" answer, which the executor turns into a retryable throw) and every
 * later one with `true` -- so a test can watch a retry replay the same payload.
 *
 * `raw-failure` throws a socket-shaped error instead of answering, forever: the
 * shape imapflow produces when the connection dies mid-command, which is the one
 * error this module does not write itself. `refuse-always` is the other half of
 * the same split -- the provider's "not confirmed" answer every time, which is
 * this module's own wording.
 */
let providerAnswer: "confirm" | "refuse-once" | "refuse-always" | "raw-failure";
/**
 * What the connection library would put in front of us: the server's farewell,
 * which names the host and the account. It must never reach a renderable column.
 */
const RAW_SOCKET_TEXT = "Connection closed: * BYE imap.example.com session terminated for demo@example.com";
const messageFlagsAdd = vi.fn(async (uids: number | number[]) => {
  const list = Array.isArray(uids) ? uids : [uids];
  addCalls.push(list);
  if (providerAnswer === "raw-failure") throw Object.assign(new Error(RAW_SOCKET_TEXT), { code: "ECONNRESET" });
  if (providerAnswer === "refuse-always") return false;
  if (providerAnswer === "refuse-once" && addCalls.length === 1) return false;
  return true;
});
const messageFlagsRemove = vi.fn(async (uids: number | number[]) => {
  removeCalls.push(Array.isArray(uids) ? uids : [uids]);
  return true;
});
const client = {
  usable: true,
  connect,
  getMailboxLock: vi.fn(async () => lock),
  messageFlagsAdd,
  messageFlagsRemove,
  logout,
};

type Deltas = Array<{ updated?: number; failed?: number }>;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ACCOUNT, "demo@example.com", "custom", "Demo", "encrypted", "imap.example.com", 993, 1, "smtp.example.com", 465, 1, "email", "connected", new Date().toISOString());
}

function insertFolder(db: DatabaseHandle): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)")
    .run(ACCOUNT, MAILBOX, "Inbox", "\\Inbox");
}

function insertMessage(db: DatabaseHandle, id: string, uid: number, flags: string[]): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ACCOUNT, MAILBOX, uid, "Subject", "Demo", "demo@example.com", "[]", new Date().toISOString(), "", "", "", JSON.stringify(flags), 0, 0, new Date().toISOString());
}

/** One account, one inbox of `count` messages, `flags(i)` for the i-th (1-based). */
function fixture(count: number, flags: (index: number) => string[] = () => []): { db: DatabaseHandle; ids: string[] } {
  const db = openDatabase(":memory:");
  insertAccount(db);
  insertFolder(db);
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `msg-${i}`;
    insertMessage(db, id, i, flags(i));
    ids.push(id);
  }
  return { db, ids };
}

const flagState = (db: DatabaseHandle, id: string) =>
  db.prepare("SELECT flags_json, pending_flags_push, pending_flags_base_json FROM messages WHERE id = ?").get(id) as {
    flags_json: string;
    pending_flags_push: number;
    pending_flags_base_json: string | null;
  };

/**
 * The unread badge, derived from `messages` rather than read off the deleted
 * `folders.unseen` column (contract §3.6, I4).
 *
 * Note what this exposed: the fixture used to seed `unseen = count` while its
 * `flags(i)` argument was free to mark some of those rows seen, so the seeded
 * number could contradict the rows it claimed to describe. Deriving it cannot.
 */
const folderUnseen = (db: DatabaseHandle): number =>
  (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND effective_mailbox = ? AND flags_json NOT LIKE '%\\Seen%'")
    .get(ACCOUNT, MAILBOX) as { count: number }).count;

/**
 * The state of a row no push marker has ever been written to.
 *
 * `pending_flags_push` is nullable with no default, so "unmarked" reads as NULL on
 * a row this session never touched (a row marked and then released reads 0). The
 * distinction matters to the assertion below and to nothing else.
 */
const untouched = (flags: string[]): { flags_json: string; pending_flags_push: null; pending_flags_base_json: null } => ({
  flags_json: JSON.stringify(flags),
  pending_flags_push: null,
  pending_flags_base_json: null,
});

/** A row marked for push, with the pre-patch flag set recorded as its baseline. */
const marked = (flags: string[], baseline: string[]): { flags_json: string; pending_flags_push: number; pending_flags_base_json: string } => ({
  flags_json: JSON.stringify(flags),
  pending_flags_push: 1,
  pending_flags_base_json: JSON.stringify(baseline),
});

const taskRows = (db: DatabaseHandle, except = ""): TaskRow[] =>
  (db.prepare("SELECT id FROM tasks WHERE id != ? ORDER BY rowid").all(except) as Array<{ id: string }>).map(
    (row) => taskRow(db, row.id) as TaskRow,
  );

/**
 * The acceptance with a recording starter instead of a real scheduler: the test
 * then drives the rows it recorded through the real scheduler when it wants them
 * run, and can assert the committed state in between. `start()` before the
 * scheduler exists is exactly the contract's "start after the commit" split.
 */
function acceptanceDeps(db: DatabaseHandle): { deps: { db: DatabaseHandle; masterKey: Buffer; scheduler: { start: (id: string) => void } }; started: string[] } {
  const started: string[] = [];
  return { deps: { db, masterKey: MASTER_KEY, scheduler: { start: (id: string) => started.push(id) } }, started };
}

/** One attempt, driven the way the scheduler drives it: real row, real sealed payload. */
async function attempt(db: DatabaseHandle, taskId: string, deltas: Deltas, started: string[] = []): Promise<void> {
  const runner = createFlagsRunner({ db, masterKey: MASTER_KEY, scheduler: { start: (id) => started.push(id) } });
  const task = taskRow(db, taskId) as TaskRow;
  await runner({
    task,
    payload: openTaskPayload(MASTER_KEY, task) as FlagsTaskPayload,
    items: taskItems(db, taskId),
    report: (delta) => {
      deltas.push(delta);
      reportTaskProgress(db, taskId, delta, Date.now());
    },
  });
}

/** The real scheduler: registry, chain, retry ladder (1ms), terminal hook. */
async function drain(db: DatabaseHandle, taskId: string): Promise<Array<{ id: string; status: string }>> {
  const registry = createTaskRegistry();
  // The runner gets a starter even though this file only drains the frozen
  // spelling: a legacy reversed payload makes the runner COMMIT a task of its
  // own, so the dependency is real rather than incidental. It is late-bound
  // because the scheduler is built from the registry that holds the runner --
  // the same cycle production wiring has to break, and the reason
  // `CommitTaskDeps.scheduler` is a one-method interface.
  const delegate: { start: (id: string) => void } = { start: () => undefined };
  registry.register("flags", createFlagsRunner({ db, masterKey: MASTER_KEY, scheduler: delegate }));
  const settled: Array<{ id: string; status: string }> = [];
  const scheduler = startTaskScheduler({
    db,
    masterKey: MASTER_KEY,
    registry,
    hooks: { onTaskSettled: (task: TaskRow) => settled.push({ id: task.id, status: task.status }) },
    dueTickMs: 60_000,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });
  delegate.start = (id) => scheduler.start(id);
  scheduler.start(taskId);
  await scheduler.drain();
  await scheduler.stop();
  return settled;
}

let db: DatabaseHandle;

beforeEach(() => {
  vi.clearAllMocks();
  addCalls = [];
  removeCalls = [];
  providerAnswer = "confirm";
  imapClientForAccount.mockImplementation(async () => client);
});

afterEach(() => {
  db?.close();
  vi.restoreAllMocks();
});

describe("task flags acceptance: the local commit is the whole promise", () => {
  it("writes the target state, the marker and one frozen task per account, before any provider call", async () => {
    const world = fixture(3, (index) => (index === 3 ? [SEEN] : []));
    db = world.db;
    const { deps, started } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });

    // Applied plus already there: msg-3 was already seen, so it needs no push and
    // must not appear as a change.
    expect(accepted).toMatchObject({ updated: 3, failed: 0, changedIds: ["msg-1", "msg-2"] });
    expect(started).toEqual(accepted.handles.map((handle) => handle.id));
    expect(accepted.handles).toHaveLength(1);
    // The marker's baseline is the pre-patch remote-confirmed set, and the unread
    // badge follows the rows: all three are marked seen by now, including the one
    // that was already there.
    expect(flagState(db, "msg-1")).toEqual(marked([SEEN], []));
    expect(folderUnseen(db)).toBe(0);
    // The no-op is untouched -- no write, and above all no marker: a marker with
    // no push behind it is a message whose flags sync skips forever.
    expect(flagState(db, "msg-3")).toEqual(untouched([SEEN]));
    expect(imapClientForAccount).not.toHaveBeenCalled();

    const taskId = accepted.handles[0]!.id;
    expect(taskRow(db, taskId)).toMatchObject({ kind: "flags", account_id: ACCOUNT, scope: "batch", status: "pending", total: 2, updated: 0, failed: 0 });
    expect(taskItems(db, taskId).map((item) => [item.message_id, item.changed])).toEqual([
      ["msg-1", 1],
      ["msg-2", 1],
    ]);
    const payload = openTaskPayload(MASTER_KEY, taskRow(db, taskId) as TaskRow) as FrozenFlagsPayload;
    expect(payload.accountId).toBe(ACCOUNT);
    expect(payload.entries.map((entry) => [entry.id, entry.mailbox, entry.uid, entry.add, entry.remove])).toEqual([
      ["msg-1", MAILBOX, 1, [SEEN], []],
      ["msg-2", MAILBOX, 2, [SEEN], []],
    ]);

    // Now let the scheduler run it: one STORE for the flag group, and the task's
    // own counters account for every entry it was created with.
    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "completed" }]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", total: 2, updated: 2, failed: 0 });
    expect(addCalls).toEqual([[1, 2]]);
    expect(removeCalls).toEqual([]);
  });

  it("counts an entry whose message left the cache as failed instead of losing it", async () => {
    const world = fixture(3);
    db = world.db;
    const { deps } = acceptanceDeps(db);
    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });
    const taskId = accepted.handles[0]!.id;

    // A move, a delete, a re-sync that dropped the row: whatever the cause, the
    // entry names a message this cache no longer has.
    db.prepare("DELETE FROM messages WHERE id = ?").run("msg-2");

    await drain(db, taskId);

    // The legacy executor dropped this entry silently, so it counted as neither
    // updated nor failed and the task could never add up to its own `total`.
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", total: 3, updated: 2, failed: 1 });
    expect(addCalls).toEqual([[1, 3]]);
  });

  it("replays a refused push on the next attempt and still counts each entry once", async () => {
    const world = fixture(2);
    db = world.db;
    const { deps } = acceptanceDeps(db);
    const taskId = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } }).handles[0]!.id;

    providerAnswer = "refuse-once";
    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "completed" }]);

    // The payload is frozen, so the retry sends the same two uids again -- that is
    // the point of freezing it, and it is why the report has to wait for the
    // attempt that finishes: a per-chunk report would have counted these entries
    // twice here.
    expect(addCalls).toEqual([[1, 2], [1, 2]]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", attempt_count: 2, total: 2, updated: 2, failed: 0 });
  });

  it("does not count the blocked share twice (the legacy formula did)", async () => {
    const world = fixture(2);
    db = world.db;
    // A message with an unreconciled move: readable, but not writable until sync
    // has settled it -- `prepareLocalFlags` keeps it out of `prepared` entirely.
    db.prepare("UPDATE messages SET pending_move_destination = ? WHERE id = ?").run("Archive", "msg-2");
    const { deps } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });

    // `commitLocalFlags` returned `prepared.length - blocked.length` here, i.e. 0,
    // because the blocked id was subtracted a second time. Its `failed` (=
    // ids - prepared) already contained that id, so the legacy pair summed to one
    // less than the selection while calling itself a full report. The acceptance
    // reports what it did instead, and its two numbers cover the selection.
    expect(accepted).toMatchObject({ updated: 1, failed: 1, changedIds: ["msg-1"] });
    expect(taskItems(db, accepted.handles[0]!.id).map((item) => item.message_id)).toEqual(["msg-1"]);
    const payload = openTaskPayload(MASTER_KEY, taskRow(db, accepted.handles[0]!.id) as TaskRow) as FrozenFlagsPayload;
    expect(payload.entries.map((entry) => entry.id)).toEqual(["msg-1"]);
    expect(flagState(db, "msg-2")).toEqual(untouched([]));
  });

  it("records nothing at all when the patch changes nothing", async () => {
    const world = fixture(2, () => [SEEN]);
    db = world.db;
    const { deps, started } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });

    expect(accepted).toEqual({ handles: [], updated: 2, failed: 0, changedIds: [] });
    expect(started).toEqual([]);
    expect(taskRows(db)).toEqual([]);
    expect(flagState(db, "msg-1")).toEqual(untouched([SEEN]));
  });

  it("splits an account's delta at the entry limit", async () => {
    const world = fixture(1001);
    db = world.db;
    const { deps } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });

    expect(accepted.handles).toHaveLength(2);
    expect(accepted.handles.map((handle) => (taskRow(db, handle.id) as TaskRow).total)).toEqual([1000, 1]);
    expect(accepted.changedIds).toHaveLength(1001);
  });

  it("names a lone member with the bare job id, which is the shape a route advertises", async () => {
    // One account, one slice: the job's only member is the job, so the id the route
    // told the renderer to poll resolves without a prefix. Deriving the total from
    // the *account's* entry count rather than from the whole job would break exactly
    // here (it would name this `job-9:acc-1` and the advertised `job-9` would 404).
    const world = fixture(2);
    db = world.db;
    const { deps, started } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true }, jobId: "job-9" });

    expect(accepted.handles.map((handle) => handle.id)).toEqual(["job-9"]);
    expect(started).toEqual(["job-9"]);
  });

  it("names a job's members the way the reader resolves them", async () => {
    // The batch-jobs route hands in the id it just advertised, so the alias has to
    // be able to find every slice of it later -- including the second slice of one
    // account, which cannot be named `<jobId>:<accountId>` a second time without
    // colliding on the primary key. The bare id belongs to a job of exactly one
    // member, so neither slice of this one takes it; `job-ids.ts` owns the grammar
    // and this pins that the acceptance is what uses it (contract §10 第 22 条).
    const world = fixture(1001);
    db = world.db;
    const { deps, started } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true }, jobId: "job-9" });

    expect(accepted.handles.map((handle) => handle.id)).toEqual([`job-9:${ACCOUNT}`, `job-9:${ACCOUNT}:2`]);
    expect(started).toEqual([`job-9:${ACCOUNT}`, `job-9:${ACCOUNT}:2`]);
    expect(accepted.handles.map((handle) => (taskRow(db, handle.id) as TaskRow).total)).toEqual([1000, 1]);
  });

  it("passes no id at all when the caller advertises none", async () => {
    // The explicit-id message routes hand no id to anyone, so their slices must be
    // auto-named: a job id nobody was told about would still be resolvable by
    // guessing `rootJobId`, which is a job the alias never sold.
    const world = fixture(2);
    db = world.db;
    const { deps } = acceptanceDeps(db);

    const accepted = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } });

    expect(accepted.handles).toHaveLength(1);
    expect((taskRow(db, accepted.handles[0]!.id) as TaskRow).id).not.toContain(":");
  });
});

describe("task flags runner: the two payload spellings a migrated row can hold", () => {
  it("drains the historical {ids, patch} row by accepting it afresh", async () => {
    const world = fixture(2);
    db = world.db;
    const parentId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "flags",
      payload: { ids: world.ids, patch: { seen: true } },
      total: 2,
    } satisfies TaskSpec);

    const deltas: Deltas = [];
    const started: string[] = [];
    await attempt(db, parentId, deltas, started);

    // Local-first: the patch is applied, the marker is set, and the push is owed
    // by a task of its own.
    expect(deltas).toEqual([{ updated: 2, failed: 0 }]);
    expect(flagState(db, "msg-1")).toEqual(marked([SEEN], []));
    const children = taskRows(db, parentId);
    expect(children).toHaveLength(1);
    expect(started).toEqual([children[0]!.id]);
    expect(children[0]).toMatchObject({ kind: "flags", status: "pending", total: 2, parent_id: null });
    // The child holds the spelling this layer writes -- the drain converges onto
    // the new pipeline instead of executing the legacy remote-first path.
    const childPayload = openTaskPayload(MASTER_KEY, children[0]!) as FrozenFlagsPayload;
    expect(childPayload.entries.map((entry) => entry.id)).toEqual(world.ids);

    // `drain()` claims by predicate, not by the id it was nudged with, so it also
    // picks up the parent -- which `attempt` left `pending`, because a runner never
    // settles its own row. That is the scheduler doing exactly what its comment
    // says, and it buys a second claim for free: the re-run finds the patch already
    // in force and queues no second push.
    const settled = await drain(db, children[0]!.id);
    expect(settled).toContainEqual({ id: children[0]!.id, status: "completed" });
    expect(settled).toContainEqual({ id: parentId, status: "completed" });
    expect(taskRows(db, parentId)).toHaveLength(1);
    expect(addCalls).toEqual([[1, 2]]);
  });

  it("counts a missing id as failed instead of throwing, for both spellings", async () => {
    db = fixture(1).db;
    const taskId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "flags",
      payload: { messageId: "gone", patch: { seen: true } },
      total: 1,
    } satisfies TaskSpec);

    const deltas: Deltas = [];
    // The legacy singular path threw "Message not found." and the legacy batch
    // path counted the same id as failed; the merge picks one answer, and this is
    // it. Nobody observes the difference: the caller is the scheduler, which only
    // reads whether the runner threw.
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([{ updated: 0, failed: 1 }]);
    expect(taskRows(db, taskId)).toEqual([]);
  });

  it("settles an id-less {patch} row as a no-op", async () => {
    db = fixture(1).db;
    // The shape `planJob` derives for a flags job; those migrate `completed`, so
    // meeting one pending is defence, not a real path.
    const taskId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "flags",
      payload: { patch: { seen: true } },
      total: 3,
    } satisfies TaskSpec);

    const deltas: Deltas = [];
    await attempt(db, taskId, deltas);

    expect(deltas).toEqual([]);
    expect(imapClientForAccount).not.toHaveBeenCalled();
  });

  it("treats the row's account as the authority, not the payload's", async () => {
    const world = fixture(1);
    db = world.db;
    // A payload whose account field disagrees with the row it was sealed into.
    // Resolving the wrong one throws "Account not found." here, which is the
    // failure mode the move port was bitten by (`kinds/move.ts:39-50`).
    const taskId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "flags",
      payload: { accountId: "somewhere-else", entries: [{ id: "msg-1", mailbox: MAILBOX, uid: 1, add: [SEEN], remove: [] }] },
      total: 1,
    } satisfies TaskSpec);

    await drain(db, taskId);

    expect(taskRow(db, taskId)).toMatchObject({ status: "completed", updated: 1, failed: 0 });
    expect(addCalls).toEqual([[1]]);
  });
});

describe("task flags runner: what a failed push leaves where the user can read it", () => {
  /**
   * The runner is the only place the push's error object meets the task row, and
   * the row's `error_message` is rendered: `jobSnapshot` (`jobs.ts:365`) hands it
   * to `GET /api/batch-jobs/:id`, and the batch poller toasts it verbatim
   * (`batchJobRunner.ts:179`, `showToast(job.error)`). So the two kinds of error
   * `pushFlagsRemote` can produce have to be told apart here, and these two tests
   * are the two arms -- each fails if the split is removed, in opposite ways.
   */
  it("keeps the socket's own text out of every column the renderer reads", async () => {
    const world = fixture(2);
    db = world.db;
    const { deps } = acceptanceDeps(db);
    const taskId = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } }).handles[0]!.id;

    providerAnswer = "raw-failure";
    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "failed" }]);

    // The push really was attempted, so the failure below is the socket's and not
    // a missing account's.
    expect(addCalls.length).toBeGreaterThan(0);
    const row = taskRow(db, taskId) as TaskRow;
    // Ours, not the transport's: without the catch this is `ECONNRESET` -- the
    // library's spelling -- and the sentence is the server's farewell.
    expect(row.error_code).toBe("connection_failed");
    expect(row.error_message).toBe("与邮件服务器的连接在完成前中断。请检查网络、VPN/代理和防火墙设置后重试。");

    // The whole row, not just the two columns this test names: "no transport text
    // is persisted" is the rule, so a third column that started carrying the
    // message would have to break this rather than pass unobserved.
    const persisted = JSON.stringify(db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    expect(persisted).not.toContain("BYE");
    expect(persisted).not.toContain("demo@example.com");

    // And the projection the route actually serves -- the same string the poller
    // toasts, through the reader that would drop the error if it were null.
    const snapshot = jobSnapshot(db, taskId);
    expect(snapshot?.error).toBe(row.error_message);
    expect(JSON.stringify(snapshot)).not.toContain("BYE");
  });

  it("passes its own refusal through, without inventing a code for it", async () => {
    const world = fixture(2);
    db = world.db;
    const { deps } = acceptanceDeps(db);
    const taskId = acceptFlagsTask(deps, { messageIds: world.ids, patch: { seen: true } }).handles[0]!.id;

    providerAnswer = "refuse-always";
    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "failed" }]);

    // "The provider accepted but did not confirm" is already written for the user
    // by the module that observed it, so translating it through `safeMailError`
    // would be a downgrade to the generic `unknown` sentence. It stays verbatim --
    // and this half is why `flagsPushError` is not simply `safeMailError`.
    expect(taskRow(db, taskId)).toMatchObject({
      status: "failed",
      error_code: null,
      error_message: "邮件服务器未确认状态更新，请稍后重试。",
    });
  });
});

describe("task flags runner: payloads it cannot execute", () => {
  it("fails a payload that is neither spelling on the first sighting", async () => {
    db = fixture(1).db;
    const taskId = recordTask(db, MASTER_KEY, {
      accountId: ACCOUNT,
      kind: "flags",
      payload: { somethingElse: true },
      total: 1,
    } satisfies TaskSpec);

    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "failed" }]);

    // No backoff ladder: no attempt can turn this payload into a runnable one, so
    // the eight rounds the legacy queue spent on it bought nothing.
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "unknown_payload", attempt_count: 1 });
  });

  it("fails a task that carries no payload on the first sighting", async () => {
    db = fixture(1).db;
    const taskId = recordTask(db, MASTER_KEY, { accountId: ACCOUNT, kind: "flags", total: 1 } satisfies TaskSpec);

    expect(await drain(db, taskId)).toEqual([{ id: taskId, status: "failed" }]);
    expect(taskRow(db, taskId)).toMatchObject({ status: "failed", error_code: "no_payload", attempt_count: 1 });
    expect(imapClientForAccount).not.toHaveBeenCalled();
  });
});
