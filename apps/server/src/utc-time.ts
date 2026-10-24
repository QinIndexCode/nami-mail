/**
 * R05: every comparable stored time is normalized to UTC ("Z") ISO form.
 *
 * SQLite comparisons are string comparisons — "09:00+08:00" sorts BEFORE
 * "02:00Z" lexicographically, so a send or snooze due at 01:00Z looked
 * not-yet-due to the due queries for hours. Persistence entries store only
 * the effective value (the same instant, always in Z form); a one-shot
 * migration rewrites legacy rows (see normalizeScheduledTimesMigration in
 * outbox.ts). Display keeps rendering the original instant; nothing about
 * the point in time changes, only its wire/storage spelling.
 */
export function toUtcIsoTimestamp(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Epoch ms for a stored ISO timestamp, or `undefined` when it is not one.
 *
 * `Date.parse`, never `CAST(strftime('%s', ...) AS INTEGER) * 1000`: the latter
 * truncates to whole seconds, and the legacy fixture shows why that matters -- it
 * makes the legacy queue's ISO timestamps land on the same *millisecond* as the
 * `batch_jobs` INTEGER ones (`'2026-10-17T02:58:01.030Z'` is exactly
 * `1792205881030`), so truncating invents a 30 ms ordering inversion in data that
 * had no precision loss. `toUtcIsoTimestamp` runs first so a non-`Z` value is not
 * reinterpreted in the local timezone; it is the same ruler
 * `scheduled-times-migration.ts` uses.
 *
 * One home for both of its callers, because they must agree: the migration reads
 * a legacy `send_at` into a task's `due_at` (`tasks/migrate.ts`), and acceptance
 * reads the `sendAt` the user just named into the very same column. A parked mail
 * has to be scheduled by the ruler it was migrated by.
 */
export function isoToEpochMs(value: string): number | undefined {
  const normalized = toUtcIsoTimestamp(value);
  if (!normalized) return undefined;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
