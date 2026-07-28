import { randomUUID } from "node:crypto";
import type { AgentError } from "@nami/agent-contracts";
import { AGENT_PROTOCOL_VERSION, asAgentDesktopError, agentDesktopError } from "./contracts.mjs";
import type { JsonValue } from "./broker-protocol.mjs";
import type { AgentHostServiceStarter } from "./service-start.mjs";

export type CliOutputFormat = "table" | "json" | "jsonl" | "text";
export type CliCommandAccess = "local" | "read-only" | "service-start" | "mcp-stdio" | "requires-gui-confirmation";

export type CliCommandDefinition = {
  id: string;
  words: readonly string[];
  access: CliCommandAccess;
};

const cliCommands: readonly CliCommandDefinition[] = [
  { id: "help", words: ["help"], access: "local" },
  { id: "version", words: ["version"], access: "local" },
  { id: "doctor", words: ["doctor"], access: "read-only" },
  { id: "status", words: ["status"], access: "read-only" },
  { id: "accounts.list", words: ["accounts", "list"], access: "read-only" },
  { id: "folders.list", words: ["folders", "list"], access: "read-only" },
  { id: "messages.list", words: ["messages", "list"], access: "read-only" },
  { id: "messages.get", words: ["messages", "get"], access: "read-only" },
  { id: "messages.search", words: ["messages", "search"], access: "read-only" },
  { id: "threads.get", words: ["threads", "get"], access: "read-only" },
  { id: "attachments.list", words: ["attachments", "list"], access: "read-only" },
  { id: "attachments.export", words: ["attachments", "export"], access: "read-only" },
  { id: "rag.search", words: ["rag", "search"], access: "read-only" },
  { id: "rag.status", words: ["rag", "status"], access: "read-only" },
  { id: "rag.verify", words: ["rag", "verify"], access: "read-only" },
  { id: "agent.chat", words: ["agent", "chat"], access: "read-only" },
  { id: "agent.run", words: ["agent", "run"], access: "read-only" },
  { id: "mcp.start", words: ["mcp", "start"], access: "mcp-stdio" },
  { id: "service.start", words: ["service", "start"], access: "service-start" },
  { id: "drafts.create", words: ["drafts", "create"], access: "requires-gui-confirmation" },
  { id: "drafts.update", words: ["drafts", "update"], access: "requires-gui-confirmation" },
  { id: "drafts.delete", words: ["drafts", "delete"], access: "requires-gui-confirmation" },
  { id: "mail.reply", words: ["mail", "reply"], access: "requires-gui-confirmation" },
  { id: "mail.forward", words: ["mail", "forward"], access: "requires-gui-confirmation" },
  { id: "mail.send", words: ["mail", "send"], access: "requires-gui-confirmation" },
  { id: "mail.archive", words: ["mail", "archive"], access: "requires-gui-confirmation" },
  { id: "mail.move", words: ["mail", "move"], access: "requires-gui-confirmation" },
  { id: "mail.trash", words: ["mail", "trash"], access: "requires-gui-confirmation" },
  { id: "mail.mark-read", words: ["mail", "mark-read"], access: "requires-gui-confirmation" },
  { id: "mail.mark-unread", words: ["mail", "mark-unread"], access: "requires-gui-confirmation" },
  { id: "rag.rebuild", words: ["rag", "rebuild"], access: "requires-gui-confirmation" },
];

const commandByLength = [...cliCommands].sort((left, right) => right.words.length - left.words.length);
const valueOptions = new Set(["output", "account", "folder", "limit", "since", "before", "query", "message", "thread", "attachment"]);
const booleanOptions = new Set(["dry-run", "yes", "interactive", "non-interactive"]);
const outputFormats = new Set<CliOutputFormat>(["table", "json", "jsonl", "text"]);

export type ParsedCliInvocation = {
  command: CliCommandDefinition;
  output: CliOutputFormat;
  options: {
    account?: string;
    folder?: string;
    limit?: number;
    since?: string;
    before?: string;
    query?: string;
    message?: string;
    thread?: string;
    attachment?: string;
    dryRun: boolean;
    yes: boolean;
    interactive: boolean;
  };
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
  arguments: Omit<ParsedCliInvocation, "command" | "output">;
  requestId: string;
};

