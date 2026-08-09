// LLM Agent integration test v2 - independent conversations, error detection, delays
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://127.0.0.1:3187";

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

async function createConversation(title, scope) {
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, scope }),
  });
  const data = await resp.json();
  return data.id;
}

async function sendMessage(conversationId, content, scope, context = {}) {
  const body = JSON.stringify({
    content, providerId: PROVIDER_ID, mode: "agent",
    scope: scope ?? { mode: "all_accounts", accountIds: ["test-account-001", "test-account-002"], messageIds: [] },
    context,
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

function toolsCalled(events) {
  return events.filter(e => e.type === "tool" && e.activity?.state === "running").map(e => e.activity.toolName);
}
function getText(events) {
  return events.filter(e => e.type === "text_delta").map(e => e.delta).join("");
}
function getErrors(events) {
  return events.filter(e => e.type === "error");
}
function getCitations(events) {
  return events.filter(e => e.type === "citation");
}
function isCompleted(events) {
  return events.some(e => e.type === "completed");
}

const ALL_SCOPE = { mode: "all_accounts", accountIds: ["test-account-001", "test-account-002"], messageIds: [] };
const ACCT1_SCOPE = { mode: "selected_account", accountIds: ["test-account-001"], messageIds: [] };
const ACCT2_SCOPE = { mode: "selected_account", accountIds: ["test-account-002"], messageIds: [] };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log("\n========== LLM Agent Integration Tests v2 ==========\n");

// Test 1: List messages
console.log("Test 1: List messages");
{
  const conv = await createConversation("T1-List", ALL_SCOPE);
  const result = await sendMessage(conv, "请列出我收件箱里的所有邮件。", ALL_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T1 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    assert(tools.some(t => t === "messages.list" || t === "rag.search"), "should call messages.list or rag.search");
    assert(text.length > 10, "should have response text");
  }
  await sleep(3000);
}

// Test 2: Read specific message
console.log("\nTest 2: Read specific message");
{
  const conv = await createConversation("T2-Read", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请读取主题包含\"项目周报\"的邮件内容。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T2 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(tools.length > 0, "should call at least one tool");
      assert(text.length > 10, "should have response text");
    }
  }
  await sleep(3000);
}

// Test 3: Get thread
console.log("\nTest 3: Get email thread");
{
  const conv = await createConversation("T3-Thread", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请找到\"项目周报\"相关的邮件线程，列出线程中所有邮件。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T3 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.length > 10, "should have response text");
    }
  }
  await sleep(3000);
}

// Test 4: List attachments
console.log("\nTest 4: List attachments");
{
  const conv = await createConversation("T4-Attach", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请列出\"代码审查反馈\"这封邮件的附件。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T4 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.length > 10, "should have response text");
    }
  }
  await sleep(3000);
}

// Test 5: List folders
console.log("\nTest 5: List folders");
{
  const conv = await createConversation("T5-Folders", ALL_SCOPE);
  const result = await sendMessage(conv, "请列出第一个账户的所有文件夹。", ALL_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T5 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(tools.some(t => t === "folders.list" || t === "accounts.list" || t === "rag.search"), "should call a relevant tool");
      assert(text.length > 10, "should have response text");
    }
  }
  await sleep(3000);
}

// Test 6: Sender filter (verify fix)
console.log("\nTest 6: Filter by sender (verify fix)");
{
  const conv = await createConversation("T6-Sender", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请列出所有来自 lisi@example.com 的邮件。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T6 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.includes("代码审查") || text.includes("lisi") || text.includes("李四"), "should mention lisi's message");
    }
  }
  await sleep(3000);
}

// Test 7: Empty mailbox
console.log("\nTest 7: Empty mailbox");
{
  const conv = await createConversation("T7-Empty", ACCT2_SCOPE);
  const result = await sendMessage(conv, "请列出这个账户的所有邮件。", ACCT2_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T7 request failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "duration:", result.duration + "ms", "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.includes("空") || text.includes("没有") || text.includes("无邮件") || text.includes("0"), "should indicate empty");
    }
  }
  await sleep(3000);
}

