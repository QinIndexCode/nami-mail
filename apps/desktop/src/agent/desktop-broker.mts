import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  createAgentError,
  createAgentFailureEnvelope,
  isAgentErrorCode,
  type AgentError,
  type AgentResponseEnvelope,
  type BrokerJsonValue,
  type CallerContext,
  type ExternalPairingSummary,
} from "@nami/agent-contracts";
import {
  createHostIdentityProof,
  signBrokerRequest,
  signBrokerResponse,
  verifyBrokerRequest,
  verifyBrokerResponse,
  type BrokerRequestFrame,
} from "./broker-protocol.mjs";
import {
  DesktopBrokerState,
  DesktopClientProfileStore,
  type BrokerClientProfile,
  type DesktopSafeStorage,
} from "./broker-state.mjs";
import { AGENT_PROTOCOL_VERSION, agentDesktopError, asAgentDesktopError } from "./contracts.mjs";
import { WindowsSidDaclPipeRelay, expectedPipePath, maximumMessageLength } from "./secure-pipe-relay.mjs";

const discoveryVersion = 1;
const brokerTimeoutMs = 30_000;
const brokerLivenessTimeoutMs = 2_000;
const brokerLivenessAttemptTimeoutMs = 500;
const brokerLivenessRetryDelayMs = 50;
const identifierPattern = /^[A-Za-z0-9_-]{16,160}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{16,160}$/;

export type ExternalAgentToolBridge = {
  invokeExternalAgentTool: (input: {
    requestId: string;
    caller: CallerContext;
    toolName: string;
    input: unknown;
  }) => Promise<AgentResponseEnvelope<BrokerJsonValue>>;
};

export type DesktopBrokerDiscovery = {
  schemaVersion: typeof discoveryVersion;
  transport: "windows-named-pipe";
  pipeName: string;
  path: string;
  ownerSid: string;
  hostId: string;
  hostPublicKeyPem: string;
  bootId: string;
  startedAt: string;
};

export type DesktopBrokerHostOptions = {
  userDataPath: string;
  safeStorage: DesktopSafeStorage;
  scriptPath: string;
  invokeExternalAgentTool: ExternalAgentToolBridge["invokeExternalAgentTool"];
  onDiagnostic?: (message: string) => void;
  /** Invoked after the shutdown response is delivered when a paired client requests host shutdown. */
  onHostShutdown?: () => void | Promise<void>;
};

export type DesktopBrokerInvocation = {
  command: string;
  arguments: BrokerJsonValue;
  requestId: string;
};

export type DoctorDiagnosticRow = {
  check: string;
  status: "ok" | "warn" | "error";
  detail: string;
};

export type DesktopBrokerClientOptions = {
  userDataPath: string;
  safeStorage: DesktopSafeStorage;
  profile: string;
  entryPoint: "cli" | "mcp";
};

type BrokerCommandPayload = {
  entryPoint: "cli" | "mcp";
  command: string;
  arguments: BrokerJsonValue;
};

type HostIdentity = Awaited<ReturnType<DesktopBrokerState["hostIdentity"]>>;

function now(): string {
  return new Date().toISOString();
}

function discoveryPath(userDataPath: string): string {
  return path.join(userDataPath, "agent-broker-discovery.json");
}

function brokerStatePath(userDataPath: string): string {
  return path.join(userDataPath, "agent-broker-state.json");
}

function clientProfilesPath(userDataPath: string): string {
  return path.join(userDataPath, "agent-client-profiles.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is BrokerJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.entries(value).every(([key, entry]) => !["__proto__", "constructor", "prototype"].includes(key) && isJsonValue(entry, seen));
}

function validDiscovery(value: unknown): value is DesktopBrokerDiscovery {
  return isPlainObject(value)
    && value.schemaVersion === discoveryVersion
    && value.transport === "windows-named-pipe"
    && typeof value.pipeName === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.pipeName)
    && typeof value.path === "string"
    && value.path === expectedPipePath(value.pipeName)
    && typeof value.ownerSid === "string"
    && /^S-1-(?:0|1|2|3|5|15|16|18)-(?:\d+-){1,14}\d+$/.test(value.ownerSid)
    && typeof value.hostId === "string"
    && identifierPattern.test(value.hostId)
    && typeof value.hostPublicKeyPem === "string"
    && typeof value.bootId === "string"
    && identifierPattern.test(value.bootId)
    && typeof value.startedAt === "string"
    && Number.isFinite(Date.parse(value.startedAt));
}

