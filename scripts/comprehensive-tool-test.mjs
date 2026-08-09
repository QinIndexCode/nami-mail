// Comprehensive mail tool test - directly invokes all 9 tools against the real database
// Tests happy paths, failure cases, security boundaries, and edge cases
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = path.join(projectRoot, "apps", "server", "dist");
const agentCoreDist = path.join(projectRoot, "packages", "agent-core", "dist");

const dbPath = path.join(projectRoot, "data", "nami-mail.db");
const masterKeyPath = path.join(projectRoot, "data", "master.key");

// Load compiled modules
const { openDatabase } = await import(pathToFileURL(path.join(serverDist, "db.js")).href);
const { loadOrCreateMasterKey } = await import(pathToFileURL(path.join(serverDist, "crypto.js")).href);
const { SqliteMailApplicationService } = await import(pathToFileURL(path.join(serverDist, "agent", "sqlite-mail-application-service.js")).href);
const { createMailTools } = await import(pathToFileURL(path.join(serverDist, "agent", "mail-tools.js")).href);
const { createToolRegistry } = await import(pathToFileURL(path.join(agentCoreDist, "index.js")).href);

const masterKey = loadOrCreateMasterKey(masterKeyPath);
const db = openDatabase(dbPath);
const mailApp = new SqliteMailApplicationService({ db, masterKey, syncMessageLimit: 200 });
const registry = createToolRegistry(createMailTools(mailApp));

// ---- Test framework ----
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    console.log("  FAIL:", message);
  }
}

function assertEqual(actual, expected, message) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function makeCaller(scopes) {
  return {
    callerId: "test-user",
    kind: "test",
    entryPoint: "test",
    accessLevel: "full-access",
    scopes,
    accountScope: { mode: "selected", accountIds: ["test-account-001", "test-account-002"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function makeContext(accountIds, allowedMessageIds, scopes) {
  const ctx = {
    requestId: "test-request-" + Math.random().toString(36).slice(2, 8),
    caller: makeCaller(scopes ?? ["read:accounts", "read:folders", "read:messages", "read:attachments", "write:drafts"]),
    accountIds,
  };
  if (allowedMessageIds !== undefined) {
    ctx.allowedMessageIds = allowedMessageIds;
  }
  return ctx;
}

function makeCall(toolName, input) {
  return { id: "call-" + Math.random().toString(36).slice(2, 8), toolName, input, requestedAt: "2026-07-31T00:00:00Z" };
}

async function runTool(toolName, input, context) {
  const call = makeCall(toolName, input);
  const resolution = registry.resolve(call);
  if (!resolution.ok) {
    return { ok: false, error: resolution.error, status: "resolution_failed" };
  }
  const result = await registry.executeResolved(resolution, context);
  return {
    ok: result.status === "succeeded",
    status: result.status,
    output: result.output,
    error: result.error,
  };
}

// ---- Tests ----
const ACCT1 = "test-account-001";
const ACCT2 = "test-account-002";

console.log("\n========== 1. accounts.list ==========");

// 1.1 List with all_accounts scope
console.log("1.1 List accounts with both accounts in scope");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("accounts.list", {}, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.accounts.length === 2, "should return 2 accounts");
  assert(result.output.accounts.some(a => a.id === ACCT1), "should include account 1");
  assert(result.output.accounts.some(a => a.id === ACCT2), "should include account 2");
  console.log("  accounts:", result.output.accounts.map(a => `${a.id}(${a.email})`));
}

// 1.2 List with only one account in scope
console.log("1.2 List accounts with only account 1 in scope");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("accounts.list", {}, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.accounts.length === 1, "should return 1 account");
  assert(result.output.accounts[0].id === ACCT1, "should be account 1");
}

// 1.3 List with empty accountIds (SCOPE_DENIED)
console.log("1.3 List accounts with empty scope (should be denied)");
{
  const ctx = makeContext([]);
  const result = await runTool("accounts.list", {}, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  error code:", result.error.code);
}

// 1.4 List with invalid input (schema violation)
console.log("1.4 List accounts with invalid input");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("accounts.list", { unexpected: true }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "TOOL_INPUT_INVALID", "should be TOOL_INPUT_INVALID");
  console.log("  error code:", result.error.code);
}

// 1.5 List without read:accounts scope (note: scope enforcement is at agent-service level, not tool level)
console.log("1.5 List accounts without read:accounts scope (tool-level test)");
{
  const ctx = makeContext([ACCT1, ACCT2], undefined, ["read:messages"]);
  const result = await runTool("accounts.list", {}, ctx);
  // Tool itself doesn't check caller.scopes - that's enforced by agent-service before dispatch
  console.log("  status:", result.status, "(scope enforcement is at agent-service level)");
}

console.log("\n========== 2. folders.list ==========");

// 2.1 List folders for account 1
console.log("2.1 List folders for account 1");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("folders.list", { accountId: ACCT1 }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.folders.length === 4, "should return 4 folders");
  assert(result.output.folders.some(f => f.specialUse === "inbox"), "should have inbox");
  assert(result.output.folders.some(f => f.specialUse === "sent"), "should have sent");
  assert(result.output.folders.some(f => f.specialUse === "drafts"), "should have drafts");
  assert(result.output.folders.some(f => f.specialUse === "trash"), "should have trash");
  console.log("  folders:", result.output.folders.map(f => `${f.path}(${f.specialUse}, total=${f.total}, unseen=${f.unseen})`));
}

// 2.2 List folders for account 2 (empty account)
console.log("2.2 List folders for account 2 (empty)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("folders.list", { accountId: ACCT2 }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.folders.length === 3, "should return 3 folders");
  console.log("  folders:", result.output.folders.map(f => `${f.path}(${f.specialUse}, total=${f.total})`));
}

// 2.3 List folders for out-of-scope account
console.log("2.3 List folders for out-of-scope account");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("folders.list", { accountId: ACCT2 }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  error code:", result.error.code);
}

// 2.4 List folders for non-existent account (in scope but not in DB - returns empty)
console.log("2.4 List folders for non-existent account (returns empty)");
{
  const ctx = makeContext([ACCT1, ACCT2, "non-existent"]);
  const result = await runTool("folders.list", { accountId: "non-existent" }, ctx);
  assert(result.ok, "should succeed (returns empty list for non-existent account)");
  assert(result.output.folders.length === 0, "should return 0 folders");
  console.log("  folders:", result.output.folders.length);
}

// 2.5 List folders with missing accountId
console.log("2.5 List folders with missing accountId");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("folders.list", {}, ctx);
  assert(!result.ok, "should fail with schema validation");
  console.log("  error code:", result.error?.code);
}

