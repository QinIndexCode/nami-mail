import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { readRendererLocalStore, rendererLocalStorePath, writeRendererLocalStoreEntry } from "./renderer-local-store.mjs";

/**
 * Registers the durable renderer-preference channels. The renderer origin is
 * an ephemeral port, so per-origin localStorage cannot survive a relaunch;
 * these channels mirror preference entries (avatars, locale) into a userData
 * JSON file instead. The read is a one-shot synchronous handshake: the preload
 * caches the store at startup so the app's first frame can resolve the locale
 * without a flash. Electron's main process is single-threaded and both
 * handlers are synchronous, so read-modify-write cycles never interleave.
 * Dependencies are injected so the registration is unit-testable without
 * Electron (the confirmation-ipc pattern).
 */
export function registerRendererLocalStoreIpc(
  ipcMain: Pick<IpcMain, "on" | "handle">,
  isCurrentRenderer: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  userDataPath: () => string,
): void {
  let cache: Record<string, string> | undefined;
  ipcMain.on("nami:local-store-read", (event) => {
    cache ??= readRendererLocalStore(rendererLocalStorePath(userDataPath()));
    event.returnValue = isCurrentRenderer(event) ? cache : {};
  });
  ipcMain.handle("nami:local-store-set", (event, key: unknown, value: unknown) => {
    if (!isCurrentRenderer(event)) return { saved: false };
    const result = writeRendererLocalStoreEntry(rendererLocalStorePath(userDataPath()), key, value);
    // Drop the cache so a later navigation's read handshake sees the new entry.
    cache = undefined;
    return result;
  });
}
