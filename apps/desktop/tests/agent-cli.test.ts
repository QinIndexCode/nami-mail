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

const requestId = "123e4567-e89b-12d3-a456-426614174004";

function parse(argv: string[]) {
  const parsed = parseCliArguments(argv);
  assert.equal(parsed.ok, true, `Expected CLI parsing to succeed: ${argv.join(" ")}`);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.invocation;
}

test("CLI parses the eight External Mail v1 reads with their published options", () => {
  const accounts = parse(["accounts", "list", "--output=json"]);
  assert.equal(accounts.command.id, "accounts.list");
  assert.equal(accounts.output, "json");

  const folders = parse(["folders", "list", "--account", "account-001"]);
  assert.equal(folders.command.id, "folders.list");
  assert.equal(folders.options.account, "account-001");

  const summarize = parse([
    "mail", "summarize",
    "--folder", "INBOX",
    "--limit", "10",
    "--since", "2026-07-01T00:00:00Z",
    "--before", "2026-07-02T00:00:00Z",
    "--unread", "true",
    "--sender", "billing@example.com",
  ]);
  assert.equal(summarize.command.id, "mail.summarize");
  assert.deepEqual(summarize.options, {
    profile: "default",
    folder: "INBOX",
    limit: 10,
    since: "2026-07-01T00:00:00Z",
    before: "2026-07-02T00:00:00Z",
    unread: true,
    sender: "billing@example.com",
  });

  const messages = parse([
    "messages", "list",
    "--folder", "INBOX",
    "--limit", "25",
    "--since", "2026-07-01T00:00:00Z",
    "--before", "2026-07-02T00:00:00Z",
    "--unread", "true",
    "--flagged", "false",
    "--sender", "billing@example.com",
    "--cursor", "page-002",
  ]);
  assert.equal(messages.command.id, "messages.list");
  assert.deepEqual(messages.options, {
    profile: "default",
    folder: "INBOX",
    limit: 25,
    since: "2026-07-01T00:00:00Z",
    before: "2026-07-02T00:00:00Z",
    unread: true,
    flagged: false,
    sender: "billing@example.com",
    cursor: "page-002",
  });

  const message = parse(["messages", "get", "--message", "message-001"]);
  assert.equal(message.command.id, "messages.get");
  assert.equal(message.options.message, "message-001");

  const batch = parse(["messages", "batch-get", "--message", "message-001,message-002"]);
  assert.equal(batch.command.id, "messages.batch_get");
  assert.equal(batch.options.message, "message-001,message-002");

  const thread = parse(["threads", "get", "--thread", "thread-001"]);
  assert.equal(thread.command.id, "threads.get");
  assert.equal(thread.options.thread, "thread-001");

  const attachments = parse(["attachments", "list", "--message", "message-001"]);
  assert.equal(attachments.command.id, "attachments.list");
  assert.equal(attachments.options.message, "message-001");
});

