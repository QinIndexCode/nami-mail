/**
 * The task layer's terminal statuses, as the renderer needs to read them from a
 * `task-settled` frame.
 *
 * The server owns the vocabulary (`apps/server/src/tasks/types.ts`); this is the
 * client's copy, and `apps/server/tests/sse-contract.test.ts` asserts the two
 * lists are identical (contract §8 G12). The copy earns its place: a listener
 * that treated only `completed`/`failed` as settled would drop a `cancelled`
 * task's frame on the floor and leave the UI showing work that will never
 * finish -- the same "never settle early, never settle wrongly" direction the
 * alias mapping takes.
 */
export const TASK_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "unknown_delivery",
] as const;

export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

export function isTaskTerminalStatus(value: unknown): value is TaskTerminalStatus {
  return typeof value === "string" && (TASK_TERMINAL_STATUSES as readonly string[]).includes(value);
}
