/**
 * The batch-job wire shapes, as their own module.
 *
 * They lived in `api.ts` until that file hit the monolith ratchet: the shapes
 * are read by the poll runner (`batchJobRunner.ts`), the toolbar and `App.tsx`,
 * and none of them needs the request layer to know what a job looks like.
 * `api.ts` still re-exports both names, so this is a file move rather than a
 * migration for its callers.
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
