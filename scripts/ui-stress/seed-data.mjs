/**
 * UI stress seed — fills a local server database with tens of thousands of
 * simulated messages (a configurable share unread) so the Playwright stress
 * spec can observe list rendering, scroll, and batch-operation blocking.
 *
 * The script reuses the exact server modules the runtime uses (openDatabase,
 * loadOrCreateMasterKey, encryptMessagePayload) so the seeded database is
 * structurally identical to a real one. The seeds account points its IMAP/SMTP
 * host at an unused loopback port, so batch operations fail fast with a local
 * refusal instead of hanging on DNS — batch latency then isolates UI behavior.
 *
 * Usage:
 *   node scripts/ui-stress/seed-data.mjs [--count 20000] [--ratio 0.75] [--seed 42] [--dir data/ui-stress]
 */

import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverDist = path.join(projectRoot, "apps", "server", "dist");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

const count = Number.parseInt(arg("--count", "20000"), 10) || 20000;
const unreadRatio = Math.min(1, Math.max(0, Number.parseFloat(arg("--ratio", "0.75")) || 0.75));
const seedValue = Number.parseInt(arg("--seed", "42"), 10) || 42;
const dataDir = path.resolve(projectRoot, arg("--dir", "data/ui-stress"));
const databasePath = path.join(dataDir, "nami-mail.db");
const masterKeyPath = path.join(dataDir, "master.key");

const { openDatabase } = await import(pathToFileURL(path.join(serverDist, "db.js")).href);
const { loadOrCreateMasterKey } = await import(pathToFileURL(path.join(serverDist, "crypto.js")).href);
const { encryptMessagePayload } = await import(pathToFileURL(path.join(serverDist, "message-storage.js")).href);
const {
  encryptAccountPassword,
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
} = await import(pathToFileURL(path.join(serverDist, "account-credentials.js")).href);

