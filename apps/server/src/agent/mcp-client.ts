import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Transform, type TransformCallback } from "node:stream";
import { checkJsonValue, isSafeJsonValue, maxJsonDepth } from "@nami/agent-contracts";
import { serverLog } from "../logging.js";

/**
 * Minimal MCP (Model Context Protocol) stdio client that speaks newline
 * delimited JSON-RPC 2.0. It intentionally mirrors the hand-written protocol
 * style of the desktop NamiMail MCP server (apps/desktop/src/agent/mcp.mts)
 * rather than depending on the SDK, so the transport, concurrency, timeout,
 * and JSON safety rules stay explicit and testable.
 *
 * Everything here crosses a trust boundary: the peer is an arbitrary
 * user-configured child process writing to its own stdout. Its output is
 * therefore treated as hostile input with three independent guards — a byte
 * budget applied before readline sees a byte, a bounded shape/size check on
 * every parsed value, and a top-level try/catch around the readline callback
 * itself, which runs on a stack where an escaping exception becomes
 * `uncaughtException` and takes down the whole service process.
 */

export const mcpProtocolVersion = "2025-03-26";

const maxStdioLineLength = 1_000_000;
const defaultConnectTimeoutMs = 15_000;
const defaultRequestTimeoutMs = 60_000;
const defaultToolLimit = 100;

/**
 * Byte budgets for one MCP server's stdout, enforced by the guard transform
 * that sits between the child's pipe and readline.
 *
 * - Per line (8 MB). Comfortably above `maxStdioLineLength` (1 MB) so a merely
 *   oversized *bounded* response is still dropped by the cheap
 *   post-formation length check instead of costing the user their connection.
 *   This threshold exists for the case that check cannot see at all: a server
 *   that writes gigabytes without ever emitting a newline, where readline's own
 *   line buffer keeps concatenating until Node throws
 *   `RangeError: Invalid string length` from inside its data handler.
 * - Per session (64 MB). A single response can never exceed the line budget, so
 *   this only fires on sustained flooding. It is a rate/memory ceiling rather
 *   than a quota, set high enough that an agent session doing ordinary tool
 *   calls (tens of KB per response) never reaches it in practice.
 */
const maxStdioLineFloodBytes = 8 * 1024 * 1024;
const maxStdioSessionFloodBytes = 64 * 1024 * 1024;
const newlineByte = 0x0a;

/**
 * Variables that must never be inherited by an external MCP server process.
 * The desktop host keeps its loopback API bearer token and the local mail
 * database path in process.env; an arbitrary configured MCP command could
 * otherwise read them to reach the protected local mail API. Only the
 * process-owned NAMI_MAIL_* variables and the local service details are
 * stripped; an explicitly configured transport.env still overrides below.
 */
const mcpInheritedEnvExclusions = ["DATABASE_PATH", "MASTER_KEY_PATH", "HOST", "PORT", "WEB_DIST_PATH"] as const;

function sanitizeMcpInheritedEnv(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("NAMI_MAIL_")) continue;
    if ((mcpInheritedEnvExclusions as readonly string[]).includes(key)) continue;
    inherited[key] = value;
  }
  return inherited;
}

export type McpClientErrorCode =
  | "CONNECTION_FAILED"
  | "CONNECT_TIMEOUT"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROTOCOL_ERROR"
  | "CLOSED"
  | "NOT_CONNECTED";

