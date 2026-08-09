import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createPermissionEngine, createAgentRuntime, createToolRegistry, type AgentTool } from "../src/index.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const caller = {
  callerId: "desktop_1",
  kind: "desktop-ui" as const,
  entryPoint: "desktop" as const,
  accessLevel: "send-confirmed" as const,
  scopes: ["read:messages", "send:mail"] as const,
  accountScope: { mode: "selected" as const, accountIds: ["account_1"] },
  interactive: true,
  canRequestConfirmation: true,
};

function call(toolName: string, input: unknown) {
  return { id: "call_1", toolName, input, requestedAt: timestamp };
}

test("registry validates tool input before invoking an implementation", () => {
  let executions = 0;
  const tool: AgentTool<{ accountId: string; query: string }, { count: number }> = {
    descriptor: {
      name: "mail.messages.search",
      title: "Search messages",
      description: "Searches cached mail metadata.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "required",
      confirmationPolicy: "never",
      availableToExternal: true,
    },
    inputSchema: z.object({ accountId: z.string().min(1), query: z.string().min(1) }).strict(),
    outputSchema: z.object({ count: z.number().int().nonnegative() }).strict(),
    resolveAccountIds: (input) => [input.accountId],
    execute: async () => {
      executions += 1;
      return { ok: true, value: { count: 1 } };
    },
  };
  const registry = createToolRegistry([tool]);
  const resolution = registry.resolve(call("mail.messages.search", { accountId: "account_1" }));

  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.equal(resolution.error.code, "TOOL_INPUT_INVALID");
  assert.equal(executions, 0);
});

test("high-risk tools wait for an immutable desktop confirmation and audit intent", async () => {
  let executions = 0;
  const audits: string[] = [];
  const tool: AgentTool<{ accountId: string }, { delivered: boolean }> = {
    descriptor: {
      name: "mail.send",
      title: "Send mail",
      description: "Sends the prepared mail through the selected account.",
      category: "mail",
      executionMode: "high-risk",
      requiredScopes: ["send:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "send-mail",
      availableToExternal: false,
    },
    inputSchema: z.object({ accountId: z.string().min(1) }).strict(),
    outputSchema: z.object({ delivered: z.boolean() }).strict(),
    resolveAccountIds: (input) => [input.accountId],
    confirmationPreview: () => ({ title: "Send mail", summary: "One recipient will receive this message." }),
    execute: async () => {
      executions += 1;
      return { ok: true, value: { delivered: true } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
    payloadHasher: { digest: async () => "a".repeat(64) },
    ids: { nextAuditEventId: () => "audit_1", nextConfirmationId: () => "confirm_1" },
    confirmations: {
      create: async (request) => request,
      consumeApproval: async () => ({ approved: true }),
    },
    audit: { append: async (event) => { audits.push(event.outcome); } },
  });

  const pending = await runtime.invokeTool({ requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9", caller, call: call("mail.send", { accountId: "account_1" }) });
  assert.equal(pending.status, "confirmation_required");
  assert.equal(executions, 0);

  const completed = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.send", { accountId: "account_1" }),
    confirmationId: "confirm_1",
  });
  assert.equal(completed.status, "completed");
  assert.equal(executions, 1);
  assert.deepEqual(audits, ["intent", "succeeded"]);
});

test("full-access executes high-risk sends immediately without any confirmation", async () => {
  let executions = 0;
  let confirmationRequests = 0;
  const tool: AgentTool<{ accountId: string }, { delivered: boolean }> = {
    descriptor: {
      name: "mail.send",
      title: "Send mail",
      description: "Sends the prepared mail through the selected account.",
      category: "mail",
      executionMode: "high-risk",
      requiredScopes: ["send:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "send-mail",
      availableToExternal: true,
    },
    inputSchema: z.object({ accountId: z.string().min(1) }).strict(),
    outputSchema: z.object({ delivered: z.boolean() }).strict(),
    resolveAccountIds: (input) => [input.accountId],
    execute: async () => {
      executions += 1;
      return { ok: true, value: { delivered: true } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
    payloadHasher: { digest: async () => "a".repeat(64) },
    ids: { nextAuditEventId: () => "audit_1", nextConfirmationId: () => "confirm_1" },
    confirmations: {
      create: async (request) => {
        confirmationRequests += 1;
        return request;
      },
      consumeApproval: async () => ({ approved: true }),
    },
    audit: { append: async () => undefined },
  });
  const autoCaller = { ...caller, accessLevel: "full-access" as const };

  const result = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller: autoCaller,
    call: call("mail.send", { accountId: "account_1" }),
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.result.status, "succeeded");
  assert.equal(executions, 1);
  assert.equal(confirmationRequests, 0);
});

test("cancelled high-risk invocations never create confirmations or execute tools", async () => {
  let executions = 0;
  let confirmationRequests = 0;
  const tool: AgentTool<{ accountId: string }, { delivered: boolean }> = {
    descriptor: {
      name: "mail.send",
      title: "Send mail",
      description: "Sends the prepared mail through the selected account.",
      category: "mail",
      executionMode: "high-risk",
      requiredScopes: ["send:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "send-mail",
      availableToExternal: false,
    },
    inputSchema: z.object({ accountId: z.string().min(1) }).strict(),
    outputSchema: z.object({ delivered: z.boolean() }).strict(),
    resolveAccountIds: (input) => [input.accountId],
    execute: async () => {
      executions += 1;
      return { ok: true, value: { delivered: true } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
    payloadHasher: { digest: async () => "a".repeat(64) },
    ids: { nextAuditEventId: () => "audit_1", nextConfirmationId: () => "confirm_1" },
    confirmations: {
      create: async (request) => {
        confirmationRequests += 1;
        return request;
      },
      consumeApproval: async () => ({ approved: true }),
    },
  });
  const controller = new AbortController();
  controller.abort();

  const result = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.send", { accountId: "account_1" }),
    signal: controller.signal,
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.result.status, "cancelled");
  assert.equal(confirmationRequests, 0);
  assert.equal(executions, 0);
});

test("aborting while an approval is resolving never executes the confirmed tool", async () => {
  let executions = 0;
  const controller = new AbortController();
  const tool: AgentTool<{ accountId: string }, { delivered: boolean }> = {
    descriptor: {
      name: "mail.send",
      title: "Send mail",
      description: "Sends the prepared mail through the selected account.",
      category: "mail",
      executionMode: "high-risk",
      requiredScopes: ["send:mail"],
      accountAccess: "required",
      confirmationPolicy: "required",
      confirmationAction: "send-mail",
      availableToExternal: false,
    },
    inputSchema: z.object({ accountId: z.string().min(1) }).strict(),
    outputSchema: z.object({ delivered: z.boolean() }).strict(),
    resolveAccountIds: (input) => [input.accountId],
    execute: async () => {
      executions += 1;
      return { ok: true, value: { delivered: true } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
    payloadHasher: { digest: async () => "a".repeat(64) },
    ids: { nextAuditEventId: () => "audit_1", nextConfirmationId: () => "confirm_1" },
    confirmations: {
      create: async (request) => request,
      consumeApproval: async () => {
        controller.abort();
        return { approved: true };
      },
    },
    audit: { append: async () => undefined },
  });

  const result = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.send", { accountId: "account_1" }),
    confirmationId: "confirm_1",
    signal: controller.signal,
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.result.status, "cancelled");
  assert.equal(executions, 0);
});

test("a host-controlled execution scope powers account-implicit tools without widening caller access", async () => {
  let observedAccountIds: readonly string[] = [];
  let observedMessageIds: readonly string[] | undefined;
  const tool: AgentTool<Record<string, never>, { accounts: string[] }> = {
    descriptor: {
      name: "mail.accounts.list",
      title: "List accounts",
      description: "Lists only accounts in the active conversation scope.",
      category: "accounts",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ accounts: z.array(z.string()) }).strict(),
    execute: async (context) => {
      observedAccountIds = context.accountIds;
      observedMessageIds = context.allowedMessageIds;
      return { ok: true, value: { accounts: [...context.accountIds] } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
  });

  const completed = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.accounts.list", {}),
    executionAccountIds: ["account_1"],
    allowedMessageIds: ["message_1"],
  });

  assert.equal(completed.status, "completed");
  assert.deepEqual(observedAccountIds, ["account_1"]);
  assert.deepEqual(observedMessageIds, ["message_1"]);

  const accountScoped = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.accounts.list", {}),
    executionAccountIds: ["account_1"],
  });
  assert.equal(accountScoped.status, "completed");
  assert.equal(observedMessageIds, undefined);

  const denied = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.accounts.list", {}),
    executionAccountIds: ["account_2"],
  });
  assert.equal(denied.status, "completed");
  if (denied.status === "completed") assert.equal(denied.result.status, "denied");
  assert.deepEqual(observedAccountIds, ["account_1"]);
});

