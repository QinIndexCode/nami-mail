// Throwaway diagnostic: measure the per-phase cost of the startup DB path
// against a copy of the user's real database. Run from apps/server:
//   node measure-startup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "./dist/db.js";
import { messagePayloadForRow } from "./dist/message-storage.js";

const source = "C:\\Users\\Admin\\AppData\\Roaming\\Nami Mail\\data\\nami-mail.db";
const copy = path.join(os.tmpdir(), `nami-measure-${Date.now()}.db`);

let t = performance.now();
fs.copyFileSync(source, copy);
console.log(`copy: ${(performance.now() - t).toFixed(0)} ms`);
console.log(`size: ${(fs.statSync(copy).size / 1024 / 1024).toFixed(1)} MB`);

const dummyKey = Buffer.alloc(32, 1);

t = performance.now();
const db = openDatabase(copy);
console.log(`openDatabase (schema+pragma+migrate): ${(performance.now() - t).toFixed(0)} ms`);

const count = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
console.log(`messages rows: ${count}`);

const markers = db.prepare("SELECT id, completed_at FROM data_migrations").all();
console.log(`data_migrations: ${JSON.stringify(markers)}`);

const scanSql = `
  SELECT COUNT(*) AS n FROM messages
  WHERE encrypted_payload IS NULL OR encrypted_payload = '' OR payload_version <> 1
     OR message_id IS NOT NULL OR subject <> '' OR from_name <> '' OR from_address <> ''
     OR to_json <> '[]' OR COALESCE(cc_json, '[]') <> '[]' OR in_reply_to IS NOT NULL
     OR COALESCE(references_json, '[]') <> '[]' OR snippet <> '' OR text_body <> '' OR html_body <> ''
     OR COALESCE(attachments_json, '[]') <> '[]'
`;
t = performance.now();
const scanMatch = db.prepare(scanSql).get().n;
console.log(`migration full-scan: ${(performance.now() - t).toFixed(0)} ms (matched=${scanMatch})`);

const stats = db.prepare(`
  SELECT COUNT(*) AS n, SUM(length(encrypted_payload)) AS bytes
  FROM messages WHERE encrypted_payload IS NOT NULL AND encrypted_payload <> ''
`).get();
console.log(`payload rows=${stats.n}, totalBytes=${stats.bytes}`);

const sample = db.prepare(`
  SELECT id, account_id, encrypted_payload, payload_version FROM messages
  WHERE encrypted_payload IS NOT NULL AND encrypted_payload <> ''
  LIMIT 300
`).all();
let dt = performance.now();
let ok = 0;
let fail = 0;
for (const row of sample) {
  try {
    messagePayloadForRow(row, dummyKey);
    ok += 1;
  } catch {
    fail += 1;
  }
}
const dtMs = performance.now() - dt;
const perRowMs = dtMs / sample.length;
console.log(
  `sample decrypt: ${sample.length} rows in ${dtMs.toFixed(0)} ms`
  + ` (${perRowMs.toFixed(3)} ms/row, ok=${ok} fail=${fail})`,
);
console.log(`extrapolated full decrypt loop: ${((perRowMs * stats.n) / 1000).toFixed(1)} s`);

db.close();
try {
  fs.unlinkSync(copy);
  fs.unlinkSync(`${copy}-wal`);
  fs.unlinkSync(`${copy}-shm`);
} catch {
  /* best-effort cleanup */
}
