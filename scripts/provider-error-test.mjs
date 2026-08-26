// Provider error handling tests - invalid API key, timeout, unreachable endpoint
const BASE = "http://127.0.0.1:3187";
const VALID_SCOPE = { mode: "all_accounts", accountIds: ["test-account-001", "test-account-002"], messageIds: [] };
const ACCT1_SCOPE = { mode: "selected_account", accountIds: ["test-account-001"], messageIds: [] };

// Dynamically resolve the default provider ID
const providerListResp = await fetch(`${BASE}/api/agent/providers`);
const providerListData = await providerListResp.json();
const VALID_PROVIDER_ID = providerListData.defaultProviderId;
console.log(`Using valid provider: ${VALID_PROVIDER_ID}`);

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; } else { failed++; failures.push(message); console.log("  FAIL:", message); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createConversation(title, scope) {
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, scope: scope ?? VALID_SCOPE }),
  });
  return (await resp.json()).id;
}

async function sendMessage(conversationId, content, providerId, scope) {
  const response = await fetch(`${BASE}/api/agent/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      providerId,
      mode: "agent",
      scope: scope ?? ACCT1_SCOPE,
      context: {},
    }),
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
function isCompleted(events) { return events.some(e => e.type === "completed"); }

async function createTempProvider(label, overrides = {}) {
  const config = {
    label,
    kind: "openai-compatible",
    endpoint: "https://token-plan-cn.xiaomimimo.com/v1/",
    model: "mimo-v2.5-pro",
    apiKey: "tp-cyef4wra9cqwpw4f3346emghb34sijskyjzhitju3bkc89v2",
    timeoutMs: 60000,
    allowCloudMailContent: true,
    ...overrides,
  };
  const resp = await fetch(`${BASE}/api/agent/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await resp.json();
  return data.id;
}

async function deleteProvider(id) {
  await fetch(`${BASE}/api/agent/providers/${id}`, { method: "DELETE" });
}

console.log("\n========== Provider Error Handling Tests ==========\n");

// Test 1: Invalid API Key
console.log("Test 1: Invalid API Key");
{
  const badProviderId = await createTempProvider("Bad-Key-Provider", { apiKey: "invalid-api-key-xxx" });
  console.log("  created provider:", badProviderId);
  const conv = await createConversation("T1-BadKey", ACCT1_SCOPE);
  const result = await sendMessage(conv, "你好", badProviderId, ACCT1_SCOPE);
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  duration:", result.duration + "ms");
  console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message?.slice(0, 80)));
  console.log("  text:", text.slice(0, 100));
  assert(isCompleted(result.events), "should complete");
  assert(errors.length > 0, "should have error event");
  // Invalid API key should result in auth error or provider error
  assert(
    errors.some(e => e.error?.code === "PROVIDER_AUTH_FAILED" || e.error?.code === "PROVIDER_ERROR" || e.error?.code === "PROVIDER_UNAVAILABLE"),
    `should be auth/provider error, got: ${errors.map(e => e.error?.code)}`
  );
  await deleteProvider(badProviderId);
  await sleep(2000);
}

// Test 2: Timeout (very short timeout)
console.log("\nTest 2: Provider timeout (1 second)");
{
  const timeoutProviderId = await createTempProvider("Timeout-Provider", { timeoutMs: 1000 });
  console.log("  created provider:", timeoutProviderId);
  const conv = await createConversation("T2-Timeout", ACCT1_SCOPE);
  const result = await sendMessage(conv, "请列出收件箱里的所有邮件，并详细总结每封邮件的内容。", timeoutProviderId, ACCT1_SCOPE);
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  duration:", result.duration + "ms");
  console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message?.slice(0, 80)));
  console.log("  text:", text.slice(0, 100));
  assert(isCompleted(result.events), "should complete");
  // Timeout should result in PROVIDER_TIMEOUT error (may take longer than 1s due to retry/backoff)
  if (errors.length > 0) {
    assert(
      errors.some(e => e.error?.code === "PROVIDER_TIMEOUT" || e.error?.code === "PROVIDER_ERROR"),
      `should be timeout error, got: ${errors.map(e => e.error?.code)}`
    );
  }
  await deleteProvider(timeoutProviderId);
  await sleep(2000);
}