function mulberry32(state) {
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(seedValue);
const pick = (items) => items[Math.floor(random() * items.length)];

const senders = [
  { name: "陈明", address: "ming.chen@example.test" },
  { name: "李娜", address: "lina@example.test" },
  { name: "Zhang Wei", address: "zhang.wei@example.test" },
  { name: "Sarah Kim", address: "sarah.kim@example.test" },
  { name: "王强", address: "qiang.wang@example.test" },
  { name: "Anita Patel", address: "anita.patel@example.test" },
  { name: "Mónica Ruiz", address: "monica.ruiz@example.test" },
  { name: "no-reply", address: "noreply@example.test" },
];

const subjects = [
  "项目进度周报",
  "Meeting notes: Q3 planning",
  "发票与报销单跟进",
  "Release v0.3 checklist",
  "客户拜访安排",
  "Server maintenance window",
  "设计稿评审意见",
  "本周读书笔记分享",
];

const bodies = [
  "你好，附件中的文档请在本周五前完成评审，如有疑问随时联系我。",
  "Hi! Please review the attached plan and drop your comments before the stand-up.",
  "验证码：826491，5 分钟内有效，请勿转发给任何人。",
  "Reminder: the maintenance window starts at 22:00 UTC; rollback steps are in the runbook.",
  "辛苦更新一下预算表，财务下周一要出报表。",
  "The CI pipeline is green again — the flaky test was pinned to a fixed clock.",
  "以下是我整理的会议纪要，有遗漏的地方请补充。",
  "本周的分享材料我放到共享盘了，欢迎提出修改意见。",
];

const openPort = () => {
  // Unused loopback port so IMAP/SMTP connect fails immediately (ECONNREFUSED).
  const server = new net.Server();
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
};

const nowMs = Date.now();
const dayMs = 24 * 60 * 60 * 1_000;

fs.mkdirSync(dataDir, { recursive: true });
const accountId = "stress-account";
const accountEmail = "stress@example.test";

const seedStart = performance.now();
const db = openDatabase(databasePath);
const masterKey = loadOrCreateMasterKey(masterKeyPath);

const existing = db.prepare("SELECT COUNT(*) AS count FROM messages").get();
if (existing.count > 0) {
  console.warn(`Database already contains ${existing.count} messages; deleting to reseed.`);
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM folders");
  db.exec("DELETE FROM accounts");
}

const deadPort = await openPort();
const transport = "tls";
const credentialIdentity = {
  id: accountId,
  email: accountEmail,
  provider: "custom",
  auth_method: "password",
  imap_host: "127.0.0.1",
  imap_port: deadPort,
  imap_secure: 1,
  imap_transport: transport,
  imap_username: null,
  smtp_host: "127.0.0.1",
  smtp_port: deadPort + 1,
  smtp_secure: 1,
  smtp_transport: transport,
  smtp_username: null,
  username_mode: "email",
};
db.prepare(`
  INSERT INTO accounts (
    id, email, provider, provider_name, encrypted_password, credential_crypto_version,
    imap_host, imap_port, imap_secure, imap_transport, imap_username,
    smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
    username_mode, status, created_at
  ) VALUES (?, ?, 'custom', 'Stress Lab', ?, ?, '127.0.0.1', ?, 1, ?, NULL,
    '127.0.0.1', ?, 1, ?, NULL, 'email', 'connected', ?)
`).run(
  accountId,
  accountEmail,
  encryptAccountPassword(credentialIdentity, "stress-password", masterKey),
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  deadPort,
  transport,
  deadPort + 1,
  transport,
  new Date(nowMs).toISOString(),
);

const insertFolder = db.prepare(`
  INSERT INTO folders (account_id, path, name, special_use, total, unseen)
  VALUES (?, ?, ?, ?, 0, 0)
`);
insertFolder.run(accountId, "INBOX", "收件箱", null);
insertFolder.run(accountId, "[Gmail]/All Mail", "所有邮件", "\\All");
insertFolder.run(accountId, "[Gmail]/Trash", "废纸篓", "\\Trash");
insertFolder.run(accountId, "[Gmail]/Archive", "归档", "\\Archive");

// The app silently reloads the list every refresh_interval_seconds and the
// reload resets the accumulated scroll-pagination to page 1. Use the largest
// allowed interval so a stress run is not washed out every minute.
db.prepare(`
  INSERT INTO app_settings (id, refresh_interval_seconds, updated_at)
  VALUES (1, 300, ?)
  ON CONFLICT(id) DO UPDATE SET refresh_interval_seconds = 300, updated_at = excluded.updated_at
`).run(new Date(nowMs).toISOString());

const insertMessage = db.prepare(`
  INSERT INTO messages (
    id, account_id, mailbox, uid, remote_id_lookup, subject,
    from_name, from_address, to_json, cc_json, in_reply_to, references_json,
    sent_at, snippet, text_body, html_body, flags_json,
    has_attachments, attachments_json, encrypted_payload, payload_version,
    size, snoozed_until, created_at
  ) VALUES (?, ?, 'INBOX', ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL,
    ?, ?, ?, '', ?, 0, NULL, ?, 1, ?, NULL, ?)
`);

const insertMany = db.transaction((rows) => {
  for (const row of rows) insertMessage.run(...row);
});

const rows = [];
const batchSize = 2_000;
const encodedSeen = JSON.stringify(["\\Seen"]);
for (let index = 0; index < count; index += 1) {
  const id = `stress-message-${index}`;
  const sender = pick(senders);
  const subject = `${pick(subjects)} #${index}`;
  const body = `${pick(bodies)}\n\n（模拟邮件 #${index}，用于 UI 压力测试。）`;
  const unread = random() < unreadRatio;
  const sentAtIso = new Date(nowMs - Math.floor(random() * 90) * dayMs - Math.floor(random() * dayMs)).toISOString();
  const payload = {
    messageId: `${id}@stress.example.test`,
    subject,
    fromName: sender.name,
    fromAddress: sender.address,
    to: [],
    cc: null,
    inReplyTo: null,
    references: null,
    snippet: body.slice(0, 80),
    textBody: body,
    htmlBody: "",
    attachments: null,
  };
  rows.push([
    id,
    accountId,
    index + 1,
    `${id}@imap.example.test`,
    subject,
    sender.name,
    sender.address,
    sentAtIso,
    payload.snippet,
    body,
    unread ? "[]" : encodedSeen,
    encryptMessagePayload(masterKey, id, accountId, payload),
    Math.max(500, body.length * 3),
    sentAtIso,
  ]);
  if (rows.length >= batchSize) {
    insertMany(rows);
    rows.length = 0;
  }
}
if (rows.length) insertMany(rows);

const unreadCount = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE flags_json NOT LIKE '%\\\\Seen%'").get().count;
const totalCount = db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
db.close();
masterKey.fill(0);

fs.writeFileSync(path.join(dataDir, "seed-manifest.json"), JSON.stringify({
  messages: totalCount,
  unread: unreadCount,
  imapPort: deadPort,
  seed: seedValue,
}));

console.log(JSON.stringify({
  databasePath,
  masterKeyPath,
  messages: totalCount,
  unread: unreadCount,
  unreadRatio: Number((unreadCount / totalCount).toFixed(3)),
  imapPort: deadPort,
  seed: seedValue,
  elapsedMs: Math.round(performance.now() - seedStart),
}, null, 2));