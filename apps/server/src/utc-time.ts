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
