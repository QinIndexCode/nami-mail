import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentHostUpdateDrainLifecycle,
  agentHostServiceStartupFailureExitCode,
  formatAgentHostStartupFailure,
  resolveDesktopAgentLaunch,
  startupErrorForDesktopAgentLaunch,
  type AgentHostSnapshot,
  type AgentUpdateDrainController,
  type VerifiedAgentHost,
} from "../src/agent/desktop-host-integration.mts";
import {
  agentConfirmationIpcChannel,
  createAgentConfirmationIpcHandler,
  normalizeAgentConfirmationIpcRequest,
} from "../src/agent/confirmation-ipc.mts";
import {
  installTrustedDesktopAgentConfirmationClickHandler,
  normalizeDesktopAgentConfirmationRequest,
  trustedDesktopAgentConfirmationRequest,
} from "../src/preload.cts";

const activeSnapshot: AgentHostSnapshot = {
  state: "running",
  endpoint: {
    transport: "windows-named-pipe",
    path: "\\\\.\\pipe\\NamiMail.Agent.Host",
    ownerSid: "S-1-5-21-111111111-222222222-333333333-1001",
  },
  updateDrain: {
    state: "accepting",
    activeOperationCount: 0,
  },
};

function createController(events: string[], snapshot: AgentHostSnapshot = activeSnapshot): AgentUpdateDrainController {
  return {
    getSnapshot: () => snapshot,
    async prepareForUpdate() {
      events.push("prepare");
      return true;
    },
    completeUpdateHandoff() {
      events.push("handoff");
    },
    async recoverAfterInstallerFailure() {
      events.push("recover");
      return true;
    },
  };
}

test("Agent host launch accepts only one exact flag before the option separator", () => {
  assert.deepEqual(resolveDesktopAgentLaunch(["NamiMail.exe"]), { kind: "gui" });
  assert.deepEqual(resolveDesktopAgentLaunch(["NamiMail.exe", "--agent-host"]), { kind: "service" });
  assert.deepEqual(resolveDesktopAgentLaunch(["NamiMail.exe", "--", "--agent-host"]), { kind: "gui" });

  const duplicate = resolveDesktopAgentLaunch(["NamiMail.exe", "--agent-host", "--agent-host"]);
  assert.equal(duplicate.kind, "rejected");
  if (duplicate.kind === "rejected") assert.equal(duplicate.error.code, "INVALID_ARGUMENT");

  const assignedValue = resolveDesktopAgentLaunch(["NamiMail.exe", "--agent-host=1"]);
  assert.equal(assignedValue.kind, "rejected");
  if (assignedValue.kind === "rejected") assert.equal(assignedValue.error.code, "INVALID_ARGUMENT");
});

test("unavailable service mode reports a structured security failure before runtime startup", () => {
  const launch = resolveDesktopAgentLaunch(["NamiMail.exe", "--agent-host"]);
  assert.equal(launch.kind, "service");
  if (launch.kind === "gui") return;
  const error = startupErrorForDesktopAgentLaunch(launch);
  assert.equal(error.code, "BROKER_SECURITY_UNAVAILABLE");
  assert.equal(error.retryable, false);
  assert.equal(agentHostServiceStartupFailureExitCode, 1);
  assert.match(formatAgentHostStartupFailure(error), /BROKER_SECURITY_UNAVAILABLE/);
});

test("update drain ignores an absent external Broker", async () => {
  const lifecycle = new AgentHostUpdateDrainLifecycle(() => undefined);
  assert.equal(await lifecycle.prepareForUpdateInstall(), true);
  assert.equal(lifecycle.hasDrainedHost(), false);
  assert.equal(lifecycle.completeUpdateHandoff(), true);
  assert.equal(await lifecycle.recoverAfterInstallerFailure(), false);
});

