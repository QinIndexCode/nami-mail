import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);

/**
 * The command-line launcher injects an absolute, Node-ABI-specific module
 * path. Electron deliberately ignores it unless the explicit runtime marker
 * is present, so a cached Node binary can never shadow its own ABI build.
 */
export function resolveSqliteModuleRequest(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeAbi: string | undefined = process.versions.modules,
): string {
  if (environment.NAMI_MAIL_NODE_SQLITE_RUNTIME !== "1") return "better-sqlite3";

  const modulePath = environment.NAMI_MAIL_NODE_SQLITE_MODULE?.trim();
  const expectedAbi = environment.NAMI_MAIL_NODE_SQLITE_ABI?.trim();
  if (!modulePath || !expectedAbi) {
    throw new Error("Nami Mail's Node SQLite launcher is incomplete. Restart it with npm.cmd run dev or npm.cmd start.");
  }
  if (expectedAbi !== runtimeAbi) {
    throw new Error(`Nami Mail's Node SQLite cache targets ABI ${expectedAbi}, but this runtime uses ABI ${runtimeAbi ?? "unknown"}. Restart the launcher to rebuild the cache.`);
  }
  return modulePath;
}

export function loadDatabaseConstructor(): typeof BetterSqlite3 {
  return require(resolveSqliteModuleRequest()) as typeof BetterSqlite3;
}
