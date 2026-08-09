// Test data seeding script - inserts test mail accounts, folders, and messages
// Uses the server's own compiled modules for proper encryption
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = path.join(projectRoot, "apps", "server", "dist");

const { openDatabase } = await import(pathToFileURL(path.join(serverDist, "db.js")).href);
const { encryptAccountPassword, ACCOUNT_CREDENTIAL_CRYPTO_VERSION } = await import(pathToFileURL(path.join(serverDist, "account-credentials.js")).href);
const { loadOrCreateMasterKey } = await import(pathToFileURL(path.join(serverDist, "crypto.js")).href);

const dbPath = path.join(projectRoot, "data", "nami-mail.db");
const masterKeyPath = path.join(projectRoot, "data", "master.key");
const masterKey = loadOrCreateMasterKey(masterKeyPath);
const db = openDatabase(dbPath);

// --- Account 1: Primary test account with messages ---
const acct1Id = "test-account-001";
const acct1Email = "test@nami-mail.local";
const acct1Identity = {
  id: acct1Id, email: acct1Email, provider: "custom", auth_method: "password",
  imap_host: "imap.test.local", imap_port: 993, imap_secure: 1, imap_transport: "tls", imap_username: acct1Email,
  smtp_host: "smtp.test.local", smtp_port: 465, smtp_secure: 1, smtp_transport: "tls", smtp_username: acct1Email,
  username_mode: "email",
};
db.prepare(`INSERT INTO accounts (
  id, email, provider, provider_name, encrypted_password, credential_crypto_version,
  auth_method, imap_host, imap_port, imap_secure, imap_transport, imap_username,
  smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username, username_mode, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  acct1Id, acct1Email, "custom", "Test Provider",
  encryptAccountPassword(acct1Identity, "dummy-password", masterKey), ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  "password", "imap.test.local", 993, 1, "tls", acct1Email,
  "smtp.test.local", 465, 1, "tls", acct1Email, "email", "connected", new Date().toISOString()
);
console.log("Account 1 inserted:", acct1Id);

// --- Account 2: Empty mailbox test ---
const acct2Id = "test-account-002";
const acct2Email = "empty@nami-mail.local";
const acct2Identity = {
  id: acct2Id, email: acct2Email, provider: "custom", auth_method: "password",
  imap_host: "imap.test.local", imap_port: 993, imap_secure: 1, imap_transport: "tls", imap_username: acct2Email,
  smtp_host: "smtp.test.local", smtp_port: 465, smtp_secure: 1, smtp_transport: "tls", smtp_username: acct2Email,
  username_mode: "email",
};
db.prepare(`INSERT INTO accounts (
  id, email, provider, provider_name, encrypted_password, credential_crypto_version,
  auth_method, imap_host, imap_port, imap_secure, imap_transport, imap_username,
  smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username, username_mode, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  acct2Id, acct2Email, "custom", "Empty Provider",
  encryptAccountPassword(acct2Identity, "dummy-password", masterKey), ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  "password", "imap.test.local", 993, 1, "tls", acct2Email,
  "smtp.test.local", 465, 1, "tls", acct2Email, "email", "connected", new Date().toISOString()
);
console.log("Account 2 inserted:", acct2Id);

// --- Folders for Account 1 ---
const folders = [
  { path: "INBOX", name: "收件箱", special_use: "inbox", total: 3, unseen: 2 },
  { path: "Sent", name: "已发送", special_use: "sent", total: 1, unseen: 0 },
  { path: "Drafts", name: "草稿", special_use: "drafts", total: 0, unseen: 0 },
  { path: "Trash", name: "垃圾箱", special_use: "trash", total: 0, unseen: 0 },
];
const insertFolder = db.prepare(`INSERT INTO folders (account_id, path, name, special_use, total, unseen, uid_validity) VALUES (?, ?, ?, ?, ?, ?, ?)`);
for (const f of folders) insertFolder.run(acct1Id, f.path, f.name, f.special_use, f.total, f.unseen, "12345");
console.log("Folders inserted:", folders.length);

// --- Folders for Account 2 (empty) ---
const emptyFolders = [
  { path: "INBOX", name: "收件箱", special_use: "inbox", total: 0, unseen: 0 },
  { path: "Sent", name: "已发送", special_use: "sent", total: 0, unseen: 0 },
  { path: "Drafts", name: "草稿", special_use: "drafts", total: 0, unseen: 0 },
];
for (const f of emptyFolders) insertFolder.run(acct2Id, f.path, f.name, f.special_use, f.total, f.unseen, "67890");
console.log("Empty account folders inserted:", emptyFolders.length);

// --- Messages for Account 1 ---
const attachmentJson = JSON.stringify([
  { partId: "1.1", filename: "code-review-checklist.pdf", contentType: "application/pdf", size: 204800, related: false, disposition: "attachment" },
  { partId: "1.2", filename: "screenshot.png", contentType: "image/png", size: 51200, related: false, disposition: "attachment" },
]);

const messages = [
  {
    id: "msg-001", uid: 1, mailbox: "INBOX",
    message_id: "<msg-001@nami-mail.local>",
    subject: "项目周报 - 第30周",
    from_name: "张三", from_address: "zhangsan@example.com",
    to_json: JSON.stringify([{ name: "我", address: acct1Email }]),
    cc_json: null, in_reply_to: null, references_json: null,
    snippet: "本周完成了 Agent 运行时测试和 CLI/MCP 接口验证...",
    text_body: "本周工作总结：\n1. 完成 Agent 运行时核心循环测试\n2. CLI/MCP 接口验证通过\n3. Broker 恢复路径已修复\n4. v0.3.0 发布准备中\n\n下周计划：\n1. 完成安装包验证\n2. 推送 v0.3.0 标签\n3. 启动 GitHub 发布工作流",
    html_body: "",
    flags: ["\\Seen", "\\Flagged"], has_attachments: 0, attachments_json: null,
    sent_at: "2026-07-28T10:00:00Z",
  },
  {
    id: "msg-002", uid: 2, mailbox: "INBOX",
    message_id: "<msg-002@nami-mail.local>",
    subject: "Re: 代码审查反馈",
    from_name: "李四", from_address: "lisi@example.com",
    to_json: JSON.stringify([{ name: "我", address: acct1Email }]),
    cc_json: JSON.stringify([{ name: "王五", address: "wangwu@example.com" }]),
    in_reply_to: null, references_json: null,
    snippet: "我已经审查了你提交的 PR，有几个建议...",
    text_body: "你好，\n\n我已经审查了你提交的 PR #28，以下是反馈：\n\n1. broker-recovery-coordinator.ts 中的恢复逻辑很好，但建议添加更详细的日志\n2. cli.mts 中的 --version 别名处理需要考虑边缘情况\n3. MCP 配置文档中的 cmd /c 宿主方式是正确的\n4. smoke-installer.mjs 的 MCP 验证很全面\n\n总体来说代码质量很高，批准合并。\n\n李四",
    html_body: "",
    flags: [], has_attachments: 1, attachments_json: attachmentJson,
    sent_at: "2026-07-27T15:30:00Z",
  },
  {
    id: "msg-003", uid: 3, mailbox: "INBOX",
    message_id: "<msg-003@nami-mail.local>",
    subject: "服务器维护通知",
    from_name: "系统管理员", from_address: "admin@example.com",
    to_json: JSON.stringify([{ name: "全体员工", address: "all@example.com" }]),
    cc_json: null, in_reply_to: null, references_json: null,
    snippet: "计划于本周六凌晨进行服务器维护...",
    text_body: "各位同事：\n\n计划于 2026年8月2日（周六）凌晨 2:00-6:00 进行服务器维护。\n\n维护内容：\n1. 数据库升级\n2. 安全补丁更新\n3. 网络配置调整\n\n维护期间服务将暂停，请提前保存工作。\n\n系统管理员",
    html_body: "<html><body><p>各位同事：</p><p>计划于 2026年8月2日（周六）凌晨 2:00-6:00 进行服务器维护。</p></body></html>",
    flags: [], has_attachments: 0, attachments_json: null,
    sent_at: "2026-07-26T09:00:00Z",
  },
  {
    id: "msg-004", uid: 1, mailbox: "Sent",
    message_id: "<msg-004@nami-mail.local>",
    subject: "Re: 项目周报 - 第30周",
    from_name: "我", from_address: acct1Email,
    to_json: JSON.stringify([{ name: "张三", address: "zhangsan@example.com" }]),
    cc_json: null,
    in_reply_to: "<msg-001@nami-mail.local>",
    references_json: JSON.stringify(["<msg-001@nami-mail.local>"]),
    snippet: "收到周报，辛苦了。关于下周计划...",
    text_body: "张三你好，\n\n收到周报，辛苦了。关于下周计划，我有几点补充：\n1. 安装包验证优先级最高\n2. 发布前需要完整运行 605 项测试\n3. GitHub 发布工作流需要确认签名状态\n\n另外，v0.3.0 的发布说明需要补充 MCP cmd /c 配置要求。\n\n谢谢",
    html_body: "",
    flags: ["\\Seen"], has_attachments: 0, attachments_json: null,
    sent_at: "2026-07-28T11:00:00Z",
  },
];

const insertMessage = db.prepare(`INSERT INTO messages (
  id, account_id, mailbox, uid, message_id, subject,
  from_name, from_address, to_json, cc_json,
  in_reply_to, references_json,
  sent_at, snippet, text_body, html_body,
  flags_json, has_attachments, attachments_json, encrypted_payload, payload_version, size, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

for (const m of messages) {
  insertMessage.run(
    m.id, acct1Id, m.mailbox, m.uid, m.message_id, m.subject,
    m.from_name, m.from_address, m.to_json, m.cc_json,
    m.in_reply_to, m.references_json,
    m.sent_at, m.snippet, m.text_body, m.html_body,
    JSON.stringify(m.flags), m.has_attachments, m.attachments_json, null, 0, m.text_body.length, new Date().toISOString()
  );
}
console.log("Messages inserted:", messages.length);

// --- Verify ---
const accountCount = db.prepare("SELECT COUNT(*) as count FROM accounts").get();
const folderCount = db.prepare("SELECT COUNT(*) as count FROM folders").get();
const messageCount = db.prepare("SELECT COUNT(*) as count FROM messages").get();
const attachmentCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE has_attachments = 1").get();
const threadCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE in_reply_to IS NOT NULL").get();
console.log("Database state:", {
  accounts: accountCount.count, folders: folderCount.count, messages: messageCount.count,
  messagesWithAttachments: attachmentCount.count, threadedMessages: threadCount.count,
});

db.close();
console.log("Done.");
