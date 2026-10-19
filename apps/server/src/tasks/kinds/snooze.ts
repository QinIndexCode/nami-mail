/**
 * The `snooze` kind: the local-only write that makes a message disappear until
 * an instant the user chose.
 *
 * It is the one kind whose work is already finished when the acceptance returns:
 * `messages.snoozed_until` is the goal state, and there is no provider that has
 * to learn about it. The durable task exists for the *other* half -- putting the
 * message back -- which can only happen at `due_at`. That is why the task carries
 * a payload (the exact instant) and one item (the message): the runner's only
 * obligation is to clear the field if the field still belongs to this task's
 * promise.
 *
 * The guard is equality, not a null check, and it is what makes re-snoozing safe.
 * A second snooze for the same message cancels the first task's *pending* row at
 * acceptance, but a row already claimed by the scheduler cannot be cancelled --
 * so an older runner may still wake up after the newer acceptance committed. It
 * must then do nothing, and `snoozed_until = ?` (the older instant) is how it
 * tells "my snooze is still the current one" from "the user moved it". Clearing
 * on `IS NOT NULL` would end the newer snooze early, which is the bug this file
 * exists to make impossible.
 */

import type { DatabaseHandle } from "../../db.js";
import { messagePayloadForRow, type MessageStorageRow } from "../../message-storage.js";
import type { NewInboxMessage } from "../../sync.js";
import { toUtcIsoTimestamp } from "../../utc-time.js";
import { TaskAbortError } from "../scheduler.js";
import { commitTask, type CommitTaskDeps } from "../store.js";
import type { TaskRunner } from "../types.js";

/** Sealed into the task: the instant this task's promise is about. */
export type SnoozeTaskPayload = {
  /** Normalized UTC ("Z") form of the instant stored in `messages.snoozed_until`. */
  until: string;
};

export type SnoozeTaskDeps = CommitTaskDeps;

export type AcceptSnoozeInput = {
  messageId: string;
  /** Any ISO form; the stored value is its normalized UTC form. */
  until: string;
};

export type SnoozeAcceptance = {
  taskId: string;
  /** The normalized value actually stored, which the route answers with. */
  snoozedUntil: string;
};

export type SnoozeRunnerDeps = {
  db: DatabaseHandle;
  masterKey: Buffer;
  /**
   * The release notification, in the same shape a freshly synced Inbox message
   * takes. Optional because the runner's obligation is the column, not the toast;
   * a host with no notification pipeline (tests, embedders) still gets a released
   * message.
   */
  onSnoozeReleased?: (message: NewInboxMessage) => void | Promise<void>;
};

/**
 * Marks the message snoozed in the caller's transaction and parks the task that
 * will bring it back.
 *
 * The update and the task are one commit (I1): a crash between them would either
 * hide a message with nothing to unhide it, or schedule a release for a message
 * that is not hidden. Returns after starting the task, which is a no-op until
 * `due_at` because the scheduler's claim predicate filters future due times -- so
 * a snooze never blocks its account's FIFO chain.
 */
export function acceptSnoozeTask(deps: SnoozeTaskDeps, input: AcceptSnoozeInput): SnoozeAcceptance {
  const normalized = toUtcIsoTimestamp(input.until);
  if (!normalized) throw new Error("稍后处理时间无效。");
  const row = deps.db.prepare("SELECT account_id FROM messages WHERE id = ?").get(input.messageId) as
    | { account_id: string }
    | undefined;
  if (!row) throw new Error("邮件不存在。");

  let taskId = "";
  deps.db.transaction(() => {
    deps.db.prepare("UPDATE messages SET snoozed_until = ? WHERE id = ?").run(normalized, input.messageId);
    // The acceptance supersedes any task still waiting to release this message.
    // A running one is left alone -- it is past the point a DELETE could safely
    // retract, and the runner's equality guard makes it a no-op.
    deps.db.prepare(`
      DELETE FROM tasks
      WHERE kind = 'snooze' AND status = 'pending'
        AND id IN (SELECT task_id FROM task_items WHERE message_id = ?)
    `).run(input.messageId);
    const handle = commitTask(deps, {
      accountId: row.account_id,
      kind: "snooze",
      items: [{ messageId: input.messageId }],
      payload: { until: normalized } satisfies SnoozeTaskPayload,
      dueAt: Date.parse(normalized),
    });
    taskId = handle.id;
  })();
  deps.scheduler.start(taskId);
  return { taskId, snoozedUntil: normalized };
}

/**
 * Cancels a snooze: the message is visible again now, and the task that would
 * have released it is withdrawn.
 *
 * Both writes share a transaction for the same reason the acceptance's do, and
 * no task is committed: cancellation's goal state is already final, so a task
 * would be durable work with nothing to converge. A runner that already claimed
 * the deleted task finds `snoozed_until` NULL (its equality guard fails) and
 * settles without touching anything.
 */
export function cancelSnoozeTask(db: DatabaseHandle, messageId: string): void {
  db.transaction(() => {
    const result = db.prepare("UPDATE messages SET snoozed_until = NULL WHERE id = ?").run(messageId);
    if (result.changes !== 1) throw new Error("邮件不存在。");
    db.prepare(`
      DELETE FROM tasks
      WHERE kind = 'snooze' AND status = 'pending'
        AND id IN (SELECT task_id FROM task_items WHERE message_id = ?)
    `).run(messageId);
  })();
}

/**
 * The runner: at `due_at`, clear the snooze if it is still the one this task
 * promised, then hand the message to the notification pipeline.
 *
 * The payload is read before the item loop rather than from each item, because
 * one task's items all share the acceptance's instant. A task with no payload is
 * a row this build could not have written (the migration never produces
 * `snooze`), so it aborts as `failed` instead of being retried into the same
 * nothing.
 */
export function createSnoozeRunner(deps: SnoozeRunnerDeps): TaskRunner<SnoozeTaskPayload> {
  return async ({ task, payload, items, report }) => {
    if (!payload || typeof payload.until !== "string") {
      throw new TaskAbortError("failed", `Task "${task.kind}" carries no release instant.`, "no_payload");
    }
    const released: NewInboxMessage[] = [];
    deps.db.transaction(() => {
      for (const item of items) {
        const row = deps.db.prepare(
          "SELECT * FROM messages WHERE id = ? AND snoozed_until = ?",
        ).get(item.message_id, payload.until) as MessageStorageRow | undefined;
        if (!row) continue;
        deps.db.prepare(
          "UPDATE messages SET snoozed_until = NULL WHERE id = ? AND snoozed_until = ?",
        ).run(item.message_id, payload.until);
        // Decrypted inside the transaction so a failure retries with the column
        // still set. After the commit the message is visible but the notification
        // would be lost, and no later pass can reconstruct "this one just woke up".
        released.push(releasedMessage(row, deps.masterKey));
        report({ updated: 1 });
      }
    })();
    for (const message of released) {
      try {
        await deps.onSnoozeReleased?.(message);
      } catch {
        // The release is committed and the message is visible; a failed toast
        // must not make the runner retry and toast the same message twice. This
        // is the same trade every notification boundary in the runtime makes.
      }
    }
  };
}

function releasedMessage(row: MessageStorageRow, masterKey: Buffer): NewInboxMessage {
  const payload = messagePayloadForRow(row, masterKey);
  return {
    id: row.id,
    accountId: row.account_id,
    subject: payload.subject,
    fromName: payload.fromName,
    fromAddress: payload.fromAddress,
  };
}
