import { useSyncExternalStore } from "react";

const PREFIX = "nami-mail.account-display-name.";
const listeners = new Set<() => void>();
let revision = 0;

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
  try {
    return storage()?.getItem(key(email))?.trim() || null;
  } catch {
    return null;
  }
}

/** Save a local-only account display name, or clear it when name is null. */
export function setAccountDisplayName(email: string, name: string | null): void {
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
