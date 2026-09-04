import { useSyncExternalStore } from "react";

/**
 * Local-only avatar pictures, keyed by lowercase email address. Avatars are a
 * browser-local preference (the local service never sees them): stored as
 * small JPEG data URLs in localStorage so the address book API payload and the
 * encrypted service store stay untouched. Reads degrade gracefully when
 * storage is unavailable (private mode, test environments).
 */
const PREFIX = "nami-mail.avatar.";

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAvatar(email: string): string | null {
  try {
    return storage()?.getItem(PREFIX + email.trim().toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** Persist (or clear, when dataUrl is null) the avatar for an email. */
export function setAvatar(email: string, dataUrl: string | null): void {
  try {
    const store = storage();
    if (!store) return;
    const key = PREFIX + email.trim().toLowerCase();
    if (dataUrl) {
      store.setItem(key, dataUrl);
    } else {
      store.removeItem(key);
    }
  } finally {
    for (const listener of listeners) listener();
  }
}

export function subscribeAvatars(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive read of the locally configured avatar for an email address. */
export function useCustomAvatar(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  return useSyncExternalStore(
    subscribeAvatars,
    () => getAvatar(normalized),
    () => null,
  );
}

/**
 * Reads a picked image file and downsizes it into a square JPEG data URL.
 * Returns null when the file is not decodable as an image.
 *
 * Uses FileReader.readAsDataURL to avoid blob-URL loading issues in
 * Electron's sandboxed renderer where `URL.createObjectURL` + `Image` can
 * silently fail to fire `onload`.
 */
export function resizeAvatarFile(file: File, maxSize = 112): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        resolve(null);
        return;
      }
      const image = new Image();
      image.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) {
            resolve(null);
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch {
          resolve(null);
        }
      };
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}