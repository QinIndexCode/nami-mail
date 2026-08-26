export type BrokerRecoveryGateState = "accepting" | "draining" | "closed";

export type BrokerRecoveryResult<TBroker> =
  | { status: "healthy"; broker: TBroker }
  | { status: "recovered"; broker: TBroker }
  | { status: "not-accepting"; state: Exclude<BrokerRecoveryGateState, "accepting"> };

/**
 * The coordinator owns replacement sequencing only. Callers retain ownership
 * of the concrete Broker implementation and provide its signed liveness probe.
 */
export type BrokerRecoveryCoordinatorOptions<TBroker> = {
  getGateState: () => BrokerRecoveryGateState;
  getCurrentBroker: () => TBroker | undefined;
  setCurrentBroker: (broker: TBroker | undefined) => void;
  closeBroker: (broker: TBroker) => Promise<void>;
  startBroker: () => Promise<TBroker>;
  probeSignedBroker: (broker: TBroker) => Promise<boolean>;
};

/**
 * Makes an existing in-process Broker usable again without racing update
 * drainage. Concurrent callers share one recovery attempt.
 */
export class BrokerRecoveryCoordinator<TBroker> {
  private ensurePromise: Promise<BrokerRecoveryResult<TBroker>> | undefined;

  constructor(private readonly options: BrokerRecoveryCoordinatorOptions<TBroker>) {}

  ensureHealthy(): Promise<BrokerRecoveryResult<TBroker>> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.ensureHealthyOnce().finally(() => {
        this.ensurePromise = undefined;
      });
    }
    return this.ensurePromise;
  }

  private async ensureHealthyOnce(): Promise<BrokerRecoveryResult<TBroker>> {
    const beforeProbe = this.notAcceptingResult();
    if (beforeProbe) return beforeProbe;

    const current = this.options.getCurrentBroker();
    if (current && await this.isSignedBrokerLive(current)) {
      const afterProbe = this.notAcceptingResult();
      return afterProbe ?? { status: "healthy", broker: current };
    }

    const afterProbe = this.notAcceptingResult();
    if (afterProbe) return afterProbe;

    if (current) {
      await this.options.closeBroker(current);
      this.clearCurrentBroker(current);
      const afterClose = this.notAcceptingResult();
      if (afterClose) return afterClose;
    }

    return this.startAndVerifyReplacement();
  }

  private async startAndVerifyReplacement(): Promise<BrokerRecoveryResult<TBroker>> {
    const beforeStart = this.notAcceptingResult();
    if (beforeStart) return beforeStart;

    const replacement = await this.options.startBroker();
    const afterStart = this.notAcceptingResult();
    if (afterStart) {
      await this.disposeReplacement(replacement);
      return afterStart;
    }

    const isLive = await this.isSignedBrokerLive(replacement);
    const afterReplacementProbe = this.notAcceptingResult();
    if (afterReplacementProbe) {
      await this.disposeReplacement(replacement);
      return afterReplacementProbe;
    }
    if (!isLive) {
      await this.disposeReplacement(replacement);
      throw new Error("The replacement NamiMail Agent Broker did not pass its signed liveness probe.");
    }

    this.options.setCurrentBroker(replacement);
    const afterAttach = this.notAcceptingResult();
    if (afterAttach) {
      await this.disposeReplacement(replacement);
      return afterAttach;
    }
    return { status: "recovered", broker: replacement };
  }

  private async isSignedBrokerLive(broker: TBroker): Promise<boolean> {
    try {
      return await this.options.probeSignedBroker(broker) === true;
    } catch {
      return false;
    }
  }

  private notAcceptingResult(): Extract<BrokerRecoveryResult<TBroker>, { status: "not-accepting" }> | undefined {
    const state = this.options.getGateState();
    return state === "accepting" ? undefined : { status: "not-accepting", state };
  }

  private clearCurrentBroker(broker: TBroker): void {
    if (this.options.getCurrentBroker() === broker) this.options.setCurrentBroker(undefined);
  }

  private async disposeReplacement(broker: TBroker): Promise<void> {
    this.clearCurrentBroker(broker);
    await this.options.closeBroker(broker);
  }
}
