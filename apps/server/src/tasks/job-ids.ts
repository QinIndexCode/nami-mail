/**
 * The id grammar a batch job's tasks are named by, in one place.
 *
 * Two sides read and write these ids and they have to agree by construction
 * rather than by convention: an acceptance **names** its members (`memberTaskId`),
 * and the compatibility alias **resolves** a user-visible job id back to them
 * (`rootJobId` + the member check in `jobs.ts`). The grammar itself is fixed by
 * the migration, which already wrote it (`migrate.ts:526-529`):
 *
 *   - a **single-account** job's task carries the bare job id,
 *   - a job that spans accounts names each task `<jobId>:<accountId>`,
 *   - an account whose selection needs more than one slice adds the chunk
 *     (`<jobId>:<accountId>:<n>`, §10 item 22) -- the flags acceptance splits at
 *     `FLAGS_TASK_ENTRY_LIMIT` = 1000 entries, so 1001 ids is an ordinary
 *     operation and two members named alike would collide on the primary key.
 *
 * The obligation that a *root* be colon-free is the caller's, at the frame that
 * knows it is handing one in: `acceptMoveTask` refuses a colon-bearing `jobId` at
 * its entry (`kinds/move.ts`), because a legal member name and a legal job name
 * can be the same string and no amount of validation in here could tell them
 * apart. See `TaskSpec.id` in `types.ts`.
 */

/**
 * The job id an id belongs to: itself, or the part before the first colon when the
 * id is a cross-account member's.
 *
 * A job id and an account id are both colon-free UUIDs, so the first colon is the
 * separator by construction rather than by convention. The root is only a guess
 * until the member set confirms the id (`resolveJobMembers`).
 */
export function rootJobId(jobId: string): string {
  const separator = jobId.indexOf(":");
  return separator === -1 ? jobId : jobId.slice(0, separator);
}

/**
 * Names one member of a job: `root` when the whole job is this one member, and
 * `root:accountId` (or `root:accountId:<chunk>` for a later chunk of the same
 * account) otherwise.
 *
 * `total` is the number of members the whole acceptance commits, and it is what
 * decides between the two spellings -- not the number of accounts. That is how a
 * single-slice flags acceptance and a one-account move job end up with the same
 * bare id the migration writes for them, while a job that only *happens* to have
 * one movable account and two slices still gets two distinct names.
 *
 * Chunk numbering starts at 1, the first slice of each account being the one that
 * gets the unnumbered name.
 */
export function memberTaskId(root: string, accountId: string, chunk: number, total: number): string {
  if (total === 1) return root;
  return chunk === 1 ? `${root}:${accountId}` : `${root}:${accountId}:${chunk}`;
}
