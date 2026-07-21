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

export const config = {
  projectRoot,
  host: process.env.HOST?.trim() || "127.0.0.1",
  // Port 0 lets the desktop host ask Windows for a free loopback port.
  port: integerEnv("PORT", 3187, 0, 65535),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH?.trim() || "./data/nami-mail.db"),
  masterKeyPath: resolveFromRoot(process.env.MASTER_KEY_PATH?.trim() || "./data/master.key"),
  syncMessageLimit: integerEnv("SYNC_MESSAGE_LIMIT", 200, 10, 500),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  webDistPath: resolveFromRoot(process.env.WEB_DIST_PATH?.trim() || "./apps/web/dist"),
  // Set only by the Electron host; browser development intentionally runs
  // without this process-local capability.
  localApiAccessToken: optionalEnv("NAMI_MAIL_LOCAL_API_TOKEN"),
  googleOAuthClientId: optionalEnv("NAMI_MAIL_GOOGLE_OAUTH_CLIENT_ID"),
  microsoftOAuthClientId: optionalEnv("NAMI_MAIL_MICROSOFT_OAUTH_CLIENT_ID"),
  microsoftOAuthTenant: optionalEnv("NAMI_MAIL_MICROSOFT_TENANT") || "common",
  oauthFlowTtlSeconds: integerEnv("NAMI_MAIL_OAUTH_FLOW_TTL_SECONDS", 600, 60, 900),
};
