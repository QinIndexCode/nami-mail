import type { AgentHostSnapshot } from "./host-controller.mjs";
import { agentDesktopError, type AgentDesktopError } from "./contracts.mjs";

export const agentHostServiceArgument = "--agent-host";
export const agentHostServiceStartupFailureExitCode = 1;

const windowsPipePathPattern = /^\\\\\.\\pipe\\[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const windowsSidPattern = /^S-1-(?:0|1|2|3|5|15|16|18)-(?:\d+-){1,14}\d+$/;

export type DesktopAgentLaunch =
  | { kind: "gui" }
  | { kind: "service" }
  | { kind: "rejected"; error: AgentDesktopError };

/**
 * Parses only Electron's dedicated service flag. Arguments after `--` are
 * application data, not Electron flags, so they must not activate a host.
 */
export function resolveDesktopAgentLaunch(argv: readonly string[]): DesktopAgentLaunch {
  const endOfOptions = argv.indexOf("--");
  const optionArguments = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  const agentHostArguments = optionArguments.filter((argument) => argument.startsWith(agentHostServiceArgument));
  if (agentHostArguments.length === 0) return { kind: "gui" };
  if (agentHostArguments.length === 1 && agentHostArguments[0] === agentHostServiceArgument) {
    return { kind: "service" };
  }
  return {
    kind: "rejected",
    error: agentDesktopError(
      "INVALID_ARGUMENT",
      "NamiMail Agent service mode accepts exactly one --agent-host argument.",
      false,
      "Start the packaged application without Agent flags, or use exactly --agent-host.",
    ),
  };
}

/**
 * There is no Node/Electron API that can prove a pipe's Windows DACL. Until a
 * native adapter provides that proof, service mode must stop before Electron
 * unwraps the master key, opens SQLite, or starts the loopback runtime.
 */
export function unavailableAgentHostStartupError(): AgentDesktopError {
  return agentDesktopError(
    "BROKER_SECURITY_UNAVAILABLE",
    "NamiMail Agent service mode requires a verified SID-DACL Windows named-pipe Broker, which is not installed in this build.",
    false,
    "Open the normal NamiMail application. Do not use a loopback, HTTP, or direct SQLite fallback.",
  );
}

export function startupErrorForDesktopAgentLaunch(launch: Exclude<DesktopAgentLaunch, { kind: "gui" }>): AgentDesktopError {
  return launch.kind === "rejected" ? launch.error : unavailableAgentHostStartupError();
}

export function formatAgentHostStartupFailure(error: AgentDesktopError): string {
  return `NamiMail Agent startup failed [${error.code}]: ${error.message}`;
}

export type AgentUpdateDrainController = {
  getSnapshot: () => AgentHostSnapshot;
  prepareForUpdate: () => Promise<boolean>;
  completeUpdateHandoff: () => void;
  recoverAfterInstallerFailure: () => Promise<boolean>;
};

/**
 * A native bridge must re-check the live pipe descriptor before update drain.
 * A claimed transport string or a Node `net` named pipe is not evidence of a
 * SID DACL and must never enter this lifecycle.
 */
export type VerifiedAgentHost = {
  controller: AgentUpdateDrainController;
  verifyActiveSidDaclPipe: () => Promise<boolean>;
};

function hasVerifiedPipeShape(snapshot: AgentHostSnapshot): boolean {
  const endpoint = snapshot.endpoint;
  return snapshot.state === "running"
    && endpoint?.transport === "windows-named-pipe"
    && windowsPipePathPattern.test(endpoint.path)
    && windowsSidPattern.test(endpoint.ownerSid);
}

/**
 * Bridges the existing controller's drain gate into the updater without
 * treating an absent or unverified Agent host as an active Broker. The normal
 * GUI runtime has no external Agent Broker until a native SID-DACL adapter is
 * available, so its update path remains unchanged.
 */
export class AgentHostUpdateDrainLifecycle {
  private drainedHost: VerifiedAgentHost | undefined;

  constructor(private readonly getActiveHost: () => VerifiedAgentHost | undefined) {}

  hasDrainedHost(): boolean {
    return Boolean(this.drainedHost);
  }

  async prepareForUpdateInstall(): Promise<boolean> {
    if (this.drainedHost) return true;
    const host = this.getActiveHost();
    if (!host) return true;
    if (!hasVerifiedPipeShape(host.controller.getSnapshot())) return false;

    try {
      if (await host.verifyActiveSidDaclPipe() !== true) return false;
      if (await host.controller.prepareForUpdate() !== true) return false;
      this.drainedHost = host;
      return true;
    } catch {
      return false;
    }
  }

  completeUpdateHandoff(): boolean {
    const host = this.drainedHost;
    if (!host) return true;
    try {
      host.controller.completeUpdateHandoff();
      this.drainedHost = undefined;
      return true;
    } catch {
      return false;
    }
  }

  async recoverAfterInstallerFailure(): Promise<boolean> {
    const host = this.drainedHost;
    if (!host) return false;
    this.drainedHost = undefined;
    try {
      return await host.controller.recoverAfterInstallerFailure();
    } catch {
      return false;
    }
  }
}
