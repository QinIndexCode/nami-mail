import { randomUUID } from "node:crypto";
import {
  createAgentError,
  externalReadMailContracts,
  externalWriteMailContracts,
  getExternalReadMailContract,
  getExternalWriteMailContract,
  type AgentError,
  type ExternalReadMailContract,
  type ExternalWriteMailContract,
} from "@nami/agent-contracts";
import { AGENT_PROTOCOL_VERSION, asAgentDesktopError, agentDesktopError } from "./contracts.mjs";
import type { JsonValue } from "./broker-protocol.mjs";

export type CliOutputFormat = "table" | "json" | "jsonl" | "text";
export type CliCommandAccess = "local" | "read-only" | "external" | "launcher";

export type CliCommandDefinition = {
  id: string;
  words: readonly string[];
  access: CliCommandAccess;
  aliases?: readonly string[];
};

const cliCommands: readonly CliCommandDefinition[] = [
  { id: "help", words: ["help"], access: "local", aliases: ["--help", "-h"] },
  { id: "version", words: ["version"], access: "local", aliases: ["--version", "-v"] },
  { id: "status", words: ["status"], access: "read-only" },
  { id: "doctor", words: ["doctor"], access: "read-only" },
  { id: "pair", words: ["pair"], access: "launcher" },
  { id: "revoke", words: ["revoke"], access: "launcher" },
  { id: "service.start", words: ["service", "start"], access: "launcher" },
  { id: "service.stop", words: ["service", "stop"], access: "launcher" },
  { id: "service.restart", words: ["service", "restart"], access: "launcher" },
  { id: "mcp.start", words: ["mcp", "start"], access: "launcher" },
  ...externalReadMailContracts.map((contract) => ({
    id: contract.toolName,
    words: contract.cliWords,
    access: "read-only" as const,
  })),
  ...externalWriteMailContracts.map((contract) => ({
    id: contract.toolName,
    words: contract.cliWords,
    access: "external" as const,
  })),
];

const commandByLength = [...cliCommands].sort((left, right) => right.words.length - left.words.length);
const valueOptions = new Set([
  "output", "profile", "account", "folder", "limit", "since", "before", "unread", "flagged", "sender", "cursor", "message", "thread",
  "draft", "to", "cc", "subject", "body", "target", "flag", "value",
]);
const outputFormats = new Set<CliOutputFormat>(["table", "json", "jsonl", "text"]);
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const blockedWriteCommands = new Set([
  "drafts.create", "drafts.update", "drafts.delete", "mail.reply", "mail.forward", "mail.send", "mail.archive", "mail.move", "mail.trash", "mail.mark-read", "mail.mark-unread", "rag.rebuild",
]);

export type ParsedCliInvocation = {
  command: CliCommandDefinition;
  output: CliOutputFormat;
  options: {
    profile: string;
    account?: string;
    folder?: string;
    limit?: number;
    since?: string;
    before?: string;
    unread?: boolean;
    flagged?: boolean;
    sender?: string;
    cursor?: string;
    message?: string;
    thread?: string;
    draft?: string;
    to?: string;
    cc?: string;
    subject?: string;
    body?: string;
    target?: string;
    flag?: string;
    value?: boolean;
  };
  /** Option names explicitly supplied by the caller, excluding defaults. */
  providedOptions: readonly string[];
  positionals: readonly string[];
  helpTarget?: CliCommandDefinition;
};

export type CliParseResult =
  | { ok: true; invocation: ParsedCliInvocation }
  | { ok: false; error: AgentError };

export type CliEnvelope<TData extends JsonValue = JsonValue> = {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  requestId: string;
  success: boolean;
  data: TData | null;
  error: AgentError | null;
  meta: {
    durationMs: number;
    version: string;
  };
};

export type CliFormattedOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CliBrokerRequest = {
  command: string;
  arguments: { [key: string]: JsonValue };
  requestId: string;
};

/** The CLI never imports a runtime, database, HTTP client, or credential store. */
export interface NamiMailBrokerClient {
  readonly transport: "windows-named-pipe";
  invoke(request: CliBrokerRequest): Promise<JsonValue>;
}

export type NamiMailCliClientOptions = {
  broker?: NamiMailBrokerClient;
  version: string;
  now?: () => number;
  createRequestId?: () => string;
};