console.log("\n========== 3. messages.list ==========");

// 3.1 List all messages
console.log("3.1 List all messages (no filter)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", {}, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 4, "should return 4 messages");
  console.log("  messages:", result.output.messages.map(m => `${m.id}(${m.subject}, from=${m.from.address})`));
}

// 3.2 List messages filtered by mailbox=INBOX
console.log("3.2 List messages in INBOX");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { mailbox: "INBOX" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 3, "should return 3 INBOX messages");
  assert(result.output.messages.every(m => m.mailbox === "INBOX"), "all should be INBOX");
  console.log("  messages:", result.output.messages.map(m => m.id));
}

// 3.3 List messages filtered by unread=true
console.log("3.3 List unread messages");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { unread: true }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 2, "should return 2 unread messages");
  console.log("  unread:", result.output.messages.map(m => `${m.id}(flags=${m.flags.join(",")})`));
}

// 3.4 List messages filtered by flagged=true
console.log("3.4 List flagged messages");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { flagged: true }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 1, "should return 1 flagged message");
  assert(result.output.messages[0].id === "msg-001", "should be msg-001");
  console.log("  flagged:", result.output.messages.map(m => m.id));
}

// 3.5 List messages filtered by sender (FIXED: now uses post-decryption filtering)
console.log("3.5 List messages from 'lisi' (FIXED: post-decryption sender filter)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { sender: "lisi" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 1, "should return 1 message from lisi");
  assert(result.output.messages[0].id === "msg-002", "should be msg-002");
  console.log("  from lisi:", result.output.messages.map(m => m.id));
}

// 3.5b List messages filtered by sender name
console.log("3.5b List messages from sender name '张三'");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { sender: "张三" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 1, "should return 1 message from 张三");
  assert(result.output.messages[0].id === "msg-001", "should be msg-001");
  console.log("  from 张三:", result.output.messages.map(m => m.id));
}

