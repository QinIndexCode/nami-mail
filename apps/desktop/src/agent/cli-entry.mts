import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  createAgentError,
  type AgentError,
} from "@nami/agent-contracts";
import {
  DesktopClientProfileStore,
  clientProfilesPath,
  readPairingOutcome,
  removePairingExchange,
  writePairingRequest,
  type DesktopSafeStorage,
} from "./broker-state.mjs";
import {
  createDesktopBrokerClient,
  probeDesktopBrokerLiveness,
} from "./desktop-broker.mjs";
import {
  createCliEnvelope,
  formatCliEnvelope,
  isMcpStdioInvocation,
  isPairInvocation,
  isRevokeInvocation,
  isServiceRestartInvocation,
  isServiceStartInvocation,
  isServiceStopInvocation,
  NamiMailCliClient,
  parseCliArguments,
  type CliEnvelope,
  type ParsedCliInvocation,
} from "./cli.mjs";
import { runNamiMailMcpStdio, NamiMailMcpToolAdapter } from "./mcp.mjs";
import { asAgentDesktopError, agentDesktopError } from "./contracts.mjs";

const pairingTimeoutMs = 120_000;
const hostStartupTimeoutMs = 25_000;
const pollIntervalMs = 250;
const mcpProtocolVersion = "2025-06-18";

export type DesktopCliEntryOptions = {
  argv: readonly string[];
  version: string;
  userDataPath: string;
  safeStorage: DesktopSafeStorage;
  input: Readable;
  output: Writable;
  error: Writable;
  /** Starts another packaged NamiMail process without giving the CLI data access. */
  launchNamiMail: (argumentsList: readonly string[]) => Promise<void>;
  /** Checks discovery and a signed response from the active local Broker host. */
  probeAgentHost?: (userDataPath: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

function now(options: DesktopCliEntryOptions): number {
  return options.now?.() ?? Date.now();
}

function sleep(options: DesktopCliEntryOptions, milliseconds: number): Promise<void> {
  if (options.sleep) return options.sleep(milliseconds);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function write(stream: Writable, value: string): void {
  stream.write(value);
}

function envelopeFailure(version: string, error: AgentError): CliEnvelope {
  return createCliEnvelope({ requestId: randomUUID(), version, durationMs: 0, data: null, error });
}

function emitEnvelope(options: DesktopCliEntryOptions, envelope: CliEnvelope, output: ParsedCliInvocation["output"]): number {
  const formatted = formatCliEnvelope(envelope, output);
  if (formatted.stdout) write(options.output, formatted.stdout);
  if (formatted.stderr) write(options.error, formatted.stderr);
  return formatted.exitCode;
}

function launcherInputError(invocation: ParsedCliInvocation, name: string, allowedOptions: readonly string[]): AgentError | undefined {
  if (invocation.positionals.length) {
    return createAgentError({ code: "INVALID_ARGUMENT", message: `${name} does not accept positional arguments.`, retryable: false });
  }
  const unexpected = invocation.providedOptions.find((option) => !allowedOptions.includes(option));
  if (unexpected) {
    return createAgentError({ code: "INVALID_ARGUMENT", message: `The --${unexpected} option is not valid for ${name}.`, retryable: false });
  }
  return undefined;
}

async function waitForPairingOutcome(options: DesktopCliEntryOptions, requestId: string) {
  const deadline = now(options) + pairingTimeoutMs;
  while (now(options) < deadline) {
    const outcome = await readPairingOutcome(options.userDataPath, requestId);
    if (outcome) return outcome;
    await sleep(options, pollIntervalMs);
  }
  return undefined;
}

async function waitForHost(options: DesktopCliEntryOptions): Promise<boolean> {
  const deadline = now(options) + hostStartupTimeoutMs;
  while (now(options) < deadline) {
    if (await isAgentHostLive(options)) return true;
    await sleep(options, pollIntervalMs);
  }
  return false;
}

async function isAgentHostLive(options: DesktopCliEntryOptions): Promise<boolean> {
  try {
    return await (options.probeAgentHost?.(options.userDataPath) ?? probeDesktopBrokerLiveness(options.userDataPath));
  } catch {
    return false;
  }
}

async function runPairing(options: DesktopCliEntryOptions, invocation: ParsedCliInvocation, operation: "pair" | "revoke"): Promise<CliEnvelope> {
  const profileStore = new DesktopClientProfileStore(clientProfilesPath(options.userDataPath), options.safeStorage);
  const startedAt = now(options);
  const profileName = invocation.options.profile;
  let requestId: string | undefined;
  try {
    let profile = await profileStore.read(profileName);
    if (operation === "pair") {
      if (profile?.pairedAt) {
        return createCliEnvelope({
          requestId: randomUUID(),
          version: options.version,
          durationMs: now(options) - startedAt,
          data: null,
          error: createAgentError({
            code: "CONFLICT",
            message: "This NamiMail Agent profile is already paired.",
            retryable: false,
            suggestion: `Run namimail revoke --profile ${profileName} before pairing it again.`,
          }),
        });
      }
      profile = await profileStore.createPending(profileName);
    } else if (!profile?.pairedAt) {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: null,
        error: createAgentError({ code: "PAIRING_REQUIRED", message: "This NamiMail Agent profile is not paired.", retryable: false }),
      });
    }
    if (!profile) throw agentDesktopError("PAIRING_REQUIRED", "The NamiMail Agent client profile is unavailable.");
    const request = await writePairingRequest(options.userDataPath, {
      operation,
      profile: profileName,
      clientId: profile.clientId,
      clientPublicKeyPem: profile.publicKeyPem,
    });
    requestId = request.requestId;
    await options.launchNamiMail(["--agent-pair", request.requestId]);
    const outcome = await waitForPairingOutcome(options, request.requestId);
    if (!outcome) {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: null,
        error: createAgentError({
          code: "PAIRING_REQUIRED",
          message: "NamiMail did not receive a pairing decision before the request expired.",
          retryable: true,
          suggestion: "Keep the NamiMail confirmation window open, then run the command again.",
        }),
      });
    }
    if (outcome.status !== "approved") {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: null,
        error: createAgentError({
          code: operation === "pair" ? "PAIRING_REQUIRED" : "PAIRING_REVOKED",
          message: operation === "pair" ? "NamiMail pairing was not approved." : "NamiMail did not revoke the requested profile.",
          retryable: false,
        }),
      });
    }
    return createCliEnvelope({
      requestId: randomUUID(),
      version: options.version,
      durationMs: now(options) - startedAt,
      data: operation === "pair"
        ? { status: "paired", profile: profileName, accountScope: "approved-account-snapshot" }
        : { status: "revoked", profile: profileName },
      error: null,
    });
  } catch (error) {
    const known = asAgentDesktopError(error);
    return envelopeFailure(options.version, (known ?? agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail could not complete the local pairing request.",
      true,
    )).toAgentError());
  } finally {
    if (requestId) await removePairingExchange(options.userDataPath, requestId);
  }
}

