import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { agentDesktopError } from "./contracts.mjs";
import { minimalSpawnEnvironment } from "../spawn-environment.mjs";

const pipeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const windowsSidPattern = /^S-1-(?:0|1|2|3|5|15|16|18)-(?:\d+-){1,14}\d+$/;
const maximumMessageLength = 1_000_000;
const startupTimeoutMs = 10_000;
const defaultRequestReadTimeoutMs = 10_000;
// The relay used to wait for a parent answer without a limit. This ceiling is
// a third of the client's 30s exchange budget and fifty times the slowest
// healthy exchange measured under a 4-vCPU load, so it only fires for a parent
// that actually stopped answering.
const defaultParentResponseTimeoutMs = 10_000;

export type SecurePipeEndpoint = {
  transport: "windows-named-pipe";
  pipeName: string;
  path: string;
  ownerSid: string;
};

export type SecurePipeRelayOptions = {
  scriptPath: string;
  pipeName?: string;
  powershellPath?: string;
  requestReadTimeoutMs?: number;
  /** Ceiling for one parent answer; must stay below the client's exchange budget. */
  parentResponseTimeoutMs?: number;
  onRequest: (payload: string) => Promise<string>;
  onStderr?: (line: string) => void;
  /** One line per relay start, so a slow start names its stage instead of staying silent. */
  onDiagnostic?: (line: string) => void;
};

type RelayStageTimings = {
  daclMs?: number;
  pipeMs?: number;
  readyMs?: number;
};

type RelayReadyMessage = {
  type: "ready";
  pipeName: string;
  path: string;
  ownerSid: string;
  daclProtected: boolean;
  ownerOnly: boolean;
  accessRuleCount: number;
  /** Relay process id, so a timed-out start can be tied to a concrete process. */
  pid?: number;
  /** Relay-side stage durations; the Node side adds spawn and delivery time. */
  stageTimings?: RelayStageTimings;
};

type RelayRequestMessage = {
  type: "request";
  connectionId: string;
  payload: string;
};

function expectedPipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

function defaultPipeName(): string {
  return `nami-mail-agent-${randomBytes(18).toString("base64url")}`;
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseRelayMessage(line: string): RelayReadyMessage | RelayRequestMessage | undefined {
  if (line.length > maximumMessageLength) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value) || typeof value.type !== "string") return undefined;
  if (
    value.type === "ready"
    && typeof value.pipeName === "string"
    && typeof value.path === "string"
    && typeof value.ownerSid === "string"
    && typeof value.daclProtected === "boolean"
    && typeof value.ownerOnly === "boolean"
    && typeof value.accessRuleCount === "number"
  ) {
    const ready: RelayReadyMessage = {
      type: "ready",
      pipeName: value.pipeName,
      path: value.path,
      ownerSid: value.ownerSid,
      daclProtected: value.daclProtected,
      ownerOnly: value.ownerOnly,
      accessRuleCount: value.accessRuleCount,
    };
    // Diagnostics are optional: an older script or a malformed timing field must
    // not fail an otherwise valid relay.
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) ready.pid = value.pid;
    if (isPlainObject(value.stageTimings)) {
      const stages: RelayStageTimings = {};
      for (const key of ["daclMs", "pipeMs", "readyMs"] as const) {
        const milliseconds = value.stageTimings[key];
        if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0) {
          stages[key] = Math.round(milliseconds);
        }
      }
      ready.stageTimings = stages;
    }
    return ready;
  }
  if (
    value.type === "request"
    && typeof value.connectionId === "string"
    && /^[a-f0-9]{32}$/.test(value.connectionId)
    && typeof value.payload === "string"
  ) return value as RelayRequestMessage;
  return undefined;
}

function asStableRelayFailure(): string {
  return JSON.stringify({
    type: "response",
    error: {
      code: "HOST_UNAVAILABLE",
      message: "NamiMail Agent host is temporarily unavailable.",
      retryable: true,
    },
  });
}