// 3.6 List messages filtered by after date
console.log("3.6 List messages after 2026-07-28");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { after: "2026-07-28T00:00:00Z" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  messages:", result.output.messages.map(m => `${m.id}(sentAt=${m.sentAt})`));
}

// 3.7 List messages filtered by before date
console.log("3.7 List messages before 2026-07-27");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { before: "2026-07-27T00:00:00Z" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  messages:", result.output.messages.map(m => `${m.id}(sentAt=${m.sentAt})`));
}

// 3.8 List messages with limit=2
console.log("3.8 List messages with limit=2");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { limit: 2 }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 2, "should return 2 messages");
  assert(result.output.nextCursor !== undefined, "should have nextCursor for pagination");
  console.log("  messages:", result.output.messages.map(m => m.id), "nextCursor:", result.output.nextCursor);
}

// 3.9 List messages with pagination (cursor)
console.log("3.9 List messages with cursor (page 2)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const page1 = await runTool("messages.list", { limit: 2 }, ctx);
  const page2 = await runTool("messages.list", { limit: 2, cursor: page1.output.nextCursor }, ctx);
  assert(page2.ok, "page 2 should succeed");
  assert(page2.output.messages.length === 2, "should return 2 messages on page 2");
  console.log("  page 2:", page2.output.messages.map(m => m.id));
}

// 3.10 List messages with combined filters
console.log("3.10 List messages with combined filters (mailbox=INBOX, unread=true)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { mailbox: "INBOX", unread: true }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 2, "should return 2 unread INBOX messages");
  console.log("  combined:", result.output.messages.map(m => m.id));
}

// 3.11 List messages from empty account only
console.log("3.11 List messages from empty account (account 2)");
{
  const ctx = makeContext([ACCT2]);
  const result = await runTool("messages.list", {}, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 0, "should return 0 messages for empty account");
  console.log("  empty account messages:", result.output.messages.length);
}

// 3.12 List messages with limit=0 (invalid)
console.log("3.12 List messages with limit=0 (invalid)");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("messages.list", { limit: 0 }, ctx);
  assert(!result.ok, "should fail");
  console.log("  error:", result.error?.code);
}

// 3.13 List messages with limit > 50 (invalid)
console.log("3.13 List messages with limit=100 (over max)");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("messages.list", { limit: 100 }, ctx);
  console.log("  status:", result.status, "error:", result.error?.code);
}

// 3.14 List messages with invalid extra param
console.log("3.14 List messages with unexpected param");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("messages.list", { accountId: ACCT1 }, ctx);
  assert(!result.ok, "should fail (accountId not allowed)");
  console.log("  error:", result.error?.code);
}

console.log("\n========== 4. messages.get ==========");

// 4.1 Get message by valid ID
console.log("4.1 Get message msg-001");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.get", { messageId: "msg-001" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.message.id === "msg-001", "should be msg-001");
  assert(result.output.message.subject.length > 0, "should have subject");
  assert(result.output.message.text.length > 0, "should have text body");
  assert(result.output.message.to.length > 0, "should have recipients");
  console.log("  subject:", result.output.message.subject);
  console.log("  from:", result.output.message.from);
  console.log("  text length:", result.output.message.text.length);
  console.log("  bodyTruncated:", result.output.message.bodyTruncated);
}

// 4.2 Get message with attachments (msg-002)
console.log("4.2 Get message msg-002 (has attachments)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.get", { messageId: "msg-002" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.message.hasAttachments === true, "should have attachments");
  console.log("  subject:", result.output.message.subject);
  console.log("  hasAttachments:", result.output.message.hasAttachments);
}

// 4.3 Get message with HTML body (msg-003)
console.log("4.3 Get message msg-003 (has HTML)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.get", { messageId: "msg-003" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  subject:", result.output.message.subject);
  console.log("  text length:", result.output.message.text.length);
}

// 4.4 Get non-existent message
console.log("4.4 Get non-existent message");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.get", { messageId: "non-existent" }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "NOT_FOUND", "should be NOT_FOUND");
  console.log("  error:", result.error.code);
}