async function writeAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function readDiscovery(userDataPath: string): Promise<DesktopBrokerDiscovery> {
  try {
    const value = JSON.parse(await fs.readFile(discoveryPath(userDataPath), "utf8")) as unknown;
    if (!validDiscovery(value)) throw new Error("invalid discovery");
    return value;
  } catch {
    throw agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail Agent host is not running.",
      true,
      "Open Nami Mail or run namimail service start.",
    );
  }
}

/** Reads only non-secret host discovery metadata for the managed launcher. */
export async function readDesktopBrokerDiscovery(userDataPath: string): Promise<DesktopBrokerDiscovery | undefined> {
  try {
    return await readDiscovery(userDataPath);
  } catch {
    return undefined;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Verifies that discovery identifies a currently reachable Broker that can
 * prove the expected host identity. The probe is deliberately unsigned and
 * uses a unique, unpaired client identity, so it cannot advance a real
 * pairing counter or access mail data.
 */
export async function probeDesktopBrokerLiveness(
  userDataPath: string,
  timeoutMs = brokerLivenessTimeoutMs,
): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > brokerTimeoutMs) return false;
  const discovery = await readDesktopBrokerDiscovery(userDataPath);
  if (!discovery) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestId = `probe-${randomBytes(18).toString("base64url")}`;
    const requestCounter = "1";
    const probe = {
      type: "request",
      protocolVersion: AGENT_PROTOCOL_VERSION,
      requestId,
      hostId: discovery.hostId,
      bootId: discovery.bootId,
      clientId: `probe-${randomBytes(18).toString("base64url")}`,
      counter: requestCounter,
      payload: { entryPoint: "cli", command: "status", arguments: {} },
      signature: randomBytes(64).toString("base64url"),
    };
    try {
      const remaining = deadline - Date.now();
      const rawResponse = await requestPipe(
        discovery.path,
        JSON.stringify(probe),
        Math.max(100, Math.min(brokerLivenessAttemptTimeoutMs, remaining)),
      );
      const response = JSON.parse(rawResponse) as unknown;
      return verifyBrokerResponse(response, {
        pairing: {
          hostId: discovery.hostId,
          hostPublicKeyPem: discovery.hostPublicKeyPem,
        },
        requestId,
        requestCounter,
        bootId: discovery.bootId,
      }).ok;
    } catch {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(brokerLivenessRetryDelayMs, remaining));
    }
  }
  return false;
}

function incrementCounter(value: string): string {
  if (!/^(0|[1-9]\d{0,18})$/.test(value)) {
    throw agentDesktopError("BROKER_COUNTER_INVALID", "The NamiMail Agent client counter is invalid.");
  }
  const next = BigInt(value) + 1n;
  if (next > 9_223_372_036_854_775_807n) {
    throw agentDesktopError("BROKER_COUNTER_INVALID", "The NamiMail Agent client counter is exhausted.");
  }
  return next.toString(10);
}

function brokerFailurePayload(requestId: string, error: AgentError): AgentResponseEnvelope<BrokerJsonValue> {
  return createAgentFailureEnvelope({ requestId, error, meta: { durationMs: 0 } });
}

function serializableAgentError(error: AgentError): BrokerJsonValue {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.suggestion ? { suggestion: error.suggestion } : {}),
  };
}

/**
 * AgentError.details intentionally accepts unknown values for in-process audit
 * context. A signed wire response must be strict JSON, so it only retains the
 * stable public error fields rather than serializing arbitrary detail data.
 */
function serializableResponseEnvelope(response: AgentResponseEnvelope<BrokerJsonValue>): BrokerJsonValue {
  if (response.success) {
    return {
      protocolVersion: response.protocolVersion,
      requestId: response.requestId,
      success: true,
      data: response.data,
      error: null,
      meta: {
        contractVersion: response.meta.contractVersion,
        durationMs: response.meta.durationMs,
        ...(response.meta.traceId ? { traceId: response.meta.traceId } : {}),
      },
    };
  }
  return {
    protocolVersion: response.protocolVersion,
    requestId: response.requestId,
    success: false,
    data: null,
    error: serializableAgentError(response.error),
    meta: {
      contractVersion: response.meta.contractVersion,
      durationMs: response.meta.durationMs,
      ...(response.meta.traceId ? { traceId: response.meta.traceId } : {}),
    },
  };
}