function parseFailure(message: string, suggestion?: string): CliParseResult {
  return { ok: false, error: agentDesktopError("INVALID_ARGUMENT", message, false, suggestion).toAgentError() };
}

function deniedCommand(command: string): CliParseResult {
  return {
    ok: false,
    error: agentDesktopError(
      "PERMISSION_DENIED",
      `The NamiMail external CLI does not expose ${command}.`,
      false,
      "Run namimail help to see the external commands that are currently available.",
    ).toAgentError(),
  };
}

function commandMatches(argv: readonly string[], words: readonly string[]): boolean {
  return words.every((word, index) => argv[index] === word);
}

function commandWithExactWords(argv: readonly string[]): CliCommandDefinition | undefined {
  return cliCommands.find((candidate) => candidate.id !== "help" && candidate.words.length === argv.length && commandMatches(argv, candidate.words));
}

function defaultCliOptions(): ParsedCliInvocation["options"] {
  return { profile: "default" };
}

function helpCommand(): CliCommandDefinition {
  const command = cliCommands.find((candidate) => candidate.id === "help");
  if (!command) throw new Error("NamiMail CLI help command is not configured.");
  return command;
}

function helpInvocation(target?: CliCommandDefinition): CliParseResult {
  return {
    ok: true,
    invocation: {
      command: helpCommand(),
      output: "table",
      options: defaultCliOptions(),
      providedOptions: [],
      positionals: target ? [...target.words] : [],
      ...(target ? { helpTarget: target } : {}),
    },
  };
}

function versionCommand(): CliCommandDefinition {
  const command = cliCommands.find((candidate) => candidate.id === "version");
  if (!command) throw new Error("NamiMail CLI version command is not configured.");
  return command;
}

function versionInvocation(): CliParseResult {
  return {
    ok: true,
    invocation: {
      command: versionCommand(),
      output: "table",
      options: defaultCliOptions(),
      providedOptions: [],
      positionals: [],
    },
  };
}

function parseVersionInvocation(argv: readonly string[]): CliParseResult | undefined {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return versionInvocation();
  return undefined;
}

function parseHelpInvocation(argv: readonly string[]): CliParseResult | undefined {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return helpInvocation();
  if (argv[0] === "help") {
    if (argv.length === 1) return helpInvocation();
    const target = commandWithExactWords(argv.slice(1));
    return target ? helpInvocation(target) : parseFailure("The requested NamiMail help topic is not recognized.", "Run namimail help for supported commands.");
  }
  const separatorIndex = argv.indexOf("--");
  const commandTokens = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const helpIndex = commandTokens.findIndex((token) => token === "--help" || token === "-h");
  if (helpIndex === -1) return undefined;
  if (helpIndex !== commandTokens.length - 1 || separatorIndex !== -1) {
    return parseFailure("Use --help only as the final command option.", "Run namimail help for supported commands.");
  }
  const target = commandWithExactWords(commandTokens.slice(0, helpIndex));
  return target ? helpInvocation(target) : parseFailure("The requested NamiMail help topic is not recognized.", "Run namimail help for supported commands.");
}

function parseOptionToken(argv: readonly string[], index: number): { name: string; value: string; nextIndex: number } | undefined {
  const token = argv[index];
  if (!token?.startsWith("--") || token === "--") return undefined;
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1) {
    const name = token.slice(2, equalsIndex);
    const value = token.slice(equalsIndex + 1);
    return name && value ? { name, value, nextIndex: index + 1 } : undefined;
  }
  const name = token.slice(2);
  const value = argv[index + 1];
  return name && value && !value.startsWith("--") ? { name, value, nextIndex: index + 2 } : undefined;
}