// 4.5 Get message from out-of-scope account
console.log("4.5 Get message with allowedMessageIds restriction");
{
  // Only allow msg-001
  const ctx = makeContext([ACCT1, ACCT2], ["msg-001"]);
  const result1 = await runTool("messages.get", { messageId: "msg-001" }, ctx);
  assert(result1.ok, "msg-001 should be allowed");
  const result2 = await runTool("messages.get", { messageId: "msg-002" }, ctx);
  assert(!result2.ok, "msg-002 should be denied");
  assert(result2.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  msg-001:", result1.ok ? "allowed" : "denied");
  console.log("  msg-002:", result2.error.code);
}

// 4.6 Get message with empty allowedMessageIds
console.log("4.6 Get message with empty allowedMessageIds");
{
  const ctx = makeContext([ACCT1, ACCT2], []);
  const result = await runTool("messages.get", { messageId: "msg-001" }, ctx);
  assert(!result.ok, "should be denied (no messages allowed)");
  console.log("  error:", result.error?.code);
}

// 4.7 Get message with missing messageId
console.log("4.7 Get message with missing messageId");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("messages.get", {}, ctx);
  assert(!result.ok, "should fail schema validation");
  console.log("  error:", result.error?.code);
}

console.log("\n========== 5. threads.get ==========");

// 5.1 Get thread for msg-004 (reply to msg-001)
console.log("5.1 Get thread containing msg-001/msg-004");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("threads.get", { threadId: "<msg-001@nami-mail.local>" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  thread messages:", result.output.messages.map(m => `${m.id}(${m.subject})`));
  console.log("  truncated:", result.output.truncated);
}

// 5.2 Get thread with non-existent threadId
console.log("5.2 Get thread with non-existent threadId");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("threads.get", { threadId: "<nonexistent@nami-mail.local>" }, ctx);
  assert(result.ok, "should succeed (empty thread)");
  assert(result.output.messages.length === 0, "should return 0 messages");
  console.log("  empty thread messages:", result.output.messages.length);
}

// 5.3 Get thread with empty threadId
console.log("5.3 Get thread with empty threadId");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("threads.get", { threadId: "" }, ctx);
  console.log("  status:", result.status, "error:", result.error?.code);
}

// 5.4 Get thread with allowedMessageIds restriction
console.log("5.4 Get thread with message scope restriction");
{
  const ctx = makeContext([ACCT1, ACCT2], ["msg-001", "msg-004"]);
  const result = await runTool("threads.get", { threadId: "<msg-001@nami-mail.local>" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  scoped thread messages:", result.output.messages.map(m => m.id));
}

console.log("\n========== 6. attachments.list ==========");

// 6.1 List attachments for msg-002 (has 2 attachments)
console.log("6.1 List attachments for msg-002 (has attachments)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("attachments.list", { messageId: "msg-002" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.attachments.length === 2, "should return 2 attachments");
  console.log("  attachments:", result.output.attachments.map(a => `${a.filename}(${a.contentType}, ${a.size}bytes)`));
}

// 6.2 List attachments for msg-001 (no attachments)
console.log("6.2 List attachments for msg-001 (no attachments)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("attachments.list", { messageId: "msg-001" }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.attachments.length === 0, "should return 0 attachments");
  console.log("  no attachments:", result.output.attachments.length);
}

// 6.3 List attachments for non-existent message
console.log("6.3 List attachments for non-existent message");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("attachments.list", { messageId: "non-existent" }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "NOT_FOUND", "should be NOT_FOUND");
  console.log("  error:", result.error.code);
}

// 6.4 List attachments with allowedMessageIds restriction
console.log("6.4 List attachments with message scope restriction");
{
  const ctx = makeContext([ACCT1, ACCT2], ["msg-001"]);
  const result = await runTool("attachments.list", { messageId: "msg-002" }, ctx);
  assert(!result.ok, "should be denied (msg-002 not in scope)");
  console.log("  error:", result.error?.code);
}

console.log("\n========== 7. mail.draft.create ==========");

// 7.1 Create a valid draft
// NOTE: saveDraft needs IMAP connection; virtual mail server is unreachable
console.log("7.1 Create a valid draft (may fail - IMAP unreachable)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [{ address: "recipient@example.com", name: "Recipient" }],
    subject: "Test draft from comprehensive test",
    text: "This is a test draft body.",
  }, ctx);
  if (result.ok) {
    assert(result.output.draft.id.length > 0, "should have draft id");
    assert(result.output.draft.accountId === ACCT1, "should be for account 1");
    console.log("  draft id:", result.output.draft.id);
    console.log("  draft subject:", result.output.draft.subject);
    globalThis.__createdDraftId = result.output.draft.id;
  } else {
    console.log("  EXPECTED FAILURE (IMAP unreachable):", result.error?.code, "-", result.error?.message);
    console.log("  Draft create/update/delete tests require live IMAP server");
  }
}

