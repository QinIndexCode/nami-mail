import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAccessLevel, CallerContext } from "@nami/agent-contracts";
import { createPermissionEngine, type AgentToolDescriptor } from "../src/index.js";

function descriptor(overrides: Partial<AgentToolDescriptor>): AgentToolDescriptor {
  return {
    name: "tools.test",
    title: "Test tool",
    description: "A test tool.",
    category: "mail",
    executionMode: "read",
    requiredScopes: [],
    accountAccess: "none",
    confirmationPolicy: "never",
    confirmationAction: "test-action",
    availableToExternal: false,
    ...overrides,
  };
}

function desktopCaller(accessLevel: AgentAccessLevel, accountIds: readonly string[] = ["account_1"]): CallerContext {
  return {
    callerId: "desktop_1",
    kind: "desktop-ui" as const,
    entryPoint: "desktop" as const,
    accessLevel,
    scopes: ["read:messages", "write:drafts", "write:mail", "send:mail"] as const,
    accountScope: { mode: "selected" as const, accountIds },
    interactive: true,
    canRequestConfirmation: true,
  };
}

function externalCaller(accessLevel: AgentAccessLevel): CallerContext {
  return {
    callerId: "paired_1",
    kind: "cli" as const,
    entryPoint: "cli" as const,
    accessLevel,
    scopes: ["read:messages", "write:drafts", "write:mail", "send:mail"] as const,
    accountScope: { mode: "selected" as const, accountIds: ["account_1"] },
    interactive: true,
    canRequestConfirmation: true,
  };
}

test("read-only callers cannot create drafts or send mail", () => {
  const engine = createPermissionEngine();
  const caller = desktopCaller("read-only");

  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "read" }), accountIds: [] }).status, "allowed");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "draft", requiredScopes: ["write:drafts"] }), accountIds: [] }).status, "denied");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "write", requiredScopes: ["write:mail"] }), accountIds: [] }).status, "denied");
});

test("send-confirmed callers can run write tools but every one asks for confirmation", () => {
  const engine = createPermissionEngine();
  const caller = desktopCaller("send-confirmed");

  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "write", requiredScopes: ["write:mail"], confirmationPolicy: "required" }), accountIds: [] }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "draft", requiredScopes: ["write:drafts"], confirmationPolicy: "required" }), accountIds: [] }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "read" }), accountIds: [] }).status, "allowed");
});

test("full-access runs every operation, including high-risk sends, without prompting", () => {
  const engine = createPermissionEngine();
  const caller = desktopCaller("full-access");

  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "write", requiredScopes: ["write:mail"], confirmationPolicy: "required" }), accountIds: [] }).status, "allowed");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "draft", requiredScopes: ["write:drafts"], confirmationPolicy: "required" }), accountIds: [] }).status, "allowed");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "high-risk", requiredScopes: ["send:mail"], confirmationPolicy: "required", confirmationAction: "send-mail" }), accountIds: [] }).status, "allowed");
});

function fullCaller(accessLevel: AgentAccessLevel, accountIds: readonly string[] = ["account_1"]): CallerContext {
  return { ...desktopCaller(accessLevel, accountIds), scopes: ["manage:accounts"] as const };
}

test("full-access still confirms irreversible operations, at every access level", () => {
  const engine = createPermissionEngine();
  const irreversible = descriptor({
    executionMode: "high-risk",
    requiredScopes: ["manage:accounts"],
    accountAccess: "required",
    confirmationPolicy: "required",
    confirmationAction: "delete-account",
    irreversible: true,
  });
  const accountIds = ["account_1"];

  assert.equal(engine.evaluate({ caller: fullCaller("full-access"), tool: irreversible, accountIds }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller: fullCaller("send-confirmed"), tool: irreversible, accountIds }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller: fullCaller("read-only"), tool: irreversible, accountIds }).status, "denied");
});

test("a non-interactive full-access caller cannot run irreversible operations either", () => {
  const engine = createPermissionEngine();
  const irreversible = descriptor({
    executionMode: "high-risk",
    requiredScopes: ["manage:accounts"],
    accountAccess: "required",
    confirmationPolicy: "required",
    confirmationAction: "delete-account",
    irreversible: true,
  });
  const caller: CallerContext = { ...fullCaller("full-access"), interactive: false, canRequestConfirmation: false };

  assert.equal(engine.evaluate({ caller, tool: irreversible, accountIds: ["account_1"] }).status, "denied");
});

test("sending mail confirms under send-confirmed and is automatic under full-access", () => {
  const engine = createPermissionEngine();
  const send = descriptor({ executionMode: "high-risk", requiredScopes: ["send:mail"], confirmationPolicy: "required", confirmationAction: "send-mail" });

  assert.equal(engine.evaluate({ caller: desktopCaller("send-confirmed"), tool: send, accountIds: ["account_1"] }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller: desktopCaller("full-access"), tool: send, accountIds: ["account_1"] }).status, "allowed");
  assert.equal(engine.evaluate({ caller: desktopCaller("read-only"), tool: send, accountIds: ["account_1"] }).status, "denied");
});

test("external callers stay read-only unless the host raises their level", () => {
  const engine = createPermissionEngine();
  const read = descriptor({ executionMode: "read", availableToExternal: true });
  const write = descriptor({ executionMode: "write", requiredScopes: ["write:mail"], confirmationPolicy: "required", availableToExternal: true });
  const closed = descriptor({ executionMode: "write", requiredScopes: ["write:mail"], availableToExternal: false });

  assert.equal(engine.evaluate({ caller: externalCaller("read-only"), tool: read, accountIds: ["account_1"] }).status, "allowed");
  assert.equal(engine.evaluate({ caller: externalCaller("read-only"), tool: write, accountIds: ["account_1"] }).status, "denied");
  assert.equal(engine.evaluate({ caller: externalCaller("send-confirmed"), tool: write, accountIds: ["account_1"] }).status, "confirmation_required");
  assert.equal(engine.evaluate({ caller: externalCaller("full-access"), tool: write, accountIds: ["account_1"] }).status, "allowed");
  assert.equal(engine.evaluate({ caller: externalCaller("send-confirmed"), tool: closed, accountIds: ["account_1"] }).status, "denied");
});

test("a non-interactive external caller cannot request a desktop confirmation", () => {
  const engine = createPermissionEngine();
  const write = descriptor({ executionMode: "write", requiredScopes: ["write:mail"], confirmationPolicy: "required", availableToExternal: true });
  const caller: CallerContext = { ...externalCaller("send-confirmed"), interactive: false, canRequestConfirmation: false };

  assert.equal(engine.evaluate({ caller, tool: write, accountIds: ["account_1"] }).status, "denied");
});

test("account scope is enforced for every access level", () => {
  const engine = createPermissionEngine();
  const caller = desktopCaller("full-access", ["account_1"]);

  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "read" }), accountIds: ["account_2"] }).status, "denied");
  assert.equal(engine.evaluate({ caller, tool: descriptor({ executionMode: "read" }), accountIds: [] }).status, "allowed");
});
