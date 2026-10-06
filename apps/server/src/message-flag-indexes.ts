/**
 * The indexes that answer the starred and unread views.
 *
 * `flags_json` is a JSON *text* column and both views test it with a
 * leading-wildcard LIKE (`'%\\Flagged%'`), which no B-tree can serve: SQLite
 * would have to read every row of the account and evaluate the pattern against
 * the stored JSON text. On top of that `messages` rows carry the encrypted
 * payload — up to ~48KB — so an unindexed view reads the whole mailbox.
 *
 * A partial index is the shape that answers this without touching the schema:
 * its WHERE clause stores only the rows that can ever match, and SQLite reuses
 * it for a query whose predicate is *recognisably the same expression*. The
 * The `WHERE` here is therefore written to be character-for-character what the
 * queries put in — same column, same LIKE, same backslashes — because a partial
 * index whose predicate the planner cannot prove implied by the query's is
 * silently ignored, and an ignored index looks exactly like no index at all.
 *
 * This module is therefore the single source of those spellings, not just the
 * index DDL: every query that filters on `flags_json` imports the constant for
 * the sense it needs (`message-filters.ts`, the `/api/stats` sidebar badges and
 * the Agent's list tool) instead of restating the pattern. A copied literal
 * drifts silently — it still parses, still runs, and just stops matching the
 * index — so a second copy is a latent performance bug with no error attached.
 *
 * Both are partial, so they cost only their own rows (measured on 20 000 rows:
 * 90KB flagged / 676KB unseen, against 1.5-2MB for the full-account indexes)
 * and a row that is neither flagged nor unseen is indexed by neither.
 *
 * Leaf module: SQL text only, no imports.
 */

/**
 * The two IMAP flag names as they appear in the stored JSON text.
 *
 * `flags_json` holds a `JSON.stringify` result, so a flag written `\Seen` in
 * source lands in the column as an escaped *two*-backslash `\Seen` — hence the
 * raw strings; every LIKE pattern below inherits that. Measured against
 * `JSON.stringify` output the two-backslash and one-backslash patterns select
 * the same rows, so the historical one-backslash spelling elsewhere was only
 * ever redundant, never a different filter.
 */
export const SEEN_FLAG_TEXT = String.raw`\\Seen`;
export const FLAGGED_FLAG_TEXT = String.raw`\\Flagged`;

/** Predicate for the starred view. Written exactly as the query spells it. */
export const FLAGGED_PREDICATE_SQL = `flags_json LIKE '%${FLAGGED_FLAG_TEXT}%'`;

/** Predicate for the unread view. Same spelling discipline as above. */
export const UNSEEN_PREDICATE_SQL = `flags_json NOT LIKE '%${SEEN_FLAG_TEXT}%'`;

/**
 * The two negations, for callers that filter on the opposite sense (the Agent's
 * list tool takes a boolean, so it needs both). No partial index is keyed on
 * these — there is no "seen" or "unflagged" view to serve, and adding one is a
 * schema decision rather than a query cleanup — but the patterns still live here
 * so no caller has to restate them.
 */
export const UNFLAGGED_PREDICATE_SQL = `flags_json NOT LIKE '%${FLAGGED_FLAG_TEXT}%'`;
export const SEEN_PREDICATE_SQL = `flags_json LIKE '%${SEEN_FLAG_TEXT}%'`;

/**
 * Both indexes in the list's own `(account_id, sort_key DESC, id DESC)` shape,
 * so the view needs no sorter and the LIMIT stops early — the same ordering the
 * list views already use (see message-list-indexes.ts).
 *
 * `IF NOT EXISTS` is correct here: both are new names, so a database opened by
 * an earlier build simply gains them on its next migration pass. Nothing is
 * dropped and rebuilt, and no `messages` table rebuild is required — a partial
 * index is an ordinary index over a subset of rows, not a column constraint, so
 * the "ALTER cannot add a STORED generated column" limit does not apply.
 */
export const MESSAGE_FLAG_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_flagged ON messages(account_id, sort_key DESC, id DESC) WHERE ${FLAGGED_PREDICATE_SQL};
  CREATE INDEX IF NOT EXISTS idx_messages_unseen ON messages(account_id, sort_key DESC, id DESC) WHERE ${UNSEEN_PREDICATE_SQL};
`;
