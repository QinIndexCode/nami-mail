import { agentDesktopError } from "./contracts.mjs";

export type UpdateDrainState = "accepting" | "draining" | "drained" | "recovering" | "closed";

export type UpdateDrainSnapshot = {
  state: UpdateDrainState;
  activeOperationCount: number;
  lastFailure?: "drain-failed" | "recovery-failed";
};

export interface UpdateDrainAdapter {
  /** Stops new broker work after the in-process gate has closed. */
  stopBrokerIngress: () => Promise<void>;
  /** Closes the Fastify runtime and its database ownership without a timeout. */
  quiesceRuntime: () => Promise<boolean>;
  /** Releases the secured named-pipe lease only after the runtime is closed. */
  releaseHostLease: () => Promise<boolean>;
  /** Reopens the previous host only when an update handoff did not start. */
  recoverAfterFailedUpdate: () => Promise<void>;
}

export type UpdateDrainPermit = {
  release: () => void;
};

/**
 * Serializes update handoff against all Agent entry points. The gate has no
 * TTL: once it starts draining, only an explicit recovery or successful
 * installer handoff may change its state.
 */
export class UpdateDrainGate {
  private state: UpdateDrainState = "accepting";
  private activeOperationCount = 0;
  private waitForZeroOperations: (() => void) | undefined;
  private preparePromise: Promise<boolean> | undefined;
  private lastFailure: UpdateDrainSnapshot["lastFailure"];

  constructor(private readonly adapter: UpdateDrainAdapter) {}

  getSnapshot(): UpdateDrainSnapshot {
    return {
      state: this.state,
      activeOperationCount: this.activeOperationCount,
      ...(this.lastFailure ? { lastFailure: this.lastFailure } : {}),
    };
  }

  enter(operationName = "agent-operation"): UpdateDrainPermit {
    if (this.state !== "accepting") {
      throw agentDesktopError(
        "UPDATE_IN_PROGRESS",
        "NamiMail is preparing an update and cannot accept new Agent operations.",
        true,
        "Wait for the update to finish, then try again.",
      );
    }
    if (!operationName || operationName.length > 128) {
      throw agentDesktopError("INVALID_ARGUMENT", "The Agent operation name is not valid.", false);
    }

    this.activeOperationCount += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.activeOperationCount -= 1;
        if (this.activeOperationCount === 0) {
          const resolve = this.waitForZeroOperations;
          this.waitForZeroOperations = undefined;
          resolve?.();
        }
      },
    };
  }

  async run<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    const permit = this.enter(operationName);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  async prepareForUpdate(): Promise<boolean> {
    if (this.state === "drained") return true;
    if (this.state === "closed") return false;
    if (this.preparePromise) return this.preparePromise;
    if (this.state !== "accepting") return false;

    // Set this synchronously before invoking an adapter so a concurrently
    // arriving IPC request cannot enter between the two drain barriers.
    this.state = "draining";
    this.lastFailure = undefined;
    this.preparePromise = this.drain();
    try {
      return await this.preparePromise;
    } finally {
      this.preparePromise = undefined;
    }
  }

  private async drain(): Promise<boolean> {
    try {
      await this.adapter.stopBrokerIngress();
      await this.waitForOperationsToFinish();
      if (!await this.adapter.quiesceRuntime()) {
        throw new Error("Runtime did not quiesce.");
      }
      if (!await this.adapter.releaseHostLease()) {
        throw new Error("Host lease did not release.");
      }
      this.state = "drained";
      return true;
    } catch {
      this.lastFailure = "drain-failed";
      return this.recoverAfterDrainFailure();
    }
  }

  private waitForOperationsToFinish(): Promise<void> {
    if (this.activeOperationCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waitForZeroOperations = resolve;
    });
  }

  private async recoverAfterDrainFailure(): Promise<boolean> {
    this.state = "recovering";
    try {
      await this.adapter.recoverAfterFailedUpdate();
      this.state = "accepting";
      return false;
    } catch {
      // A failed recovery must keep the gate closed. Let the existing desktop
      // shutdown/error path decide whether to terminate rather than reopening
      // a possibly half-closed runtime.
      this.lastFailure = "recovery-failed";
      this.state = "closed";
      return false;
    }
  }

  /** Marks the process as handed off after the installer has been launched. */
  completeUpdateHandoff(): void {
    if (this.state !== "drained") {
      throw agentDesktopError("UPDATE_IN_PROGRESS", "NamiMail Agent has not finished draining for update installation.", false);
    }
    this.state = "closed";
  }

  async recoverAfterInstallerFailure(): Promise<boolean> {
    if (this.state !== "drained") return false;
    this.state = "recovering";
    try {
      await this.adapter.recoverAfterFailedUpdate();
      this.lastFailure = undefined;
      this.state = "accepting";
      return true;
    } catch {
      this.lastFailure = "recovery-failed";
      this.state = "closed";
      return false;
    }
  }
}