function externalCaller(
  pairing: { clientId: string; scopes: readonly string[]; accountIds?: readonly string[] },
  entryPoint: "cli" | "mcp",
): CallerContext | undefined {
  if (!pairing.scopes.includes("mail-read") || !pairing.accountIds?.length) return undefined;
  return {
    callerId: pairing.clientId,
    kind: entryPoint,
    entryPoint,
    accessLevel: "read-only",
    scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments"],
    accountScope: { mode: "selected", accountIds: [...pairing.accountIds] },
    interactive: false,
    canRequestConfirmation: false,
  };
}

function validBrokerPayload(value: unknown): value is BrokerCommandPayload {
  return isPlainObject(value)
    && (value.entryPoint === "cli" || value.entryPoint === "mcp")
    && typeof value.command === "string"
    && /^[a-z][a-z0-9._-]{0,127}$/.test(value.command)
    && isJsonValue(value.arguments);
}

function cliToolInput(command: string, argumentsValue: BrokerJsonValue): { toolName: string; input: BrokerJsonValue } | undefined {
  // The managed launcher validates options into this direct contract shape.
  // The server repeats validation before ToolRegistry execution.
  return mcpToolInput(command, argumentsValue);
}

const externalReadToolNames = ["accounts.list", "folders.list", "messages.list", "mail.summarize", "messages.get", "messages.batch_get", "threads.get", "attachments.list"] as const;
const externalWriteToolNames = [
  "mail.draft.create",
  "mail.draft.update",
  "mail.draft.delete",
  "messages.move",
  "messages.set-flag",
  "messages.send",
  "mail.reply",
] as const;
export const externalToolNames = [...externalReadToolNames, ...externalWriteToolNames] as const;

function mcpToolInput(command: string, argumentsValue: BrokerJsonValue): { toolName: string; input: BrokerJsonValue } | undefined {
  const toolNames: ReadonlySet<string> = new Set(externalToolNames);
  return toolNames.has(command) && isPlainObject(argumentsValue)
    ? { toolName: command, input: argumentsValue }
    : undefined;
}

function parseEnvelope(value: unknown): AgentResponseEnvelope<BrokerJsonValue> | undefined {
  if (!isPlainObject(value)
    || typeof value.requestId !== "string"
    || typeof value.success !== "boolean"
    || !isPlainObject(value.meta)
    || typeof value.meta.durationMs !== "number") return undefined;
  if (value.success === true && value.error === null && isJsonValue(value.data)) {
    return value as AgentResponseEnvelope<BrokerJsonValue>;
  }
  if (value.success === false && value.data === null && isPlainObject(value.error)
    && typeof value.error.code === "string"
    && typeof value.error.message === "string"
    && typeof value.error.retryable === "boolean") {
    return value as AgentResponseEnvelope<BrokerJsonValue>;
  }
  return undefined;
}

function requestIdentity(value: unknown): { requestId: string; counter: string } | undefined {
  if (!isPlainObject(value) || typeof value.requestId !== "string" || typeof value.counter !== "string") return undefined;
  if (!requestIdPattern.test(value.requestId) || !/^(0|[1-9]\d{0,18})$/.test(value.counter)) return undefined;
  return { requestId: value.requestId, counter: value.counter };
}