/**
 * The only external client dependency. It intentionally has no process,
 * runtime, database, HTTP, or fallback-start method in its surface area.
 */
export interface NamiMailBrokerClient {
  readonly transport: "windows-named-pipe";
  invoke(request: CliBrokerRequest): Promise<JsonValue>;
}

export type NamiMailCliClientOptions = {
  broker?: NamiMailBrokerClient;
  serviceStarter?: AgentHostServiceStarter;
  version: string;
  now?: () => number;
  createRequestId?: () => string;
};

function parseFailure(message: string, suggestion?: string): CliParseResult {
  return {
    ok: false,
    error: agentDesktopError("INVALID_ARGUMENT", message, false, suggestion).toAgentError(),
  };
}

function commandMatches(argv: readonly string[], words: readonly string[]): boolean {
  return words.every((word, index) => argv[index] === word);
}

function commandWithExactWords(argv: readonly string[]): CliCommandDefinition | undefined {
  return cliCommands.find((candidate) => candidate.id !== "help" && candidate.words.length === argv.length && commandMatches(argv, candidate.words));
}

function defaultCliOptions(): ParsedCliInvocation["options"] {
  return {
    dryRun: false,
    yes: false,
    interactive: false,
  };
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
      positionals: target ? [...target.words] : [],
      ...(target ? { helpTarget: target } : {}),
    },
  };
}

function parseHelpInvocation(argv: readonly string[]): CliParseResult | undefined {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return helpInvocation();
  if (argv[0] === "help") {
    if (argv.length === 1) return helpInvocation();
    const target = commandWithExactWords(argv.slice(1));
    return target
      ? helpInvocation(target)
      : parseFailure("The requested NamiMail help topic is not recognized.", "Run namimail help for supported commands.");
  }

  const separatorIndex = argv.indexOf("--");
  const commandTokens = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const helpIndex = commandTokens.findIndex((token) => token === "--help" || token === "-h");
  if (helpIndex === -1) return undefined;
  if (helpIndex !== commandTokens.length - 1 || separatorIndex !== -1) {
    return parseFailure("Use --help only as the final command option.", "Run namimail help for supported commands.");
  }
  const target = commandWithExactWords(commandTokens.slice(0, helpIndex));
  return target
    ? helpInvocation(target)
    : parseFailure("The requested NamiMail help topic is not recognized.", "Run namimail help for supported commands.");
}

function parseLimit(value: string): number | undefined {
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 1_000 ? parsed : undefined;
}

function parseOptionToken(argv: readonly string[], index: number): { name: string; value?: string; nextIndex: number } | undefined {
  const token = argv[index];
  if (!token?.startsWith("--") || token === "--") return undefined;
  const equalsIndex = token.indexOf("=");
  if (equalsIndex !== -1) {
    const name = token.slice(2, equalsIndex);
    const value = token.slice(equalsIndex + 1);
    return name && value ? { name, value, nextIndex: index + 1 } : undefined;
  }
  const name = token.slice(2);
  if (booleanOptions.has(name)) return name ? { name, nextIndex: index + 1 } : undefined;
  const value = argv[index + 1];
  return name && value && !value.startsWith("--") ? { name, value, nextIndex: index + 2 } : undefined;
}