function parseLimit(value: string): number | undefined {
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 50 ? parsed : undefined;
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function optionPropertyName(option: string): Exclude<keyof ParsedCliInvocation["options"], "profile" | "limit" | "unread" | "flagged" | "value"> | undefined {
  const names: Record<string, Exclude<keyof ParsedCliInvocation["options"], "profile" | "limit" | "unread" | "flagged" | "value">> = {
    account: "account",
    folder: "folder",
    since: "since",
    before: "before",
    sender: "sender",
    cursor: "cursor",
    message: "message",
    thread: "thread",
    draft: "draft",
    to: "to",
    cc: "cc",
    subject: "subject",
    body: "body",
    target: "target",
    flag: "flag",
  };
  return names[option];
}

export function parseCliArguments(argv: readonly string[]): CliParseResult {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((argument) => typeof argument !== "string" || argument.length > 8_192 || argument.includes("\u0000"))) {
    return parseFailure("A NamiMail command is required.", "Run namimail --help for supported commands.");
  }
  const help = parseHelpInvocation(argv);
  if (help) return help;
  const version = parseVersionInvocation(argv);
  if (version) return version;
  const command = commandByLength.find((candidate) => commandMatches(argv, candidate.words));
  if (!command) {
    const attempted = argv.slice(0, 2).join(".");
    return blockedWriteCommands.has(attempted) ? deniedCommand(attempted) : parseFailure("The NamiMail command is not recognized.", "Run namimail --help for supported commands.");
  }
  const options = defaultCliOptions();
  let output: CliOutputFormat = "table";
  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  for (let index = command.words.length; index < argv.length;) {
    const token = argv[index] as string;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      index += 1;
      continue;
    }
    const parsed = parseOptionToken(argv, index);
    if (!parsed || !valueOptions.has(parsed.name)) return parseFailure(`The option ${token.slice(0, 128)} is not valid for NamiMail.`);
    if (seenOptions.has(parsed.name)) return parseFailure(`The option --${parsed.name} was provided more than once.`);
    seenOptions.add(parsed.name);
    index = parsed.nextIndex;
    if (parsed.name === "output") {
      if (!outputFormats.has(parsed.value as CliOutputFormat)) return parseFailure("The requested output format is not supported.");
      output = parsed.value as CliOutputFormat;
      continue;
    }
    if (parsed.name === "profile") {
      if (!profilePattern.test(parsed.value)) return parseFailure("The --profile value must contain 1 to 64 letters, numbers, underscores, or hyphens.");
      options.profile = parsed.value;
      continue;
    }
    if (parsed.name === "limit") {
      const limit = parseLimit(parsed.value);
      if (!limit) return parseFailure("The --limit value must be an integer between 1 and 50.");
      options.limit = limit;
      continue;
    }
    if (parsed.name === "unread" || parsed.name === "flagged" || parsed.name === "value") {
      const value = parseBoolean(parsed.value);
      if (value === undefined) return parseFailure(`The --${parsed.name} value must be true or false.`);
      options[parsed.name] = value;
      continue;
    }
    const property = optionPropertyName(parsed.name);
    if (!property) return parseFailure(`The option --${parsed.name} is not valid for NamiMail.`);
    options[property] = parsed.value;
  }
  return { ok: true, invocation: { command, output, options, providedOptions: [...seenOptions], positionals } };
}

export function createCliEnvelope<TData extends JsonValue>(input: {
  requestId: string;
  version: string;
  durationMs: number;
  data: TData | null;
  error: AgentError | null;
}): CliEnvelope<TData> {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    requestId: input.requestId,
    success: input.error === null,
    data: input.data,
    error: input.error,
    meta: { durationMs: Math.max(0, Math.round(input.durationMs)), version: input.version },
  };
}

type CliOptionHint = {
  name: string;
  type: "string" | "integer" | "boolean";
  required: boolean;
  description: string;
};