test("CLI sends each External Mail v1 read with its exact broker contract input", async () => {
  const received: Array<{ command: string; arguments: unknown; requestId: string }> = [];
  const broker: NamiMailBrokerClient = {
    transport: "windows-named-pipe",
    async invoke(request) {
      received.push(request);
      return { command: request.command };
    },
  };
  const client = new NamiMailCliClient({
    broker,
    version: "0.2.3",
    now: () => 10,
    createRequestId: () => requestId,
  });

  const cases = [
    { argv: ["accounts", "list"], command: "accounts.list", arguments: {} },
    { argv: ["folders", "list", "--account", "account-001"], command: "folders.list", arguments: { accountId: "account-001" } },
    {
      argv: ["messages", "list", "--folder", "INBOX", "--limit", "25", "--since", "2026-07-01T00:00:00Z", "--before", "2026-07-02T00:00:00Z", "--unread", "true", "--flagged", "false", "--sender", "billing@example.com", "--cursor", "page-002"],
      command: "messages.list",
      arguments: {
        mailbox: "INBOX",
        limit: 25,
        after: "2026-07-01T00:00:00Z",
        before: "2026-07-02T00:00:00Z",
        unread: true,
        flagged: false,
        sender: "billing@example.com",
        cursor: "page-002",
      },
    },
    { argv: ["messages", "get", "--message", "message-001"], command: "messages.get", arguments: { messageId: "message-001" } },
    { argv: ["messages", "batch-get", "--message", "message-001,message-002"], command: "messages.batch_get", arguments: { messageIds: ["message-001", "message-002"] } },
    { argv: ["threads", "get", "--thread", "thread-001"], command: "threads.get", arguments: { threadId: "thread-001" } },
    { argv: ["attachments", "list", "--message", "message-001"], command: "attachments.list", arguments: { messageId: "message-001" } },
    {
      argv: ["mail", "summarize", "--folder", "INBOX", "--limit", "10", "--since", "2026-07-01T00:00:00Z", "--before", "2026-07-02T00:00:00Z", "--unread", "true", "--sender", "billing@example.com"],
      command: "mail.summarize",
      arguments: {
        mailbox: "INBOX",
        limit: 10,
        after: "2026-07-01T00:00:00Z",
        before: "2026-07-02T00:00:00Z",
        unread: true,
        sender: "billing@example.com",
      },
    },
  ];

  for (const entry of cases) {
    const result = await client.invoke(parse(entry.argv));
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { command: entry.command });
  }
  assert.deepEqual(received, cases.map((entry) => ({
    command: entry.command,
    arguments: entry.arguments,
    requestId,
  })));

  const output = formatCliEnvelope(await client.invoke(parse(["accounts", "list", "--output=json"])), "json");
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /accounts\.list/);
});

test("CLI rejects unsupported options, obsolete search, invalid dates, and missing identifiers before broker work", async () => {
  const unknownOption = parseCliArguments(["messages", "list", "--server", "http://127.0.0.1"]);
  assert.equal(unknownOption.ok, false);
  if (!unknownOption.ok) assert.equal(unknownOption.error.code, "INVALID_ARGUMENT");

  const obsoleteSearch = parseCliArguments(["messages", "search", "--query", "invoice"]);
  assert.equal(obsoleteSearch.ok, false);
  if (!obsoleteSearch.ok) assert.equal(obsoleteSearch.error.code, "INVALID_ARGUMENT");

  const deniedWrite = parseCliArguments(["mail", "send", "--yes"]);
  assert.equal(deniedWrite.ok, false);
  if (!deniedWrite.ok) assert.equal(deniedWrite.error.code, "PERMISSION_DENIED");

  let brokerCalls = 0;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        brokerCalls += 1;
        return null;
      },
    },
    version: "0.2.3",
    createRequestId: () => requestId,
  });
  const failures = [
    { argv: ["folders", "list"], code: "INVALID_ARGUMENT" },
    { argv: ["messages", "get"], code: "INVALID_ARGUMENT" },
    { argv: ["threads", "get"], code: "INVALID_ARGUMENT" },
    { argv: ["attachments", "list"], code: "INVALID_ARGUMENT" },
    { argv: ["messages", "list", "--account", "account-001"], code: "INVALID_ARGUMENT" },
    { argv: ["messages", "list", "--since", "tomorrow"], code: "TOOL_INPUT_INVALID" },
    { argv: ["messages", "list", "--since", "2026-07-02T00:00:00Z", "--before", "2026-07-01T00:00:00Z"], code: "TOOL_INPUT_INVALID" },
  ];
  for (const failure of failures) {
    const result = await client.invoke(parse(failure.argv));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, failure.code);
  }
  assert.equal(brokerCalls, 0);
});

