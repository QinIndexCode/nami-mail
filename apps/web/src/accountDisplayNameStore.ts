import { useSyncExternalStore } from "react";

const PREFIX = "nami-mail.account-display-name.";
const listeners = new Set<() => void>();
let revision = 0;
const persistedNames = new Map<string, string | null>();

/** Server metadata is independent of the desktop's changing loopback port. */
export function hydrateAccountDisplayNames(accounts: { email: string; displayName?: string | null }[]): void {
  persistedNames.clear();
  for (const account of accounts) {
    if (account.displayName !== undefined) persistedNames.set(key(account.email), account.displayName?.trim() || null);
  }
  revision += 1;
  for (const listener of listeners) listener();
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function key(email: string): string {
  return PREFIX + email.trim().toLowerCase();
}

/** Read the local display name for an account, if one has been configured. */
export function getAccountDisplayName(email: string): string | null {
  if (persistedNames.has(key(email))) return persistedNames.get(key(email)) ?? null;
  try {
    return storage()?.getItem(key(email))?.trim() || null;
  } catch {
    return null;
  }
}

/** Update the renderer cache after saving, or use browser storage in demo mode. */
export function setAccountDisplayName(email: string, name: string | null): void {
  if (persistedNames.has(key(email))) {
    persistedNames.set(key(email), name?.trim().slice(0, 64) || null);
    revision += 1;
    for (const listener of listeners) listener();
    return;
  }
  try {
    const store = storage();
    if (!store) return;
    const storageKey = key(email);
    const normalized = name?.trim().slice(0, 64) ?? "";
    if (normalized) store.setItem(storageKey, normalized);
    else store.removeItem(storageKey);
  } catch {
    // Local display names are optional; unavailable storage must not block mail.
  }
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
