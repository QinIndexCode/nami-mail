import type { DeliveryTask } from "./batchJobTypes";
import { formatFullDate } from "./app/app-utils";
import type { Translate } from "./i18n";

/**
 * How the cloud-sync panel's rows read.
 *
 * Separated from the component so the three decisions a row makes — which
 * action this kind names, which of its two halves a row belongs to, and which
 * state sentence its numbers justify — have unit tests of their own. The
 * component then only lays the answers out.
 */

/**
 * The task kinds, mirrored from the server's `TASK_KINDS`.
 *
 * An array rather than only the union, because the check has to survive a
 * server that is NEWER than this bundle: `DeliveryTask.kind` is typed as the
 * union, but a row read off the wire can carry a name this build has never
 * heard of, and the panel's answer to that is a label that says so instead of
 * hiding the task (the server forwards the kind verbatim for exactly this
 * reason).
 */
export const DELIVERY_TASK_KINDS = ["move", "flags", "undo", "send", "draft-discard", "snooze", "filter", "agent-apply"] as const;

/** What the task is doing to the mail, in the reader's language. */
export function cloudSyncKindLabel(kind: string, t: Translate): string {
  return (DELIVERY_TASK_KINDS as readonly string[]).includes(kind)
    ? t(`cloudSync.kind.${kind}`)
    : t("cloudSync.kind.other");
}

/**
 * The account line. An address when the server has one, the id when it does
 * not: the panel is about the account whose provider is being written to, and a
 * removed account's task is still a task.
 */
export function cloudSyncAccountLabel(task: DeliveryTask): string {
  return task.accountEmail || task.accountId;
}

/**
 * The row's state sentence.
 *
 * Order matters, and each branch is what the numbers can actually support:
 *
 * - **Terminal rows first**, because `completedAt` is the one field that says
 *   which half of the list a row came from — a failed task's `updated`/`failed`
 *   are final, while a running one's are a snapshot.
 * - **`dueAt` before progress**, because a snooze that has not come due has no
 *   progress by definition and "waiting until 09:00" is the whole truth about
 *   it.
 * - **Progress only when there is some.** The flags runner reports its counters
 *   once, at the end (deliberately: the push is not chunked, so there is no
 *   earlier number to report), which means a 1262-message flag push shows
 *   `updated: 0` for its whole life. Rendering "0/1262 done" for that would
 *   describe a stuck task rather than a busy one, so an unreported count falls
 *   back to the scope sentence.
 * - **A whole-batch failure carries no count**: `failed` is what the runner
 *   recorded per message, and a push refused before it touched any message
 *   reports zero — "0/300 failed" would read as nothing having failed.
 */
export function cloudSyncTaskDetail(task: DeliveryTask, t: Translate, locale: string, now: number = Date.now()): string {
  if (task.completedAt !== null) {
    if (task.status === "unknown_delivery") return t("cloudSync.unknownDetail");
    if (task.failed > 0) return t("cloudSync.failedDetail", { failed: task.failed, total: task.total });
    return t("cloudSync.failedWhole");
  }
  if (task.dueAt !== null && task.dueAt > now) {
    return t("cloudSync.waitingUntil", { time: formatFullDate(new Date(task.dueAt).toISOString(), locale) });
  }
  if (task.updated > 0) return t("cloudSync.progress", { updated: task.updated, total: task.total });
  return task.scope === "batch" ? t("cloudSync.queued", { count: task.total }) : t("cloudSync.inFlight");
}
