import type { AgentErrorCode } from "@nami/agent-contracts";
import { agentDesktopError } from "./contracts.mjs";

const windowsPipePrefix = "\\\\.\\pipe\\";
const safePipeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const windowsSidPattern = /^S-1-(?:0|1|2|3|5|15|16|18)-(?:\d+-){1,14}\d+$/;
const opaqueIdentityPattern = /^[A-Za-z0-9_-]{16,160}$/;

export type HostLeaseState = "idle" | "acquiring" | "active" | "releasing" | "released";

export type WindowsNamedPipeEndpoint = {
  transport: "windows-named-pipe";
  path: string;
  ownerSid: string;
};

export type HostLeaseRequest = {
  pipeName: string;
  ownerSid: string;
  hostId: string;
  bootId: string;
};

export type DaclNamedPipeLease = {
  endpoint: WindowsNamedPipeEndpoint;
  release: () => Promise<void>;
};

/**
 * The production adapter must create an exclusive Windows named pipe with a
 * DACL limited to the current user's SID. Implementations without that proof
 * are rejected before a runtime, database, or broker can be started.
 */
export interface DaclCapableNamedPipeAdapter {
  readonly transport: "windows-named-pipe";
  readonly accessControl: "sid-dacl";
  acquireExclusive(request: HostLeaseRequest): Promise<DaclNamedPipeLease>;
}

export type HostLeaseSnapshot = {
  state: HostLeaseState;
  endpoint?: WindowsNamedPipeEndpoint;
  hostId?: string;
  bootId?: string;
};

function protocolError(code: AgentErrorCode, message: string): never {
  throw agentDesktopError(code, message, false);
}

export function namedPipePath(pipeName: string): string {
  if (!safePipeNamePattern.test(pipeName)) {
    protocolError("BROKER_SECURITY_UNAVAILABLE", "The requested broker pipe name is not valid.");
  }
  return `${windowsPipePrefix}${pipeName}`;
}

export function validateHostLeaseRequest(request: HostLeaseRequest): void {
  namedPipePath(request.pipeName);
  if (!windowsSidPattern.test(request.ownerSid)) {
    protocolError("BROKER_SECURITY_UNAVAILABLE", "The current Windows account identity could not be verified.");
  }
  if (!opaqueIdentityPattern.test(request.hostId) || !opaqueIdentityPattern.test(request.bootId)) {
    protocolError("BROKER_SECURITY_UNAVAILABLE", "The local Agent host identity is not valid.");
  }
}

function validateLeaseEndpoint(endpoint: WindowsNamedPipeEndpoint, request: HostLeaseRequest): void {
  if (
    endpoint.transport !== "windows-named-pipe"
    || endpoint.path !== namedPipePath(request.pipeName)
    || endpoint.ownerSid !== request.ownerSid
  ) {
    protocolError("BROKER_SECURITY_UNAVAILABLE", "The broker adapter did not return the requested secured named pipe.");
  }
}

/**
 * Deliberate fail-closed placeholder. A TCP loopback fallback would let a
 * different local process impersonate the broker, so it is never offered.
 */
export class UnavailableNamedPipeAdapter implements DaclCapableNamedPipeAdapter {
  readonly transport = "windows-named-pipe" as const;
  readonly accessControl = "sid-dacl" as const;

  async acquireExclusive(_request: HostLeaseRequest): Promise<DaclNamedPipeLease> {
    void _request;
    protocolError(
      "BROKER_SECURITY_UNAVAILABLE",
      "Secure local Agent IPC is unavailable because no SID-DACL named-pipe adapter is installed.",
    );
  }
}

/**
 * Owns exactly one broker lease. A new instance is required after release so
 * callers cannot accidentally revive an endpoint whose security state changed.
 */
export class AgentHostLease {
  private state: HostLeaseState = "idle";
  private activeLease: DaclNamedPipeLease | undefined;
  private activeRequest: HostLeaseRequest | undefined;
  private acquirePromise: Promise<WindowsNamedPipeEndpoint> | undefined;
  private releasePromise: Promise<void> | undefined;

  constructor(private readonly adapter: DaclCapableNamedPipeAdapter = new UnavailableNamedPipeAdapter()) {}

  getSnapshot(): HostLeaseSnapshot {
    return {
      state: this.state,
      ...(this.activeLease ? { endpoint: { ...this.activeLease.endpoint } } : {}),
      ...(this.activeRequest ? { hostId: this.activeRequest.hostId, bootId: this.activeRequest.bootId } : {}),
    };
  }

  async acquire(request: HostLeaseRequest): Promise<WindowsNamedPipeEndpoint> {
    validateHostLeaseRequest(request);
    if (this.state !== "idle") {
      protocolError("HOST_LEASE_UNAVAILABLE", "The local Agent host lease is already being used or has been released.");
    }
    if (this.adapter.transport !== "windows-named-pipe" || this.adapter.accessControl !== "sid-dacl") {
      protocolError("BROKER_SECURITY_UNAVAILABLE", "The configured Agent IPC adapter cannot enforce a Windows SID DACL.");
    }

    this.state = "acquiring";
    const acquirePromise = (async () => {
      try {
        const lease = await this.adapter.acquireExclusive(request);
        if (!lease) {
          protocolError("HOST_LEASE_UNAVAILABLE", "The local Agent host lease could not be acquired.");
        }
        validateLeaseEndpoint(lease.endpoint, request);
        this.activeLease = lease;
        this.activeRequest = { ...request };
        this.state = "active";
        return { ...lease.endpoint };
      } catch (error) {
        this.activeLease = undefined;
        this.activeRequest = undefined;
        this.state = "idle";
        throw error;
      } finally {
        this.acquirePromise = undefined;
      }
    })();
    this.acquirePromise = acquirePromise;
    return acquirePromise;
  }

  async release(): Promise<void> {
    if (this.state === "released") return;
    if (this.state === "acquiring") {
      await this.acquirePromise;
    }
    if (this.releasePromise) return this.releasePromise;
    if (this.state !== "active" || !this.activeLease) {
      protocolError("HOST_LEASE_UNAVAILABLE", "The local Agent host lease is not active.");
    }

    const lease = this.activeLease;
    this.state = "releasing";
    const releasePromise = (async () => {
      try {
        await lease.release();
        this.activeLease = undefined;
        this.activeRequest = undefined;
        this.state = "released";
      } catch (error) {
        // Retain the lease object because Windows may still consider it held.
        this.state = "active";
        throw error;
      } finally {
        this.releasePromise = undefined;
      }
    })();
    this.releasePromise = releasePromise;
    return releasePromise;
  }

  requireActiveEndpoint(): WindowsNamedPipeEndpoint {
    if (this.state !== "active" || !this.activeLease) {
      protocolError("HOST_UNAVAILABLE", "NamiMail Agent host is not running.");
    }
    return { ...this.activeLease.endpoint };
  }
}

export { AgentHostLease as HostLease };
