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
 * desktop store's startup snapshot. The override covers the asynchronous
 * window of a write (a clear right after boot must not resurrect the
 * snapshot value while the durable IPC write is still in flight) and the
 * failure case where neither surface can hold the value. Once the durable
 * write settles successfully the surfaces agree and the override is dropped,
 * so later external localStorage changes stay readable; a failed write keeps
 * the override to preserve the session choice.
 */
const pendingOverrides = new Map<string, string | null>();

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
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Session storage may fail (quota, private mode); the durable write below
    // still runs.
  }
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
        // The surfaces now agree with the session value.
        if (result?.saved) pendingOverrides.delete(key);
      })
      .catch(() => undefined);
  } catch {
    // A synchronous bridge failure leaves the override in effect for this session.
  }
}