async function runServiceStart(options: DesktopCliEntryOptions): Promise<CliEnvelope> {
  const startedAt = now(options);
  try {
    if (await isAgentHostLive(options)) {
      return createCliEnvelope({ requestId: randomUUID(), version: options.version, durationMs: now(options) - startedAt, data: { status: "already-running" }, error: null });
    }
    await options.launchNamiMail(["--agent-host"]);
    if (!await waitForHost(options)) {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: null,
        error: createAgentError({
          code: "HOST_UNAVAILABLE",
          message: "NamiMail Agent host did not become ready.",
          retryable: true,
          suggestion: "Open NamiMail and try again after Windows PowerShell is available.",
        }),
      });
    }
    return createCliEnvelope({ requestId: randomUUID(), version: options.version, durationMs: now(options) - startedAt, data: { status: "started" }, error: null });
  } catch (error) {
    const known = asAgentDesktopError(error);
    return envelopeFailure(options.version, (known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail could not start the Agent host.", true)).toAgentError());
  }
}

async function runServiceStop(options: DesktopCliEntryOptions, invocation: ParsedCliInvocation): Promise<CliEnvelope> {
  const startedAt = now(options);
  try {
    if (!await isAgentHostLive(options)) {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: { status: "not-running" },
        error: null,
      });
    }
    const broker = createDesktopBrokerClient({
      userDataPath: options.userDataPath,
      safeStorage: options.safeStorage,
      profile: invocation.options.profile,
      entryPoint: "cli",
    });
    await broker.invoke({ command: "host.shutdown", arguments: {}, requestId: randomUUID() });
    return createCliEnvelope({
      requestId: randomUUID(),
      version: options.version,
      durationMs: now(options) - startedAt,
      data: { status: "stopping" },
      error: null,
    });
  } catch (error) {
    const known = asAgentDesktopError(error);
    return envelopeFailure(options.version, (known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail could not stop the Agent host.", true)).toAgentError());
  }
}

async function runServiceRestart(options: DesktopCliEntryOptions, invocation: ParsedCliInvocation): Promise<CliEnvelope> {
  const startedAt = now(options);
  try {
    let wasRunning = true;
    if (!await isAgentHostLive(options)) {
      wasRunning = false;
    } else {
      const broker = createDesktopBrokerClient({
        userDataPath: options.userDataPath,
        safeStorage: options.safeStorage,
        profile: invocation.options.profile,
        entryPoint: "cli",
      });
      await broker.invoke({ command: "host.shutdown", arguments: {}, requestId: randomUUID() });
      const deadline = now(options) + hostStartupTimeoutMs;
      while (now(options) < deadline && await isAgentHostLive(options)) {
        await sleep(options, pollIntervalMs);
      }
    }
    await options.launchNamiMail(["--agent-host"]);
    if (!await waitForHost(options)) {
      return createCliEnvelope({
        requestId: randomUUID(),
        version: options.version,
        durationMs: now(options) - startedAt,
        data: null,
        error: createAgentError({
          code: "HOST_UNAVAILABLE",
          message: "NamiMail Agent host did not become ready after restart.",
          retryable: true,
          suggestion: "Open NamiMail and try again after Windows PowerShell is available.",
        }),
      });
    }
    return createCliEnvelope({
      requestId: randomUUID(),
      version: options.version,
      durationMs: now(options) - startedAt,
      data: { status: "restarted", from: wasRunning ? "running" : "not-running" },
      error: null,
    });
  } catch (error) {
    const known = asAgentDesktopError(error);
    return envelopeFailure(options.version, (known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail could not restart the Agent host.", true)).toAgentError());
  }
}

async function runMcp(options: DesktopCliEntryOptions, invocation: ParsedCliInvocation): Promise<number> {
  const invalid = launcherInputError(invocation, "namimail mcp start", ["profile"]);
  if (invalid) {
    write(options.error, `${invalid.code}: ${invalid.message}\n`);
    return 2;
  }
  try {
    const broker = createDesktopBrokerClient({
      userDataPath: options.userDataPath,
      safeStorage: options.safeStorage,
      profile: invocation.options.profile,
      entryPoint: "mcp",
    });
    await runNamiMailMcpStdio({
      mcpProtocolVersion,
      serverInfo: { name: "NamiMail", version: options.version },
      toolAdapter: new NamiMailMcpToolAdapter({ broker }),
      input: options.input,
      output: options.output,
    });
    return 0;
  } catch (error) {
    const known = asAgentDesktopError(error);
    const rendered = known ?? agentDesktopError("HOST_UNAVAILABLE", "NamiMail MCP could not start.", true);
    write(options.error, `${rendered.code}: ${rendered.message}\n`);
    return 3;
  }
}

/** Executes a packaged CLI process. It never opens Runtime, Fastify, or SQLite. */
export async function runDesktopCli(options: DesktopCliEntryOptions): Promise<number> {
  const parsed = parseCliArguments(options.argv);
  if (!parsed.ok) return emitEnvelope(options, envelopeFailure(options.version, parsed.error), "table");
  const invocation = parsed.invocation;
  if (isMcpStdioInvocation(invocation)) {
    const invalid = launcherInputError(invocation, "namimail mcp start", ["profile", "output"]);
    if (invalid) return emitEnvelope(options, envelopeFailure(options.version, invalid), invocation.output);
    return runMcp(options, invocation);
  }
  if (isPairInvocation(invocation) || isRevokeInvocation(invocation)) {
    const invalid = launcherInputError(invocation, `namimail ${invocation.command.id}`, ["profile", "output"]);
    if (invalid) return emitEnvelope(options, envelopeFailure(options.version, invalid), invocation.output);
    const result = await runPairing(options, invocation, isPairInvocation(invocation) ? "pair" : "revoke");
    return emitEnvelope(options, result, invocation.output);
  }
  if (isServiceStartInvocation(invocation)) {
    const invalid = launcherInputError(invocation, "namimail service start", ["output"]);
    if (invalid) return emitEnvelope(options, envelopeFailure(options.version, invalid), invocation.output);
    return emitEnvelope(options, await runServiceStart(options), invocation.output);
  }
  if (isServiceStopInvocation(invocation)) {
    const invalid = launcherInputError(invocation, "namimail service stop", ["profile", "output"]);
    if (invalid) return emitEnvelope(options, envelopeFailure(options.version, invalid), invocation.output);
    return emitEnvelope(options, await runServiceStop(options, invocation), invocation.output);
  }
  if (isServiceRestartInvocation(invocation)) {
    const invalid = launcherInputError(invocation, "namimail service restart", ["profile", "output"]);
    if (invalid) return emitEnvelope(options, envelopeFailure(options.version, invalid), invocation.output);
    return emitEnvelope(options, await runServiceRestart(options, invocation), invocation.output);
  }
  const client = new NamiMailCliClient({
    version: options.version,
    broker: createDesktopBrokerClient({
      userDataPath: options.userDataPath,
      safeStorage: options.safeStorage,
      profile: invocation.options.profile,
      entryPoint: "cli",
    }),
  });
  return emitEnvelope(options, await client.invoke(invocation), invocation.output);
}