export function parseCliArguments(argv: readonly string[]): CliParseResult {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((argument) => typeof argument !== "string" || argument.length > 8_192)) {
    return parseFailure("A NamiMail command is required.", "Run namimail --help for supported commands.");
  }

  const help = parseHelpInvocation(argv);
  if (help) return help;

  const command = commandByLength.find((candidate) => commandMatches(argv, candidate.words));
  if (!command) return parseFailure("The NamiMail command is not recognized.", "Run namimail --help for supported commands.");
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
    if (!parsed || (!valueOptions.has(parsed.name) && !booleanOptions.has(parsed.name))) {
      return parseFailure(`The option ${token.slice(0, 128)} is not valid for NamiMail.`);
    }
    if (seenOptions.has(parsed.name)) return parseFailure(`The option --${parsed.name} was provided more than once.`);
    seenOptions.add(parsed.name);
    index = parsed.nextIndex;

    if (booleanOptions.has(parsed.name)) {
      if (parsed.value !== undefined) return parseFailure(`The option --${parsed.name} does not accept a value.`);
      if (parsed.name === "non-interactive") options.interactive = false;
      else if (parsed.name === "interactive") options.interactive = true;
      else if (parsed.name === "dry-run") options.dryRun = true;
      else options.yes = true;
      continue;
    }
    if (!parsed.value) return parseFailure(`The option --${parsed.name} requires a value.`);
    if (parsed.name === "output") {
      if (!outputFormats.has(parsed.value as CliOutputFormat)) {
        return parseFailure("The requested output format is not supported.");
      }
      output = parsed.value as CliOutputFormat;
      continue;
    }
    if (parsed.name === "limit") {
      const limit = parseLimit(parsed.value);
      if (!limit) return parseFailure("The --limit value must be an integer between 1 and 1000.");
      options.limit = limit;
      continue;
    }
    options[optionPropertyName(parsed.name)] = parsed.value;
  }

  if (seenOptions.has("interactive") && seenOptions.has("non-interactive")) {
    return parseFailure("Use only one of --interactive or --non-interactive.");
  }
  return {
    ok: true,
    invocation: {
      command,
      output,
      options,
      positionals,
    },
  };
}

function optionPropertyName(option: Exclude<typeof valueOptions extends Set<infer Value> ? Value : never, "output" | "limit">): Exclude<keyof ParsedCliInvocation["options"], "dryRun" | "yes" | "interactive" | "limit"> {
  const names: Record<string, Exclude<keyof ParsedCliInvocation["options"], "dryRun" | "yes" | "interactive" | "limit">> = {
    account: "account",
    folder: "folder",
    since: "since",
    before: "before",
    query: "query",
    message: "message",
    thread: "thread",
    attachment: "attachment",
  };
  return names[option] as Exclude<keyof ParsedCliInvocation["options"], "dryRun" | "yes" | "interactive" | "limit">;
}

function createEnvelope<TData extends JsonValue>(input: {
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
    meta: {
      durationMs: Math.max(0, Math.round(input.durationMs)),
      version: input.version,
    },
  };
}

function localVersionPayload(version: string): JsonValue {
  return { name: "NamiMail", version };
}

function localHelpPayload(version: string, target?: CliCommandDefinition): JsonValue {
  const commands = target ? [target] : cliCommands;
  return {
    name: "NamiMail",
    version,
    usage: target
      ? `namimail ${target.words.join(" ")} [options]`
      : "namimail <command> [options]",
    commands: commands.map((command) => ({
      command: command.words.join(" "),
      id: command.id,
      access: command.access,
    })),
  };
}

function serviceStartPayload(result: Awaited<ReturnType<AgentHostServiceStarter["start"]>>): JsonValue {
  return {
    status: result.status,
    ...(result.pid === undefined ? {} : { pid: result.pid }),
  };
}

function localMcpStartError(): AgentError {
  return agentDesktopError(
    "NOT_SUPPORTED",
    "The MCP stdio command must be handled by the installed NamiMail MCP launcher.",
    false,
    "Run namimail mcp start from an MCP client configuration.",
  ).toAgentError();
}

/**
 * External command behavior. This class can use an already running secured
 * broker only; it cannot open the NamiMail database or start a second Runtime.
 */