test("CLI parses the seven External Mail v1 writes with their published options", () => {
  const create = parse(["draft", "create", "--account", "account-001", "--to", "Alice <alice@example.com>, bob@example.com", "--cc", "carol@example.com", "--subject", "Hi", "--body", "Hello there"]);
  assert.equal(create.command.id, "mail.draft.create");
  assert.equal(create.command.access, "external");
  assert.equal(create.options.account, "account-001");
  assert.equal(create.options.to, "Alice <alice@example.com>, bob@example.com");

  const update = parse(["draft", "update", "--account", "account-001", "--draft", "draft-001", "--to", "alice@example.com", "--subject", "Hi", "--body", "Updated"]);
  assert.equal(update.command.id, "mail.draft.update");
  assert.equal(update.options.draft, "draft-001");

  const remove = parse(["draft", "delete", "--account", "account-001", "--draft", "draft-001"]);
  assert.equal(remove.command.id, "mail.draft.delete");

  const move = parse(["messages", "move", "--message", "message-001", "--target", "archive"]);
  assert.equal(move.command.id, "messages.move");
  assert.equal(move.options.target, "archive");

  const setFlag = parse(["messages", "set-flag", "--message", "message-001", "--flag", "seen", "--value", "false"]);
  assert.equal(setFlag.command.id, "messages.set-flag");
  assert.equal(setFlag.options.value, false);

  const send = parse(["messages", "send", "--account", "account-001", "--to", "alice@example.com", "--subject", "Hi", "--body", "Hello"]);
  assert.equal(send.command.id, "messages.send");

  const reply = parse(["mail", "reply", "--account", "account-001", "--message", "message-001", "--body", "Reply"]);
  assert.equal(reply.command.id, "mail.reply");
});

test("CLI sends each External Mail v1 write with its exact broker contract input", async () => {
  const received: Array<{ command: string; arguments: unknown; requestId: string }> = [];
  const broker: NamiMailBrokerClient = {
    transport: "windows-named-pipe",
    async invoke(request) {
      received.push(request);
      return { command: request.command };
    },
  };
  const client = new NamiMailCliClient({
    broker,
    version: "0.3.0",
    now: () => 10,
    createRequestId: () => requestId,
  });

  const cases = [
    {
      argv: ["draft", "create", "--account", "account-001", "--to", "Alice <alice@example.com>, bob@example.com", "--cc", "carol@example.com", "--subject", "Hi", "--body", "Hello"],
      command: "mail.draft.create",
      arguments: {
        accountId: "account-001",
        to: [{ name: "Alice", address: "alice@example.com" }, { address: "bob@example.com" }],
        cc: [{ address: "carol@example.com" }],
        subject: "Hi",
        text: "Hello",
      },
    },
    {
      argv: ["draft", "update", "--account", "account-001", "--draft", "draft-001", "--to", "alice@example.com", "--subject", "Hi", "--body", "Updated"],
      command: "mail.draft.update",
      arguments: { accountId: "account-001", draftId: "draft-001", to: [{ address: "alice@example.com" }], subject: "Hi", text: "Updated" },
    },
    { argv: ["draft", "delete", "--account", "account-001", "--draft", "draft-001"], command: "mail.draft.delete", arguments: { accountId: "account-001", draftId: "draft-001" } },
    { argv: ["messages", "move", "--message", "message-001", "--target", "trash"], command: "messages.move", arguments: { messageId: "message-001", target: "trash" } },
    { argv: ["messages", "set-flag", "--message", "message-001", "--flag", "seen", "--value", "true"], command: "messages.set-flag", arguments: { messageId: "message-001", flag: "seen", value: true } },
    { argv: ["messages", "send", "--account", "account-001", "--to", "alice@example.com", "--subject", "Hi", "--body", "Hello"], command: "messages.send", arguments: { accountId: "account-001", to: [{ address: "alice@example.com" }], subject: "Hi", text: "Hello" } },
    { argv: ["mail", "reply", "--account", "account-001", "--message", "message-001", "--to", "alice@example.com", "--subject", "Custom", "--body", "Reply"], command: "mail.reply", arguments: { accountId: "account-001", messageId: "message-001", to: [{ address: "alice@example.com" }], subject: "Custom", text: "Reply" } },
  ];

  for (const entry of cases) {
    const result = await client.invoke(parse(entry.argv));
    assert.equal(result.success, true, entry.argv.join(" "));
    assert.deepEqual(result.data, { command: entry.command });
  }
  assert.deepEqual(received, cases.map((entry) => ({
    command: entry.command,
    arguments: entry.arguments,
    requestId,
  })));
});