// Test 8: Multi-turn context
console.log("\nTest 8: Multi-turn context");
{
  const conv = await createConversation("T8-Multi", ACCT1_SCOPE);
  const r1 = await sendMessage(conv, "请列出收件箱里未读的邮件。", ACCT1_SCOPE);
  if (r1.error) { console.log("  ERROR t1:", r1.error); assert(false, "T8 turn 1 failed"); }
  else {
    console.log("  t1 tools:", toolsCalled(r1.events), "text:", getText(r1.events).slice(0, 100));
    const errors1 = getErrors(r1.events);
    if (errors1.length) console.log("  t1 errors:", errors1.map(e => e.error?.code));
    await sleep(3000);
    const r2 = await sendMessage(conv, "请读取第一封未读邮件的详细内容。", ACCT1_SCOPE);
    if (r2.error) { console.log("  ERROR t2:", r2.error); assert(false, "T8 turn 2 failed"); }
    else {
      console.log("  t2 tools:", toolsCalled(r2.events), "text:", getText(r2.events).slice(0, 100));
      const errors2 = getErrors(r2.events);
      if (errors2.length) console.log("  t2 errors:", errors2.map(e => e.error?.code));
      assert(isCompleted(r2.events), "turn 2 should complete");
    }
  }
  await sleep(3000);
}

// Test 9: Provider error handling (SSE returns 200 with error event)
console.log("\nTest 9: Provider error handling");
{
  const conv = await createConversation("T9-Error", ALL_SCOPE);
  const body = JSON.stringify({
    content: "测试", providerId: "invalid-provider-id", mode: "agent", scope: ALL_SCOPE, context: {},
  });
  const response = await fetch(`${BASE}/api/agent/conversations/${conv}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  // SSE returns 200 even for provider errors - the error is in the stream
  const text = await response.text();
  console.log("  HTTP status:", response.status);
  console.log("  response:", text.slice(0, 300));
  assert(response.status === 200, "SSE should return 200 (error is in stream)");
  assert(text.includes("error"), "response should contain error event");
  assert(text.includes("NOT_FOUND") || text.includes("not_found") || text.includes("不存在"), "should mention provider not found");
}

// Test 10: Conversation persistence (verify conversation still exists after messages)
console.log("\nTest 10: Conversation persistence");
{
  const conv = await createConversation("T10-Persist", ALL_SCOPE);
  const r1 = await sendMessage(conv, "请列出所有账户。", ALL_SCOPE);
  await sleep(2000);
  // Verify conversation still exists
  const getResp = await fetch(`${BASE}/api/agent/conversations/${conv}`);
  const data = await getResp.json();
  console.log("  conversation exists:", getResp.ok, "title:", data.title);
  assert(getResp.ok, "conversation should exist after message");
  assert(data.title === "T10-Persist", "title should match");
  // Verify conversation appears in list
  const listResp = await fetch(`${BASE}/api/agent/conversations`);
  const list = await listResp.json();
  const found = list.items.some(c => c.id === conv);
  console.log("  found in list:", found);
  assert(found, "conversation should appear in list");
}

// Test 11: RAG search
console.log("\nTest 11: RAG search");
{
  const conv = await createConversation("T11-RAG", ACCT1_SCOPE);
  const result = await sendMessage(conv, "服务器维护是什么时候？", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T11 failed"); }
  else {
    const citations = getCitations(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  citations:", citations.length, "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.includes("维护") || text.includes("8月") || text.includes("服务器"), "should mention maintenance");
    }
  }
  await sleep(3000);
}

// Test 12: Flagged messages
console.log("\nTest 12: Flagged messages");
{
  const conv = await createConversation("T12-Flagged", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请列出所有标星的邮件。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T12 failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.includes("周报") || text.includes("项目") || text.includes("张三"), "should mention flagged message");
    }
  }
  await sleep(3000);
}

// Test 13: Provider API
console.log("\nTest 13: Provider API");
{
  const listResp = await fetch(`${BASE}/api/agent/providers`);
  const providers = await listResp.json();
  assert(listResp.ok, "should list providers");
  assert(providers.items.length > 0, "should have providers");
  assert(providers.defaultProviderId === PROVIDER_ID, "should have correct default");
  console.log("  providers:", providers.items.map(p => `${p.label}(${p.model})`));
}

// Test 14: Unread filter
console.log("\nTest 14: Unread filter");
{
  const conv = await createConversation("T14-Unread", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请列出所有未读邮件。", ACCT1_SCOPE);
  if (result.error) { console.log("  ERROR:", result.error); assert(false, "T14 failed"); }
  else {
    const tools = toolsCalled(result.events);
    const text = getText(result.events);
    const errors = getErrors(result.events);
    console.log("  tools:", tools, "text len:", text.length);
    if (errors.length) console.log("  errors:", errors.map(e => e.error?.code));
    console.log("  preview:", text.slice(0, 200));
    assert(isCompleted(result.events), "should complete");
    if (errors.length === 0) {
      assert(text.includes("代码审查") || text.includes("服务器") || text.includes("维护") || text.includes("李四"), "should mention unread messages");
    }
  }
}

console.log("\n========== Summary ==========");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\n--- Failures ---");
  for (const f of failures) console.log(" -", f);
}
process.exit(failed > 0 ? 1 : 0);
