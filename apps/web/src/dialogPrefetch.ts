import { api } from "./api";
import type { CalendarEvent } from "./types";

const DEFAULT_TTL_MS = 30_000;

type CacheEntry<T> = { promise: Promise<T>; fetchedAt: number };

export type PrefetchCache<T> = {
  /** Cached hit (within TTL) resolves immediately; otherwise shares the in-flight request. */
  get(): Promise<T>;
  /** Start fetching without waiting — call before opening the dialog. */
  warm(): void;
  /** Discard the cached value and refetch in the background. */
  refresh(): void;
  /**
   * Monotonic revision, bumped by every `refresh()`.
   *
   * A consumer that awaits `get()` captures this first and compares it after
   * awaiting: a change means a newer refresh superseded the response, so writing
   * it to state would undo the local edit that triggered the refresh (a deleted
   * contact reappearing). The promise itself cannot express this — it is shared
   * by everyone who asked while it was in flight.
   */
  revision(): number;
};

/**
 * Module-level cache for dialog data: a request is fetched once, its promise
 * is shared by everyone (mount, pre-warm, refresh), and a TTL keeps the value
 * fresh without re-fetching on every open. Failures evict the entry so a later
 * `get()` retries instead of re-surfacing the old rejection.
 */
export function createPrefetchCache<T>(loader: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): PrefetchCache<T> {
  let entry: CacheEntry<T> | null = null;
  let revision = 0;
  const load = (): Promise<T> => {
    const promise = loader().catch((error: unknown) => {
      if (entry?.promise === promise) entry = null;
      throw error;
    });
    entry = { promise, fetchedAt: Date.now() };
    return promise;
  };
  return {
    get() {
      if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry.promise;
      return load();
    },
    warm() {
      void this.get().catch(() => undefined);
    },
    refresh() {
      // Bumping first: any response already being awaited belongs to the state
      // this refresh is replacing.
      revision += 1;
      entry = null;
      void this.get().catch(() => undefined);
    },
    revision() {
      return revision;
    },
  };
}

export const contactsCache = createPrefetchCache(() => api.contacts().then((result) => result.items));
export const templatesCache = createPrefetchCache(() => api.templates().then((result) => result.items));
/** Keep the existing full-calendar consumers complete across server pages. */
export async function loadCalendarEvents(range?: { after?: string; before?: string }) {
  const items = new Map<string, CalendarEvent>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await api.calendarEvents(range, 1000, cursor);
    for (const item of result.items) items.set(item.id, item);
    cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Calendar pagination did not advance.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...items.values()];
}
export const calendarCache = createPrefetchCache(() => loadCalendarEvents());