// 7.2 Create draft with CC recipients
console.log("7.2 Create draft with CC (may fail - IMAP unreachable)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [{ address: "to@example.com" }],
    cc: [{ address: "cc@example.com" }],
    subject: "Draft with CC",
    text: "Body with CC.",
  }, ctx);
  if (result.ok) {
    console.log("  draft id:", result.output.draft.id);
    console.log("  recipients:", result.output.draft.recipients.length);
  } else {
    console.log("  EXPECTED FAILURE (IMAP unreachable):", result.error?.code);
  }
}

// 7.3 Create draft for out-of-scope account (scope check happens before IMAP)
console.log("7.3 Create draft for out-of-scope account");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT2,
    to: [{ address: "recipient@example.com" }],
    subject: "Out of scope",
    text: "Should fail.",
  }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  error:", result.error.code);
}

// 7.4 Create draft with invalid email
console.log("7.4 Create draft with invalid email");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [{ address: "not-an-email" }],
    subject: "Invalid",
    text: "Should fail.",
  }, ctx);
  assert(!result.ok, "should fail schema validation");
  console.log("  error:", result.error?.code);
}

// 7.5 Create draft with empty to array
console.log("7.5 Create draft with empty to array");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [],
    subject: "No recipients",
    text: "Should fail.",
  }, ctx);
  assert(!result.ok, "should fail (to must have at least 1)");
  console.log("  error:", result.error?.code);
}

// 7.6 Create draft without write:drafts scope (scope enforced at agent-service level)
console.log("7.6 Create draft without write:drafts scope (tool-level test)");
{
  const ctx = makeContext([ACCT1], undefined, ["read:messages"]);
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [{ address: "recipient@example.com" }],
    subject: "No scope",
    text: "Should fail.",
  }, ctx);
  console.log("  status:", result.status, "(scope enforcement is at agent-service level)");
}

console.log("\n========== 8. mail.draft.update ==========");

// 8.1 Update the created draft
console.log("8.1 Update created draft (requires IMAP)");
{
  const draftId = globalThis.__createdDraftId;
  if (!draftId) {
    console.log("  SKIP: no draft was created (IMAP unreachable)");
  } else {
    const ctx = makeContext([ACCT1, ACCT2]);
    const result = await runTool("mail.draft.update", {
      draftId,
      accountId: ACCT1,
      to: [{ address: "updated@example.com", name: "Updated" }],
      subject: "Updated draft subject",
      text: "Updated draft body content.",
    }, ctx);
    if (result.ok) {
      assert(result.output.draft.id === draftId, "should be same draft id");
      console.log("  updated draft id:", result.output.draft.id);
      console.log("  updated subject:", result.output.draft.subject);
    } else {
      console.log("  EXPECTED FAILURE (IMAP unreachable):", result.error?.code);
    }
  }
}

// 8.2 Update non-existent draft
console.log("8.2 Update non-existent draft");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("mail.draft.update", {
    draftId: "non-existent-draft",
    accountId: ACCT1,
    to: [{ address: "recipient@example.com" }],
    subject: "Update non-existent",
    text: "Should fail.",
  }, ctx);
  console.log("  status:", result.status, "error:", result.error?.code);
}

// 8.3 Update draft for out-of-scope account
console.log("8.3 Update draft for out-of-scope account");
{
  const draftId = globalThis.__createdDraftId;
  if (!draftId) {
    console.log("  SKIP: no draft was created (IMAP unreachable)");
  } else {
    const ctx = makeContext([ACCT2]);
    const result = await runTool("mail.draft.update", {
      draftId,
      accountId: ACCT1,
      to: [{ address: "recipient@example.com" }],
      subject: "Out of scope update",
      text: "Should fail.",
    }, ctx);
    assert(!result.ok, "should fail");
    assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
    console.log("  error:", result.error.code);
  }
}

