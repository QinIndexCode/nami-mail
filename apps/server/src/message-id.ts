import { z } from "zod";

/**
 * The two id shapes a `messages` row can carry.
 *
 * Synced mail and drafts derive their id from the account, mailbox and uid
 * (`sha256(accountId\0mailbox\0uid)`, first 32 hex characters -- `messageKey` in
 * `sync.ts` and `stableMessageId` in `drafts.ts`), so essentially every row is
 * the 32-hex spelling. A pending-sent placeholder is minted with `randomUUID()`
 * before the provider has assigned a uid (`pending-sent.ts`), so the uuid
 * spelling is real too.
 *
 * The attachment, inline-image and EML routes validated with
 * `z.string().uuid()`, which refused the 32-hex spelling these routes exist to
 * serve: a real message answered 400 before any lookup. Accepting both keeps the
 * placeholder reachable without hiding the common shape.
 */
export const MESSAGE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const messageIdSchema = z.string().regex(MESSAGE_ID_PATTERN);