test("update drain rejects a claimed host until both pipe shape and native SID-DACL proof pass", async () => {
  const events: string[] = [];
  const badSnapshot: AgentHostSnapshot = {
    ...activeSnapshot,
    endpoint: {
      ...activeSnapshot.endpoint!,
      path: "\\\\.\\pipe\\invalid pipe name",
    },
  };
  const invalidShape: VerifiedAgentHost = {
    controller: createController(events, badSnapshot),
    async verifyActiveSidDaclPipe() {
      events.push("verify");
      return true;
    },
  };
  assert.equal(await new AgentHostUpdateDrainLifecycle(() => invalidShape).prepareForUpdateInstall(), false);
  assert.deepEqual(events, []);

  const unverified: VerifiedAgentHost = {
    controller: createController(events),
    async verifyActiveSidDaclPipe() {
      events.push("verify");
      return false;
    },
  };
  assert.equal(await new AgentHostUpdateDrainLifecycle(() => unverified).prepareForUpdateInstall(), false);
  assert.deepEqual(events, ["verify"]);
});

test("verified Agent host drains, hands off, and recovers through the controller", async () => {
  const events: string[] = [];
  const host: VerifiedAgentHost = {
    controller: createController(events),
    async verifyActiveSidDaclPipe() {
      events.push("verify");
      return true;
    },
  };
  const lifecycle = new AgentHostUpdateDrainLifecycle(() => host);
  assert.equal(await lifecycle.prepareForUpdateInstall(), true);
  assert.equal(lifecycle.hasDrainedHost(), true);
  assert.equal(lifecycle.completeUpdateHandoff(), true);
  assert.deepEqual(events, ["verify", "prepare", "handoff"]);

  const recoveryLifecycle = new AgentHostUpdateDrainLifecycle(() => host);
  assert.equal(await recoveryLifecycle.prepareForUpdateInstall(), true);
  assert.equal(await recoveryLifecycle.recoverAfterInstallerFailure(), true);
  assert.deepEqual(events, ["verify", "prepare", "handoff", "verify", "prepare", "recover"]);
});

test("preload confirmation gate accepts only a trusted activation on the rendered confirmation card", () => {
  const confirmationId = "confirmation-7a338d89-7197-472f-95ee-d6db4c974b59";
  const card = {
    getAttribute: (name: string) => name === "data-nami-agent-confirmation-id" ? confirmationId : null,
    closest: () => undefined,
  };
  const button = {
    disabled: false,
    getAttribute: (name: string) => name === "data-nami-agent-confirmation-id"
      ? confirmationId
      : name === "data-nami-agent-confirmation-decision"
        ? "approve"
        : null,
    closest: (selector: string) => selector === "[data-nami-agent-confirmation-card]" ? card : undefined,
  };
  const child = {
    getAttribute: () => null,
    closest: (selector: string) => selector.startsWith("button[") ? button : undefined,
  };

  assert.deepEqual(normalizeDesktopAgentConfirmationRequest(confirmationId, "approve"), {
    confirmationId,
    decision: "approve",
  });
  assert.equal(normalizeDesktopAgentConfirmationRequest(` ${confirmationId}`, "approve"), undefined);
  assert.equal(normalizeDesktopAgentConfirmationRequest("confirmation/other", "approve"), undefined);
  assert.equal(normalizeDesktopAgentConfirmationRequest(confirmationId, "approved"), undefined);
  assert.equal(normalizeDesktopAgentConfirmationRequest(confirmationId, { decision: "approve" }), undefined);

  // detail=0 is the shape generated by keyboard activation. It remains valid
  // as long as Chromium marks the click as trusted.
  assert.deepEqual(trustedDesktopAgentConfirmationRequest({ isTrusted: true, detail: 0, target: child }), {
    confirmationId,
    decision: "approve",
  });
  assert.equal(trustedDesktopAgentConfirmationRequest({ isTrusted: false, target: child }), undefined);
  assert.equal(trustedDesktopAgentConfirmationRequest({ isTrusted: true, target: {
    ...child,
    closest: () => ({ ...button, disabled: true }),
  } }), undefined);
});