export class NamiMailCliClient {
  constructor(private readonly options: NamiMailCliClientOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async invoke(invocation: ParsedCliInvocation): Promise<CliEnvelope> {
    const startedAt = this.now();
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    if (invocation.command.access === "local") {
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: invocation.command.id === "help"
          ? localHelpPayload(this.options.version, invocation.helpTarget)
          : localVersionPayload(this.options.version),
        error: null,
      });
    }
    if (invocation.command.access === "service-start") {
      if (!this.options.serviceStarter) {
        return createEnvelope({
          requestId,
          version: this.options.version,
          durationMs: this.now() - startedAt,
          data: null,
          error: agentDesktopError(
            "HOST_UNAVAILABLE",
            "The installed NamiMail CLI cannot start an Agent host in this environment.",
            true,
            "Open NamiMail, then retry the command.",
          ).toAgentError(),
        });
      }
      try {
        const result = await this.options.serviceStarter.start();
        return createEnvelope({
          requestId,
          version: this.options.version,
          durationMs: this.now() - startedAt,
          data: serviceStartPayload(result),
          error: null,
        });
      } catch (error) {
        const knownError = asAgentDesktopError(error);
        return createEnvelope({
          requestId,
          version: this.options.version,
          durationMs: this.now() - startedAt,
          data: null,
          error: (knownError ?? agentDesktopError(
            "HOST_UNAVAILABLE",
            "NamiMail could not start the Agent host.",
            true,
          )).toAgentError(),
        });
      }
    }
    if (invocation.command.access === "mcp-stdio") {
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: localMcpStartError(),
      });
    }
    if (invocation.command.access !== "read-only") {
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: agentDesktopError(
          "PERMISSION_DENIED",
          "External NamiMail commands are read-only. This operation requires a visible in-app confirmation.",
          false,
          "Open NamiMail and complete the operation from the Agent workspace.",
        ).toAgentError(),
      });
    }
    const broker = this.options.broker;
    if (!broker) {
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: agentDesktopError(
          "HOST_UNAVAILABLE",
          "NamiMail Agent host is not available.",
          true,
          "Open NamiMail or run namimail service start.",
        ).toAgentError(),
      });
    }
    if (broker.transport !== "windows-named-pipe") {
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: agentDesktopError(
          "BROKER_SECURITY_UNAVAILABLE",
          "NamiMail only accepts secured Windows named-pipe Agent IPC.",
          false,
        ).toAgentError(),
      });
    }
    try {
      const data = await broker.invoke({
        command: invocation.command.id,
        arguments: {
          options: invocation.options,
          positionals: invocation.positionals,
        },
        requestId,
      });
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data,
        error: null,
      });
    } catch (error) {
      const knownError = asAgentDesktopError(error);
      return createEnvelope({
        requestId,
        version: this.options.version,
        durationMs: this.now() - startedAt,
        data: null,
        error: (knownError ?? agentDesktopError(
          "HOST_UNAVAILABLE",
          "NamiMail Agent host is not available. Start NamiMail or run namimail service start.",
          true,
        )).toAgentError(),
      });
    }
  }
}

export function isMcpStdioInvocation(invocation: ParsedCliInvocation): boolean {
  return invocation.command.access === "mcp-stdio";
}

export function assertCliCannotStartRuntime(): never {
  throw agentDesktopError(
    "CLI_RUNTIME_FORBIDDEN",
    "The NamiMail CLI must connect to an existing Agent host and cannot start Runtime or SQLite.",
    false,
    "Start the service explicitly with NamiMail, then retry the command.",
  );
}

function toText(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "";
  return JSON.stringify(value, null, 2);
}

function toTable(value: JsonValue): string {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    return toText(value);
  }
  const records = value as Array<Record<string, JsonValue>>;
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const rows = records.map((record) => columns.map((column) => toText(record[column] ?? null).replace(/[\r\n]+/g, " ")));
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
  return [render(columns), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n");
}

function exitCodeForError(error: AgentError): number {
  switch (error.code) {
    case "INVALID_ARGUMENT": return 2;
    case "HOST_UNAVAILABLE":
    case "HOST_LEASE_UNAVAILABLE": return 3;
    case "PAIRING_REQUIRED":
    case "PAIRING_REVOKED":
    case "BROKER_AUTHENTICATION_FAILED":
    case "BROKER_REPLAY_DETECTED": return 4;
    case "UPDATE_IN_PROGRESS": return 5;
    case "PERMISSION_DENIED":
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
    return {
      stdout: "",
      stderr: `${envelope.error.code}: ${envelope.error.message}${suggestion}\n`,
      exitCode: exitCodeForError(envelope.error),
    };
  }
  const content = output === "table" ? toTable(envelope.data) : toText(envelope.data);
  return { stdout: content ? `${content}\n` : "", stderr: "", exitCode: 0 };
}

export { cliCommands };
