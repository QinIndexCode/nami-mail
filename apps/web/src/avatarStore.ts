import { useSyncExternalStore } from "react";
import { durableGet, durableSet } from "./durablePreferences";

/**
 * Local-only avatar pictures, keyed by lowercase email address. Avatars are a
 * browser-local preference (the local service never sees them): stored as
 * small JPEG data URLs via the durable preference layer — localStorage for
 * the session, mirrored to a main-process userData file on the desktop,
 * because the desktop origin's ephemeral port wipes per-origin storage on
 * every launch. Reads and writes degrade gracefully when storage is
 * unavailable (private mode, quota exceeded, test environments).
 */
const PREFIX = "nami-mail.avatar.";

const listeners = new Set<() => void>();

export function getAvatar(email: string): string | null {
  return durableGet(PREFIX + email.trim().toLowerCase());
}

/**
 * Persist (or clear, when dataUrl is null) the avatar for an email. The
 * durable layer absorbs every storage failure, so this never throws and the
 * subscriber notification always follows the write attempt.
 */
export function setAvatar(email: string, dataUrl: string | null): void {
  durableSet(PREFIX + email.trim().toLowerCase(), dataUrl);
  for (const listener of listeners) listener();
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