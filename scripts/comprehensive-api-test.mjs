// Comprehensive API endpoint test - covers Provider errors, conversation CRUD,
// confirmation decisions, provider config, multi-turn persistence, and edge cases
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:3187";
const VALID_SCOPE = { mode: "all_accounts", accountIds: ["test-account-001", "test-account-002"], messageIds: [] };
const ACCT1_SCOPE = { mode: "selected_account", accountIds: ["test-account-001"], messageIds: [] };
const ACCT2_SCOPE = { mode: "selected_account", accountIds: ["test-account-002"], messageIds: [] };

// Dynamically resolve the default provider ID from the API
const providerListResp = await fetch(`${BASE}/api/agent/providers`);
const providerListData = await providerListResp.json();
const PROVIDER_ID = providerListData.defaultProviderId;
if (!PROVIDER_ID) {
  console.error("No default provider configured. Please create a provider first.");
  process.exit(1);
}
console.log(`Using provider: ${PROVIDER_ID}`);

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; } else { failed++; failures.push(message); console.log("  FAIL:", message); }
}

function assertEqual(actual, expected, message) {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  assert(equal, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createConversation(title, scope, providerId) {
  const body = { title, scope: scope ?? VALID_SCOPE };
  if (providerId) body.providerId = providerId;
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

async function sendMessage(conversationId, content, opts = {}) {
  const body = JSON.stringify({
    content,
    providerId: opts.providerId ?? PROVIDER_ID,
    mode: opts.mode ?? "agent",
    scope: opts.scope ?? VALID_SCOPE,
    context: opts.context ?? {},
  });
  const response = await fetch(`${BASE}/api/agent/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) return { error: `HTTP ${response.status}`, body: await response.text() };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const startTime = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
      }
    }
  }
  return { events, duration: Date.now() - startTime };
}

function getErrors(events) { return events.filter(e => e.type === "error"); }
function getText(events) { return events.filter(e => e.type === "text_delta").map(e => e.delta).join(""); }
function getTools(events) { return events.filter(e => e.type === "tool" && e.activity?.state === "running").map(e => e.activity.toolName); }
function isCompleted(events) { return events.some(e => e.type === "completed"); }

console.log("\n========== Comprehensive API Endpoint Tests ==========\n");

// ========== Section A: Conversation CRUD ==========
console.log("========== A. Conversation CRUD ==========\n");

// A.1 Create conversation with minimal fields
console.log("A.1 Create conversation (minimal)");
{
  const { status, data } = await createConversation("API-Test-A1", VALID_SCOPE);
  assert(status === 201, `should return 201, got ${status}`);
  assert(typeof data.id === "string" && data.id.length > 0, "should have id");
  assert(data.title === "API-Test-A1", "title should match");
  assert(data.scope.mode === "all_accounts", "scope should match");
  console.log("  conversation id:", data.id);
}

// A.2 Create conversation without title (should use default)
console.log("A.2 Create conversation (no title)");
{
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: VALID_SCOPE }),
  });
  const data = await resp.json();
  assert(resp.status === 201, `should return 201, got ${resp.status}`);
  assert(typeof data.id === "string", "should have id");
  console.log("  default title:", data.title);
}

// A.3 Create conversation with empty accountIds (schema allows empty array)
console.log("A.3 Create conversation (empty accountIds - allowed by schema)");
{
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Empty-Accounts", scope: { mode: "all_accounts", accountIds: [], messageIds: [] } }),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "id:", data.id ?? data.code);
  // Schema allows empty accountIds (no .min(1) on the array)
  assert(resp.status === 201, `should return 201 (schema allows empty), got ${resp.status}`);
}

// A.4 Create conversation with invalid scope mode
console.log("A.4 Create conversation (invalid scope mode)");
{
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Bad", scope: { mode: "invalid_mode", accountIds: ["x"], messageIds: [] } }),
  });
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
  console.log("  status:", resp.status);
}

// A.5 Get conversation by id
console.log("A.5 Get conversation by id");
{
  const { data: created } = await createConversation("API-Test-A5", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(data.id === created.id, "id should match");
  assert(data.title === "API-Test-A5", "title should match");
  console.log("  got conversation:", data.id);
}

// A.6 Get non-existent conversation
console.log("A.6 Get non-existent conversation");
{
  const resp = await fetch(`${BASE}/api/agent/conversations/non-existent-id`);
  console.log("  status:", resp.status);
  assert(resp.status === 404, `should return 404, got ${resp.status}`);
}

// A.7 List conversations
console.log("A.7 List conversations");
{
  const resp = await fetch(`${BASE}/api/agent/conversations`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(Array.isArray(data.items), "items should be array");
  console.log("  total conversations:", data.items.length);
}

// A.8 List conversations with query search
console.log("A.8 List conversations with query");
{
  const resp = await fetch(`${BASE}/api/agent/conversations?query=API-Test`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  console.log("  matching conversations:", data.items.length);
}

// A.9 Update conversation title
console.log("A.9 Update conversation title");
{
  const { data: created } = await createConversation("Original-Title", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Updated-Title" }),
  });
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(data.title === "Updated-Title", "title should be updated");
  console.log("  updated title:", data.title);
}

// A.10 Update conversation with empty title (invalid)
console.log("A.10 Update conversation with empty title");
{
  const { data: created } = await createConversation("To-Update", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "" }),
  });
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
  console.log("  status:", resp.status);
}

// A.11 Update non-existent conversation
console.log("A.11 Update non-existent conversation");
{
  const resp = await fetch(`${BASE}/api/agent/conversations/non-existent`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "X" }),
  });
  assert(resp.status === 404, `should return 404, got ${resp.status}`);
  console.log("  status:", resp.status);
}

// A.12 Delete conversation
console.log("A.12 Delete conversation");
{
  const { data: created } = await createConversation("To-Delete", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}`, { method: "DELETE" });
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(data.ok === true, "should return ok: true");
  // Verify deleted
  const getResp = await fetch(`${BASE}/api/agent/conversations/${created.id}`);
  assert(getResp.status === 404, "deleted conversation should 404");
  console.log("  deleted successfully");
}

// A.13 Delete non-existent conversation
console.log("A.13 Delete non-existent conversation");
{
  const resp = await fetch(`${BASE}/api/agent/conversations/non-existent`, { method: "DELETE" });
  assert(resp.status === 404, `should return 404, got ${resp.status}`);
  console.log("  status:", resp.status);
}

// A.14 Get conversation messages (via GET conversation which includes messages)
console.log("A.14 Get conversation messages");
{
  const { data: created } = await createConversation("Messages-Test", VALID_SCOPE);
  // Send a message first
  await sendMessage(created.id, "你好", { scope: ACCT1_SCOPE });
  await sleep(5000); // wait for message processing to complete
  // Messages are returned as part of the conversation object
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(Array.isArray(data.messages), "messages should be array");
  console.log("  messages:", data.messages?.length ?? 0);
  if (data.messages?.length < 2) {
    console.log("  NOTE: messages may still be streaming, will verify in E.1");
  }
}

// ========== Section B: Provider Error Handling ==========
console.log("\n========== B. Provider Error Handling ==========\n");

// B.1 Invalid provider ID
console.log("B.1 Invalid provider ID");
{
  const { data: created } = await createConversation("B1-InvalidProvider", VALID_SCOPE);
  const result = await sendMessage(created.id, "测试", { providerId: "non-existent-provider" });
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  errors:", errors.map(e => e.error?.code));
  console.log("  text preview:", text.slice(0, 100));
  assert(errors.length > 0, "should have error event");
  assert(errors.some(e => e.error?.code === "NOT_FOUND"), "should be NOT_FOUND");
  assert(isCompleted(result.events), "should complete");
}

// B.2 Empty content (schema validation)
console.log("B.2 Empty content (schema validation)");
{
  const { data: created } = await createConversation("B2-Empty", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "   ",
      providerId: PROVIDER_ID,
      mode: "agent",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "code:", data.code);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// B.3 Content too long (> 16000 chars)
console.log("B.3 Content too long");
{
  const { data: created } = await createConversation("B3-TooLong", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "x".repeat(20000),
      providerId: PROVIDER_ID,
      mode: "agent",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// B.4 Missing providerId
console.log("B.4 Missing providerId");
{
  const { data: created } = await createConversation("B4-NoProvider", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "test",
      mode: "agent",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// B.5 Invalid mode
console.log("B.5 Invalid mode");
{
  const { data: created } = await createConversation("B5-BadMode", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "test",
      providerId: PROVIDER_ID,
      mode: "invalid",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// B.6 Message to non-existent conversation (SSE returns 200, error in stream)
console.log("B.6 Message to non-existent conversation");
{
  const response = await fetch(`${BASE}/api/agent/conversations/non-existent/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "test",
      providerId: PROVIDER_ID,
      mode: "agent",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  // SSE endpoint always returns 200; error is in the stream
  const text = await response.text();
  console.log("  status:", response.status);
  console.log("  response:", text.slice(0, 200));
  assert(response.status === 200, "SSE should return 200 (error in stream)");
  assert(text.includes("error"), "response should contain error event");
}

// B.7 chat mode (no tools)
console.log("B.7 chat mode (no tools)");
{
  const { data: created } = await createConversation("B7-Chat", VALID_SCOPE);
  await sleep(1000); // ensure conversation is fully created
  const result = await sendMessage(created.id, "你好，请简单介绍一下你自己。", { mode: "chat", scope: ACCT1_SCOPE });
  const tools = getTools(result.events);
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", tools, "text len:", text.length);
  if (errors.length) console.log("  errors:", errors.map(e => e.error?.code));
  console.log("  preview:", text.slice(0, 100));
  assert(isCompleted(result.events), "should complete");
  if (errors.length === 0) {
    assert(text.length > 0, "should have response");
    assert(tools.length === 0, "chat mode should not call tools");
  }
}

// ========== Section C: Provider Configuration API ==========
console.log("\n========== C. Provider Configuration API ==========\n");

// C.1 List providers
console.log("C.1 List providers");
{
  const resp = await fetch(`${BASE}/api/agent/providers`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  assert(Array.isArray(data.items), "items should be array");
  assert(data.items.length > 0, "should have providers");
  assert(data.defaultProviderId === PROVIDER_ID, "should have correct default");
  console.log("  providers:", data.items.map(p => `${p.label}(${p.model}, cloud=${p.cloud})`));
}

// C.2 Get single provider (NOTE: GET /:id endpoint does not exist, only list)
console.log("C.2 Get single provider (via list)");
{
  const resp = await fetch(`${BASE}/api/agent/providers`);
  const data = await resp.json();
  assert(resp.status === 200, `should return 200, got ${resp.status}`);
  const found = data.items.find(p => p.id === PROVIDER_ID);
  assert(found !== undefined, "should find provider in list");
  assert(found.model === "mimo-v2.5-pro", "model should match");
  assert(found.apiKeyConfigured === true, "apiKey should be configured");
  assert(found.configured === true, "should be configured");
  console.log("  provider:", found.label, "model:", found.model);
}

// C.3 Get non-existent provider (no GET /:id endpoint, so 404)
console.log("C.3 Get non-existent provider (no GET /:id endpoint)");
{
  const resp = await fetch(`${BASE}/api/agent/providers/non-existent`);
  assert(resp.status === 404, `should return 404 (no such route), got ${resp.status}`);
  console.log("  status:", resp.status);
}

// C.4 Create new provider (invalid - missing required fields)
console.log("C.4 Create provider (missing fields)");
{
  const resp = await fetch(`${BASE}/api/agent/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Test" }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// C.5 Create provider with invalid endpoint
console.log("C.5 Create provider (invalid endpoint)");
{
  const resp = await fetch(`${BASE}/api/agent/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Bad Endpoint",
      kind: "openai-compatible",
      endpoint: "ftp://invalid.example.com",
      model: "test-model",
      timeoutMs: 30000,
      allowCloudMailContent: false,
    }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// C.6 Create provider with invalid timeout (too low)
console.log("C.6 Create provider (invalid timeout)");
{
  const resp = await fetch(`${BASE}/api/agent/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Bad Timeout",
      kind: "openai-compatible",
      endpoint: "https://api.example.com/v1/",
      model: "test-model",
      timeoutMs: 100,
      allowCloudMailContent: false,
    }),
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// C.7 Update existing provider (PATCH requires full schema)
console.log("C.7 Update provider (full schema required)");
{
  // First get current provider config from list
  const listResp = await fetch(`${BASE}/api/agent/providers`);
  const listData = await listResp.json();
  const current = listData.items.find(p => p.id === PROVIDER_ID);
  const resp = await fetch(`${BASE}/api/agent/providers/${PROVIDER_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label: "Xiaomi MiMo Updated",
      kind: current.kind,
      endpoint: current.endpoint,
      model: current.model,
      timeoutMs: current.timeoutMs,
      allowCloudMailContent: current.cloudContentConsent,
    }),
  });
  console.log("  status:", resp.status);
  if (resp.ok) {
    const data = await resp.json();
    console.log("  new label:", data.label);
    // Restore original label
    await fetch(`${BASE}/api/agent/providers/${PROVIDER_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: "Xiaomi MiMo",
        kind: current.kind,
        endpoint: current.endpoint,
        model: current.model,
        timeoutMs: current.timeoutMs,
        allowCloudMailContent: current.cloudContentConsent,
      }),
    });
  } else {
    const data = await resp.json();
    console.log("  error:", data.code, data.message);
  }
}

// C.8 Delete non-existent provider (should 404, do NOT delete the default)
console.log("C.8 Delete non-existent provider (preserve default)");
{
  const resp = await fetch(`${BASE}/api/agent/providers/non-existent`, { method: "DELETE" });
  console.log("  status:", resp.status);
  assert(resp.status === 404, `should return 404, got ${resp.status}`);
}

// C.9 Verify default provider still exists (must not have been deleted)
console.log("C.9 Verify default provider intact");
{
  const resp = await fetch(`${BASE}/api/agent/providers`);
  const data = await resp.json();
  assert(data.defaultProviderId === PROVIDER_ID, "default provider should still exist");
  assert(data.items.some(p => p.id === PROVIDER_ID), "provider should still be in list");
  console.log("  default provider:", data.defaultProviderId, "intact");
}

// ========== Section D: Confirmation Decision API ==========
console.log("\n========== D. Confirmation Decision API ==========\n");

// D.1 Decide on non-existent confirmation (approve) - endpoint is POST /api/agent/confirmations/:id
console.log("D.1 Approve non-existent confirmation");
{
  const resp = await fetch(`${BASE}/api/agent/confirmations/non-existent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "code:", data.code);
  // Confirmation endpoint returns 501 (not_supported) in current version
  assert(resp.status === 501 || resp.status === 404, `should return 501 or 404, got ${resp.status}`);
}

// D.2 Decide with invalid decision value
console.log("D.2 Decide with invalid decision");
{
  const resp = await fetch(`${BASE}/api/agent/confirmations/non-existent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "invalid" }),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "code:", data.code);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// D.3 Decide with missing decision
console.log("D.3 Decide with missing decision");
{
  const resp = await fetch(`${BASE}/api/agent/confirmations/non-existent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "code:", data.code);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// D.4 Decide with reject
console.log("D.4 Reject non-existent confirmation");
{
  const resp = await fetch(`${BASE}/api/agent/confirmations/non-existent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "reject" }),
  });
  const data = await resp.json();
  console.log("  status:", resp.status, "code:", data.code);
  assert(resp.status === 501 || resp.status === 404, `should return 501 or 404, got ${resp.status}`);
}

// ========== Section E: Multi-turn Context Persistence ==========
console.log("\n========== E. Multi-turn Context Persistence ==========\n");

// E.1 Multi-turn with context retention
console.log("E.1 Multi-turn context retention");
{
  const { data: created } = await createConversation("E1-MultiTurn", ACCT1_SCOPE);
  // Turn 1: list messages
  const r1 = await sendMessage(created.id, "请列出收件箱里的邮件主题。", { scope: ACCT1_SCOPE });
  console.log("  t1 tools:", getTools(r1.events), "errors:", getErrors(r1.events).map(e => e.error?.code));
  await sleep(3000);
  // Turn 2: ask about first message (relies on context)
  const r2 = await sendMessage(created.id, "第一封邮件是谁发的？", { scope: ACCT1_SCOPE });
  console.log("  t2 tools:", getTools(r2.events), "errors:", getErrors(r2.events).map(e => e.error?.code));
  console.log("  t2 text:", getText(r2.events).slice(0, 150));
  await sleep(2000);
  // Verify messages persisted (via GET conversation which includes messages)
  const convResp = await fetch(`${BASE}/api/agent/conversations/${created.id}`);
  const convData = await convResp.json();
  console.log("  persisted messages:", convData.messages?.length ?? 0);
  assert(convData.messages?.length >= 4, "should have at least 4 messages (2 user + 2 assistant)");
}

// E.2 Verify conversation scope is retained across messages
console.log("E.2 Verify scope retention");
{
  const { data: created } = await createConversation("E2-Scope", ACCT2_SCOPE);
  // Send with ACCT2 scope (empty mailbox)
  const r1 = await sendMessage(created.id, "请列出所有邮件。", { scope: ACCT2_SCOPE });
  console.log("  t1 tools:", getTools(r1.events), "text:", getText(r1.events).slice(0, 100));
  await sleep(2000);
  // Verify scope is still ACCT2
  const getResp = await fetch(`${BASE}/api/agent/conversations/${created.id}`);
  const getData = await getResp.json();
  console.log("  scope:", getData.scope?.mode, getData.scope?.accountIds);
  assert(getData.scope.accountIds[0] === "test-account-002", "scope should be retained");
}

// ========== Section F: Edge Cases ==========
console.log("\n========== F. Edge Cases ==========\n");

// F.1 Empty mailbox (account 2)
console.log("F.1 Empty mailbox (account 2)");
{
  const { data: created } = await createConversation("F1-Empty", ACCT2_SCOPE);
  const result = await sendMessage(created.id, "请列出这个账户的所有邮件。", { scope: ACCT2_SCOPE });
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", getTools(result.events), "errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 200));
  assert(isCompleted(result.events), "should complete");
  if (errors.length === 0) {
    assert(text.includes("空") || text.includes("没有") || text.includes("无") || text.includes("0"), "should indicate empty");
  }
}

// F.2 current_message scope
console.log("F.2 current_message scope");
{
  const scope = { mode: "current_message", accountIds: ["test-account-001"], messageIds: ["msg-001"] };
  const { data: created } = await createConversation("F2-CurrentMsg", scope);
  const result = await sendMessage(created.id, "请总结这封邮件。", { scope });
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", getTools(result.events), "errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 200));
  assert(isCompleted(result.events), "should complete");
}

// F.3 current_thread scope
console.log("F.3 current_thread scope");
{
  const scope = { mode: "current_thread", accountIds: ["test-account-001"], messageIds: ["msg-001", "msg-004"] };
  const { data: created } = await createConversation("F3-CurrentThread", scope);
  const result = await sendMessage(created.id, "请总结这个邮件线程。", { scope });
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", getTools(result.events), "errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 200));
  assert(isCompleted(result.events), "should complete");
}

