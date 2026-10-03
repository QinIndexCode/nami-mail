import fs from "node:fs/promises";
import path from "node:path";

export type SupportedBrokerTransport = "windows-named-pipe" | "unix-domain-socket";

const windowsPipePrefix = "\\\\.\\pipe\\";
const safePipeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSupportedBrokerTransport(value: unknown): value is SupportedBrokerTransport {
  return value === "windows-named-pipe" || value === "unix-domain-socket";
}

export function isValidWindowsPipePath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith(windowsPipePrefix)) {
    return false;
  }
  const pipeName = pathname.slice(windowsPipePrefix.length);
  return safePipeNamePattern.test(pipeName);
}

export function isValidUnixSocketPath(pathname: string): boolean {
  if (typeof pathname !== "string" || pathname.length === 0) {
    return false;
  }
  // Standard sockaddr_un sun_path limit is 104-108 bytes across POSIX implementations
  if (Buffer.byteLength(pathname, "utf8") > 104) {
    return false;
  }
  // Must be an absolute path or relative to secure directory
  return pathname.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathname);
}

export function isValidBrokerEndpointPath(pathname: string, transport?: SupportedBrokerTransport): boolean {
  if (transport === "windows-named-pipe") {
    return isValidWindowsPipePath(pathname);
  }
  if (transport === "unix-domain-socket") {
    return isValidUnixSocketPath(pathname);
  }
  return isValidWindowsPipePath(pathname) || isValidUnixSocketPath(pathname);
}

export function getDefaultBrokerTransport(): SupportedBrokerTransport {
  return process.platform === "win32" ? "windows-named-pipe" : "unix-domain-socket";
}

export function resolveBrokerEndpointPath(
  userDataPath: string,
  transport: SupportedBrokerTransport,
  identifier: string,
): string {
  if (transport === "windows-named-pipe") {
    return `${windowsPipePrefix}${identifier}`;
  }
  return path.join(userDataPath, `${identifier}.sock`);
}

/**
 * Validates that an existing Unix domain socket file belongs to the current user
 * and has exclusive 0600 file permissions (no group or other access).
 */
export async function verifyUnixSocketPermissions(socketPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(socketPath);
    if (!stats.isSocket()) {
      return false;
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      return false;
    }
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
