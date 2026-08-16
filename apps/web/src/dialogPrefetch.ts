import { api } from "./api";
import type { CalendarEvent, Contact, MailTemplate } from "./types";

const DEFAULT_TTL_MS = 30_000;

type CacheEntry<T> = { promise: Promise<T>; fetchedAt: number };

export type PrefetchCache<T> = {
  /** Cached hit (within TTL) resolves immediately; otherwise shares the in-flight request. */
  get(): Promise<T>;
  /** Start fetching without waiting — call before opening the dialog. */
  warm(): void;
  /** Discard the cached value and refetch in the background. */
  refresh(): void;
};

/**
 * Module-level cache for dialog data: a request is fetched once, its promise
 * is shared by everyone (mount, pre-warm, refresh), and a TTL keeps the value
 * fresh without re-fetching on every open. Failures evict the entry so a later
 * `get()` retries instead of re-surfacing the old rejection.
 */
export function createPrefetchCache<T>(loader: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): PrefetchCache<T> {
  let entry: CacheEntry<T> | null = null;
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
      entry = null;
      void this.get().catch(() => undefined);
    },
  };
}

export const contactsCache = createPrefetchCache(() => api.contacts().then((result) => result.items));
export const templatesCache = createPrefetchCache(() => api.templates().then((result) => result.items));
/** The full calendar; dialogs filter locally so month paging never refetches. */
export const calendarCache = createPrefetchCache(() => api.calendarEvents().then((result) => result.items));