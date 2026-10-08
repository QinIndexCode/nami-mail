import { desktopBridge } from "./desktop";

/**
 * Durable preference storage for the renderer.
 *
 * On the desktop the app's origin is http://127.0.0.1:<ephemeral port> (the
 * local service binds PORT=0), so localStorage is wiped on every launch. The
 * desktop bridge mirrors preference entries into a main-process file under
 * userData (the local mail service never sees them). In a browser the bridge
 * is absent and localStorage alone is used — a single stable origin.
 *
 * Read order: the synchronous session override map first, then localStorage,
 * then the desktop store's startup snapshot. The override map exists because
 * both persistent surfaces can lag or fail on the desktop: a clear right
 * after boot must not resurrect the snapshot value (the durable IPC write is
 * asynchronous and the localStorage entry may not exist), and a quota-blocked
 * localStorage write must not lose the session choice. An override entry of
 * null is a tombstone — distinct from "never overridden" — so clearing a
 * preference sticks for the whole session even when every persistent surface
 * still holds the old value.
 *
 * Writes update the override map first, then both persistent surfaces;
 * failures degrade gracefully — losing a preference must never surface as an
 * application error or an unhandled rejection.
 */
const sessionOverrides = new Map<string, string | null>();

export function durableGet(key: string): string | null {
  const overridden = sessionOverrides.get(key);
  if (overridden !== undefined) return overridden;
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // Storage unavailable (private mode, tests); fall through to the desktop store.
  }
  const bridge = desktopBridge();
  if (!bridge?.getLocalEntry) return null;
  try {
    return bridge.getLocalEntry(key);
  } catch {
    return null;
  }
}

export function durableSet(key: string, value: string | null): void {
  // The synchronous override governs every read in this session, regardless
  // of what the persistent surfaces end up holding.
  sessionOverrides.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Session storage may fail (quota, private mode); the override and the
    // durable write below still govern.
  }
  const bridge = desktopBridge();
  if (!bridge?.setLocalEntry) return;
  try {
    // Fire-and-forget, but the rejection IS handled: a failed durable write
    // must never surface as an unhandled rejection or an application error.
    void Promise.resolve(bridge.setLocalEntry(key, value)).catch(() => undefined);
  } catch {
    // A synchronous bridge failure leaves the override in effect for this session.
  }
}
