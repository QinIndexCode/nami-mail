import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { agentDesktopError } from "./contracts.mjs";

const pipeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const windowsSidPattern = /^S-1-(?:0|1|2|3|5|15|16|18)-(?:\d+-){1,14}\d+$/;
const maximumMessageLength = 1_000_000;
const startupTimeoutMs = 10_000;
const defaultRequestReadTimeoutMs = 10_000;

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
  onRequest: (payload: string) => Promise<string>;
  onStderr?: (line: string) => void;
};

type RelayReadyMessage = {
  type: "ready";
  pipeName: string;
  path: string;
  ownerSid: string;
  daclProtected: boolean;
  ownerOnly: boolean;
  accessRuleCount: number;
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
    return value as RelayReadyMessage;
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
    const powershellPath = this.options.powershellPath ?? defaultPowerShellPath();
    this.startPromise = new Promise<SecurePipeEndpoint>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const fail = (message: string, retryable = false) => settle(() => reject(agentDesktopError(
        "BROKER_SECURITY_UNAVAILABLE",
        message,
        retryable,
        "Open Nami Mail again after Windows PowerShell 5.1 is available.",
      )));
      const timeout = setTimeout(() => fail("NamiMail could not start the secured Agent pipe."), startupTimeoutMs);
      timeout.unref?.();
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
        ], {
          windowsHide: true,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        fail("NamiMail could not launch the secured Windows Agent pipe.", true);
        return;
      }
      this.child = child;
      this.stdout = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
      this.stderr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });
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
            void this.close();
            return;
          }
          const endpoint: SecurePipeEndpoint = {
            transport: "windows-named-pipe",
            pipeName,
            path: message.path,
            ownerSid: message.ownerSid,
          };
          this.endpoint = endpoint;
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

  private async handleRequest(message: RelayRequestMessage): Promise<void> {
    const child = this.child;
    if (!child || child.killed || this.closed) return;
    let payload = asStableRelayFailure();
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
        const timeout = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Best-effort shutdown after closing stdin.
          }
          resolve();
        }, 2_000);
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