export class McpClientError extends Error {
  constructor(
    readonly code: McpClientErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

export type McpServerTransportOptions = {
  command: string;
  args?: readonly string[];
  /** Merged over process.env when spawning the MCP server process. */
  env?: Record<string, string>;
  cwd?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export type McpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpDiscoveredTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
};

export type McpServerCapabilities = {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  tools: readonly McpDiscoveredTool[];
};

export type McpCallToolResult = {
  content: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError: boolean;
};

export type McpJsonRpcId = number | string | null;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: McpClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The JSON admissibility walk is shared with the desktop MCP host so both ends
 * of a peer connection enforce one depth budget and one prototype-pollution
 * rule. Re-exported under its original names because it is part of this
 * module's published surface for callers that validate peer values directly.
 */
export { isSafeJsonValue, maxJsonDepth };

type StdioFloodReason = "line" | "session";

/**
 * Counts the child's stdout before readline is allowed to see any of it.
 *
 * `maxStdioLineLength` alone is not a flood guard: it only runs once readline
 * has already assembled a whole line, and readline imposes no length ceiling of
 * its own. This transform is therefore placed upstream, where exceeding a
 * budget simply stops forwarding — readline never accumulates the buffer that
 * would otherwise blow up as `RangeError: Invalid string length`.
 */
class StdioFloodGuard extends Transform {
  /** Bytes of the not-yet-terminated line carried across chunks. */
  private lineBytes = 0;
  private sessionBytes = 0;
  private tripped = false;

  constructor(
    private readonly onFlood: (reason: StdioFloodReason, detail: { lineBytes: number; sessionBytes: number }) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    // After the first trip the guard is inert: the connection is already being
    // torn down and nothing more may reach the listener.
    if (this.tripped) {
      callback();
      return;
    }
    this.sessionBytes += chunk.length;
    // Length of the line this chunk completes (or, with no newline in it, of
    // the line still being built) — the conservative reading of "longest line
    // in flight".
    const firstBreak = chunk.indexOf(newlineByte);
    const lastBreak = chunk.lastIndexOf(newlineByte);
    const openLineBytes = firstBreak < 0 ? this.lineBytes + chunk.length : this.lineBytes + firstBreak + 1;
    // Only the bytes after the last newline carry into the next chunk.
    this.lineBytes = lastBreak < 0 ? this.lineBytes + chunk.length : chunk.length - lastBreak - 1;

    const reason: StdioFloodReason | undefined = openLineBytes > maxStdioLineFloodBytes
      ? "line"
      : this.sessionBytes > maxStdioSessionFloodBytes
        ? "session"
        : undefined;
    if (!reason) {
      callback(null, chunk);
      return;
    }
    this.tripped = true;
    callback();
    this.onFlood(reason, { lineBytes: openLineBytes, sessionBytes: this.sessionBytes });
  }
}

function isJsonRpcId(value: unknown): value is McpJsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function mcpClientError(error: unknown): McpClientError {
  if (error instanceof McpClientError) return error;
  if (error instanceof Error) {
    return new McpClientError("CONNECTION_FAILED", error.message, true);
  }
  return new McpClientError("CONNECTION_FAILED", "The MCP server process failed.", true);
}

/**
 * Owns one child MCP server process and serializes JSON-RPC requests over
 * stdout. Multiple in-flight requests are tracked by id, each with its own
 * timeout and optional AbortSignal. Notifications and out-of-band messages
 * are ignored. Closing the client rejects every pending request.
 */
export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutGuard?: StdioFloodGuard;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private connected = false;
  private closing = false;
  private capabilities?: McpServerCapabilities;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly transport: McpServerTransportOptions) {
    this.connectTimeoutMs = transport.connectTimeoutMs ?? defaultConnectTimeoutMs;
    this.requestTimeoutMs = transport.requestTimeoutMs ?? defaultRequestTimeoutMs;
  }

  get isConnected(): boolean {
    return this.connected && Boolean(this.child) && !this.closing;
  }

  /** True when a child process was spawned and has not exited yet. */
  get isAlive(): boolean {
    return Boolean(this.child && !this.closing);
  }

