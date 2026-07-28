import { spawn as nodeSpawn } from "node:child_process";
import { agentDesktopError } from "./contracts.mjs";

export const agentHostServiceModeExitPolicy = {
  normalShutdownExitCode: 0,
  startupFailureExitCode: 1,
} as const;

export type AgentHostLaunchPlan = {
  executablePath: string;
  arguments: readonly ["--agent-host"];
  exitPolicy: typeof agentHostServiceModeExitPolicy;
  options: {
    detached: false;
    shell: false;
    stdio: "ignore";
    windowsHide: true;
  };
};

export type SpawnedAgentHostProcess = {
  pid?: number;
  unref?: () => void;
};

export interface AgentHostProcessSpawner {
  spawn(plan: AgentHostLaunchPlan): SpawnedAgentHostProcess;
}

export function createNodeAgentHostProcessSpawner(): AgentHostProcessSpawner {
  return {
    spawn(plan) {
      return nodeSpawn(plan.executablePath, [...plan.arguments], plan.options);
    },
  };
}

export type AgentHostServiceStartResult = {
  status: "started" | "already-running";
  pid?: number;
};

export interface AgentHostServiceStarter {
  start(): Promise<AgentHostServiceStartResult>;
}

export type ElectronAgentHostServiceStarterOptions = {
  executablePath: string;
  spawner: AgentHostProcessSpawner;
  verifySecureBroker: () => Promise<boolean>;
  isHostRunning?: () => Promise<boolean>;
  waitForReady: () => Promise<void>;
};

function validExecutablePath(value: string): boolean {
  return value.trim().length > 0 && value.length <= 32_768 && !value.includes("\u0000");
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createAgentHostLaunchPlan(executablePath: string): AgentHostLaunchPlan {
  if (!validExecutablePath(executablePath)) {
    throw agentDesktopError("INVALID_ARGUMENT", "The packaged NamiMail executable path is not valid.", false);
  }
  return {
    executablePath,
    arguments: ["--agent-host"],
    exitPolicy: agentHostServiceModeExitPolicy,
    options: {
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  };
}

export class ElectronAgentHostServiceStarter implements AgentHostServiceStarter {
  private startPromise: Promise<AgentHostServiceStartResult> | undefined;

  constructor(private readonly options: ElectronAgentHostServiceStarterOptions) {}

  async start(): Promise<AgentHostServiceStartResult> {
    if (!this.startPromise) {
      this.startPromise = this.startOnce().finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async startOnce(): Promise<AgentHostServiceStartResult> {
    let secureBrokerAvailable: boolean;
    try {
      secureBrokerAvailable = await this.options.verifySecureBroker();
    } catch {
      throw agentDesktopError(
        "BROKER_SECURITY_UNAVAILABLE",
        "NamiMail could not verify SID-DACL named-pipe Agent IPC.",
        false,
      );
    }
    if (secureBrokerAvailable !== true) {
      throw agentDesktopError(
        "BROKER_SECURITY_UNAVAILABLE",
        "NamiMail cannot start Agent service mode without SID-DACL named-pipe IPC.",
        false,
        "Open NamiMail after secure local Agent IPC is available.",
      );
    }
    if (this.options.isHostRunning) {
      let hostIsRunning: boolean;
      try {
        hostIsRunning = await this.options.isHostRunning();
      } catch {
        throw agentDesktopError(
          "HOST_UNAVAILABLE",
          "NamiMail could not verify the existing Agent host before starting the service.",
          true,
        );
      }
      if (hostIsRunning) return { status: "already-running" };
    }

    const plan = createAgentHostLaunchPlan(this.options.executablePath);
    let child: SpawnedAgentHostProcess;
    try {
      child = this.options.spawner.spawn(plan);
    } catch {
      throw agentDesktopError(
        "HOST_UNAVAILABLE",
        "NamiMail could not start the packaged Agent host.",
        true,
        "Open NamiMail and try again.",
      );
    }
    if (!child || typeof child !== "object") {
      throw agentDesktopError("HOST_UNAVAILABLE", "NamiMail did not receive a process handle for the Agent host.", true);
    }
    child.unref?.();

    try {
      await this.options.waitForReady();
    } catch {
      throw agentDesktopError(
        "HOST_UNAVAILABLE",
        "NamiMail started the Agent host but it did not become ready.",
        true,
        "Wait briefly, then run namimail status.",
      );
    }

    return {
      status: "started",
      ...(validPid(child.pid) ? { pid: child.pid } : {}),
    };
  }
}
