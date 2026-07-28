import assert from "node:assert/strict";
import test from "node:test";
import {
  isMcpStdioInvocation,
  NamiMailCliClient,
  parseCliArguments,
  type NamiMailBrokerClient,
} from "../src/agent/cli.mts";
import {
  createAgentHostLaunchPlan,
  ElectronAgentHostServiceStarter,
  type AgentHostServiceStarter,
} from "../src/agent/service-start.mts";

const requestId = "123e4567-e89b-12d3-a456-426614174004";

function parse(args: string[]) {
  const parsed = parseCliArguments(args);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.invocation;
}

test("CLI help and command help remain local", async () => {
  let brokerCalls = 0;
  let serviceCalls = 0;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        brokerCalls += 1;
        return null;
      },
    },
    serviceStarter: {
      async start() {
        serviceCalls += 1;
        return { status: "started" };
      },
    },
    version: "0.1.2",
    createRequestId: () => requestId,
  });

  const globalHelp = await client.invoke(parse(["--help"]));
  assert.equal(globalHelp.success, true);
  assert.equal((globalHelp.data as { name: string }).name, "NamiMail");
  assert.equal(brokerCalls, 0);
  assert.equal(serviceCalls, 0);

  const commandHelp = parse(["messages", "list", "--help"]);
  assert.equal(commandHelp.command.id, "help");
  assert.equal(commandHelp.helpTarget?.id, "messages.list");
  const commandHelpResult = await client.invoke(commandHelp);
  assert.equal(commandHelpResult.success, true);
  assert.equal(((commandHelpResult.data as { commands: Array<{ id: string }> }).commands)[0]?.id, "messages.list");
  assert.equal(brokerCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("ordinary read-only CLI commands use an existing broker and never start service", async () => {
  let serviceCalls = 0;
  const brokerCalls: string[] = [];
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke(input) {
        brokerCalls.push(input.command);
        return { ready: true };
      },
    },
    serviceStarter: {
      async start() {
        serviceCalls += 1;
        return { status: "started" };
      },
    },
    version: "0.1.2",
    createRequestId: () => requestId,
  });

  const result = await client.invoke(parse(["status", "--output", "json"]));
  assert.equal(result.success, true);
  assert.deepEqual(brokerCalls, ["status"]);
  assert.equal(serviceCalls, 0);
});

test("service start invokes only the explicit service starter", async () => {
  const serviceStarter: AgentHostServiceStarter = {
    async start() {
      return { status: "started", pid: 4242 };
    },
  };
  const client = new NamiMailCliClient({
    serviceStarter,
    version: "0.1.2",
    createRequestId: () => requestId,
  });

  const result = await client.invoke(parse(["service", "start", "--output", "json"]));
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { status: "started", pid: 4242 });
});

test("MCP launch invocation is never sent through the ordinary CLI broker path", async () => {
  let brokerCalls = 0;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        brokerCalls += 1;
        return null;
      },
    },
    version: "0.1.2",
    createRequestId: () => requestId,
  });

  const invocation = parse(["mcp", "start"]);
  assert.equal(isMcpStdioInvocation(invocation), true);
  const result = await client.invoke(invocation);
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "NOT_SUPPORTED");
  assert.equal(brokerCalls, 0);
});

test("Electron service starter uses a fixed agent-host launch plan and deduplicates concurrent starts", async () => {
  const plans: ReturnType<typeof createAgentHostLaunchPlan>[] = [];
  let ready: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const starter = new ElectronAgentHostServiceStarter({
    executablePath: "C:\\Program Files\\NamiMail\\NamiMail.exe",
    spawner: {
      spawn(plan) {
        plans.push(plan);
        return { pid: 4242 };
      },
    },
    verifySecureBroker: async () => true,
    waitForReady: () => readyPromise,
  });

  const first = starter.start();
  const second = starter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0], {
    executablePath: "C:\\Program Files\\NamiMail\\NamiMail.exe",
    arguments: ["--agent-host"],
    exitPolicy: {
      normalShutdownExitCode: 0,
      startupFailureExitCode: 1,
    },
    options: {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  });
  ready?.();
  assert.deepEqual(await first, { status: "started", pid: 4242 });
  assert.deepEqual(await second, { status: "started", pid: 4242 });
});

test("Electron service starter does not launch a duplicate host when the secured host is already running", async () => {
  let spawnCalls = 0;
  const starter = new ElectronAgentHostServiceStarter({
    executablePath: "C:\\Program Files\\NamiMail\\NamiMail.exe",
    spawner: {
      spawn() {
        spawnCalls += 1;
        return {};
      },
    },
    verifySecureBroker: async () => true,
    isHostRunning: async () => true,
    waitForReady: async () => undefined,
  });

  assert.deepEqual(await starter.start(), { status: "already-running" });
  assert.equal(spawnCalls, 0);
});

test("service start without a configured starter fails without touching the broker", async () => {
  let brokerCalls = 0;
  const broker: NamiMailBrokerClient = {
    transport: "windows-named-pipe",
    async invoke() {
      brokerCalls += 1;
      return null;
    },
  };
  const client = new NamiMailCliClient({ broker, version: "0.1.2", createRequestId: () => requestId });
  const result = await client.invoke(parse(["service", "start"]));
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "HOST_UNAVAILABLE");
  assert.equal(brokerCalls, 0);
});

test("Electron service starter fails closed before spawning when SID-DACL Broker IPC is unavailable", async () => {
  let spawnCalls = 0;
  const starter = new ElectronAgentHostServiceStarter({
    executablePath: "C:\\Program Files\\NamiMail\\NamiMail.exe",
    spawner: {
      spawn() {
        spawnCalls += 1;
        return {};
      },
    },
    verifySecureBroker: async () => false,
    waitForReady: async () => undefined,
  });

  await assert.rejects(
    starter.start(),
    (error: unknown) => (error as { code?: string }).code === "BROKER_SECURITY_UNAVAILABLE",
  );
  assert.equal(spawnCalls, 0);
});