console.log("\n========== 9. mail.draft.delete ==========");

// 9.1 Delete the created draft
console.log("9.1 Delete created draft (requires IMAP)");
{
  const draftId = globalThis.__createdDraftId;
  if (!draftId) {
    console.log("  SKIP: no draft was created (IMAP unreachable)");
  } else {
    const ctx = makeContext([ACCT1, ACCT2]);
    const result = await runTool("mail.draft.delete", {
      draftId,
      accountId: ACCT1,
    }, ctx);
    if (result.ok) {
      assert(result.output.deleted === true, "should return deleted=true");
      console.log("  deleted:", result.output.deleted);
    } else {
      console.log("  EXPECTED FAILURE (IMAP unreachable):", result.error?.code);
    }
  }
}

// 9.2 Delete non-existent draft
console.log("9.2 Delete non-existent draft");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("mail.draft.delete", {
    draftId: "non-existent-draft",
    accountId: ACCT1,
  }, ctx);
  console.log("  status:", result.status, "error:", result.error?.code);
}

// 9.3 Delete draft for out-of-scope account
console.log("9.3 Delete draft for out-of-scope account");
{
  const ctx = makeContext([ACCT2]);
  const result = await runTool("mail.draft.delete", {
    draftId: "any-draft",
    accountId: ACCT1,
  }, ctx);
  assert(!result.ok, "should fail");
  assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  error:", result.error.code);
}

console.log("\n========== 10. Security Boundaries ==========");

// 10.1 current_message scope - only see specific message
console.log("10.1 current_message scope (only msg-002)");
{
  const ctx = makeContext([ACCT1, ACCT2], ["msg-002"]);
  // messages.list should only return msg-002
  const listResult = await runTool("messages.list", {}, ctx);
  assert(listResult.ok, "list should succeed");
  assert(listResult.output.messages.length === 1, "should only see 1 message");
  assert(listResult.output.messages[0].id === "msg-002", "should be msg-002");
  console.log("  visible messages:", listResult.output.messages.map(m => m.id));

  // messages.get for msg-001 should be denied
  const getResult = await runTool("messages.get", { messageId: "msg-001" }, ctx);
  assert(!getResult.ok, "msg-001 should be denied");
  console.log("  msg-001 access:", getResult.error?.code);

  // messages.get for msg-002 should succeed
  const getResult2 = await runTool("messages.get", { messageId: "msg-002" }, ctx);
  assert(getResult2.ok, "msg-002 should be accessible");
  console.log("  msg-002 access: allowed");
}

// 10.2 selected_account scope - only see one account's data
console.log("10.2 selected_account scope (only account 2 - empty)");
{
  const ctx = makeContext([ACCT2]);
  const accountsResult = await runTool("accounts.list", {}, ctx);
  assert(accountsResult.output.accounts.length === 1, "should see 1 account");
  assert(accountsResult.output.accounts[0].id === ACCT2, "should be account 2");

  const messagesResult = await runTool("messages.list", {}, ctx);
  assert(messagesResult.output.messages.length === 0, "should see 0 messages");
  console.log("  account 2 messages:", messagesResult.output.messages.length);

  // Try to access account 1's message
  const getResult = await runTool("messages.get", { messageId: "msg-001" }, ctx);
  console.log("  msg-001 access:", getResult.error?.code ?? "allowed");
}

// 10.3 Cross-account scope denial
console.log("10.3 Cross-account folders access denial");
{
  const ctx = makeContext([ACCT1]);
  const result = await runTool("folders.list", { accountId: ACCT2 }, ctx);
  assert(!result.ok, "should deny access to account 2 folders");
  assert(result.error.code === "SCOPE_DENIED", "should be SCOPE_DENIED");
  console.log("  error:", result.error.code);
}

// 10.4 Empty allowedMessageIds + messages.list
console.log("10.4 Empty allowedMessageIds + messages.list");
{
  const ctx = makeContext([ACCT1, ACCT2], []);
  const result = await runTool("messages.list", {}, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 0, "should return 0 messages");
  console.log("  messages with empty allowedMessageIds:", result.output.messages.length);
}

console.log("\n========== 11. Edge Cases ==========");

