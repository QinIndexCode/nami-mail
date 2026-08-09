// Debug tool call tracing - records every tool call's input and output
const BASE = "http://127.0.0.1:3187";
const ACCT1_SCOPE = { mode: "selected_account", accountIds: ["test-account-001"], messageIds: [] };

// Dynamically resolve provider
const providerResp = await fetch(`${BASE}/api/agent/providers`);
const providerData = await providerResp.json();
const PROVIDER_ID = providerData.defaultProviderId;
console.log(`Provider: ${PROVIDER_ID}`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createConversation(title, scope) {
  const resp = await fetch(`${BASE}/api/agent/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, scope }),
  });
  return (await resp.json()).id;
}

async function sendMessageWithTrace(conversationId, content, scope) {
  const response = await fetch(`${BASE}/api/agent/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content, providerId: PROVIDER_ID, mode: "agent", scope, context: {},
    }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const toolTraces = []; // {toolName, state, summary, error}
  let currentTool = null;
  const startTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          events.push(event);

          if (event.type === "tool") {
            if (event.activity.state === "running") {
              currentTool = { toolName: event.activity.toolName, startTime: Date.now() };
              console.log(`\n  [TOOL START] ${event.activity.toolName}`);
            } else if (event.activity.state === "completed") {
              if (currentTool) {
                currentTool.duration = Date.now() - currentTool.startTime;
                currentTool.summary = event.activity.summary;
                toolTraces.push(currentTool);
                console.log(`  [TOOL DONE]  ${currentTool.toolName} (${currentTool.duration}ms) - ${event.activity.summary}`);
                currentTool = null;
              }
            } else if (event.activity.state === "failed") {
              if (currentTool) {
                currentTool.duration = Date.now() - currentTool.startTime;
                currentTool.error = event.activity.error;
                toolTraces.push(currentTool);
                console.log(`  [TOOL FAIL]  ${currentTool.toolName} (${currentTool.duration}ms) - ${event.activity.error?.message}`);
                currentTool = null;
              }
            }
          }

          if (event.type === "text_delta") {
            process.stdout.write(event.delta);
          }

          if (event.type === "error") {
            console.log(`\n  [ERROR] ${event.error?.code}: ${event.error?.message}`);
          }

          if (event.type === "completed") {
            console.log(`\n  [COMPLETED] reason: ${event.reason}`);
          }
        } catch { /* skip */ }
      }
    }
  }

  return { events, toolTraces, duration: Date.now() - startTime };
}

console.log("\n========== Tool Call Debug Tracing ==========\n");

// Test A: Simple "list unread emails" - should be 1 tool call
console.log("--- Test A: 请列出收件箱里未读的邮件 ---");
{
  const conv = await createConversation("Debug-A", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, "请列出收件箱里未读的邮件。", ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

await sleep(3000);

// Test B: Simple "list all emails" - should be 1 tool call
console.log("\n--- Test B: 请列出所有邮件 ---");
{
  const conv = await createConversation("Debug-B", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, "请列出所有邮件。", ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

await sleep(3000);

// Test C: "read first email" - should be 2 tool calls (list + get)
console.log("\n--- Test C: 请读取第一封邮件的详细内容 ---");
{
  const conv = await createConversation("Debug-C", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, "请读取第一封邮件的详细内容。", ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

await sleep(3000);

// Test D: "show thread" - should be list + threads.get
console.log("\n--- Test D: 请显示项目周报的邮件线程 ---");
{
  const conv = await createConversation("Debug-D", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, '请显示"项目周报"相关的邮件线程。', ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

await sleep(3000);

// Test E: "list flagged emails" - should be 1 tool call
console.log("\n--- Test E: 请列出所有标星的邮件 ---");
{
  const conv = await createConversation("Debug-E", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, "请列出所有标星的邮件。", ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

await sleep(3000);

// Test F: "list attachments for first email" - should be list + attachments.list
console.log("\n--- Test F: 请列出第一封邮件的附件 ---");
{
  const conv = await createConversation("Debug-F", ACCT1_SCOPE);
  const result = await sendMessageWithTrace(conv, "请列出第一封邮件的附件。", ACCT1_SCOPE);
  console.log(`\n  Total tools: ${result.toolTraces.length}, Duration: ${result.duration}ms`);
  console.log("  Tool sequence:", result.toolTraces.map(t => `${t.toolName}(${t.duration}ms)`));
}

console.log("\n========== Debug Complete ==========");