test("CLI rejects malformed writes before broker work and never lets --yes bypass confirmation", async () => {
  let brokerCalls = 0;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        brokerCalls += 1;
        return null;
      },
    },
    version: "0.3.0",
    createRequestId: () => requestId,
  });

  // --yes and unknown options are rejected at parse time (INVALID_ARGUMENT).
  const parseFailures = [
    ["messages", "send", "--account", "account-001", "--to", "alice@example.com", "--subject", "s", "--body", "b", "--yes"],
    ["draft", "create", "--account", "account-001", "--to", "alice@example.com", "--subject", "s", "--body", "b", "--bogus", "x"],
  ];
  for (const argv of parseFailures) {
    const parsed = parseCliArguments(argv);
    assert.equal(parsed.ok, false, argv.join(" "));
    if (!parsed.ok) assert.equal(parsed.error.code, "INVALID_ARGUMENT", argv.join(" "));
  }

  // Missing required options and invalid contract values are rejected by the
  // CLI client before any broker work happens.
  const invokeFailures = [
    { argv: ["draft", "create", "--account", "account-001"], code: "INVALID_ARGUMENT" },
    { argv: ["messages", "move", "--message", "message-001"], code: "INVALID_ARGUMENT" },
    { argv: ["messages", "set-flag", "--message", "message-001", "--flag", "seen"], code: "INVALID_ARGUMENT" },
    { argv: ["draft", "create", "--account", "account-001", "--to", "not-an-email", "--subject", "s", "--body", "b"], code: "TOOL_INPUT_INVALID" },
    { argv: ["messages", "move", "--message", "message-001", "--target", "delete"], code: "TOOL_INPUT_INVALID" },
  ];
  for (const failure of invokeFailures) {
    const result = await client.invoke(parse(failure.argv));
    assert.equal(result.success, false, failure.argv.join(" "));
    assert.equal(result.error?.code, failure.code, failure.argv.join(" "));
  }
  assert.equal(brokerCalls, 0);
});

test("CLI rejects known options that do not belong to local or diagnostic commands", async () => {
  let brokerCalls = 0;
  const client = new NamiMailCliClient({
    broker: {
      transport: "windows-named-pipe",
      async invoke() {
        brokerCalls += 1;
        return null;
      },
    },
    version: "0.3.0",
    createRequestId: () => requestId,
  });

  const cases = [
    ["version", "--account", "account-001"],
    ["version", "--profile", "work-readonly"],
    ["status", "--account", "account-001"],
    ["doctor", "--limit", "5"],
  ];
  for (const argv of cases) {
    const result = await client.invoke(parse(argv));
    assert.equal(result.success, false, argv.join(" "));
    assert.equal(result.error?.code, "INVALID_ARGUMENT", argv.join(" "));
  }
  assert.equal(brokerCalls, 0);
});

