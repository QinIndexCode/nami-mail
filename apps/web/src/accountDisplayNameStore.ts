import { useSyncExternalStore } from "react";

const PREFIX = "nami-mail.account-display-name.";
const listeners = new Set<() => void>();
let revision = 0;
const persistedNames = new Map<string, string | null>();

/**
 * Server-backed display names live in the renderer's memory cache, hydrated
 * from account rows (server metadata is independent of the desktop's changing
 * loopback port). The historical localStorage fallback (PR #136) was removed:
 * on the desktop the ephemeral origin wipes it on every launch, so it only
 * ever produced stale overrides; demo mode now keeps names in memory for the
 * session, which is all a demo ever promised.
 */

/** Server metadata is independent of the desktop's changing loopback port. */
export function hydrateAccountDisplayNames(accounts: { email: string; displayName?: string | null }[]): void {
  persistedNames.clear();
  for (const account of accounts) {
    if (account.displayName !== undefined) persistedNames.set(key(account.email), account.displayName?.trim() || null);
  }
  revision += 1;
  for (const listener of listeners) listener();
}

function key(email: string): string {
  return PREFIX + email.trim().toLowerCase();
}

/** Read the local display name for an account, if one has been configured. */
export function getAccountDisplayName(email: string): string | null {
  return persistedNames.get(key(email)) ?? null;
}

/** Update the renderer cache after saving, or keep the name for this session in demo mode. */
export function setAccountDisplayName(email: string, name: string | null): void {
  persistedNames.set(key(email), name?.trim().slice(0, 64) || null);
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render consumers when a display name changes in this renderer. */
export function useAccountDisplayNames(): number {
  return useSyncExternalStore(subscribe, () => revision, () => 0);
}
