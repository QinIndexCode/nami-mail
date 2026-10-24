/**
 * The push stream's event vocabulary, as a module of its own.
 *
 * `realtimeSync.ts` registers one listener per entry, and the server's
 * `SERVER_EVENT_TYPES` is the emit-side manifest. Keeping the names in a file
 * with no React imports is what lets `apps/server/tests/sse-contract.test.ts`
 * import it and assert the two sets are equal (contract §8 G12) without pulling
 * a hook and its runtime into a Node test.
 *
 * Adding a server event without adding it here is the silent failure G12 exists
 * to catch: the frame goes out, no listener exists, and nothing reports it.
 */
export const REALTIME_EVENT_NAMES = [
  "mail.received",
  "mail.synced",
  "settings.changed",
  "sync.progress",
  "task-progress",
  "task-settled",
  "mail-changed",
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];