test("CLI returns structured security errors instead of using a loopback fallback", async () => {
  const client = new NamiMailCliClient({
    broker: {
      transport: "loopback-http" as never,
      async invoke() { return null; },
    },
    version: "0.2.3",
  });
  const envelope = await client.invoke(parse(["accounts", "list"]));
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

test("CLI accepts --version and -v as standard version aliases", async () => {
  for (const argv of [["--version"], ["-v"]]) {
    const parsed = parseCliArguments(argv);
    assert.equal(parsed.ok, true, `Expected --version alias to parse: ${argv.join(" ")}`);
    if (!parsed.ok) throw new Error(parsed.error.message);
    assert.equal(parsed.invocation.command.id, "version");
    assert.equal(parsed.invocation.output, "table");
    assert.deepEqual(parsed.invocation.options, { profile: "default" });
    assert.deepEqual([...parsed.invocation.providedOptions], []);
    assert.deepEqual([...parsed.invocation.positionals], []);
  }

  const client = new NamiMailCliClient({
    version: "0.3.0",
    createRequestId: () => requestId,
  });
  const longFlag = await client.invoke(parse(["--version"]));
  assert.equal(longFlag.success, true);
  assert.deepEqual(longFlag.data, { name: "NamiMail", version: "0.3.0" });

  const shortFlag = await client.invoke(parse(["-v"]));
  assert.equal(shortFlag.success, true);
  assert.deepEqual(shortFlag.data, { name: "NamiMail", version: "0.3.0" });

  const jsonOutput = formatCliEnvelope(await client.invoke(parse(["version", "--output", "json"])), "json");
  assert.equal(jsonOutput.exitCode, 0);
  assert.match(jsonOutput.stdout, /"version"\s*:\s*"0\.3\.0"/);
});

test("CLI rejects --version combined with other options or arguments", () => {
  for (const argv of [
    ["--version", "--output", "json"],
    ["--version", "extra"],
    ["-v", "--profile", "work"],
  ]) {
    const parsed = parseCliArguments(argv);
    assert.equal(parsed.ok, false, `Expected --version to be rejected with extra args: ${argv.join(" ")}`);
    if (!parsed.ok) assert.equal(parsed.error.code, "INVALID_ARGUMENT");
  }
});

test("CLI help output includes standard flag aliases for help and version", async () => {
  const client = new NamiMailCliClient({
    version: "0.3.0",
    createRequestId: () => requestId,
  });

  const helpResult = await client.invoke(parse(["help"]));
  assert.equal(helpResult.success, true);
  const commands = helpResult.data.commands as Array<{ command: string; id: string; aliases?: string[] }>;
  const helpCommand = commands.find((c) => c.id === "help");
  assert.ok(helpCommand, "Help payload must include the help command.");
  assert.deepEqual(helpCommand.aliases, ["--help", "-h"], "Help command must list --help and -h aliases.");
  const versionCommand = commands.find((c) => c.id === "version");
  assert.ok(versionCommand, "Help payload must include the version command.");
  assert.deepEqual(versionCommand.aliases, ["--version", "-v"], "Version command must list --version and -v aliases.");

  const shortFlagHelp = await client.invoke(parse(["-h"]));
  assert.equal(shortFlagHelp.success, true);
  assert.deepEqual(shortFlagHelp.data, helpResult.data, "-h must produce the same payload as help.");

  const helpVersionTopic = await client.invoke(parse(["help", "version"]));
  assert.equal(helpVersionTopic.success, true);
  const topicCommands = helpVersionTopic.data.commands as Array<{ command: string; id: string; aliases?: string[] }>;
  assert.equal(topicCommands.length, 1);
  assert.equal(topicCommands[0].id, "version");
  assert.deepEqual(topicCommands[0].aliases, ["--version", "-v"]);
});

test("CLI help lists accepted options for each read-only command", async () => {
  const client = new NamiMailCliClient({
    version: "0.3.0",
    createRequestId: () => requestId,
  });

  type OptionHint = { name: string; type: string; required: boolean; description: string };
  type CommandWithOptions = { command: string; id: string; options: OptionHint[] };

  // Per-command help: messages list should show all 8 specific options + 2 common options.
  const messagesHelp = await client.invoke(parse(["help", "messages", "list"]));
  assert.equal(messagesHelp.success, true);
  const messagesCmd = (messagesHelp.data.commands as CommandWithOptions[])[0];
  assert.equal(messagesCmd.id, "messages.list");
  const messageOptionNames = messagesCmd.options.map((o) => o.name);
  assert.deepEqual(messageOptionNames, [
    "folder", "limit", "since", "before", "unread", "flagged", "sender", "cursor",
    "output", "profile",
  ]);
  const folderOption = messagesCmd.options.find((o) => o.name === "folder");
  assert.equal(folderOption?.required, false);
  assert.equal(folderOption?.type, "string");
  assert.ok(folderOption?.description, "folder option must have a description");

  // Per-command help: folders list should show --account as required.
  const foldersHelp = await client.invoke(parse(["help", "folders", "list"]));
  const foldersCmd = (foldersHelp.data.commands as CommandWithOptions[])[0];
  assert.equal(foldersCmd.id, "folders.list");
  const accountOption = foldersCmd.options.find((o) => o.name === "account");
  assert.equal(accountOption?.required, true, "account option must be marked required for folders list");

  // Per-command help: accounts list should only show common options.
  const accountsHelp = await client.invoke(parse(["help", "accounts", "list"]));
  const accountsCmd = (accountsHelp.data.commands as CommandWithOptions[])[0];
  assert.equal(accountsCmd.id, "accounts.list");
  assert.deepEqual(accountsCmd.options.map((o) => o.name), ["output", "profile"]);

  // General help: all commands should have an options array.
  const generalHelp = await client.invoke(parse(["help"]));
  const allCommands = generalHelp.data.commands as CommandWithOptions[];
  for (const cmd of allCommands) {
    assert.ok(Array.isArray(cmd.options), `Command ${cmd.id} must have an options array`);
  }
});

test("CLI parses service stop and service restart as launcher commands", async () => {
  const stop = parse(["service", "stop"]);
  assert.equal(stop.command.id, "service.stop");
  assert.equal(stop.command.access, "launcher");
  assert.deepEqual(stop.options, { profile: "default" });

  const stopWithProfile = parse(["service", "stop", "--profile", "ops", "--output=json"]);
  assert.equal(stopWithProfile.command.id, "service.stop");
  assert.equal(stopWithProfile.options.profile, "ops");
  assert.equal(stopWithProfile.output, "json");

  const restart = parse(["service", "restart"]);
  assert.equal(restart.command.id, "service.restart");
  assert.equal(restart.command.access, "launcher");

  // Launcher commands are dispatched by the desktop entry point, not the CLI client.
  const client = new NamiMailCliClient({
    version: "0.3.0",
    createRequestId: () => requestId,
  });
  const stopResult = await client.invoke(stop);
  assert.equal(stopResult.success, false);
  assert.equal(stopResult.error?.code, "NOT_SUPPORTED");
  const restartResult = await client.invoke(restart);
  assert.equal(restartResult.success, false);
  assert.equal(restartResult.error?.code, "NOT_SUPPORTED");
});

test("CLI maps stable error codes to documented exit codes, including counter failures", async () => {
  const client = new NamiMailCliClient({
    version: "0.3.0",
    createRequestId: () => requestId,
  });
  const exitCodeFor = async (code: string) => {
    const envelope = await client.invoke(parse(["accounts", "list"]));
    const withCode = { ...envelope, error: { code, message: "test", retryable: false } };
    return formatCliEnvelope(withCode, "json").exitCode;
  };
  assert.equal(await exitCodeFor("INVALID_ARGUMENT"), 2);
  assert.equal(await exitCodeFor("HOST_UNAVAILABLE"), 3);
  assert.equal(await exitCodeFor("PAIRING_REQUIRED"), 4);
  assert.equal(await exitCodeFor("BROKER_AUTHENTICATION_FAILED"), 4);
  assert.equal(await exitCodeFor("BROKER_REPLAY_DETECTED"), 4);
  assert.equal(await exitCodeFor("BROKER_COUNTER_INVALID"), 4);
  assert.equal(await exitCodeFor("UPDATE_IN_PROGRESS"), 5);
  assert.equal(await exitCodeFor("PERMISSION_DENIED"), 6);
  assert.equal(await exitCodeFor("SCOPE_DENIED"), 6);
  assert.equal(await exitCodeFor("CLI_RUNTIME_FORBIDDEN"), 6);
  assert.equal(await exitCodeFor("TOOL_NOT_FOUND"), 1);
});
