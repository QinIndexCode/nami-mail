import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCliCannotStartRuntime,
  formatCliEnvelope,
  NamiMailCliClient,
  parseCliArguments,
  type NamiMailBrokerClient,
} from "../src/agent/cli.mts";
import { asAgentDesktopError } from "../src/agent/contracts.mts";

test("parses stable read-only commands and typed options", () => {
  const parsed = parseCliArguments([
    "messages",
    "search",
    "--output=json",
    "--account",
    "account-001",
    "--limit",
    "25",
    "--query",
    "invoice",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.invocation.command.id, "messages.search");
  assert.equal(parsed.invocation.output, "json");
  assert.equal(parsed.invocation.options.account, "account-001");
  assert.equal(parsed.invocation.options.limit, 25);
  assert.equal(parsed.invocation.options.query, "invoice");
});

test("rejects ambiguous or unsupported CLI options", () => {
  const incompatible = parseCliArguments(["messages", "list", "--interactive", "--non-interactive"]);
  assert.equal(incompatible.ok, false);
  if (!incompatible.ok) assert.equal(incompatible.error.code, "INVALID_ARGUMENT");

  const unknown = parseCliArguments(["messages", "list", "--server", "http://127.0.0.1"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "INVALID_ARGUMENT");
});

test("CLI sends read-only work to an existing named-pipe broker only", async () => {
  const parsed = parseCliArguments(["messages", "list", "--output", "json"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const received: string[] = [];
  const broker: NamiMailBrokerClient = {
    transport: "windows-named-pipe",
    async invoke(request) {
      received.push(request.command);
      return [{ id: "message-001", subject: "Quarterly report" }];
    },
  };
  const client = new NamiMailCliClient({
    broker,
    version: "0.1.2",
    now: () => 10,
    createRequestId: () => "123e4567-e89b-12d3-a456-426614174004",
  });
  const envelope = await client.invoke(parsed.invocation);
  assert.equal(envelope.success, true);
  assert.deepEqual(received, ["messages.list"]);
  const output = formatCliEnvelope(envelope, parsed.invocation.output);
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /Quarterly report/);
});

test("CLI refuses write operations even when --yes is provided", async () => {
  const parsed = parseCliArguments(["mail", "send", "--yes"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  let invoked = false;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        invoked = true;
        return null;
      },
    },
    version: "0.1.2",
  });
  const envelope = await client.invoke(parsed.invocation);
  assert.equal(envelope.success, false);
  assert.equal(envelope.error?.code, "PERMISSION_DENIED");
  assert.equal(invoked, false);
});

test("CLI returns structured security errors instead of using a loopback fallback", async () => {
  const parsed = parseCliArguments(["status"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const client = new NamiMailCliClient({
    broker: {
      transport: "loopback-http" as never,
      async invoke() { return null; },
    },
    version: "0.1.2",
  });
  const envelope = await client.invoke(parsed.invocation);
  assert.equal(envelope.success, false);
  assert.equal(envelope.error?.code, "BROKER_SECURITY_UNAVAILABLE");
  const output = formatCliEnvelope(envelope, "json");
  assert.equal(output.exitCode, 1);
  assert.match(output.stdout, /BROKER_SECURITY_UNAVAILABLE/);
});

test("CLI runtime guard refuses local Runtime or SQLite startup", () => {
  assert.throws(
    () => assertCliCannotStartRuntime(),
    (error) => asAgentDesktopError(error)?.code === "CLI_RUNTIME_FORBIDDEN",
  );
});
