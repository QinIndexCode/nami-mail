import assert from "node:assert/strict";
import test from "node:test";
import {
  getDefaultBrokerTransport,
  isSupportedBrokerTransport,
  isValidBrokerEndpointPath,
  isValidUnixSocketPath,
  isValidWindowsPipePath,
  resolveBrokerEndpointPath,
} from "../src/agent/ipc-transport.mjs";
import { NamiMailCliClient, parseCliArguments } from "../src/agent/cli.mjs";
import { NamiMailMcpToolAdapter } from "../src/agent/mcp.mjs";

test("isSupportedBrokerTransport validates accepted IPC transports", () => {
  assert.equal(isSupportedBrokerTransport("windows-named-pipe"), true);
  assert.equal(isSupportedBrokerTransport("unix-domain-socket"), true);
  assert.equal(isSupportedBrokerTransport("loopback-http"), false);
  assert.equal(isSupportedBrokerTransport("tcp"), false);
  assert.equal(isSupportedBrokerTransport(""), false);
  assert.equal(isSupportedBrokerTransport(null), false);
  assert.equal(isSupportedBrokerTransport(undefined), false);
});

test("isValidWindowsPipePath enforces Windows named-pipe naming rules", () => {
  assert.equal(isValidWindowsPipePath("\\\\.\\pipe\\nami-agent-test"), true);
  assert.equal(isValidWindowsPipePath("\\\\.\\pipe\\nami_broker.001"), true);
  assert.equal(isValidWindowsPipePath("\\\\.\\pipe\\"), false);
  assert.equal(isValidWindowsPipePath("/tmp/nami.sock"), false);
  assert.equal(isValidWindowsPipePath("invalid-pipe"), false);
});

test("isValidUnixSocketPath enforces Unix domain socket path constraints", () => {
  assert.equal(isValidUnixSocketPath("/tmp/nami-agent.sock"), true);
  assert.equal(isValidUnixSocketPath("/var/run/nami/agent.sock"), true);
  assert.equal(isValidUnixSocketPath(""), false);
  // Rejects paths exceeding standard sockaddr_un byte limit
  const longPath = "/" + "a".repeat(120) + ".sock";
  assert.equal(isValidUnixSocketPath(longPath), false);
});

test("isValidBrokerEndpointPath supports both transports conditionally and generally", () => {
  const winPipe = "\\\\.\\pipe\\nami-mail-broker";
  const unixSock = "/tmp/nami-mail-broker.sock";

  assert.equal(isValidBrokerEndpointPath(winPipe, "windows-named-pipe"), true);
  assert.equal(isValidBrokerEndpointPath(unixSock, "windows-named-pipe"), false);

  assert.equal(isValidBrokerEndpointPath(unixSock, "unix-domain-socket"), true);
  assert.equal(isValidBrokerEndpointPath(winPipe, "unix-domain-socket"), false);

  assert.equal(isValidBrokerEndpointPath(winPipe), true);
  assert.equal(isValidBrokerEndpointPath(unixSock), true);
});

test("getDefaultBrokerTransport reflects host platform expectations", () => {
  const expected = process.platform === "win32" ? "windows-named-pipe" : "unix-domain-socket";
  assert.equal(getDefaultBrokerTransport(), expected);
});

test("resolveBrokerEndpointPath formats appropriate path for transport", () => {
  const winEndpoint = resolveBrokerEndpointPath("C:\\Users\\test\\data", "windows-named-pipe", "agent-test");
  assert.equal(winEndpoint, "\\\\.\\pipe\\agent-test");

  const unixEndpoint = resolveBrokerEndpointPath("/home/user/.config/nami", "unix-domain-socket", "agent-test");
  assert.match(unixEndpoint, /agent-test\.sock$/);
});

test("NamiMailCliClient accepts unix-domain-socket transport and invokes broker", async () => {
  let invoked = false;
  const client = new NamiMailCliClient({
    broker: {
      transport: "unix-domain-socket",
      async invoke(req) {
        invoked = true;
        return { ok: true, command: req.command };
      },
    },
    version: "0.4.3",
    createRequestId: () => "test-request-id-001",
  });

  const parsed = parseCliArguments(["accounts", "list"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = await client.invoke(parsed.invocation);
  assert.equal(result.success, true);
  assert.equal(invoked, true);
});

test("NamiMailMcpToolAdapter accepts unix-domain-socket transport and invokes broker", async () => {
  let invoked = false;
  const adapter = new NamiMailMcpToolAdapter({
    broker: {
      transport: "unix-domain-socket",
      async invoke() {
        invoked = true;
        return { accounts: [] };
      },
    },
    createRequestId: () => "test-mcp-request-id-001",
  });

  const result = await adapter.callTool({ name: "namimail_accounts_list", arguments: {} });
  assert.equal(result.isError, false);
  assert.equal(invoked, true);
});