const commandOptionHints: Readonly<Record<string, readonly CliOptionHint[]>> = {
  "accounts.list": [],
  "folders.list": [
    { name: "account", type: "string", required: true, description: "The account id to list folders for." },
  ],
  "messages.list": [
    { name: "folder", type: "string", required: false, description: "Mailbox path to list messages from." },
    { name: "limit", type: "integer", required: false, description: "Maximum number of messages to return (1-50)." },
    { name: "since", type: "string", required: false, description: "ISO 8601 timestamp; only messages after this date." },
    { name: "before", type: "string", required: false, description: "ISO 8601 timestamp; only messages before this date." },
    { name: "unread", type: "boolean", required: false, description: "Filter unread (true) or read (false) messages." },
    { name: "flagged", type: "boolean", required: false, description: "Filter flagged (true) or unflagged (false) messages." },
    { name: "sender", type: "string", required: false, description: "Filter by sender email address." },
    { name: "cursor", type: "string", required: false, description: "Pagination cursor from a previous response." },
  ],
  "messages.get": [
    { name: "message", type: "string", required: true, description: "The message id to retrieve." },
  ],
  "messages.batch_get": [
    { name: "message", type: "string", required: true, description: "Comma-separated message ids to retrieve (1-10)." },
  ],
  "mail.summarize": [
    { name: "folder", type: "string", required: false, description: "Mailbox path to summarize messages from." },
    { name: "limit", type: "integer", required: false, description: "Maximum number of messages to summarize (1-50)." },
    { name: "since", type: "string", required: false, description: "ISO 8601 timestamp; only messages after this date." },
    { name: "before", type: "string", required: false, description: "ISO 8601 timestamp; only messages before this date." },
    { name: "unread", type: "boolean", required: false, description: "Filter unread (true) or read (false) messages." },
    { name: "sender", type: "string", required: false, description: "Filter by sender email address." },
  ],
  "threads.get": [
    { name: "thread", type: "string", required: true, description: "The thread id to retrieve." },
  ],
  "attachments.list": [
    { name: "message", type: "string", required: true, description: "The message id to list attachments for." },
  ],
  "mail.draft.create": [
    { name: "account", type: "string", required: true, description: "The account id to create the draft in." },
    { name: "to", type: "string", required: true, description: "Comma-separated recipients; use \"Name <addr>\" for display names." },
    { name: "cc", type: "string", required: false, description: "Comma-separated Cc recipients." },
    { name: "subject", type: "string", required: true, description: "The draft subject." },
    { name: "body", type: "string", required: true, description: "The plain-text draft body." },
  ],
  "mail.draft.update": [
    { name: "account", type: "string", required: true, description: "The account id of the draft." },
    { name: "draft", type: "string", required: true, description: "The draft id to update." },
    { name: "to", type: "string", required: true, description: "Comma-separated recipients; use \"Name <addr>\" for display names." },
    { name: "cc", type: "string", required: false, description: "Comma-separated Cc recipients." },
    { name: "subject", type: "string", required: true, description: "The draft subject." },
    { name: "body", type: "string", required: true, description: "The plain-text draft body." },
  ],
  "mail.draft.delete": [
    { name: "account", type: "string", required: true, description: "The account id of the draft." },
    { name: "draft", type: "string", required: true, description: "The draft id to delete." },
  ],
  "messages.move": [
    { name: "message", type: "string", required: true, description: "The message id to move." },
    { name: "target", type: "string", required: true, description: "Destination mailbox: archive or trash." },
  ],
  "messages.set-flag": [
    { name: "message", type: "string", required: true, description: "The message id to update." },
    { name: "flag", type: "string", required: true, description: "Flag to set: seen or flagged." },
    { name: "value", type: "boolean", required: true, description: "true to set the flag, false to clear it." },
  ],
  "messages.send": [
    { name: "account", type: "string", required: true, description: "The account id to send from." },
    { name: "to", type: "string", required: true, description: "Comma-separated recipients; use \"Name <addr>\" for display names." },
    { name: "cc", type: "string", required: false, description: "Comma-separated Cc recipients." },
    { name: "subject", type: "string", required: true, description: "The message subject." },
    { name: "body", type: "string", required: true, description: "The plain-text message body." },
  ],
  "mail.reply": [
    { name: "account", type: "string", required: true, description: "The account id to create the reply in." },
    { name: "message", type: "string", required: true, description: "The original message id to reply to." },
    { name: "to", type: "string", required: false, description: "Override recipients; defaults to the original sender." },
    { name: "cc", type: "string", required: false, description: "Comma-separated Cc recipients." },
    { name: "subject", type: "string", required: false, description: "Override subject; defaults to Re: <original>." },
    { name: "body", type: "string", required: true, description: "The plain-text reply body." },
  ],
  "status": [],
  "doctor": [],
  "pair": [],
  "revoke": [],
  "service.start": [
    { name: "output", type: "string", required: false, description: "Output format: table (default), json, jsonl, or text." },
  ],  "service.stop": [],
  "service.restart": [],
  "mcp.start": [],
  "help": [],
  "version": [],
};

const commonOptionHints: readonly CliOptionHint[] = [
  { name: "output", type: "string", required: false, description: "Output format: table (default), json, jsonl, or text." },
  { name: "profile", type: "string", required: false, description: "NamiMail Agent profile name (default: default)." },
];

