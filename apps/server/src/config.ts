import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "../../../");

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * The local service must never answer outside this machine: it hosts
 * mailbox contents, sends mail, and derives account secrets. Only loopback
 * bind hosts are accepted; anything else is a misconfiguration that would
 * put the whole local API on the network.
 */
export function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255);
  }
  return false;
}

/** True for loopback socket peer addresses, including Node's IPv4-mapped forms. */
export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (!value) return true; // injected requests and abstract sockets carry no peer address
  const remote = value.trim().toLowerCase();
  if (remote === "::1" || remote === "::ffff:127.0.0.1" || remote === "::ffff:7f00:1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(remote)) {
    return remote.split(".").every((octet) => Number(octet) <= 255);
  }
  return false;
}

const hostValue = process.env.HOST?.trim() || "127.0.0.1";
if (!isLoopbackHost(hostValue)) {
  throw new Error(
    `Refusing to bind Nami Mail's local service to non-loopback host "${hostValue}". `
    + "The local API exposes mailbox data and send capability and must stay reachable "
    + "only from this machine; set HOST to 127.0.0.1, ::1, or localhost.",
  );
}

export const config = {
  projectRoot,
  host: hostValue,
  // Port 0 lets the desktop host ask Windows for a free loopback port.
  port: integerEnv("PORT", 3187, 0, 65535),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH?.trim() || "./data/nami-mail.db"),
  masterKeyPath: resolveFromRoot(process.env.MASTER_KEY_PATH?.trim() || "./data/master.key"),
  // Per-account mailbox sync cap: 0 syncs the whole mailbox like Gmail's web
  // client (no limit), a positive value fetches only the newest N messages.
  // The default matches the documented initial-sync cache (the README
  // promises "the newest 200 messages per folder") so a first connection
  // does not silently pull a multi-GB mailbox; set 0 or a larger value for
  // mailboxes that need the full history.
  syncMessageLimit: integerEnv("SYNC_MESSAGE_LIMIT", 200, 0, 100_000),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  webDistPath: resolveFromRoot(process.env.WEB_DIST_PATH?.trim() || "./apps/web/dist"),
  // Standalone runs may still set it explicitly in the environment. The
  // Electron host no longer uses this channel: it passes the capability
  // directly to startServer so child processes never inherit it from the
  // desktop main process.
  localApiAccessToken: optionalEnv("NAMI_MAIL_LOCAL_API_TOKEN"),
  googleOAuthClientId: optionalEnv("NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID"),
  microsoftOAuthClientId: optionalEnv("NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID"),
  microsoftOAuthTenant: optionalEnv("NAMI_MAIL_MICROSOFT_TENANT") || "common",
  oauthFlowTtlSeconds: integerEnv("NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS", 600, 60, 900),
  translationEndpoint: optionalEnv("NAMI_MAIL_TRANSLATION_ENDPOINT"),
  translationApiKey: optionalEnv("NAMI_MAIL_TRANSLATION_API_KEY"),
  translationTimeoutMs: integerEnv("NAMI_MAIL_TRANSLATION_TIMEOUT_MS", 25_000, 1_000, 60_000),
};
