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
 * Read order: a pending session override first, then localStorage, then the
 * desktop store's startup snapshot. On the desktop, localStorage is empty
 * in practice (the origin is a fresh ephemeral port on every launch), so
 * the snapshot is the effective durable read there — the localStorage arm
 * exists for the browser, where a stable origin makes it the whole store.
 * The override covers the asynchronous window of a write (a clear right
 * after boot must not resurrect the snapshot value while the durable IPC
 * write is still in flight) and the failure case where neither surface can
 * hold the value.
 *
 * An override is dropped only when EVERY readable surface agrees with the
 * session value: the synchronous write here can fail (quota) while the
 * durable write succeeds, and dropping the override on durable success
 * alone would resurrect the stale localStorage value on every later read.
 * A successful settlement therefore re-asserts the session value into
 * localStorage first; only when the re-assert also succeeds (or the value
 * was already there) is the override dropped. A failed write — or a
 * permanently quota-blocked surface — keeps the override for the session.
 */
const pendingOverrides = new Map<string, string | null>();

function writeLocalStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function durableGet(key: string): string | null {
  const overridden = pendingOverrides.get(key);
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
  const stored = writeLocalStorage(key, value);
  const bridge = desktopBridge();
  if (!bridge?.setLocalEntry) return; // Browser mode: the synchronous write is the whole story.
  // Desktop: the durable write is asynchronous, which leaves a window where
  // both readable surfaces may disagree with the just-made choice — and a
  // cleared entry would fall back to the stale startup snapshot. A session
  // override closes that window until the write settles; a failed write keeps
  // it so the session choice is preserved.
  pendingOverrides.set(key, value);
  try {
    // Fire-and-forget with the rejection handled: a failed durable write must
    // never surface as an unhandled rejection or an application error.
    void Promise.resolve(bridge.setLocalEntry(key, value))
      .then((result) => {
        if (!result?.saved) return; // Keep the override: the session choice must survive.
        if (stored) {
          // The synchronous surface already holds the session value.
          pendingOverrides.delete(key);
          return;
        }
        // The first localStorage write failed (quota). Re-assert the session
        // value now that the durable side is confirmed: only a surface that
        // truly cannot hold it keeps the override for the rest of the session.
        if (writeLocalStorage(key, value)) pendingOverrides.delete(key);
      })
      .catch(() => undefined);
  } catch {
    // A synchronous bridge failure leaves the override in effect for this session.
  }
}
