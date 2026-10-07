/**
 * Boots a throwaway Nami Mail server for the real-chain e2e run.
 *
 * The default e2e specs all drive the demo shell (`/?demo=1`), which never
 * issues a real request: `isDemo` short-circuits every load in App.tsx and
 * swaps in fixture data. That leaves the whole
 * `renderer -> vite proxy -> Fastify -> SQLite` path without browser-level
 * coverage, where contract drift, error-code mapping and token/host handling
 * would only surface in a packaged desktop run.
 *
 * This script seeds a tiny database with the real server modules (so the schema
 * and the encryption are genuine, not mocked) and then runs the server against
 * it on a dedicated port and data directory. Isolation matters: during
 * development 3187 is usually the developer's own mailbox, and a test must
 * never read or mutate real local data.
 *
 * Usage:
 *   node scripts/e2e-real/serve-fixture.mjs [--port 3199] [--count 6] [--dir data/e2e-real]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const port = String(arg("--port", "3199"));
const count = String(arg("--count", "6"));
const dataDir = path.resolve(projectRoot, arg("--dir", "data/e2e-real"));
const serverEntry = path.join(projectRoot, "apps", "server", "dist", "index.js");

// The seed reuses apps/server/dist modules, so a stale build would quietly
// produce a fixture the current source cannot read.
if (!fs.existsSync(serverEntry)) {
  console.error("[e2e-real] apps/server/dist/index.js is missing — run: npm run build --workspace @nami/server");
  process.exit(1);
}

const accountId = "stress-account";
const TRACKING_HTML = '<p>发票与报销单跟进</p><img src="https://tracker.invalid/pixel.png" width="1" height="1"><p>附件中的文档请在本周五前完成评审。</p>';

async function addTrackingPixelMessage(dir) {
  const { openDatabase } = await import(pathToFileURL(path.join(projectRoot, "apps", "server", "dist", "db.js")).href);
  const { loadOrCreateMasterKey } = await import(pathToFileURL(path.join(projectRoot, "apps", "server", "dist", "crypto.js")).href);
  const { encryptMessagePayload } = await import(pathToFileURL(path.join(projectRoot, "apps", "server", "dist", "message-storage.js")).href);

  const masterKeyPath = path.join(dir, "master.key");
  const masterKey = loadOrCreateMasterKey(masterKeyPath);
  const db = openDatabase(path.join(dir, "nami-mail.db"));
  try {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE id = ?").get("e2e-tracking-pixel");
    if (existing.count > 0) return;
    const id = "e2e-tracking-pixel";
    const payload = {
      messageId: `${id}@e2e.example.test`,
      subject: "含远程图片的邮件",
      fromName: "陈明",
      fromAddress: "ming.chen@example.test",
      to: [],
      cc: null,
      inReplyTo: null,
      references: null,
      snippet: "发票与报销单跟进",
      textBody: "发票与报销单跟进",
      htmlBody: TRACKING_HTML,
      attachments: null,
    };
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, remote_id_lookup, subject,
        from_name, from_address, to_json, cc_json, in_reply_to, references_json,
        sent_at, snippet, text_body, html_body, flags_json,
        has_attachments, attachments_json, encrypted_payload, payload_version,
        size, snoozed_until, created_at
      ) VALUES (?, ?, 'INBOX', 9001, ?, ?, ?, ?, '[]', NULL, NULL, NULL,
        ?, ?, ?, ?, ?, 0, NULL, ?, 1, ?, NULL, ?)
    `).run(
      id,
      accountId,
      `${id}@imap.example.test`,
      payload.subject,
      payload.fromName,
      payload.fromAddress,
      nowIso,
      payload.snippet,
      payload.textBody,
      payload.htmlBody,
      JSON.stringify(["\\Seen"]),
      encryptMessagePayload(masterKey, id, accountId, payload),
      1024,
      nowIso,
    );
  } finally {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    masterKey.fill(0);
  }
}

const seeded = spawnSync(process.execPath, [
  path.join(projectRoot, "scripts", "ui-stress", "seed-data.mjs"),
  "--count", count,
  "--dir", dataDir,
], { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });

if (seeded.status !== 0) {
  console.error("[e2e-real] seeding failed");
  process.exit(seeded.status ?? 1);
}

// The stress seed only writes plain-text bodies, but the tracking-pixel defence
// is about HTML bodies: this adds one message whose html_body points a remote
// image at a host that does not resolve, so a browser-level assertion can prove
// the renderer never requests it directly. Written through the real storage
// module so the payload is encrypted exactly as a synced message would be.
await addTrackingPixelMessage(dataDir);

// The server resolves DATABASE_PATH and MASTER_KEY_PATH through its own config
// and runs with cwd=apps/server, so both are passed as absolute paths.
const server = spawn(process.execPath, [serverEntry], {
  cwd: path.join(projectRoot, "apps", "server"),
  env: {
    ...process.env,
    DATABASE_PATH: path.join(dataDir, "nami-mail.db"),
    MASTER_KEY_PATH: path.join(dataDir, "master.key"),
    PORT: port,
  },
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill());
}
server.on("exit", (code) => process.exit(code ?? 0));