function optionsForCommand(command: CliCommandDefinition): readonly CliOptionHint[] {
  // Launcher commands (pair, revoke, service.*, mcp.start) accept common
  // options but are dispatched by the desktop entry point, not the CLI client.
  // Read-only and local commands show common options in help for discoverability.
  const specific = commandOptionHints[command.id] ?? [];
  const showCommon = command.access === "read-only" || command.access === "external" || command.access === "local" || command.id === "pair" || command.id === "revoke" || command.id === "service.stop" || command.id === "service.restart" || command.id === "mcp.start";
  return showCommon ? [...specific, ...commonOptionHints] : specific;
}

function localPayload(version: string, invocation: ParsedCliInvocation): JsonValue {
  if (invocation.command.id === "version") return { name: "NamiMail", version };
  const commands = invocation.helpTarget ? [invocation.helpTarget] : cliCommands;
  return {
    name: "NamiMail",
    version,
    usage: invocation.helpTarget ? `namimail ${invocation.helpTarget.words.join(" ")} [options]` : "namimail <command> [options]",
    commands: commands.map((command) => ({
      command: command.words.join(" "),
      id: command.id,
      access: command.access,
      ...(command.aliases ? { aliases: [...command.aliases] } : {}),
      options: optionsForCommand(command).map((option) => ({
        name: option.name,
        type: option.type,
        required: option.required,
        description: option.description,
      })),
    })),
  };
}

function invalidInput(message: string): { ok: false; error: AgentError } {
  return { ok: false, error: createAgentError({ code: "INVALID_ARGUMENT", message, retryable: false }) };
}

function noUnexpectedOptions(invocation: ParsedCliInvocation, allowed: readonly (keyof ParsedCliInvocation["options"])[]): AgentError | undefined {
  if (invocation.positionals.length) return invalidInput("NamiMail commands do not accept positional arguments.").error;
  const allowedOptions = new Set<string>(["output", "profile", ...allowed]);
  const unexpected = invocation.providedOptions.find((option) => !allowedOptions.has(option));
  if (unexpected) return invalidInput(`The --${unexpected} option is not valid for ${invocation.command.words.join(" ")}.`).error;
  return undefined;
}

function localInputError(invocation: ParsedCliInvocation): AgentError | undefined {
  // Help stores its already validated topic words as positionals for rendering.
  if (invocation.command.id === "help") return undefined;
  if (invocation.positionals.length) return invalidInput("NamiMail commands do not accept positional arguments.").error;
  const unexpected = invocation.providedOptions.find((option) => option !== "output");
  return unexpected
    ? invalidInput(`The --${unexpected} option is not valid for ${invocation.command.words.join(" ")}.`).error
    : undefined;
}

function validatedExternalInput(
  invocation: ParsedCliInvocation,
  input: { [key: string]: JsonValue },
  contract: ExternalReadMailContract | ExternalWriteMailContract,
): { ok: true; input: { [key: string]: JsonValue } } | { ok: false; error: AgentError } {
  const parsed = contract.inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: createAgentError({ code: "TOOL_INPUT_INVALID", message: "The command input does not match the published NamiMail contract.", retryable: false }) };
  return { ok: true, input: parsed.data as { [key: string]: JsonValue } };
}

