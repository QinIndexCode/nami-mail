/**
 * The two halves of the batch/task wire surface, as their own module.
 *
 * They lived in `api.ts` until that file hit the monolith ratchet: the shapes
 * are read by the delivery watcher (`batchJobRunner.ts`), the cloud-sync panel
 * and `App.tsx`, and none of them needs the request layer to know what a job
 * looks like. `api.ts` still re-exports the two names it did before, so for its
 * callers this is a file move rather than a migration.
 *
 * The halves answer different questions and are deliberately not merged:
 * `BatchJobSnapshot` is "how is the job I just accepted doing", which a caller
 * holding one id can ask; `DeliveryTaskList` is "what is in flight at all",
 * which is what the rail panel asks. The acceptance of a job commits exactly
 * the tasks the second one lists, so they describe the same work at different
 * widths rather than two kinds of work.
 */

/**
 * The predicate a job resolves against -- one spelling of the list filters, so
 * a job cannot select a different set than the list shows.
 */
export type BatchJobQuery = {
  accountId?: string;
  folder?: string;
  q?: string;
  starred?: boolean;
  unread?: boolean;
  archived?: boolean;
  snoozed?: boolean;
  /** Matches the server's hasAttachments: the Attachments view across folders. */
  hasAttachments?: boolean;
  /** Attachment-kind segmentation, mirroring the list filter. */
  attachmentKind?: string;
  /** Sent-date bounds as UTC instants ("after" inclusive, "before" exclusive). */
  after?: string;
  before?: string;
  /** Matches the server's scope=all: search every account and mailbox. */
  scope?: "all";
};

/**
 * Progress view of a batch job — the exact shape of `GET /api/batch-jobs/:id`.
 *
 * Progress numbers only. The server deliberately keeps a job's changed-message
 * ids out of this response: a 30 000-id selection made every poll carry 1.3 MB,
 * and the poll loop runs every 600ms for up to 10 minutes. `batchJobUndo` sends
 * no id list either — the server undoes from its own record of what changed.
 * `undoWindowMs` stays optional because `start` fabricates a local "just
 * started" snapshot before the first poll lands.
 *
 * `id` names a job root, and after the task switch it may instead name a single
 * task: a job is one parent plus one `task_items` row per selected message, and
 * the read resolves either spelling so a lone task (a reverse, say) is pollable
 * by the same call.
 */
export type BatchJobSnapshot = {
  id: string;
  kind: "flags" | "move" | "undo";
  status: "running" | "completed" | "failed";
  total: number;
  done: number;
  updated: number;
  failed: number;
  createdAt: number;
  error?: string;
  undone?: boolean;
  undoWindowMs?: number;
};

/**
 * Why the server refused an undo, in the order `kinds/undo.ts` checks it: the
 * kind, whether the parent is still running, the one-shot claim, the window, and
 * finally whether the parent's payload reads back into a reverse.
 *
 * Mirrored for the same reason as the task vocabulary below: the renderer turns
 * each word into its own sentence, so a word missing here is a gap worth seeing.
 * The HTTP status cannot carry this — six of the seven share 409, which is why
 * the route puts the word in the body (`ApiError.reason`).
 */
export type BatchJobUndoReason =
  | "not_found"
  | "unsupported_parent"
  | "not_completed"
  | "already_undone"
  | "no_window"
  | "expired"
  | "inverse_unavailable";

/**
 * The task vocabulary, mirrored from the server's `tasks` layer.
 *
 * Mirrored rather than imported: the server's copy is `as const` over an array
 * that shares a file with its DDL, and the renderer has no build path to it.
 * The unions are what the panel switches on, so a kind added on the server
 * *without* a label here is a visible gap (`cloudSync.kind.*` falls back to the
 * raw name) instead of a compile error — which is the right way round, since the
 * server may legitimately be newer than the bundle that is running.
 */
export type DeliveryTaskKind = "move" | "flags" | "undo" | "send" | "draft-discard" | "snooze" | "filter" | "agent-apply";
export type DeliveryTaskScope = "single" | "batch";
export type DeliveryTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown_delivery";

/**
 * One row of the cloud-sync panel — the exact shape of `GET /api/tasks`.
 *
 * This is `TaskProgress` plus the two things a row needs to render on its own
 * (the account, and `dueAt`, which is what "waiting until" reads) and minus the
 * undo window, which is only meaningful to a caller holding one job id. The
 * server builds it from a join, so `accountEmail` is null when the account row
 * is already gone; the panel falls back to the id rather than dropping the row,
 * because a task in flight for a removed account is still in flight.
 */
export type DeliveryTask = {
  id: string;
  accountId: string;
  accountEmail: string | null;
  kind: DeliveryTaskKind;
  scope: DeliveryTaskScope;
  status: DeliveryTaskStatus;
  total: number;
  updated: number;
  failed: number;
  createdAt: number;
  /** Set once the task is terminal; null while it is outstanding. */
  completedAt: number | null;
  /** When a not-yet-due task becomes claimable (a snooze); null means "now". */
  dueAt: number | null;
  error?: { code?: string; message?: string };
};

/** The panel's two halves, in the order it renders them. */
export type DeliveryTaskList = {
  /** Non-terminal rows, oldest first. */
  syncing: DeliveryTask[];
  /** Recent terminal rows that did not deliver, newest first. */
  attention: DeliveryTask[];
};