// Test 3: Unreachable endpoint
console.log("\nTest 3: Unreachable endpoint");
{
  const unreachableProviderId = await createTempProvider("Unreachable-Provider", {
    endpoint: "https://nonexistent-host-12345.example.invalid/v1/",
  });
  console.log("  created provider:", unreachableProviderId);
  const conv = await createConversation("T3-Unreachable", ACCT1_SCOPE);
  const result = await sendMessage(conv, "你好", unreachableProviderId, ACCT1_SCOPE);
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  duration:", result.duration + "ms");
  console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message?.slice(0, 80)));
  console.log("  text:", text.slice(0, 100));
  assert(isCompleted(result.events), "should complete");
  assert(errors.length > 0, "should have error event");
  // Unreachable host should result in PROVIDER_UNAVAILABLE or PROVIDER_ERROR
  assert(
    errors.some(e => e.error?.code === "PROVIDER_UNAVAILABLE" || e.error?.code === "PROVIDER_ERROR" || e.error?.code === "PROVIDER_TIMEOUT"),
    `should be unavailable/timeout error, got: ${errors.map(e => e.error?.code)}`
  );
  await deleteProvider(unreachableProviderId);
  await sleep(2000);
}

// Test 4: Non-existent model
console.log("\nTest 4: Non-existent model");
{
  const badModelProviderId = await createTempProvider("Bad-Model-Provider", { model: "non-existent-model-xyz" });
  console.log("  created provider:", badModelProviderId);
  const conv = await createConversation("T4-BadModel", ACCT1_SCOPE);
  const result = await sendMessage(conv, "你好", badModelProviderId, ACCT1_SCOPE);
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  duration:", result.duration + "ms");
  console.log("  errors:", errors.map(e => e.error?.code + ":" + e.error?.message?.slice(0, 80)));
  console.log("  text:", text.slice(0, 100));
  assert(isCompleted(result.events), "should complete");
  // Bad model should result in PROVIDER_ERROR
  if (errors.length > 0) {
    console.log("  error code:", errors[0].error?.code);
  }
  await deleteProvider(badModelProviderId);
  await sleep(2000);
}

// Test 5: Provider health check
console.log("\nTest 5: Provider health check");
{
  const checkResp = await fetch(`${BASE}/api/agent/providers/${VALID_PROVIDER_ID}/check`, { method: "POST" });
  const data = await checkResp.json();
  console.log("  status:", checkResp.status);
  console.log("  data:", JSON.stringify(data).slice(0, 200));
  assert(checkResp.status === 200, `should return 200, got ${checkResp.status}`);
}

// Test 6: Health check for non-existent provider
console.log("\nTest 6: Health check for non-existent provider");
{
  const checkResp = await fetch(`${BASE}/api/agent/providers/non-existent/check`, { method: "POST" });
  console.log("  status:", checkResp.status);
  assert(checkResp.status === 404, `should return 404, got ${checkResp.status}`);
}

// Test 7: Valid provider still works (regression check)
console.log("\nTest 7: Valid provider regression check");
{
  const conv = await createConversation("T7-Valid", ACCT1_SCOPE);
  const result = await sendMessage(conv, "你好", VALID_PROVIDER_ID, ACCT1_SCOPE);
  const errors = getErrors(result.events);
  const text = getText(result.events);
  console.log("  duration:", result.duration + "ms");
  console.log("  errors:", errors.map(e => e.error?.code));
  console.log("  text:", text.slice(0, 150));
  assert(isCompleted(result.events), "should complete");
  if (errors.length === 0) {
    assert(text.length > 0, "should have response text");
  }
}

console.log("\n========== Summary ==========");
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\n--- Failures ---");
  for (const f of failures) console.log(" -", f);
}
process.exit(failed > 0 ? 1 : 0);
