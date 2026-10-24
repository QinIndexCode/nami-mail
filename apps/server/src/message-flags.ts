/**
 * Shared vocabulary for message flag updates.
 *
 * Three places speak it: `sync-flags.ts` (the sync-side STORE -- provider first,
 * then the local cache), the flags acceptance in `tasks/kinds/flags.ts` (local
 * target state first, then one task per account), and `flags-outbox.ts`, which
 * translates a committed patch into the IMAP store the push task sends. The last
 * of those applies nothing locally any more -- that half moved into the
 * acceptance -- but it is still a reader of this vocabulary. All three translate
 * the same patch shape into the same IMAP flag names, so the shape and the names
 * have one definition here.
 *
 * Each path deliberately keeps its own write ordering; only the vocabulary is
 * shared.
 */

export type MessageFlagsPatch = {
  seen?: boolean;
  flagged?: boolean;
};

export const messageFlagNames = {
  seen: "\\Seen",
  flagged: "\\Flagged",
} as const;
