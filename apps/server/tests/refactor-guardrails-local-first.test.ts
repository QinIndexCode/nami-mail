/**
 * 批次 0 护栏 · 计数与本地优先（架构契约 §9 的 T1 / T3 / T5）。
 *
 * 这些测试存在的意义是"先钉住行为，再重构"：批次 2/3 会把计数改成完全派生、
 * 把写入改成单事务任务提交，届时**这些断言会被主动翻转**，翻转本身就是那两批
 * 的验收证据。因此当时失败的行为一律写成"刻画当前行为"的断言并标注
 * `CONTRACT-TODO(batch N)`，而不是留在仓库里的红灯——红灯会破坏批次 0 的闸门
 * （`npm test` 全绿），且无法区分"已知缺陷"与"刚写坏的代码"。三条 TODO 现在都
 * 已经翻转完毕，本文件是翻转后的形状。
 *
 * **T1 已翻转（批次 2 · 原子切换第 3 件·3）**：它原本驱动 `commitLocalFlags` 并
 * 钉住 `updated = -3` 的负数。flags 两条路由改走 `acceptFlagsTask` 之后，那个函数
 * 在生产里**再无调用者**，所以这里改为驱动验收本身——否则这条护栏会继续"通过"，
 * 却对任何新公式的错法都不敏感（`tests/task-flags-runner.test.ts` 有同域的分片见证）。
 *
 * **T3/T5 同批重指向（批次 2 · 原子切换第 4 件）**：它们也曾驱动 `commitLocalFlags`，
 * 与 T1 是同一条死路径。第 4 件把那个函数整个删掉（连同 `operation-queue.ts` 与
 * `batch-jobs.ts`），于是两条护栏改为驱动 `acceptFlagsTask`——**断言逐字不变**，
 * 因为它们钉的是 `folders.total/unseen` 这两列的 ±1 语义，而那份 SQL 在
 * `kinds/flags.ts` 里逐字存在（这也正是它必须逐字存在的原因）。本地桩队列
 * （`stubQueue`）与其 type-only import 一并消失：验收路径不经过队列。
 *
 * **T5 再次翻转（批次 3）**：两列连同 `countSourceFolderDeparture` /
 * `revertSourceFolderDeparture` 一起删除了（契约 §3.6、I4），所以"计数器病态"
 * 不再是可观察行为，而成了**不可表达**的状态。T5 因此从"刻画病态"改成"证明病态
 * 无法表达"：列不在 schema 里，两个数出自同一组行，目标态写与清是恒等变换。
 *
 * 三条结论都是用户投诉的第一号问题（侧边栏计数不准）的直接证据：
 *   T1  全 blocked 的 flags 提交曾把 `updated` 扣成负数，`updated + failed` 不再等于输入条数（已翻转）。
 *   T5  `folders.total/unseen` 是钳位过的 ±1 计数器，一对 depart/revert 不是恒等变换；
 *       一次"标未读"就能造出 unseen(1) > total(0) 这种任何真实邮箱都不可能的组合（已翻转）。
 *   T3  在常规路径上列值与 messages 派生真值恰好一致——这是重构必须保住的不变量。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { UNSEEN_PREDICATE_SQL } from "../src/message-flag-indexes.js";
import { acceptFlagsTask } from "../src/tasks/kinds/flags.js";
import { taskItems } from "../src/tasks/store.js";

const NOW = "2026-10-16T00:00:00.000Z";
const PENDING_MOVE_RECONCILIATION = "Archive";
const MASTER_KEY = Buffer.alloc(32, 0x11);

/**
 * The acceptance's collaborators: the database, the key that seals a task's
 * payload, and a starter that records what it was handed. There is no provider
 * here on purpose — the acceptance never contacts one.
 */
function acceptanceDeps(db: DatabaseHandle): { deps: { db: DatabaseHandle; masterKey: Buffer; scheduler: { start: (id: string) => void } }; started: string[] } {
  const started: string[] = [];
  return { deps: { db, masterKey: MASTER_KEY, scheduler: { start: (id: string) => started.push(id) } }, started };
}

function insertAccount(db: DatabaseHandle, id: string): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    )
    VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1, 'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(id, `${id}@example.test`, NOW);
}

/**
 * A folder row, with no counts on it: `folders` stores metadata only now
 * (contract §3.6), and every assertion below reads `derivedCounts` instead.
 */
function insertFolder(db: DatabaseHandle, accountId: string, path: string): void {
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, '\\Inbox')")
    .run(accountId, path, path);
}

