/**
 * Pins the development ports to the server's canonical PORT default.
 *
 * The local API listens on apps/server/src/config.ts's PORT fallback (3187);
 * the web dev server proxies /api to it (apps/web/vite.config.ts) and the
 * stress runner spawns the server on it (scripts/ui-stress/run-stress.mjs).
 * Those references live in different packages, so this test keeps them from
 * drifting apart, and keeps the web dev server's own port distinct from the
 * API port so the two services cannot collide.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFile(path.join(projectRoot, relative), "utf8");

test("dev ports stay pinned to the server's canonical PORT default", async () => {
  const serverConfig = await read("apps/server/src/config.ts");
  const serverPortMatch = serverConfig.match(/integerEnv\("PORT",\s*(\d+),\s*0,\s*65535\)/);
  assert.ok(serverPortMatch, "apps/server/src/config.ts must declare the PORT default with its validation bounds.");
  const serverPort = Number(serverPortMatch[1]);

  const viteConfig = await read("apps/web/vite.config.ts");
  const proxyMatch = viteConfig.match(/"\/api":\s*"https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)"/);
  assert.ok(proxyMatch, "apps/web/vite.config.ts must proxy /api to the local API port.");
  assert.equal(Number(proxyMatch[1]), serverPort, "The vite /api proxy must target the server's PORT default.");

  const stressRunner = await read("scripts/ui-stress/run-stress.mjs");
  const stressPortMatch = stressRunner.match(/const PORT = (\d+);/);
  assert.ok(stressPortMatch, "scripts/ui-stress/run-stress.mjs must declare its server PORT.");
  assert.equal(Number(stressPortMatch[1]), serverPort, "The stress runner must spawn the server on the PORT default.");

  const webManifest = await read("apps/web/package.json");
  const webDevPortMatch = webManifest.match(/--port (\d+)/);
  assert.ok(webDevPortMatch, "apps/web/package.json must pin the vite dev server port.");
  const webDevPort = Number(webDevPortMatch[1]);
  assert.notEqual(webDevPort, serverPort, "The web dev server must not share the API port.");
  assert.ok(webDevPort > 0 && webDevPort <= 65535, "The web dev port must be a valid port number.");
});
