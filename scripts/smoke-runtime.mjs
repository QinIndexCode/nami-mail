import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-mail-runtime-"));
const environmentKeys = ["HOST", "PORT", "DATABASE_PATH", "MASTER_KEY_PATH", "WEB_DIST_PATH"];
const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
let server;

try {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.DATABASE_PATH = path.join(temporaryDataDirectory, "nami-mail.db");
  process.env.MASTER_KEY_PATH = path.join(temporaryDataDirectory, "master.key");
  process.env.WEB_DIST_PATH = path.join(projectRoot, "apps", "web", "dist");

  const { startServer } = await import("../apps/server/dist/runtime.js");
  server = await startServer();

  const health = await fetch(`${server.url}/api/health`).then((response) => response.json());
  assert.deepEqual({ ok: health.ok, service: health.service }, { ok: true, service: "nami-mail" });

  const rendererResponse = await fetch(`${server.url}/?desktop=1`);
  assert.match(rendererResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  const renderer = await rendererResponse.text();
  assert.match(renderer, /<div id="root"><\/div>/);

  console.log(JSON.stringify({ url: server.url, health, rendererServed: true }));
} finally {
  await server?.close();
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(temporaryDataDirectory, { recursive: true, force: true });
}
