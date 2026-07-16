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

export const config = {
  projectRoot,
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: integerEnv("PORT", 3187, 1, 65535),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH?.trim() || "./data/nami-mail.db"),
  masterKeyPath: resolveFromRoot(process.env.MASTER_KEY_PATH?.trim() || "./data/master.key"),
  syncIntervalSeconds: integerEnv("SYNC_INTERVAL_SECONDS", 180, 30, 86_400),
  syncMessageLimit: integerEnv("SYNC_MESSAGE_LIMIT", 200, 10, 500),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  webDistPath: path.resolve(projectRoot, "apps/web/dist"),
};