// F.4 Request with malformed JSON
console.log("F.4 Malformed JSON body");
{
  const { data: created } = await createConversation("F4-BadJSON", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid json",
  });
  console.log("  status:", resp.status);
  assert(resp.status === 400, `should return 400, got ${resp.status}`);
}

// F.5 Request with missing content-type
console.log("F.5 Missing content-type");
{
  const { data: created } = await createConversation("F5-NoCT", VALID_SCOPE);
  const resp = await fetch(`${BASE}/api/agent/conversations/${created.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "test",
      providerId: PROVIDER_ID,
      mode: "agent",
      scope: VALID_SCOPE,
      context: {},
    }),
  });
  console.log("  status:", resp.status);
  // Should still work or return 400 depending on parser
  assert(resp.status === 400 || resp.status === 415 || resp.status === 200, `unexpected status ${resp.status}`);
}

// F.6 Context with currentMessageId
console.log("F.6 Context with currentMessageId");
{
  const { data: created } = await createConversation("F6-Ctx", ACCT1_SCOPE);
  const result = await sendMessage(created.id, "请总结当前邮件。", {
    scope: ACCT1_SCOPE,
    context: { currentMessageId: "msg-001" },
  });
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", getTools(result.events), "errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 200));
  assert(isCompleted(result.events), "should complete");
}

// F.7 Context with currentThreadMessageIds
console.log("F.7 Context with currentThreadMessageIds");
{
  const { data: created } = await createConversation("F7-CtxThread", ACCT1_SCOPE);
  const result = await sendMessage(created.id, "请总结这个线程。", {
    scope: ACCT1_SCOPE,
    context: { currentThreadMessageIds: ["msg-001", "msg-004"] },
  });
  const text = getText(result.events);
  const errors = getErrors(result.events);
  console.log("  tools:", getTools(result.events), "errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 200));
  assert(isCompleted(result.events), "should complete");
}

// ========== Section G: Invalid Routes ==========
console.log("\n========== G. Invalid Routes ==========\n");

// G.1 Unknown endpoint
console.log("G.1 Unknown endpoint");
{
  const resp = await fetch(`${BASE}/api/agent/unknown-endpoint`);
  console.log("  status:", resp.status);
  assert(resp.status === 404, `should return 404, got ${resp.status}`);
}

// G.2 Invalid HTTP method
console.log("G.2 Invalid HTTP method on conversations");
{
  const resp = await fetch(`${BASE}/api/agent/conversations`, { method: "PUT" });
  console.log("  status:", resp.status);
  assert(resp.status === 404 || resp.status === 405, `should return 404/405, got ${resp.status}`);
}

// G.3 Invalid conversation id format in URL
console.log("G.3 Malformed conversation id");
{
  const resp = await fetch(`${BASE}/api/agent/conversations/!@#$%^/messages`);
  console.log("  status:", resp.status);
}

console.log("\n========== Summary ==========");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\n--- Failures ---");
  for (const f of failures) console.log(" -", f);
}
process.exit(failed > 0 ? 1 : 0);