async function requestPipe(pathname: string, request: string, timeoutMs = brokerTimeoutMs): Promise<string> {
  if (
    !pathname.startsWith("\\\\.\\pipe\\")
    || request.length > maximumMessageLength
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > brokerTimeoutMs
  ) {
    throw agentDesktopError("BROKER_SECURITY_UNAVAILABLE", "The NamiMail Agent pipe endpoint is invalid.");
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let received = "";
    const socket = net.createConnection(pathname);
    const finishFailure = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };
    const finishSuccess = (line: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      let closeTimeout: NodeJS.Timeout | undefined;
      const complete = () => {
        if (!closeTimeout) return;
        clearTimeout(closeTimeout);
        closeTimeout = undefined;
        socket.destroy();
        resolve(line);
      };
      socket.once("close", complete);
      socket.once("error", complete);
      closeTimeout = setTimeout(complete, 250);
      closeTimeout.unref?.();
      try {
        // Electron's named-pipe client can leave a relay instance occupied
        // after an abrupt destroy. Complete the response exchange first so
        // PowerShell can recreate its single-instance SID-DACL pipe.
        socket.end();
      } catch {
        complete();
      }
    };
    const timeout = setTimeout(() => finishFailure(() => reject(agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail Agent host did not respond in time.",
      true,
      "Open Nami Mail and try again.",
    ))), timeoutMs);
    timeout.unref?.();
    socket.once("connect", () => {
      socket.write(`${request}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.length > maximumMessageLength) {
        finishFailure(() => reject(agentDesktopError("BROKER_AUTHENTICATION_FAILED", "The NamiMail Agent response is too large.")));
        return;
      }
      const lineEnd = received.indexOf("\n");
      if (lineEnd === -1) return;
      const line = received.slice(0, lineEnd).replace(/\r$/, "");
      finishSuccess(line);
    });
    socket.once("error", () => finishFailure(() => reject(agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail Agent host is not available.",
      true,
      "Open Nami Mail or run namimail service start.",
    ))));
    socket.once("end", () => {
      if (!settled) finishFailure(() => reject(agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host closed the local pipe.", true)));
    });
  });
}

/** The in-process authenticated Broker host. Its pipe transport never opens mail data. */
export class DesktopAgentBrokerHost {
  private readonly state: DesktopBrokerState;
  private relay: WindowsSidDaclPipeRelay | undefined;
  private identity: HostIdentity | undefined;
  private bootId: string | undefined;
  private discovery: DesktopBrokerDiscovery | undefined;
  private acceptingRequests = false;
  private activeRequestCount = 0;
  private activeRequestsSettled: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: DesktopBrokerHostOptions) {
    this.state = new DesktopBrokerState(brokerStatePath(options.userDataPath), options.safeStorage);
  }

  getDiscovery(): DesktopBrokerDiscovery | undefined {
    return this.discovery ? { ...this.discovery } : undefined;
  }

  async start(): Promise<DesktopBrokerDiscovery> {
    if (this.discovery) return { ...this.discovery };
    const identity = await this.state.hostIdentity();
    const bootId = `boot-${randomBytes(18).toString("base64url")}`;
    const relay = new WindowsSidDaclPipeRelay({
      scriptPath: this.options.scriptPath,
      onRequest: (payload) => this.handleRawRequest(payload),
      onStderr: (line) => this.options.onDiagnostic?.(`Agent pipe: ${line}`),
    });
    const endpoint = await relay.start();
    const discovery: DesktopBrokerDiscovery = {
      schemaVersion: discoveryVersion,
      transport: "windows-named-pipe",
      pipeName: endpoint.pipeName,
      path: endpoint.path,
      ownerSid: endpoint.ownerSid,
      hostId: identity.hostId,
      hostPublicKeyPem: identity.publicKeyPem,
      bootId,
      startedAt: now(),
    };
    try {
      await writeAtomically(discoveryPath(this.options.userDataPath), discovery);
    } catch (error) {
      await relay.close();
      throw error;
    }
    this.identity = identity;
    this.bootId = bootId;
    this.relay = relay;
    this.discovery = discovery;
    this.acceptingRequests = true;
    return { ...discovery };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.acceptingRequests = false;
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  /** Stops new external work, waits for admitted work, then closes the native relay. */
  async drainForUpdate(): Promise<void> {
    await this.close();
  }

  /** The relay itself verified the SID DACL at creation; this checks it remains live. */
  async verifyActiveSidDaclPipe(): Promise<boolean> {
    const discovery = this.discovery;
    const endpoint = this.relay?.getEndpoint();
    return Boolean(
      discovery
      && endpoint
      && this.relay?.isLive()
      && endpoint.path === discovery.path
      && endpoint.pipeName === discovery.pipeName
      && endpoint.ownerSid === discovery.ownerSid,
    );
  }

  /** Runs `namimail doctor` checks and returns one row per check for table rendering. */
  private async runDoctorDiagnostics(): Promise<DoctorDiagnosticRow[]> {
    const rows: DoctorDiagnosticRow[] = [];
    const push = (check: string, status: DoctorDiagnosticRow["status"], detail: string) => rows.push({ check, status, detail });

    if (this.options.safeStorage.isEncryptionAvailable()) {
      push("safe-storage", "ok", "Windows credential protection is available for encrypted Broker state.");
    } else {
      push("safe-storage", "error", "Windows credential protection is unavailable; protected state cannot be decrypted.");
    }

    try {
      await this.state.hostIdentity();
      push("broker-state", "ok", "Broker identity and pairing store are readable and intact.");
    } catch (error) {
      push("broker-state", "error", `Broker state cannot be read: ${errorMessage(error)}`);
    }

    try {
      const summary = await this.state.diagnostics();
      if (summary.pairingCount === 0) {
        push("pairings", "warn", "No paired profiles. Run namimail pair --profile <name> and approve it in Nami Mail.");
      } else {
        push(
          "pairings",
          "ok",
          `${summary.activePairingCount} active, ${summary.revokedPairingCount} revoked (${summary.pairingCount} total).`,
        );
      }
    } catch (error) {
      push("pairings", "error", `Pairing store cannot be read: ${errorMessage(error)}`);
    }

    try {
      await fs.access(this.options.userDataPath, fs.constants.W_OK);
      push("user-data", "ok", `${this.options.userDataPath} exists and is writable.`);
    } catch {
      push("user-data", "error", `User data directory is missing or not writable: ${this.options.userDataPath}`);
    }

    if (this.discovery && this.bootId) {
      try {
        const existing = await readDiscovery(this.options.userDataPath);
        if (existing.bootId === this.bootId) {
          push("discovery", "ok", "Discovery file matches the running host boot.");
        } else {
          push("discovery", "warn", "Discovery file belongs to a different host boot; stale clients may reconnect to the wrong host.");
        }
      } catch {
        push("discovery", "warn", "Discovery file is missing or unreadable while the host is running.");
      }
    } else {
      push("discovery", "error", "Broker discovery is not active.");
    }

    const pipeActive = await this.verifyActiveSidDaclPipe();
    push(
      "agent-pipe",
      pipeActive ? "ok" : "error",
      pipeActive ? "Agent named pipe is live with the expected SID-DACL." : "Agent named pipe is not active or its SID-DACL changed.",
    );

    return rows;
  }

  async revokeReadOnlyPairing(clientId: string): Promise<boolean> {
    if (!identifierPattern.test(clientId)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent client identifier is invalid.");
    }
    return this.state.revoke(clientId, now());
  }

  /**
   * Non-secret pairing summaries for the renderer settings panel and the
   * desktop drift check. Never includes keys or counters.
   */
  async describePairings(): Promise<ExternalPairingSummary[]> {
    const records = await this.state.list();
    return records.map((record) => ({
      clientId: record.clientId,
      createdAt: record.createdAt,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
      accountIds: [...(record.accountIds ?? [])],
    }));
  }

  private async closeOnce(): Promise<void> {
    await this.waitForActiveRequests();
    const discovery = this.discovery;
    this.discovery = undefined;
    this.bootId = undefined;
    this.identity = undefined;
    const relay = this.relay;
    this.relay = undefined;
    if (discovery) {
      try {
        const existing = await readDiscovery(this.options.userDataPath);
        if (existing.bootId === discovery.bootId) await fs.unlink(discoveryPath(this.options.userDataPath));
      } catch {
        // The discovery file may already belong to a newer host or be absent.
      }
    }
    await relay?.close();
  }

  private waitForActiveRequests(timeoutMs = 1_000): Promise<void> {
    if (this.activeRequestCount === 0) return Promise.resolve();
    // Bounded wait: a hung external agent request must never block desktop
    // shutdown forever (close() is awaited outside the main shutdown budget).
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeRequestsSettled = undefined;
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.activeRequestsSettled = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private releaseActiveRequest(): void {
    this.activeRequestCount -= 1;
    if (this.activeRequestCount === 0) {
      const settle = this.activeRequestsSettled;
      this.activeRequestsSettled = undefined;
      settle?.();
    }
  }

  async createReadOnlyPairing(input: { clientId: string; clientPublicKeyPem: string; accountIds: readonly string[] }): Promise<{ hostId: string; hostPublicKeyPem: string }> {
    const identity = this.identity ?? await this.state.hostIdentity();
    await this.state.createReadOnlyPairing(input);
    return { hostId: identity.hostId, hostPublicKeyPem: identity.publicKeyPem };
  }

  private async handleRawRequest(raw: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify({ type: "response", error: "invalid-request" });
    }
    const identity = this.identity;
    const bootId = this.bootId;
    if (!identity || !bootId) return JSON.stringify({ type: "response", error: "host-unavailable" });
    const identifiers = requestIdentity(parsed);
    if (!identifiers) return JSON.stringify({ type: "response", error: "invalid-request" });
    const hostIdentity = createHostIdentityProof({
      hostId: identity.hostId,
      bootId,
      publicKeyPem: identity.publicKeyPem,
      issuedAt: now(),
      privateKey: identity.privateKeyPem,
    });
    const respond = (payload: BrokerJsonValue): string => JSON.stringify(signBrokerResponse({
      requestId: identifiers.requestId,
      requestCounter: identifiers.counter,
      hostIdentity,
      payload,
      privateKey: identity.privateKeyPem,
    }));
    if (!this.acceptingRequests) {
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, createAgentError({
        code: "UPDATE_IN_PROGRESS",
        message: "NamiMail is preparing an update and cannot accept new external Agent operations.",
        retryable: true,
      }))));
    }
    this.activeRequestCount += 1;
    try {
    const verified = await verifyBrokerRequest(parsed, {
      pairingStore: this.state,
      hostId: identity.hostId,
      bootId,
      hostPublicKeyPem: identity.publicKeyPem,
    });
    if (!verified.ok) return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, verified.error)));
    const frame = parsed as BrokerRequestFrame<BrokerJsonValue>;
    if (!validBrokerPayload(frame.payload)) {
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, createAgentError({
        code: "INVALID_ARGUMENT",
        message: "The NamiMail external command payload is invalid.",
      }))));
    }
    if (!verified.pairing.accountIds?.length) {
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, createAgentError({
        code: "PAIRING_REQUIRED",
        message: "This NamiMail Agent profile must be paired again to approve an account scope.",
        retryable: false,
        suggestion: "Run namimail revoke --profile <name>, then pair the profile again in NamiMail.",
      }))));
    }
    const caller = externalCaller(verified.pairing, frame.payload.entryPoint);
    if (!caller) {
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, createAgentError({
        code: "SCOPE_DENIED",
        message: "The paired NamiMail client is not authorized for mail read access.",
      }))));
    }
    const payload = frame.payload;
    if (payload.command === "doctor") {
      const rows = await this.runDoctorDiagnostics();
      return respond({
        protocolVersion: "1.0",
        requestId: identifiers.requestId,
        success: true,
        data: rows,
        error: null,
        meta: { contractVersion: "1.0", durationMs: 0 },
      });
    }
    if (payload.command === "status") {
      return respond({
        protocolVersion: "1.0",
        requestId: identifiers.requestId,
        success: true,
        data: {
          status: "running",
          transport: "windows-named-pipe",
          entryPoint: payload.entryPoint,
          tools: [...externalToolNames],
        },
        error: null,
        meta: { contractVersion: "1.0", durationMs: 0 },
      });
    }
    if (payload.command === "host.shutdown") {
      // Reply before tearing the host down so the pipe exchange can complete.
      const response = respond({
        protocolVersion: "1.0",
        requestId: identifiers.requestId,
        success: true,
        data: { status: "stopping" },
        error: null,
        meta: { contractVersion: "1.0", durationMs: 0 },
      });
      setTimeout(() => { void this.options.onHostShutdown?.(); }, 150);
      return response;
    }
    const mapped = payload.entryPoint === "cli"
      ? cliToolInput(payload.command, payload.arguments)
      : mcpToolInput(payload.command, payload.arguments);
    if (!mapped) {
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, createAgentError({
        code: "NOT_SUPPORTED",
        message: "This NamiMail external command is not part of the external Agent interface.",
      }))));
    }
    const result = await this.options.invokeExternalAgentTool({
      requestId: identifiers.requestId,
      caller,
      toolName: mapped.toolName,
      input: mapped.input,
    });
    return respond(serializableResponseEnvelope(result));
    } catch (error) {
      const known = asAgentDesktopError(error);
      return respond(serializableResponseEnvelope(brokerFailurePayload(identifiers.requestId, known?.toAgentError() ?? createAgentError({
        code: "INTERNAL",
        message: "NamiMail Agent could not process the external request.",
        retryable: true,
      }))));
    } finally {
      this.releaseActiveRequest();
    }
  }
}

/** Managed CLI/MCP client that signs a single request over the SID-DACL pipe. */
export class DesktopAgentBrokerClient {
  readonly transport = "windows-named-pipe" as const;
  private readonly profiles: DesktopClientProfileStore;

  constructor(private readonly options: DesktopBrokerClientOptions) {
    this.profiles = new DesktopClientProfileStore(clientProfilesPath(options.userDataPath), options.safeStorage);
  }

  async invoke(request: DesktopBrokerInvocation): Promise<BrokerJsonValue> {
    if (!requestIdPattern.test(request.requestId) || typeof request.command !== "string" || !isJsonValue(request.arguments)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail external command request is invalid.");
    }
    const profile = await this.requirePairedProfile();
    const discovery = await readDiscovery(this.options.userDataPath);
    if (profile.hostId !== discovery.hostId || profile.hostPublicKeyPem !== discovery.hostPublicKeyPem) {
      throw agentDesktopError(
        "PAIRING_REQUIRED",
        "This NamiMail Agent profile is not paired with the active host identity.",
        false,
        "Run namimail pair again after restoring NamiMail data.",
      );
    }
    const counter = incrementCounter(profile.lastAcceptedCounter);
    const frame = signBrokerRequest({
      requestId: request.requestId,
      hostId: discovery.hostId,
      bootId: discovery.bootId,
      clientId: profile.clientId,
      counter,
      payload: {
        entryPoint: this.options.entryPoint,
        command: request.command,
        arguments: request.arguments,
      },
      privateKey: profile.privateKeyPem,
    });
    const rawResponse = await requestPipe(discovery.path, JSON.stringify(frame));
    let response: unknown;
    try {
      response = JSON.parse(rawResponse);
    } catch {
      throw agentDesktopError("BROKER_AUTHENTICATION_FAILED", "The NamiMail Agent host returned an invalid local response.");
    }
    const verified = verifyBrokerResponse(response, {
      pairing: { hostId: profile.hostId, hostPublicKeyPem: profile.hostPublicKeyPem },
      requestId: request.requestId,
      requestCounter: counter,
      bootId: discovery.bootId,
    });
    if (!verified.ok) throw agentDesktopError(verified.error.code, verified.error.message, verified.error.retryable, verified.error.suggestion);
    await this.profiles.advanceCounter(this.options.profile, profile.lastAcceptedCounter, counter);
    const parsed = isPlainObject(response) ? parseEnvelope(response.payload) : undefined;
    if (!parsed) throw agentDesktopError("BROKER_AUTHENTICATION_FAILED", "The NamiMail Agent host returned an invalid result envelope.");
    if (!parsed.success) {
      const error = parsed.error;
      if (isAgentErrorCode(error.code)) throw agentDesktopError(error.code, error.message, error.retryable, error.suggestion);
      throw agentDesktopError("BROKER_AUTHENTICATION_FAILED", "The NamiMail Agent host returned an invalid error code.");
    }
    return parsed.data;
  }

  private async requirePairedProfile(): Promise<BrokerClientProfile & { hostId: string; hostPublicKeyPem: string }> {
    const profile = await this.profiles.read(this.options.profile);
    if (!profile?.pairedAt || !profile.hostId || !profile.hostPublicKeyPem) {
      throw agentDesktopError(
        "PAIRING_REQUIRED",
        "This NamiMail Agent profile has not been paired.",
        false,
        `Run namimail pair --profile ${this.options.profile} and approve it in Nami Mail.`,
      );
    }
    return profile as BrokerClientProfile & { hostId: string; hostPublicKeyPem: string };
  }
}

export function createDesktopBrokerClient(options: DesktopBrokerClientOptions): DesktopAgentBrokerClient {
  return new DesktopAgentBrokerClient(options);
}
