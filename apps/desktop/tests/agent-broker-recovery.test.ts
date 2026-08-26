import assert from "node:assert/strict";
import test from "node:test";
import {
  BrokerRecoveryCoordinator,
  type BrokerRecoveryGateState,
} from "../src/agent/broker-recovery.mts";

type TestBroker = { id: string };

test("Broker recovery leaves a live signed Broker running", async () => {
  const liveBroker: TestBroker = { id: "live" };
  let current: TestBroker | undefined = liveBroker;
  let closeCalls = 0;
  let startCalls = 0;
  let probeCalls = 0;
  const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
    getGateState: () => "accepting",
    getCurrentBroker: () => current,
    setCurrentBroker: (broker) => { current = broker; },
    async closeBroker() { closeCalls += 1; },
    async startBroker() {
      startCalls += 1;
      return { id: "unexpected" };
    },
    async probeSignedBroker(broker) {
      probeCalls += 1;
      return broker === liveBroker;
    },
  });

  assert.deepEqual(await coordinator.ensureHealthy(), { status: "healthy", broker: liveBroker });
  assert.equal(current, liveBroker);
  assert.equal(probeCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(startCalls, 0);
});

test("Broker recovery replaces a stale Broker exactly once", async () => {
  const staleBroker: TestBroker = { id: "stale" };
  const replacement: TestBroker = { id: "replacement" };
  const events: string[] = [];
  let current: TestBroker | undefined = staleBroker;
  let closeCalls = 0;
  let startCalls = 0;
  const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
    getGateState: () => "accepting",
    getCurrentBroker: () => current,
    setCurrentBroker: (broker) => { current = broker; },
    async closeBroker(broker) {
      closeCalls += 1;
      events.push(`close:${broker.id}`);
    },
    async startBroker() {
      startCalls += 1;
      events.push("start");
      return replacement;
    },
    async probeSignedBroker(broker) {
      events.push(`probe:${broker.id}`);
      return broker === replacement;
    },
  });

  assert.deepEqual(await coordinator.ensureHealthy(), { status: "recovered", broker: replacement });
  assert.equal(current, replacement);
  assert.equal(closeCalls, 1);
  assert.equal(startCalls, 1);
  assert.deepEqual(events, ["probe:stale", "close:stale", "start", "probe:replacement"]);
});

test("concurrent Broker recovery callers share one replacement attempt", async () => {
  const replacement: TestBroker = { id: "replacement" };
  let current: TestBroker | undefined;
  let startCalls = 0;
  let signalStart: (() => void) | undefined;
  let finishStart: ((broker: TestBroker) => void) | undefined;
  const startObserved = new Promise<void>((resolve) => { signalStart = resolve; });
  const startPending = new Promise<TestBroker>((resolve) => { finishStart = resolve; });
  const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
    getGateState: () => "accepting",
    getCurrentBroker: () => current,
    setCurrentBroker: (broker) => { current = broker; },
    async closeBroker() {},
    async startBroker() {
      startCalls += 1;
      signalStart?.();
      return startPending;
    },
    async probeSignedBroker(broker) { return broker === replacement; },
  });

  const first = coordinator.ensureHealthy();
  const second = coordinator.ensureHealthy();
  assert.equal(first, second);
  await startObserved;
  assert.equal(startCalls, 1);
  finishStart?.(replacement);

  assert.deepEqual(await first, { status: "recovered", broker: replacement });
  assert.equal(current, replacement);
  assert.equal(startCalls, 1);
});

test("draining and closed gates do not inspect or restart a Broker", async () => {
  for (const state of ["draining", "closed"] satisfies BrokerRecoveryGateState[]) {
    const staleBroker: TestBroker = { id: state };
    let closeCalls = 0;
    let startCalls = 0;
    let probeCalls = 0;
    const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
      getGateState: () => state,
      getCurrentBroker: () => staleBroker,
      setCurrentBroker() {},
      async closeBroker() { closeCalls += 1; },
      async startBroker() {
        startCalls += 1;
        return { id: "unexpected" };
      },
      async probeSignedBroker() {
        probeCalls += 1;
        return false;
      },
    });

    assert.deepEqual(await coordinator.ensureHealthy(), { status: "not-accepting", state });
    assert.equal(probeCalls, 0, state);
    assert.equal(closeCalls, 0, state);
    assert.equal(startCalls, 0, state);
  }
});

test("a gate that begins draining during startup disposes the unverified replacement", async () => {
  const replacement: TestBroker = { id: "replacement" };
  const events: string[] = [];
  let gateState: BrokerRecoveryGateState = "accepting";
  let current: TestBroker | undefined;
  const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
    getGateState: () => gateState,
    getCurrentBroker: () => current,
    setCurrentBroker: (broker) => { current = broker; },
    async closeBroker(broker) { events.push(`close:${broker.id}`); },
    async startBroker() {
      events.push("start");
      gateState = "draining";
      return replacement;
    },
    async probeSignedBroker() {
      events.push("probe");
      return true;
    },
  });

  assert.deepEqual(await coordinator.ensureHealthy(), { status: "not-accepting", state: "draining" });
  assert.equal(current, undefined);
  assert.deepEqual(events, ["start", "close:replacement"]);
});

test("a gate that closes during the signed replacement probe disposes the replacement", async () => {
  const replacement: TestBroker = { id: "replacement" };
  const events: string[] = [];
  let gateState: BrokerRecoveryGateState = "accepting";
  let current: TestBroker | undefined;
  const coordinator = new BrokerRecoveryCoordinator<TestBroker>({
    getGateState: () => gateState,
    getCurrentBroker: () => current,
    setCurrentBroker: (broker) => { current = broker; },
    async closeBroker(broker) { events.push(`close:${broker.id}`); },
    async startBroker() {
      events.push("start");
      return replacement;
    },
    async probeSignedBroker() {
      events.push("probe");
      gateState = "closed";
      return true;
    },
  });

  assert.deepEqual(await coordinator.ensureHealthy(), { status: "not-accepting", state: "closed" });
  assert.equal(current, undefined);
  assert.deepEqual(events, ["start", "probe", "close:replacement"]);
});