test("preload capture handler invokes once and publishes only the result", async () => {
  const confirmationId = "confirmation-7a338d89-7197-472f-95ee-d6db4c974b59";
  const card = {
    getAttribute: (name: string) => name === "data-nami-agent-confirmation-id" ? confirmationId : null,
    closest: () => undefined,
  };
  const button = {
    disabled: false,
    getAttribute: (name: string) => name === "data-nami-agent-confirmation-id"
      ? confirmationId
      : name === "data-nami-agent-confirmation-decision"
        ? "reject"
        : null,
    closest: (selector: string) => selector === "[data-nami-agent-confirmation-card]" ? card : undefined,
  };
  const target = {
    getAttribute: () => null,
    closest: (selector: string) => selector.startsWith("button[") ? button : undefined,
  };
  let clickListener: ((event: unknown) => void) | undefined;
  let removedListener: ((event: unknown) => void) | undefined;
  let capture = false;
  const documentTarget = {
    addEventListener: (_type: "click", listener: (event: unknown) => void, options?: { capture?: boolean }) => {
      clickListener = listener;
      capture = options?.capture === true;
    },
    removeEventListener: (_type: "click", listener: (event: unknown) => void) => {
      removedListener = listener;
    },
  };
  const calls: unknown[][] = [];
  const results: unknown[] = [];
  const detach = installTrustedDesktopAgentConfirmationClickHandler(
    documentTarget,
    async (channel, ...args) => {
      calls.push([channel, ...args]);
      return { ok: true };
    },
    (result) => results.push(result),
  );

  assert.equal(capture, true);
  clickListener?.({ isTrusted: false, target });
  clickListener?.({ isTrusted: true, detail: 0, target });
  clickListener?.({ isTrusted: true, detail: 0, target });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [[agentConfirmationIpcChannel, confirmationId, "reject"]]);
  assert.deepEqual(results, [{ confirmationId, decision: "reject", ok: true }]);
  detach();
  assert.equal(removedListener, clickListener);
});

test("desktop confirmation IPC rejects non-main and non-local renderers before forwarding a valid decision", async () => {
  const confirmationId = "confirmation-7a338d89-7197-472f-95ee-d6db4c974b59";
  const mainFrame = { url: "http://127.0.0.1:51999/?desktop=1" };
  const mainWindow = { webContents: { id: 42, mainFrame } };
  const resolved: Array<{ confirmationId: string; decision: string }> = [];
  const handler = createAgentConfirmationIpcHandler({
    getMainWindow: () => mainWindow,
    isLocalAppUrl: (url) => new URL(url).origin === "http://127.0.0.1:51999",
    resolve: async (id, decision) => {
      resolved.push({ confirmationId: id, decision });
      return { ok: true };
    },
  });

  assert.deepEqual(normalizeAgentConfirmationIpcRequest(confirmationId, "reject"), { confirmationId, decision: "reject" });
  assert.deepEqual(await handler({ sender: { id: 42 }, senderFrame: mainFrame }, confirmationId, "approve"), { ok: true });
  assert.deepEqual(resolved, [{ confirmationId, decision: "approve" }]);

  assert.equal(await handler({ sender: { id: 7 }, senderFrame: mainFrame }, confirmationId, "approve"), undefined);
  assert.equal(await handler({ sender: { id: 42 }, senderFrame: { url: mainFrame.url } }, confirmationId, "approve"), undefined);
  const remoteMainFrame = { url: "https://example.invalid/" };
  const remoteWindow = { webContents: { id: 42, mainFrame: remoteMainFrame } };
  const remoteHandler = createAgentConfirmationIpcHandler({
    getMainWindow: () => remoteWindow,
    isLocalAppUrl: (url) => new URL(url).origin === "http://127.0.0.1:51999",
    resolve: async (id, decision) => {
      resolved.push({ confirmationId: id, decision });
      return { ok: true };
    },
  });
  assert.equal(await remoteHandler({ sender: { id: 42 }, senderFrame: remoteMainFrame }, confirmationId, "approve"), undefined);
  assert.equal(await handler({ sender: { id: 42 }, senderFrame: mainFrame }, "invalid/id", "approve"), undefined);
  assert.deepEqual(resolved, [{ confirmationId, decision: "approve" }]);
});