function describeStageTimings(timings: RelayStageTimings | undefined): string {
  if (!timings) return "";
  const parts = (["daclMs", "pipeMs", "readyMs"] as const)
    .filter((key) => timings[key] !== undefined)
    .map((key) => `${key.slice(0, -2)} ${timings[key]}ms`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/**
 * Owns the only Windows-native transport used by external callers. The
 * PowerShell 5.1 process creates the named pipe with a current-user SID DACL;
 * Node never claims that a normal net.Server descriptor is secure.
 */
export class WindowsSidDaclPipeRelay {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdout: Interface | undefined;
  private stderr: Interface | undefined;
  private endpoint: SecurePipeEndpoint | undefined;
  private startPromise: Promise<SecurePipeEndpoint> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: SecurePipeRelayOptions) {}

  getEndpoint(): SecurePipeEndpoint | undefined {
    return this.endpoint ? { ...this.endpoint } : undefined;
  }

  isLive(): boolean {
    return Boolean(this.child && !this.child.killed && this.endpoint && !this.closed);
  }

  async start(): Promise<SecurePipeEndpoint> {
    if (this.endpoint) return { ...this.endpoint };
    if (this.startPromise) return this.startPromise;
    if (process.platform !== "win32") {
      throw agentDesktopError("BROKER_SECURITY_UNAVAILABLE", "NamiMail external Agent access requires Windows SID-DACL named pipes.");
    }
    const pipeName = this.options.pipeName ?? defaultPipeName();
    if (!pipeNamePattern.test(pipeName)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pipe name is invalid.");
    }
    const requestReadTimeoutMs = this.options.requestReadTimeoutMs ?? defaultRequestReadTimeoutMs;
    if (!Number.isInteger(requestReadTimeoutMs) || requestReadTimeoutMs < 100 || requestReadTimeoutMs > 60_000) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pipe read timeout is invalid.");
    }
    const parentResponseTimeoutMs = this.options.parentResponseTimeoutMs ?? defaultParentResponseTimeoutMs;
    if (!Number.isInteger(parentResponseTimeoutMs) || parentResponseTimeoutMs < 100 || parentResponseTimeoutMs > 60_000) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent parent response timeout is invalid.");
    }
    const powershellPath = this.options.powershellPath ?? defaultPowerShellPath();
    this.startPromise = new Promise<SecurePipeEndpoint>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const fail = (message: string, retryable = false) => settle(() => {
        const error = agentDesktopError(
          "BROKER_SECURITY_UNAVAILABLE",
          message,
          retryable,
          "Open Nami Mail again after Windows PowerShell 5.1 is available.",
        );
        // A failed start must not leave a live PowerShell relay or its named
        // pipe behind: kill before rejecting so a retry starts from zero, and
        // so host.close() never has to find an unregistered child.
        void this.terminateChild().finally(() => reject(error));
      });
      const timeout = setTimeout(() => fail("NamiMail could not start the secured Agent pipe."), startupTimeoutMs);
      timeout.unref?.();
      const spawnedAt = Date.now();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = nodeSpawn(powershellPath, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.options.scriptPath,
          "-PipeName",
          pipeName,
          "-RequestReadTimeoutMilliseconds",
          String(requestReadTimeoutMs),
          "-ParentResponseTimeoutMilliseconds",
          String(parentResponseTimeoutMs),
        ], {
          env: minimalSpawnEnvironment(),
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        fail("NamiMail could not launch the secured Windows Agent pipe.", true);
        return;
      }
      this.child = child;
      try {
        this.stdout = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
        this.stderr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
      } catch {
        fail("NamiMail could not launch the secured Windows Agent pipe.", true);
        return;
      }
      this.stderr.on("line", (line) => this.options.onStderr?.(String(line).slice(0, 1_024)));
      this.stdout.on("line", (line) => {
        const message = parseRelayMessage(String(line));
        if (!message) return;
        if (message.type === "ready") {
          if (
            message.pipeName !== pipeName
            || message.path !== expectedPipePath(pipeName)
            || !windowsSidPattern.test(message.ownerSid)
            || message.daclProtected !== true
            || message.ownerOnly !== true
            || message.accessRuleCount !== 1
          ) {
            fail("NamiMail could not verify the Windows Agent pipe security descriptor.");
            return;
          }
          const endpoint: SecurePipeEndpoint = {
            transport: "windows-named-pipe",
            pipeName,
            path: message.path,
            ownerSid: message.ownerSid,
          };
          this.endpoint = endpoint;
          try {
            // One line per start, not per connection: the pid and relay-side
            // stages are what make the next starvation self-evident.
            this.options.onDiagnostic?.(
              `Agent pipe ready pid=${message.pid ?? "unknown"} in ${Date.now() - spawnedAt}ms${describeStageTimings(message.stageTimings)}`,
            );
          } catch {
            // Diagnostics must never fail a healthy relay.
          }
          settle(() => resolve({ ...endpoint }));
          return;
        }
        void this.handleRequest(message);
      });
      child.once("error", () => fail("NamiMail could not start the secured Windows Agent pipe.", true));
      child.once("exit", () => {
        this.endpoint = undefined;
        if (!settled) fail("NamiMail could not start the secured Windows Agent pipe.", true);
      });
    }).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /**
   * Terminates the spawned PowerShell relay and drops its pipe endpoint. Used
   * by every failed start path so a timeout or a rejected descriptor cannot
   * leave an orphaned relay (or its named pipe) behind for the next attempt.
   */
  private async terminateChild(): Promise<void> {
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = undefined;
    this.stderr = undefined;
    this.endpoint = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The process is already gone.
        }
        resolve();
      }, 2_000);
      timeout.unref?.();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  private async handleRequest(message: RelayRequestMessage): Promise<void> {
    const child = this.child;
    if (!child || child.killed || this.closed) return;
    let payload: string;
    try {
      payload = await this.options.onRequest(message.payload);
      if (typeof payload !== "string" || payload.length > maximumMessageLength) payload = asStableRelayFailure();
    } catch {
      payload = asStableRelayFailure();
    }
    try {
      child.stdin.write(`${JSON.stringify({ type: "response", connectionId: message.connectionId, payload })}\n`);
    } catch {
      // The relay process is already unavailable. It cannot safely retry the
      // client request because Broker counters make each frame single-use.
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const child = this.child;
    this.closePromise = (async () => {
      this.stdout?.close();
      this.stderr?.close();
      this.stdout = undefined;
      this.stderr = undefined;
      this.endpoint = undefined;
      this.child = undefined;
      if (!child || child.killed) return;
      await new Promise<void>((resolve) => {
        // The relay process usually exits as soon as stdin closes. A short
        // grace window keeps a stuck PowerShell from delaying desktop exit;
        // the OS drops the named pipe once the process is gone either way.
        const timeout = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Best-effort shutdown after closing stdin.
          }
          resolve();
        }, 500);
        timeout.unref?.();
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        try {
          child.stdin.end();
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      });
    })();
    return this.closePromise;
  }
}

export { expectedPipePath, maximumMessageLength };