test("tool descriptor deadlines abort work and return a retryable timeout", async () => {
  let abortObserved = false;
  const tool: AgentTool<Record<string, never>, { count: number }> = {
    descriptor: {
      name: "mail.messages.timeout",
      title: "Timeout test",
      description: "Exercises the runtime tool deadline.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 1_000,
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ count: z.number().int().nonnegative() }).strict(),
    execute: async (context) => {
      await new Promise<void>((resolve) => {
        context.signal?.addEventListener("abort", () => {
          abortObserved = true;
          resolve();
        }, { once: true });
      });
      return { ok: true, value: { count: 1 } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
  });

  const result = await runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.messages.timeout", {}),
    executionAccountIds: ["account_1"],
  });

  assert.equal(abortObserved, true);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.error.code, "TOOL_TIMEOUT");
    assert.equal(result.result.error.retryable, true);
  }
});

test("caller cancellation aborts a deadline-bound tool without reporting a timeout", async () => {
  let abortObserved = false;
  const controller = new AbortController();
  const tool: AgentTool<Record<string, never>, { count: number }> = {
    descriptor: {
      name: "mail.messages.cancellation",
      title: "Cancellation test",
      description: "Exercises caller cancellation during tool execution.",
      category: "messages",
      executionMode: "read",
      requiredScopes: ["read:messages"],
      accountAccess: "optional",
      confirmationPolicy: "never",
      availableToExternal: true,
      timeoutMs: 10_000,
    },
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ count: z.number().int().nonnegative() }).strict(),
    execute: async (context) => {
      await new Promise<void>((resolve) => {
        context.signal?.addEventListener("abort", () => {
          abortObserved = true;
          resolve();
        }, { once: true });
      });
      return { ok: true, value: { count: 1 } };
    },
  };
  const runtime = createAgentRuntime({
    tools: createToolRegistry([tool]),
    permissions: createPermissionEngine(),
  });
  const invocation = runtime.invokeTool({
    requestId: "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9",
    caller,
    call: call("mail.messages.cancellation", {}),
    executionAccountIds: ["account_1"],
    signal: controller.signal,
  });
  controller.abort();

  const result = await invocation;
  assert.equal(abortObserved, true);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.result.status, "cancelled");
    assert.equal(result.result.error.code, "CANCELLED");
  }
});
