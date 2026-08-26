import path from "node:path";

/**
 * Resolve the base directory the installer smoke uses for its temporary
 * installation directories.
 *
 * The smoke installs under the current user's LOCALAPPDATA so the temporary
 * payload never lands inside the repository (avoiding EBUSY-style locking,
 * AV scans and accidental git pollution), falling back to the project root
 * only on platforms that do not define it (the installer smoke is Windows-only).
 */
export function resolveInstallerSmokeBaseDirectory(projectRoot) {
  const allowedRoot = process.env.LOCALAPPDATA?.trim() || path.resolve(projectRoot);
  return path.join(allowedRoot, "NamiMailInstallerSmoke");
}
