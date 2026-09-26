export type FolderDisplayMode = "focused" | "tree";

const STORAGE_KEY = "nami-mail.folder-display-mode";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Read the sidebar folder display mode; anything unpersisted or unknown falls back to "focused". */
export function loadFolderDisplayMode(): FolderDisplayMode {
  try {
    return storage()?.getItem(STORAGE_KEY) === "tree" ? "tree" : "focused";
  } catch {
    return "focused";
  }
}

/** Persist the sidebar folder display mode. The preference is cosmetic, so blocked storage only loses the choice. */
export function saveFolderDisplayMode(mode: FolderDisplayMode): void {
  try {
    storage()?.setItem(STORAGE_KEY, mode);
  } catch {
    // Local preference only; unavailable storage must not block mail.
  }
}
