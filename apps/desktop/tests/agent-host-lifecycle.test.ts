import assert from "node:assert/strict";
import test from "node:test";
import { AgentHostController, type AgentHostRuntimeAdapter } from "../src/agent/host-controller.mts";
import {
  AgentHostLease,
  type DaclCapableNamedPipeAdapter,
  type HostLeaseRequest,
} from "../src/agent/host-lease.mts";
import { asAgentDesktopError } from "../src/agent/contracts.mts";
import { UpdateDrainGate } from "../src/agent/update-drain-gate.mts";

const leaseRequest: HostLeaseRequest = {
  pipeName: "NamiMail.Agent.Host",
  ownerSid: "S-1-5-21-111111111-222222222-333333333-1001",
  hostId: "host-identity-0001",
  bootId: "boot-identity-0001",
};

function createPipeAdapter(events: string[], options: { releaseFails?: boolean } = {}): DaclCapableNamedPipeAdapter {
  return {
    transport: "windows-named-pipe",
    accessControl: "sid-dacl",
    async acquireExclusive(request) {
      events.push("lease:acquire");
      return {
        endpoint: {
          transport: "windows-named-pipe",
          path: `\\\\.\\pipe\\${request.pipeName}`,
          ownerSid: request.ownerSid,
        },
        async release() {
          events.push("lease:release");
          if (options.releaseFails) throw new Error("lease release failed");
        },
      };
    },
  };
}

test("HostLease fails closed without a SID-DACL named-pipe adapter", async () => {
  const lease = new AgentHostLease();
  await assert.rejects(
    lease.acquire(leaseRequest),
    (error) => asAgentDesktopError(error)?.code === "BROKER_SECURITY_UNAVAILABLE",
  );
  assert.equal(lease.getSnapshot().state, "idle");
});

test("HostLease binds only the requested Windows pipe and releases exactly once", async () => {
  const events: string[] = [];
  const lease = new AgentHostLease(createPipeAdapter(events));
  const endpoint = await lease.acquire(leaseRequest);
  assert.deepEqual(endpoint, {
    transport: "windows-named-pipe",
    path: "\\\\.\\pipe\\NamiMail.Agent.Host",
    ownerSid: leaseRequest.ownerSid,
  });
  assert.equal(lease.requireActiveEndpoint().path, endpoint.path);
  await Promise.all([lease.release(), lease.release()]);
  assert.deepEqual(events, ["lease:acquire", "lease:release"]);
  assert.equal(lease.getSnapshot().state, "released");
  await assert.rejects(
    lease.acquire(leaseRequest),
    (error) => asAgentDesktopError(error)?.code === "HOST_LEASE_UNAVAILABLE",
  );
});

test("UpdateDrainGate blocks new work, waits for active work, and drains in order", async () => {
  const events: string[] = [];
  const gate = new UpdateDrainGate({
    async stopBrokerIngress() { events.push("ingress:stop"); },
    async quiesceRuntime() { events.push("runtime:quiesce"); return true; },
    async releaseHostLease() { events.push("lease:release"); return true; },
    async recoverAfterFailedUpdate() { events.push("runtime:recover"); },
  });
  const active = gate.enter("broker-read");
  const draining = gate.prepareForUpdate();
  await Promise.resolve();
  assert.equal(gate.getSnapshot().state, "draining");
  assert.throws(
    () => gate.enter("second-read"),
    (error) => asAgentDesktopError(error)?.code === "UPDATE_IN_PROGRESS",
  );
  assert.deepEqual(events, ["ingress:stop"]);
  active.release();
  assert.equal(await draining, true);
  assert.deepEqual(events, ["ingress:stop", "runtime:quiesce", "lease:release"]);
  assert.equal(gate.getSnapshot().state, "drained");
});

test("UpdateDrainGate recovers explicitly when a handoff cannot release its lease", async () => {
  const events: string[] = [];
  const gate = new UpdateDrainGate({
    async stopBrokerIngress() { events.push("ingress:stop"); },
    async quiesceRuntime() { events.push("runtime:quiesce"); return true; },
    async releaseHostLease() { events.push("lease:release"); return false; },
    async recoverAfterFailedUpdate() { events.push("runtime:recover"); },
  });
  assert.equal(await gate.prepareForUpdate(), false);
  assert.deepEqual(events, ["ingress:stop", "runtime:quiesce", "lease:release", "runtime:recover"]);
  assert.equal(gate.getSnapshot().state, "accepting");
});

test("AgentHostController starts one host, activates the GUI, and delegates update recovery", async () => {
  const events: string[] = [];
  const runtime: AgentHostRuntimeAdapter = {
    async start(input) { events.push(`runtime:start:${input.mode}`); },
    async abortStartup() { events.push("runtime:abort"); },
    async stopBrokerIngress() { events.push("ingress:stop"); },
    async quiesceRuntime() { events.push("runtime:quiesce"); return true; },
    async recoverAfterFailedUpdate(input) { events.push(`runtime:recover:${input.mode}`); },
  };
  const controller = new AgentHostController({
    createLease: () => new AgentHostLease(createPipeAdapter(events)),
    leaseRequest,
    runtime,
    gui: { async activate() { events.push("gui:activate"); } },
  });

  await controller.startService();
  await controller.startGui();
  assert.deepEqual(events.slice(0, 3), ["lease:acquire", "runtime:start:service", "gui:activate"]);
  assert.equal(controller.getSnapshot().state, "running");
  assert.equal(controller.getSnapshot().mode, "service");

  assert.equal(await controller.prepareForUpdate(), true);
  assert.deepEqual(events.slice(-3), ["ingress:stop", "runtime:quiesce", "lease:release"]);
  assert.equal(controller.getSnapshot().state, "stopped");
});

test("AgentHostController reopens the secured host after a failed installer handoff", async () => {
  const events: string[] = [];
  const runtime: AgentHostRuntimeAdapter = {
    async start(input) { events.push(`runtime:start:${input.mode}`); },
    async abortStartup() { events.push("runtime:abort"); },
    async stopBrokerIngress() { events.push("ingress:stop"); },
    async quiesceRuntime() { events.push("runtime:quiesce"); return true; },
    async recoverAfterFailedUpdate(input) { events.push(`runtime:recover:${input.mode}`); },
  };
  const controller = new AgentHostController({
    createLease: () => new AgentHostLease(createPipeAdapter(events)),
    leaseRequest,
    runtime,
    gui: { async activate() { events.push("gui:activate"); } },
  });
  await controller.startService();
  assert.equal(await controller.prepareForUpdate(), true);
  assert.equal(await controller.recoverAfterInstallerFailure(), true);
  assert.equal(controller.getSnapshot().state, "running");
  assert.deepEqual(events.slice(-2), ["lease:acquire", "runtime:recover:service"]);
});
