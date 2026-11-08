import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { RunningServer } from "../src/runtime.js";
import { openDatabase } from "../src/db.js";
import { createContact } from "../src/contacts.js";
import { updateAppSettings } from "../src/settings.js";

it("exports and previews over HTTP, requires confirmation, and activates the restored generation on a real runtime restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-restore-runtime-"));
  const key = Buffer.alloc(32, 0x5a);
  const databasePath = path.join(directory, "original.db");
  vi.stubEnv("DATABASE_PATH", databasePath); vi.stubEnv("PORT", "0"); vi.resetModules();
  const { config } = await import("../src/config.js");
  const { startServer } = await import("../src/runtime.js");
  const token = "synthetic-local-api-token";
  const localFetch = (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set("x-nami-api-token", token);
    return fetch(url, { ...init, headers });
  };
  let runtime: RunningServer | undefined;
  try {
    const seed = openDatabase(databasePath, { encryptionKey: key });
    createContact(seed, key, { name: "Backup contact", email: "backup@example.test" });
    updateAppSettings(seed, { realtimePushEnabled: false }); seed.close();
    Object.assign(config, { databasePath, port: 0, microsoftOAuthClientId: "" });
    runtime = await startServer({ masterKey: key, localApiAccessToken: token });
    const password = "synthetic-runtime-password";
    const exported = await localFetch(`${runtime.url}/api/app-backups/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
    expect(exported.status).toBe(200);
    const archive = await exported.arrayBuffer();
    const preview = await localFetch(`${runtime.url}/api/app-backups/preview`, { method: "POST", headers: { "content-type": "application/x-nami-backup", "x-nami-backup-password": Buffer.from(password).toString("base64") }, body: archive });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const { id, counts } = await preview.json() as { id: string; counts: Record<string, number> };
    expect(counts.contacts).toBe(1);
    const activation = `${runtime.url}/api/app-backups/${id}/activate`;
    expect((await localFetch(activation, { method: "POST" })).status).toBe(400);
    expect((await localFetch(activation, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) })).status).toBe(200);
    await runtime.close(); runtime = undefined;
    const original = openDatabase(databasePath, { encryptionKey: key });
    createContact(original, key, { name: "Original only", email: "original@example.test" }); original.close();
    runtime = await startServer({ masterKey: key, localApiAccessToken: token });
    const contacts = await (await localFetch(`${runtime.url}/api/contacts`)).json() as { items: Array<{ email: string }> };
    expect(contacts.items.map((item) => item.email)).toEqual(["backup@example.test"]);
    const preserved = openDatabase(databasePath, { encryptionKey: key });
    expect(preserved.prepare("SELECT COUNT(*) FROM contacts").pluck().get()).toBe(2); preserved.close();
  } finally {
    await runtime?.close(); vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