function readExternalInput(
  invocation: ParsedCliInvocation,
  contract: ExternalReadMailContract,
): { ok: true; input: { [key: string]: JsonValue } } | { ok: false; error: AgentError } {
  let input: { [key: string]: JsonValue } = {};
  let unexpected: AgentError | undefined;
  switch (contract.toolName) {
    case "accounts.list":
      unexpected = noUnexpectedOptions(invocation, []);
      input = {};
      break;
    case "folders.list":
      unexpected = noUnexpectedOptions(invocation, ["account"]);
      if (!unexpected && !invocation.options.account) return invalidInput("The folders list command requires --account.");
      input = { accountId: invocation.options.account ?? "" };
      break;
    case "messages.list":
      unexpected = noUnexpectedOptions(invocation, ["folder", "limit", "since", "before", "unread", "flagged", "sender", "cursor"]);
      input = {
        ...(invocation.options.folder ? { mailbox: invocation.options.folder } : {}),
        ...(invocation.options.limit === undefined ? {} : { limit: invocation.options.limit }),
        ...(invocation.options.since ? { after: invocation.options.since } : {}),
        ...(invocation.options.before ? { before: invocation.options.before } : {}),
        ...(invocation.options.unread === undefined ? {} : { unread: invocation.options.unread }),
        ...(invocation.options.flagged === undefined ? {} : { flagged: invocation.options.flagged }),
        ...(invocation.options.sender ? { sender: invocation.options.sender } : {}),
        ...(invocation.options.cursor ? { cursor: invocation.options.cursor } : {}),
      };
      break;
    case "mail.summarize":
      unexpected = noUnexpectedOptions(invocation, ["folder", "limit", "since", "before", "unread", "sender"]);
      input = {
        ...(invocation.options.folder ? { mailbox: invocation.options.folder } : {}),
        ...(invocation.options.limit === undefined ? {} : { limit: invocation.options.limit }),
        ...(invocation.options.since ? { after: invocation.options.since } : {}),
        ...(invocation.options.before ? { before: invocation.options.before } : {}),
        ...(invocation.options.unread === undefined ? {} : { unread: invocation.options.unread }),
        ...(invocation.options.sender ? { sender: invocation.options.sender } : {}),
      };
      break;
    case "messages.get":
      unexpected = noUnexpectedOptions(invocation, ["message"]);
      if (!unexpected && !invocation.options.message) return invalidInput("The message get command requires --message.");
      input = { messageId: invocation.options.message ?? "" };
      break;
    case "messages.batch_get":
      unexpected = noUnexpectedOptions(invocation, ["message"]);
      if (!unexpected && !invocation.options.message) return invalidInput("The messages batch-get command requires --message.");
      input = {
        messageIds: (invocation.options.message ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      };
      break;
    case "threads.get":
      unexpected = noUnexpectedOptions(invocation, ["thread"]);
      if (!unexpected && !invocation.options.thread) return invalidInput("The threads get command requires --thread.");
      input = { threadId: invocation.options.thread ?? "" };
      break;
    case "attachments.list":
      unexpected = noUnexpectedOptions(invocation, ["message"]);
      if (!unexpected && !invocation.options.message) return invalidInput("The attachments list command requires --message.");
      input = { messageId: invocation.options.message ?? "" };
      break;
  }
  if (unexpected) return { ok: false, error: unexpected };
  return validatedExternalInput(invocation, input, contract);
}

/**
 * Parses a comma-separated CLI recipient list. Each entry is either a bare
 * address ("user@example.com") or a display name followed by a bracketed
 * address ("Example User <user@example.com>").
 */
function draftRecipients(value: string | undefined): Array<{ name?: string; address: string }> {
  if (!value) return [];
  return value.split(",").map((entry) => {
    const trimmed = entry.trim();
    const match = /^(.+)\s+<([^<>]+)>$/.exec(trimmed);
    if (!match) return { address: trimmed };
    const address = (match[2] ?? "").trim();
    const name = (match[1] ?? "").trim();
    return name ? { name, address } : { address };
  }).filter((entry) => entry.address.length > 0);
}

function writeExternalInput(
  invocation: ParsedCliInvocation,
  contract: ExternalWriteMailContract,
): { ok: true; input: { [key: string]: JsonValue } } | { ok: false; error: AgentError } {
  // The empty object is only a definite-assignment fallback for TypeScript.
  // Every case either assigns the real input or sets `unexpected`, and the
  // `unexpected` guard below returns before the placeholder can be validated.
  let input: { [key: string]: JsonValue } = {};
  let unexpected: AgentError | undefined;
  switch (contract.toolName) {
    case "mail.draft.create":
      unexpected = noUnexpectedOptions(invocation, ["account", "to", "cc", "subject", "body"]);
      if (!unexpected) {
        if (!invocation.options.account) return invalidInput("The draft create command requires --account.");
        if (!invocation.options.to) return invalidInput("The draft create command requires --to.");
        if (invocation.options.subject === undefined) return invalidInput("The draft create command requires --subject.");
        if (invocation.options.body === undefined) return invalidInput("The draft create command requires --body.");
        input = {
          accountId: invocation.options.account,
          to: draftRecipients(invocation.options.to),
          ...(invocation.options.cc ? { cc: draftRecipients(invocation.options.cc) } : {}),
          subject: invocation.options.subject,
          text: invocation.options.body,
        };
      }
      break;
    case "mail.draft.update":
      unexpected = noUnexpectedOptions(invocation, ["account", "draft", "to", "cc", "subject", "body"]);
      if (!unexpected) {
        if (!invocation.options.account || !invocation.options.draft) return invalidInput("The draft update command requires --account and --draft.");
        if (!invocation.options.to) return invalidInput("The draft update command requires --to.");
        if (invocation.options.subject === undefined) return invalidInput("The draft update command requires --subject.");
        if (invocation.options.body === undefined) return invalidInput("The draft update command requires --body.");
        input = {
          accountId: invocation.options.account,
          draftId: invocation.options.draft,
          to: draftRecipients(invocation.options.to),
          ...(invocation.options.cc ? { cc: draftRecipients(invocation.options.cc) } : {}),
          subject: invocation.options.subject,
          text: invocation.options.body,
        };
      }
      break;
    case "mail.draft.delete":
      unexpected = noUnexpectedOptions(invocation, ["account", "draft"]);
      if (!unexpected) {
        if (!invocation.options.account || !invocation.options.draft) return invalidInput("The draft delete command requires --account and --draft.");
        input = { accountId: invocation.options.account, draftId: invocation.options.draft };
      }
      break;
    case "messages.move":
      unexpected = noUnexpectedOptions(invocation, ["message", "target"]);
      if (!unexpected) {
        if (!invocation.options.message || !invocation.options.target) return invalidInput("The messages move command requires --message and --target.");
        input = { messageId: invocation.options.message, target: invocation.options.target };
      }
      break;
    case "messages.set-flag":
      unexpected = noUnexpectedOptions(invocation, ["message", "flag", "value"]);
      if (!unexpected) {
        if (!invocation.options.message || !invocation.options.flag || invocation.options.value === undefined) return invalidInput("The messages set-flag command requires --message, --flag, and --value.");
        input = { messageId: invocation.options.message, flag: invocation.options.flag, value: invocation.options.value };
      }
      break;
    case "messages.send":
      unexpected = noUnexpectedOptions(invocation, ["account", "to", "cc", "subject", "body"]);
      if (!unexpected) {
        if (!invocation.options.account) return invalidInput("The messages send command requires --account.");
        if (!invocation.options.to) return invalidInput("The messages send command requires --to.");
        if (invocation.options.subject === undefined) return invalidInput("The messages send command requires --subject.");
        if (invocation.options.body === undefined) return invalidInput("The messages send command requires --body.");
        input = {
          accountId: invocation.options.account,
          to: draftRecipients(invocation.options.to),
          ...(invocation.options.cc ? { cc: draftRecipients(invocation.options.cc) } : {}),
          subject: invocation.options.subject,
          text: invocation.options.body,
        };
      }
      break;
    case "mail.reply":
      unexpected = noUnexpectedOptions(invocation, ["account", "message", "to", "cc", "subject", "body"]);
      if (!unexpected) {
        if (!invocation.options.account || !invocation.options.message) return invalidInput("The mail reply command requires --account and --message.");
        if (invocation.options.body === undefined) return invalidInput("The mail reply command requires --body.");
        input = {
          accountId: invocation.options.account,
          messageId: invocation.options.message,
          ...(invocation.options.to ? { to: draftRecipients(invocation.options.to) } : {}),
          ...(invocation.options.cc ? { cc: draftRecipients(invocation.options.cc) } : {}),
          ...(invocation.options.subject !== undefined ? { subject: invocation.options.subject } : {}),
          text: invocation.options.body,
        };
      }
      break;
  }
  if (unexpected) return { ok: false, error: unexpected };
  return validatedExternalInput(invocation, input, contract);
}

function externalInput(invocation: ParsedCliInvocation): { ok: true; input: { [key: string]: JsonValue } } | { ok: false; error: AgentError } {
  const readContract = getExternalReadMailContract(invocation.command.id);
  if (readContract) return readExternalInput(invocation, readContract);
  const writeContract = getExternalWriteMailContract(invocation.command.id);
  if (writeContract) return writeExternalInput(invocation, writeContract);
  if (invocation.command.id === "status" || invocation.command.id === "doctor") {
    const unexpected = noUnexpectedOptions(invocation, []);
    return unexpected ? { ok: false, error: unexpected } : { ok: true, input: {} };
  }
  return { ok: false, error: createAgentError({ code: "NOT_SUPPORTED", message: "This command is not part of the NamiMail external Agent interface.", retryable: false }) };
}

export class NamiMailCliClient {
  constructor(private readonly options: NamiMailCliClientOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async invoke(invocation: ParsedCliInvocation): Promise<CliEnvelope> {
    const startedAt = this.now();
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    if (invocation.command.access === "local") {
      const invalid = localInputError(invocation);
      if (invalid) return createCliEnvelope({ requestId, version: this.options.version, durationMs: this.now() - startedAt, data: null, error: invalid });
      return createCliEnvelope({ requestId, version: this.options.version, durationMs: this.now() - startedAt, data: localPayload(this.options.version, invocation), error: null });
    }
    if (invocation.command.access === "launcher") {
      return createCliEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: createAgentError({ code: "NOT_SUPPORTED", message: "This NamiMail command must be launched by the packaged desktop CLI entry point.", retryable: false }),
      });
    }
    const input = externalInput(invocation);
    if (!input.ok) return createCliEnvelope({ requestId, version: this.options.version, durationMs: this.now() - startedAt, data: null, error: input.error });
    const broker = this.options.broker;
    if (!broker) {
      return createCliEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: createAgentError({ code: "HOST_UNAVAILABLE", message: "NamiMail Agent host is not available.", retryable: true, suggestion: "Open Nami Mail or run namimail service start." }),
      });
    }
    if (broker.transport !== "windows-named-pipe") {
      return createCliEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: createAgentError({ code: "BROKER_SECURITY_UNAVAILABLE", message: "NamiMail only accepts secured Windows named-pipe Agent IPC.", retryable: false }),
      });
    }
    try {
      const data = await broker.invoke({ command: invocation.command.id, arguments: input.input, requestId });
      return createCliEnvelope({ requestId, version: this.options.version, durationMs: this.now() - startedAt, data, error: null });
    } catch (error) {
      const known = asAgentDesktopError(error);
      return createCliEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: (known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host is not available.", true)).toAgentError(),
      });
    }
  }
}