function insertMessage(
  db: DatabaseHandle,
  input: {
    id: string;
    accountId?: string;
    uid: number;
    flags?: string[];
    /** Non-null puts the row under a move intent, which is what blocks flag writes. */
    blockWithPendingMove?: boolean;
  },
): void {
  db.prepare(`
    INSERT INTO messages (
      id, account_id, mailbox, uid, subject, from_name, from_address, to_json,
      sent_at, snippet, text_body, html_body, flags_json, has_attachments, size, created_at,
      pending_move_destination, pending_move_state
    )
    VALUES (?, ?, 'INBOX', ?, 'Subject', 'Sender', 'sender@example.test', '[]', ?, '', '', '', ?, 0, 0, ?, ?, ?)
  `).run(
    input.id,
    input.accountId ?? "account-1",
    input.uid,
    NOW,
    JSON.stringify(input.flags ?? []),
    NOW,
    input.blockWithPendingMove ? PENDING_MOVE_RECONCILIATION : null,
    input.blockWithPendingMove ? "intent" : null,
  );
}

/**
 * The truth the sidebar shows, computed from the `messages` target state — which
 * since batch 3 is not "what the sidebar is supposed to show" but what the sidebar
 * *reads* (`folder-counts.ts`). `effective_mailbox` is the generated target-folder
 * column (db-schema.ts), and the unseen predicate is imported rather than
 * respelled, so this cannot drift from the badges by spelling a flag differently.
 */