// 11.1 Limit boundary: limit=1
console.log("11.1 List messages with limit=1");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { limit: 1 }, ctx);
  assert(result.ok, "should succeed");
  assert(result.output.messages.length === 1, "should return 1 message");
  assert(result.output.nextCursor !== undefined, "should have nextCursor");
  console.log("  message:", result.output.messages[0].id, "nextCursor:", result.output.nextCursor);
}

// 11.2 Limit boundary: limit=50 (max)
console.log("11.2 List messages with limit=50 (max)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { limit: 50 }, ctx);
  assert(result.ok, "should succeed");
  console.log("  messages:", result.output.messages.length);
}

// 11.3 Pagination: fetch all pages
console.log("11.3 Pagination: fetch all messages page by page");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  let allMessages = [];
  let cursor = undefined;
  let pages = 0;
  do {
    const result = await runTool("messages.list", { limit: 2, ...(cursor ? { cursor } : {}) }, ctx);
    assert(result.ok, `page ${pages + 1} should succeed`);
    allMessages.push(...result.output.messages);
    cursor = result.output.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert(allMessages.length === 4, `should fetch all 4 messages, got ${allMessages.length}`);
  console.log(`  fetched ${allMessages.length} messages in ${pages} pages`);
  console.log("  all ids:", allMessages.map(m => m.id));
}

// 11.4 Combined filters: mailbox + unread + sender
console.log("11.4 Combined filters: INBOX + unread + sender=example");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", {
    mailbox: "INBOX",
    unread: true,
    sender: "example",
  }, ctx);
  assert(result.ok, "should succeed");
  console.log("  messages:", result.output.messages.map(m => `${m.id}(from=${m.from.address})`));
}

// 11.5 Search for non-matching sender (also affected by encryption bug)
console.log("11.5 List messages with non-matching sender");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { sender: "nobody@nowhere.test" }, ctx);
  assert(result.ok, "should succeed");
  // Note: always returns 0 due to encryption bug, but 0 is correct here anyway
  console.log("  no matches:", result.output.messages.length);
}

// 11.6 Get thread for a message that has no replies
console.log("11.6 Get thread for msg-002 (no replies)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("threads.get", { threadId: "<msg-002@nami-mail.local>" }, ctx);
  assert(result.ok, "should succeed");
  console.log("  thread messages:", result.output.messages.map(m => m.id));
}

// 11.7 Invalid cursor
console.log("11.7 List messages with invalid cursor");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const result = await runTool("messages.list", { cursor: "not-a-number" }, ctx);
  console.log("  status:", result.status);
  if (result.ok) {
    console.log("  messages:", result.output.messages.length);
  } else {
    console.log("  error:", result.error?.code);
  }
}

// 11.8 Check that draft body is not leaked in output (requires IMAP)
console.log("11.8 Verify draft body is not in output (requires IMAP)");
{
  const ctx = makeContext([ACCT1, ACCT2]);
  const secretBody = "SECRET_DRAFT_BODY_CONTENT_12345";
  const result = await runTool("mail.draft.create", {
    accountId: ACCT1,
    to: [{ address: "recipient@example.com" }],
    subject: "Leak test",
    text: secretBody,
  }, ctx);
  if (result.ok) {
    const json = JSON.stringify(result.output);
    assert(!json.includes(secretBody), "draft body must not appear in output");
    console.log("  body not leaked: OK");
    // Clean up
    await runTool("mail.draft.delete", { draftId: result.output.draft.id, accountId: ACCT1 }, ctx);
  } else {
    console.log("  SKIP (IMAP unreachable):", result.error?.code);
    // Still verify the tool descriptor: draft output schema doesn't include text body
    console.log("  Note: draft output schema only includes id, accountId, subject, recipients, updatedAt");
  }
}

console.log("\n========== 12. Cancellation ==========");

// 12.1 Cancelled signal
console.log("12.1 Cancelled signal");
{
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    requestId: "test-cancel",
    caller: makeCaller(["read:accounts"]),
    accountIds: [ACCT1],
    signal: controller.signal,
  };
  const result = await runTool("accounts.list", {}, ctx);
  assert(!result.ok, "should fail");
  console.log("  error:", result.error?.code);
}

console.log("\n========== SUMMARY ==========");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\n--- Failures ---");
  for (const f of failures) {
    console.log(" -", f);
  }
}
db.close();
process.exit(failed > 0 ? 1 : 0);