export function isMcpStdioInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "mcp.start";
}

export function isServiceStartInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "service.start";
}

export function isServiceStopInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "service.stop";
}

export function isServiceRestartInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "service.restart";
}

export function isPairInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "pair";
}

export function isRevokeInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.id === "revoke";
}

export function assertCliCannotStartRuntime(): never {
  throw agentDesktopError(
    "CLI_RUNTIME_FORBIDDEN",
    "The NamiMail CLI must connect to an existing Agent host and cannot start Runtime or SQLite.",
    false,
    "Connect through the paired NamiMail Agent host instead.",
  );
}

function toText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "";
  return JSON.stringify(value, null, 2);
}

function toTable(value: JsonValue): string {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) return toText(value);
  const records = value as Array<Record<string, JsonValue>>;
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const rows = records.map((record) => columns.map((column) => toText(record[column] ?? null).replace(/[\r\n]+/g, " ")));
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
  return [render(columns), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n");
}

function exitCodeForError(error: AgentError): number {
  switch (error.code) {
    case "INVALID_ARGUMENT":
    case "TOOL_INPUT_INVALID": return 2;
    case "HOST_UNAVAILABLE":
    case "HOST_LEASE_UNAVAILABLE": return 3;
    case "PAIRING_REQUIRED":
    case "PAIRING_REVOKED":
    case "PAIRING_EXPIRED":
    case "BROKER_AUTHENTICATION_FAILED":
    case "BROKER_REPLAY_DETECTED":
    case "BROKER_COUNTER_INVALID": return 4;
    case "UPDATE_IN_PROGRESS": return 5;
    case "PERMISSION_DENIED":
    case "SCOPE_DENIED":
    case "CLI_RUNTIME_FORBIDDEN": return 6;
    default: return 1;
  }
}

export function formatCliEnvelope(envelope: CliEnvelope, output: CliOutputFormat): CliFormattedOutput {
  if (output === "json" || output === "jsonl") {
    return { stdout: `${JSON.stringify(envelope)}\n`, stderr: "", exitCode: envelope.error ? exitCodeForError(envelope.error) : 0 };
  }
  if (envelope.error) {
    const suggestion = envelope.error.suggestion ? `\n${envelope.error.suggestion}` : "";
    return { stdout: "", stderr: `${envelope.error.code}: ${envelope.error.message}${suggestion}\n`, exitCode: exitCodeForError(envelope.error) };
  }
  const content = output === "table" ? toTable(envelope.data) : toText(envelope.data);
  return { stdout: content ? `${content}\n` : "", stderr: "", exitCode: 0 };
}

export { cliCommands };
