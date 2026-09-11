import { exec, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { minimalSpawnEnvironment } from "./spawn-environment.mjs";

/**
 * Opening external links from the desktop shell.
 *
 * On Windows the OAuth authorization page is handed to Chrome when installed
 * (matching the "log in with Google" flow), falling back to the OS default
 * browser otherwise. The Electron shell is injected rather than imported so the
 * URL policy and the browser resolution stay unit-testable.
 */

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

let cachedSystemBrowser: string | null | undefined;

/** Absolute path of an installed Chrome, or null when none is found. */
export function resolveChromePath(): Promise<string | null> {
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return Promise.resolve(candidate);
  }
  return new Promise((resolve) => {
    exec('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve', { env: minimalSpawnEnvironment() }, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      const match = /REG_SZ\s+(.+)\r?$/.exec(stdout.trim());
      resolve(match ? match[1]!.trim() : null);
    });
  });
}

export type ExternalOpenOptions = {
  /** Electron's `shell.openExternal`, injected so this stays Electron-free. */
  openExternal: (url: string) => Promise<void>;
  /** Platform and launcher are injectable so the branch is unit-testable. */
  platform?: NodeJS.Platform;
  resolveChrome?: () => Promise<string | null>;
  launch?: (command: string, args: readonly string[]) => { unref: () => void };
};

async function cachedChromePath(): Promise<string | null> {
  if (cachedSystemBrowser === undefined) cachedSystemBrowser = await resolveChromePath();
  return cachedSystemBrowser;
}

function launchDetached(command: string, args: readonly string[]): { unref: () => void } {
  return nodeSpawn(command, [...args], { detached: true, env: minimalSpawnEnvironment(), stdio: "ignore" });
}

export async function openInBrowser(url: string, options: ExternalOpenOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // The resolved path is cached only for the real lookup; an injected
    // resolver is consulted every time so callers stay order-independent.
    const chromePath = options.resolveChrome ? await options.resolveChrome() : await cachedChromePath();
    if (chromePath !== null) {
      (options.launch ?? launchDetached)(chromePath, [url]).unref();
      return;
    }
  }
  await options.openExternal(url);
}
