import { serializeRuntimeError } from "./desktop-diagnostics.mjs";
import type { ServerStartParams } from "./server-bridge.mjs";

export const desktopLoopbackPort = "0";

export async function startDesktopService(
  bridge: { start(params: ServerStartParams): Promise<unknown> },
  params: Omit<ServerStartParams, "host" | "port">,
): Promise<void> {
  await bridge.start({ ...params, host: "127.0.0.1", port: desktopLoopbackPort });
}

/**
 * The one local-service startup sequence.
 *
 * The desktop has exactly two ways to bring the mail service up: the first
 * launch (`boot`) and crash recovery (`restartLocalServiceAfterCrash`). They
 * used to be two hand-written copies of the same steps — load the master key,
 * fork the utility process, apply the desktop-only settings, put the renderer
 * back on the new service, restore the Agent broker — and they had already
 * drifted: recovery silently skipped the settings step, and its window reload
 * could fail into a `console.error` that a packaged install never shows. The
 * next step boot grows is the step recovery silently misses, so the sequence
 * lives here once and both callers supply the same effects.
 *
 * Electron stays out of here: `main.mts` supplies the effects (key, fork,
 * window, broker, logging, dialogs) and this module owns the order and the
 * failure policy. First-launch-only work (startup timings, the desktop smoke
 * progress file, splash dismissal, pairing requests) arrives through optional
 * hooks, so a recovery run never executes a smoke probe.
 */
export type ServiceStartupPlan<TService> = {
  /** Loads (or creates) the master-key copy the service is started with. */
  loadMasterKey: () => Promise<Buffer>;
  /** Forks the utility process and completes its start handshake. */
  startService: (masterKey: Buffer) => Promise<TService>;
  /**
   * Installs the started handle. The settings and window effects read the
   * service through module state in main.mts, so the handle has to be visible
   * before either of them runs.
   */
  installService: (service: TService) => void;
  /** Applies the desktop-only settings the freshly started service loaded. */
  applySettings: () => void;
  /**
   * Brings the external Agent broker back. Must never reject: every host mode
   * has its own broker policy (first launch notes a smoke diagnostic, the
   * headless agent host treats it as fatal, recovery logs it), and this module
   * has no business picking one.
   */
  restoreBroker: () => Promise<void>;
  /** Omitted for hosts without a window (the headless service host). */
  restoreWindow?: () => Promise<void>;
  /** Bounded runtime-log appender; a packaged install has no console. */
  log: (event: string, detail?: Record<string, unknown>) => void;
  /** Runs once the service is up, before the desktop-only settings. */
  onServiceStarted?: () => void | Promise<void>;
  /** Runs once the window finished loading the new service. */
  onWindowRestored?: () => void | Promise<void>;
  /** Runs once the broker is back. */
  onBrokerRestored?: () => void | Promise<void>;
  /** Presents a window restore that failed. Only used in "report" mode. */
  onWindowRestoreFailure?: (error: unknown) => void;
  /**
   * "throw" hands the failed window restore to the caller's own failure path
   * (first launch, where that path tears the process down). The default
   * "report" shows the failure and keeps the app running on the recovered
   * service — the whole point of the recovery path.
   */
  windowRestoreFailure?: "report" | "throw";
  /**
   * Resolve only once the window and broker restores settled. The first launch
   * does; crash recovery does not, so a renderer that never finishes loading
   * cannot hold the restart handshake open and have the next crash swallowed
   * as part of this attempt. In the background mode every settle is absorbed,
   * including a throwing failure handler. Defaults to true.
   */
  awaitRestores?: boolean;
};

/**
 * key -> fork -> install -> settings -> surfaces (window + broker).
 *
 * The broker restore is kicked off before the window navigation and joined
 * after it: its PowerShell handshake is the slowest restore and the first
 * paint does not need it, so overlapping the two is what keeps it off the
 * critical path. The master key is zeroed on every exit — the fork helper
 * zeroes its own copy, this covers a throw in between.
 */
export async function startLocalServiceAndRestoreDesktop<TService>(plan: ServiceStartupPlan<TService>): Promise<void> {
  const masterKey = await plan.loadMasterKey();
  try {
    plan.installService(await plan.startService(masterKey));
    await plan.onServiceStarted?.();
    plan.applySettings();
    const broker = plan.restoreBroker();
    const window = plan.restoreWindow ? restoreWindowQuietly(plan, plan.restoreWindow) : Promise.resolve();
    if (plan.awaitRestores === false) {
      // Recovery resolves on the service handshake alone; the surfaces are
      // left to come back on their own. Both settles are absorbed so a
      // rejecting broker restore cannot surface as an unhandled rejection.
      void window.catch(() => undefined);
      void broker.catch(() => undefined);
      return;
    }
    await window;
    await broker;
    await plan.onBrokerRestored?.();
  } finally {
    masterKey.fill(0);
  }
}

async function restoreWindowQuietly<TService>(plan: ServiceStartupPlan<TService>, restoreWindow: () => Promise<void>): Promise<void> {
  try {
    await restoreWindow();
    await plan.onWindowRestored?.();
  } catch (error) {
    plan.log("window-restore-failed", serializeRuntimeError(error));
    if (plan.windowRestoreFailure === "throw") throw error;
    plan.onWindowRestoreFailure?.(error);
  }
}
