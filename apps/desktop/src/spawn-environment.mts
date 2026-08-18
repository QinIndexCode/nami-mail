/**
 * Child processes must not inherit the desktop host's full environment: the
 * local API token, translation API key and other NAMI_MAIL_* secrets live in
 * the main process and spawning with `env: undefined` forwards them all.
 * Every spawn/exec site uses this allowlist so children only see the system
 * variables they need to function (PATH, Windows system roots, desktop
 * session variables), and nothing application-specific.
 */

const MINIMAL_SPAWN_ENVIRONMENT_KEYS = [
  // Cross-platform process basics.
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG",
  // Windows: system lookup, user profile, shell routing, COM registration.
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "COMPUTERNAME", "USERDOMAIN", "USERNAME", "HOMEDRIVE", "HOMEPATH",
  "OS", "PSModulePath",
  // Unix desktop sessions (browser opening, sound playback).
  "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS", "SHELL",
] as const;

export function minimalSpawnEnvironment(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_SPAWN_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    // An empty value is indistinguishable from an unset variable to most
    // programs; drop it so it cannot shadow the child's own defaults.
    if (typeof value === "string" && value.length > 0) environment[key] = value;
  }
  return { ...environment, ...extra };
}