function derivedCounts(db: DatabaseHandle, accountId: string, path: string): { total: number; unseen: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ${UNSEEN_PREDICATE_SQL} THEN 1 ELSE 0 END) AS unseen
    FROM messages
    WHERE account_id = ? AND effective_mailbox = ?
  `).get(accountId, path) as { total: number; unseen: number | null };
  return { total: row.total, unseen: row.unseen ?? 0 };
}

describe("T1 · 全 blocked 的 flags 提交（批次 2 已翻转：updated + failed == 输入条数）", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
  });

  afterEach(() => {
    db.close();
  });

  it("三个 id 全部 blocked 时 updated = 0、failed = 3，两者之和等于输入条数", () => {
    insertFolder(db, "account-1", "INBOX");
    const ids = ["blocked-1", "blocked-2", "blocked-3"];
    ids.forEach((id, index) => insertMessage(db, { id, uid: index + 1, blockWithPendingMove: true }));

    const { deps, started } = acceptanceDeps(db);
    const accepted = acceptFlagsTask(deps, { messageIds: ids, patch: { seen: true } });

    // 这是批次 0 要求的那次翻转。blocked 与 prepared 是**不相交**的集合，所以
    // legacy 的 `prepared.length - blocked.length` 恰好少算了自己要算的那一份；
    // 这里没有任何一封可投递，诚实的报告就是"零封完成、三封被拒"，且两者覆盖选择集。
    expect(accepted.updated).toBe(0);
    expect(accepted.failed).toBe(3);
    expect(accepted.changedIds).toEqual([]);
    expect(accepted.updated + accepted.failed).toBe(ids.length);
    // 没有可推送的条目就不建任务：一条只会在远端做空 STORE 的持久行不是"任务"。
    expect(accepted.handles).toEqual([]);
    expect(started).toEqual([]);
  });

  it("一个可提交 + 两个 blocked 时 updated = 1、failed = 2，且任务只带可提交的那一个", () => {
    insertFolder(db, "account-1", "INBOX");
    insertMessage(db, { id: "ready", uid: 1 });
    insertMessage(db, { id: "blocked-1", uid: 2, blockWithPendingMove: true });
    insertMessage(db, { id: "blocked-2", uid: 3, blockWithPendingMove: true });

    const { deps, started } = acceptanceDeps(db);
    const accepted = acceptFlagsTask(deps, { messageIds: ["ready", "blocked-1", "blocked-2"], patch: { seen: true } });

    expect(accepted.updated).toBe(1);
    expect(accepted.failed).toBe(2);
    expect(accepted.changedIds).toEqual(["ready"]);
    expect(accepted.updated + accepted.failed).toBe(3);
    // 被拒的 id 计入 failed，但绝不进载荷：持久任务只带目标态真的会变的那一封，
    // 否则重试会把一封同步还没落定的邮件反复推给服务器。
    expect(accepted.handles).toHaveLength(1);
    const taskId = accepted.handles[0]!.id;
    expect(taskItems(db, taskId).map((item) => item.message_id)).toEqual(["ready"]);
    expect(started).toEqual([taskId]);
  });
});

describe("T5 · 那两列已经不存在，所以它们的病态无法再表达（批次 3 已翻转）", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
  });

  afterEach(() => {
    db.close();
  });

  it("folders 上没有 total/unseen，只有 provider 报的远端数字", () => {
    const columns = (db.prepare("PRAGMA table_info(folders)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).not.toContain("total");
    expect(columns).not.toContain("unseen");
    // `remote_total` / `remote_unseen` 仍在，但那是另一回事：只被"已同步 M / 共 N"
    // 读，永不参与徽标，也不进 Agent 能看到的工具 schema（契约 D7）。
    expect(columns).toContain("remote_total");
    expect(columns).toContain("remote_unseen");
  });

  it("目标态写与清是恒等变换，不再有一对会净 +1 的 depart/revert", () => {
    // 批次 0 这里钉的是"空文件夹上 depart 被 `CASE WHEN total > 0` 钳住、revert 却
    // 无条件 +1，于是这一对净效果是 +1"。两个函数连同它们那两条 UPDATE 已经删掉
    // （`sync-move-statements.ts` 末尾的注记），留下的语义只有一条：计数读的是 rows。
    insertFolder(db, "account-1", "INBOX");
    const counts = () => derivedCounts(db, "account-1", "INBOX");
    expect(counts()).toEqual({ total: 0, unseen: 0 });

    insertMessage(db, { id: "m-1", uid: 1 });
    expect(counts()).toEqual({ total: 1, unseen: 1 });

    const setGoal = db.prepare("UPDATE messages SET pending_move_destination = ?, pending_move_state = NULL WHERE id = ?");
    const clearGoal = db.prepare("UPDATE messages SET pending_move_destination = NULL, pending_move_state = NULL WHERE id = ?");
    setGoal.run(PENDING_MOVE_RECONCILIATION, "m-1");
    // 目标态一写上，这封邮件就在 Inbox 视图里消失了——这是本地优先的"立刻生效"。
    expect(counts()).toEqual({ total: 0, unseen: 0 });
    clearGoal.run("m-1");
    // 而清掉之后回到原处：往返是恒等变换，这在计数器时代做不到。
    expect(counts()).toEqual({ total: 1, unseen: 1 });
  });

  it("一次「标未读」不可能再造出 unseen(1) > total(0)", () => {
    insertFolder(db, "account-1", "INBOX");
    // 一封**已读**邮件：派生真值是 total=1 / unseen=0。
    insertMessage(db, { id: "m-read", uid: 1, flags: ["\\Seen"] });

    const { deps } = acceptanceDeps(db);
    const outcome = acceptFlagsTask(deps, { messageIds: ["m-read"], patch: { seen: false } });
    expect(outcome.changedIds).toEqual(["m-read"]);

    const counts = derivedCounts(db, "account-1", "INBOX");
    expect(counts).toEqual({ total: 1, unseen: 1 });
    // 老断言是 unseen(1) > total(0)。派生之后两个数是同一组行上的两个 COUNT，
    // 所以 unseen ≤ total 由构造保证，而不是靠谁记得去维护。
    expect(counts.unseen).toBeLessThanOrEqual(counts.total);
  });
});

describe("T3 · 派生计数随目标态走（重构必须保住的不变量）", () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDatabase(":memory:");
    insertAccount(db, "account-1");
  });

  afterEach(() => {
    db.close();
  });

  it("标已读再标未读，派生 unseen 跟着动", () => {
    insertFolder(db, "account-1", "INBOX");
    for (let uid = 1; uid <= 3; uid++) insertMessage(db, { id: `m-${uid}`, uid });

    expect(derivedCounts(db, "account-1", "INBOX")).toEqual({ total: 3, unseen: 3 });

    // 写者是验收，读者是派生计数器：两边的 flag 拼写一旦不一致（`\Seen` 对
    // `Seen`），这里的数字就不会动，所以这不是"自己等于自己"。
    const { deps } = acceptanceDeps(db);
    acceptFlagsTask(deps, { messageIds: ["m-1"], patch: { seen: true } });
    expect(derivedCounts(db, "account-1", "INBOX").unseen).toBe(2);

    acceptFlagsTask(deps, { messageIds: ["m-1"], patch: { seen: false } });
    expect(derivedCounts(db, "account-1", "INBOX").unseen).toBe(3);

    // 这与 G3（任意随机变更序列后派生值 == 全量重算）是同一条不变量的单点抽样。
  });

  it("标星只影响 badges 谓词，不牵动 unseen", () => {
    insertFolder(db, "account-1", "INBOX");
    insertMessage(db, { id: "m-1", uid: 1 });

    const { deps } = acceptanceDeps(db);
    acceptFlagsTask(deps, { messageIds: ["m-1"], patch: { flagged: true } });

    expect(derivedCounts(db, "account-1", "INBOX").unseen).toBe(1);
  });
});
