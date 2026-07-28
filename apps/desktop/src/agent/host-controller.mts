import { agentDesktopError } from "./contracts.mjs";
import { AgentHostLease, type HostLeaseRequest, type WindowsNamedPipeEndpoint } from "./host-lease.mjs";
import { UpdateDrainGate, type UpdateDrainPermit, type UpdateDrainSnapshot } from "./update-drain-gate.mjs";

export type AgentHostMode = "gui" | "service";
export type AgentHostState = "idle" | "starting" | "running" | "draining" | "stopped" | "failed";

export type AgentHostRuntimeStart = {
  mode: AgentHostMode;
  endpoint: WindowsNamedPipeEndpoint;
};

/**
 * Electron main supplies this adapter. Keeping it injected prevents the CLI
 * and protocol modules from importing the Fastify runtime or SQLite directly.
 */
export interface AgentHostRuntimeAdapter {
  start: (input: AgentHostRuntimeStart) => Promise<void>;
  abortStartup: () => Promise<void>;
  stopBrokerIngress: () => Promise<void>;
  quiesceRuntime: () => Promise<boolean>;
  recoverAfterFailedUpdate: (input: AgentHostRuntimeStart) => Promise<void>;
}

/** GUI activation maps to BrowserWindow restore/show/focus in Electron main. */
export interface AgentHostGuiAdapter {
  activate: () => Promise<void>;
}

export type AgentHostControllerOptions = {
  createLease: () => AgentHostLease;
  leaseRequest: HostLeaseRequest;
  runtime: AgentHostRuntimeAdapter;
  gui: AgentHostGuiAdapter;
};

export type AgentHostSnapshot = {
  state: AgentHostState;
  mode?: AgentHostMode;
  endpoint?: WindowsNamedPipeEndpoint;
  updateDrain: UpdateDrainSnapshot;
};

/**
 * Coordinates the in-process Electron host. It never creates windows, opens
 * SQLite, or starts Fastify itself; those responsibilities remain injected in
 * main.mts after the secured lease has been obtained.
 */
export class AgentHostController {
  private state: AgentHostState = "idle";
  private mode: AgentHostMode | undefined;
  private endpoint: WindowsNamedPipeEndpoint | undefined;
  private lease: AgentHostLease | undefined;
  private startPromise: Promise<WindowsNamedPipeEndpoint> | undefined;
  private readonly drainGate: UpdateDrainGate;

  constructor(private readonly options: AgentHostControllerOptions) {
    this.drainGate = new UpdateDrainGate({
      stopBrokerIngress: () => this.options.runtime.stopBrokerIngress(),
      quiesceRuntime: () => this.options.runtime.quiesceRuntime(),
      releaseHostLease: () => this.releaseCurrentLease(),
      recoverAfterFailedUpdate: () => this.recoverHostAfterFailedUpdate(),
    });
  }

  getSnapshot(): AgentHostSnapshot {
    return {
      state: this.state,
      ...(this.mode ? { mode: this.mode } : {}),
      ...(this.endpoint ? { endpoint: { ...this.endpoint } } : {}),
      updateDrain: this.drainGate.getSnapshot(),
    };
  }

  async startGui(): Promise<WindowsNamedPipeEndpoint> {
    const endpoint = await this.start("gui");
    await this.options.gui.activate();
    return endpoint;
  }

  async startService(): Promise<WindowsNamedPipeEndpoint> {
    return this.start("service");
  }

  async activateGui(): Promise<void> {
    if (this.state !== "running") {
      throw agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host is not running.", true);
    }
    await this.options.gui.activate();
  }

  runBrokerOperation<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    return this.drainGate.run(operationName, operation);
  }

  beginBrokerOperation(operationName: string): UpdateDrainPermit {
    return this.drainGate.enter(operationName);
  }

  async prepareForUpdate(): Promise<boolean> {
    if (this.state !== "running") return false;
    this.state = "draining";
    const prepared = await this.drainGate.prepareForUpdate();
    if (prepared) {
      this.state = "stopped";
      this.endpoint = undefined;
      // Keep the previous mode until the installer is actually handed off so
      // a failed launcher can restore the same GUI or service host shape.
    } else if (this.drainGate.getSnapshot().state === "accepting") {
      this.state = "running";
    } else {
      this.state = "failed";
    }
    return prepared;
  }

  completeUpdateHandoff(): void {
    this.drainGate.completeUpdateHandoff();
    this.state = "stopped";
    this.mode = undefined;
    this.endpoint = undefined;
  }

  async recoverAfterInstallerFailure(): Promise<boolean> {
    const recovered = await this.drainGate.recoverAfterInstallerFailure();
    if (recovered) this.state = "running";
    else if (this.drainGate.getSnapshot().state === "closed") this.state = "failed";
    return recovered;
  }

  private async start(mode: AgentHostMode): Promise<WindowsNamedPipeEndpoint> {
    if (this.state === "running" && this.endpoint) return { ...this.endpoint };
    if (this.startPromise) return this.startPromise;
    if (this.state !== "idle" && this.state !== "stopped") {
      throw agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host cannot be started in its current state.", true);
    }

    this.state = "starting";
    this.startPromise = this.drainGate.run("host-start", async () => {
      const lease = this.options.createLease();
      this.lease = lease;
      try {
        const endpoint = await lease.acquire(this.options.leaseRequest);
        await this.options.runtime.start({ mode, endpoint });
        this.mode = mode;
        this.endpoint = { ...endpoint };
        this.state = "running";
        return { ...endpoint };
      } catch (error) {
        await this.options.runtime.abortStartup().catch(() => undefined);
        await lease.release().catch(() => undefined);
        if (this.lease === lease) this.lease = undefined;
        this.endpoint = undefined;
        this.mode = undefined;
        this.state = "failed";
        throw error;
      } finally {
        this.startPromise = undefined;
      }
    });
    return this.startPromise;
  }

  private async releaseCurrentLease(): Promise<boolean> {
    const lease = this.lease;
    if (!lease) return false;
    try {
      await lease.release();
      if (this.lease === lease) this.lease = undefined;
      return true;
    } catch {
      return false;
    }
  }

  private async recoverHostAfterFailedUpdate(): Promise<void> {
    const previousMode = this.mode;
    if (!previousMode) throw new Error("No Agent host mode is available for recovery.");
    // A drain can fail before releasing the lease. In that case retain the
    // existing secured endpoint instead of attempting a second host bind.
    if (this.lease) {
      const endpoint = this.lease.requireActiveEndpoint();
      await this.options.runtime.recoverAfterFailedUpdate({ mode: previousMode, endpoint });
      this.endpoint = { ...endpoint };
      this.state = "running";
      return;
    }
    const lease = this.options.createLease();
    this.lease = lease;
    try {
      const endpoint = await lease.acquire(this.options.leaseRequest);
      await this.options.runtime.recoverAfterFailedUpdate({ mode: previousMode, endpoint });
      this.endpoint = { ...endpoint };
      this.state = "running";
    } catch (error) {
      await this.options.runtime.abortStartup().catch(() => undefined);
      await lease.release().catch(() => undefined);
      if (this.lease === lease) this.lease = undefined;
      this.endpoint = undefined;
      throw error;
    }
  }
}