  private request(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!this.child || this.closing) {
      return Promise.reject(new McpClientError("NOT_CONNECTED", "The MCP server is not connected.", true));
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError("TIMEOUT", `The MCP ${method} request timed out after ${timeoutMs} ms.`, true));
      }, timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer };
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new McpClientError("CANCELLED", "The MCP request was cancelled.", true));
          return;
        }
        const abortListener = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          this.sendNotification("notifications/cancelled", { requestId: id, reason: "Aborted by caller" });
          reject(new McpClientError("CANCELLED", "The MCP request was cancelled.", true));
        };
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(id, pending);
      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.child!.stdin.write(`${message}\n`);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child || this.closing) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The session may already be closing; the notification is best-effort.
    }
  }

  /** Spawns the server process, performs the initialize handshake, then discovers tools. */
  async connect(options: { signal?: AbortSignal } = {}): Promise<McpServerCapabilities> {
    if (this.connected) return this.capabilities!;
    if (this.child && !this.closing) {
      throw new McpClientError("CONNECTION_FAILED", "The MCP server process is already starting.", true);
    }
    const timeout = setTimeout(() => {
      this.failPending(new McpClientError("CONNECT_TIMEOUT", "The MCP server did not complete initialization in time.", true));
      this.teardown();
    }, this.connectTimeoutMs);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.transport.command, this.transport.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...sanitizeMcpInheritedEnv(), ...this.transport.env },
        ...(this.transport.cwd ? { cwd: this.transport.cwd } : {}),
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw mcpClientError(error);
    }
    this.child = child;
    this.closing = false;

    // The child may close its pipes before we finish writing (e.g. an early
    // exit after initialize); consume those errors instead of crashing.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (error) => {
      this.failPending(new McpClientError("CONNECTION_FAILED", `The MCP server process failed to start: ${error.message}`, true));
      this.teardown();
    });
    child.on("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      this.failPending(new McpClientError("CLOSED", `The MCP server process closed (${detail}).`, true));
      this.teardown();
    });

    const lines = createInterface({ input: this.attachStdoutGuard(child), crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
    const handleLine = (line: string): void => this.handleLine(line);
    lines.on("line", handleLine);

    try {
      const initialize = await this.requestWithTimeout(
        "initialize",
        {
          protocolVersion: mcpProtocolVersion,
          capabilities: {},
          clientInfo: { name: "nami-mail-agent", version: "1.0.0" },
        },
        this.connectTimeoutMs,
      );
      if (!isPlainObject(initialize)) {
        throw new McpClientError("PROTOCOL_ERROR", "The MCP initialize response is not an object.", false);
      }
      if (typeof initialize.protocolVersion !== "string") {
        throw new McpClientError("PROTOCOL_ERROR", "The MCP initialize response is missing a protocol version.", false);
      }
      if (!initialize.protocolVersion.startsWith("2025-03-26") && initialize.protocolVersion !== mcpProtocolVersion) {
        throw new McpClientError(
          "PROTOCOL_ERROR",
          `The MCP server requires protocol ${initialize.protocolVersion}; Nami Mail speaks ${mcpProtocolVersion}.`,
          false,
        );
      }
      const serverInfo = isPlainObject(initialize.serverInfo) && typeof initialize.serverInfo.name === "string"
        ? { name: initialize.serverInfo.name, version: typeof initialize.serverInfo.version === "string" ? initialize.serverInfo.version : "0.0.0" }
        : { name: this.transport.command, version: "0.0.0" };
      this.connected = true;
      this.sendNotification("notifications/initialized", {});
      const tools = await this.listTools();
      clearTimeout(timeout);
      this.capabilities = { protocolVersion: initialize.protocolVersion, serverInfo, tools };
      // Reject only if an abort raced the handshake.
      if (options.signal?.aborted) throw new McpClientError("CANCELLED", "The MCP connection was cancelled.", true);
      return this.capabilities;
    } catch (error) {
      clearTimeout(timeout);
      this.teardown();
      throw mcpClientError(error);
    }
  }

  private async requestWithTimeout(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return this.request(method, params, { timeoutMs });
  }

  /**
   * Routes the child's stdout through the flood guard and returns the readable
   * side for readline. The disconnect itself reuses the module's existing
   * pattern (fail every pending request, then teardown), so a flood looks like
   * any other lost connection to callers.
   */
  private attachStdoutGuard(child: ChildProcessWithoutNullStreams): StdioFloodGuard {
    const guard = new StdioFloodGuard((reason, detail) => {
      serverLog.warn(
        { reason, ...detail, command: this.transport.command },
        "MCP server exceeded its stdout byte budget; dropping the connection",
      );
      this.failPending(new McpClientError("CLOSED", `The MCP server exceeded its stdout byte budget (${reason}).`, true));
      this.teardown();
    });
    this.stdoutGuard = guard;
    child.stdout.pipe(guard);
    return guard;
  }

  async listTools(options: { signal?: AbortSignal } = {}): Promise<readonly McpDiscoveredTool[]> {
    const response = await this.request("tools/list", {}, { signal: options.signal });
    if (!isPlainObject(response)) {
      throw new McpClientError("PROTOCOL_ERROR", "The MCP tools/list response is not an object.", false);
    }
    if (!Array.isArray(response.tools)) {
      throw new McpClientError("PROTOCOL_ERROR", "The MCP tools/list response is missing a tools array.", false);
    }
    const tools: McpDiscoveredTool[] = [];
    for (const raw of response.tools) {
      if (!isPlainObject(raw) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 128) continue;
      const inputSchema = isPlainObject(raw.inputSchema) && isSafeJsonValue(raw.inputSchema)
        ? raw.inputSchema
        : undefined;
      const annotations = isPlainObject(raw.annotations)
        ? {
          readOnlyHint: raw.annotations.readOnlyHint === true,
          destructiveHint: raw.annotations.destructiveHint === true,
          idempotentHint: raw.annotations.idempotentHint === true,
          openWorldHint: raw.annotations.openWorldHint === true,
        }
        : undefined;
      tools.push({
        name: raw.name,
        ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
        ...(inputSchema ? { inputSchema } : {}),
        ...(annotations ? { annotations } : {}),
      });
      if (tools.length >= defaultToolLimit) break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, options: { signal?: AbortSignal } = {}): Promise<McpCallToolResult> {
    if (typeof name !== "string" || !name.trim() || name.length > 128) {
      throw new McpClientError("INVALID_ARGUMENT" as McpClientErrorCode, "The MCP tool name is invalid.", false);
    }
    if (args !== undefined && !isSafeJsonValue(args)) {
      throw new McpClientError("INVALID_ARGUMENT" as McpClientErrorCode, "The MCP tool arguments must be JSON-safe.", false);
    }
    const response = await this.request("tools/call", { name, arguments: args ?? {} }, { signal: options.signal });
    if (!isPlainObject(response)) {
      throw new McpClientError("PROTOCOL_ERROR", "The MCP tools/call response is not an object.", false);
    }
    const content = Array.isArray(response.content) ? response.content.filter((entry) => isPlainObject(entry) && typeof entry.type === "string") : [];
    return {
      content: content as McpCallToolResult["content"],
      ...(Object.prototype.hasOwnProperty.call(response, "structuredContent") ? { structuredContent: response.structuredContent } : {}),
      isError: response.isError === true,
    };
  }

  /**
   * The one boundary between a child process and this process's event loop.
   *
   * readline emits `line` synchronously from inside its own data handler, so
   * anything thrown from here lands in `uncaughtException` — which kills the
   * whole service process (SQLite, IMAP, the Agent loop, the HTTP API), not
   * just this connection. `JSON.parse` alone is guarded; the shape walk that
   * follows it was not, so a deep-but-valid document killed the process from
   * inside the validator. Everything now happens under this catch.
   */
  private handleLine(line: string): void {
    try {
      this.dispatchLine(line);
    } catch (error) {
      serverLog.warn(
        { command: this.transport.command, length: line.length },
        "Dropped an MCP stdio line that failed validation",
        error,
      );
    }
  }

  private dispatchLine(line: string): void {
    if (line.length > maxStdioLineLength) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(message)) return;
    const verdict = checkJsonValue(message, new WeakSet(), 0);
    if (!verdict.safe) {
      // A document this deep is not a well-formed response to anything; the
      // peer is either broken or hostile, and neither is worth staying quiet
      // about, so the drop is recorded rather than lost.
      if (verdict.reason === "depth") {
        serverLog.warn(
          { reason: verdict.reason, command: this.transport.command, length: line.length, maxJsonDepth },
          "Dropped an MCP stdio line nested past the accepted JSON depth",
        );
      }
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) return; // Notifications are acknowledged and ignored.
    const id = message.id;
    if (!isJsonRpcId(id)) return;
    if (typeof id !== "number") return; // We only issue numeric ids; ignore foreign responses.
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.abortListener && pending.signal) pending.signal.removeEventListener("abort", pending.abortListener);
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const error = isPlainObject(message.error) ? message.error : undefined;
      const messageText = error && typeof error.message === "string" ? error.message : "The MCP server returned an error.";
      pending.reject(new McpClientError("PROTOCOL_ERROR", `MCP server error: ${messageText}`, true));
      return;
    }
    pending.resolve(message.result);
  }

  private failPending(error: McpClientError): void {
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      if (pending.abortListener && pending.signal) pending.signal.removeEventListener("abort", pending.abortListener);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private teardown(): void {
    this.connected = false;
    this.closing = true;
    const child = this.child;
    const guard = this.stdoutGuard;
    this.child = undefined;
    this.stdoutGuard = undefined;
    guard?.destroy();
    if (child) {
      child.stdin.end();
      child.kill();
      child.removeAllListeners();
    }
  }

  close(): void {
    if (this.closing) return;
    this.failPending(new McpClientError("CLOSED", "The MCP server session was closed.", false));
    this.teardown();
  }
}

export type McpServerConnectionResult = {
  ok: true;
  capabilities: McpServerCapabilities;
  toolCount: number;
  toolNames: string[];
  checkedAt: string;
} | {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
};

/** Connects to a server, discovers its tools, and closes the process. Used by test/check endpoints. */
export async function probeMcpServer(transport: McpServerTransportOptions, options: { signal?: AbortSignal } = {}): Promise<McpServerConnectionResult> {
  const client = new McpStdioClient(transport);
  try {
    const capabilities = await client.connect({ signal: options.signal });
    return {
      ok: true,
      capabilities,
      toolCount: capabilities.tools.length,
      toolNames: capabilities.tools.map((tool) => tool.name),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const failure = mcpClientError(error);
    return {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    };
  } finally {
    client.close();
  }
}
