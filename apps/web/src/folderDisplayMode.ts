import { durableGet, durableSet } from "./durablePreferences";

export type FolderDisplayMode = "focused" | "tree";

const STORAGE_KEY = "nami-mail.folder-display-mode";

/** Read the sidebar folder display mode; anything unpersisted or unknown falls back to "focused". */
export function loadFolderDisplayMode(): FolderDisplayMode {
  try {
    return durableGet(STORAGE_KEY) === "tree" ? "tree" : "focused";
  } catch {
    return "focused";
  }
}

/**
 * Persist the sidebar folder display mode. The preference is routed through
 * the durable layer: on the desktop the ephemeral origin wipes localStorage
 * on every launch, so without the mirror the choice was lost on restart.
 * Blocked storage only loses the choice.
 */
export function saveFolderDisplayMode(mode: FolderDisplayMode): void {
  try {
    durableSet(STORAGE_KEY, mode);
  } catch {
    // Local preference only; unavailable storage must not block mail.
  }
}
