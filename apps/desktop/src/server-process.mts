/**
 * Electron transport for the local-service utility process.
 *
 * `server-bridge.mts` deliberately knows nothing about Electron; this module is
 * the only place that does. It forks the service host and adapts the Electron
 * `UtilityProcess` surface to the transport the bridge expects.
 *
 * Two details matter:
 *
 * - The child gets `<ignore, pipe, pipe>` stdio so its pino output can be
 *   folded into the desktop's bounded runtime log instead of vanishing; a
 *   packaged install has no console attached.
 * - `NAMI_MAIL_SERVER_HOST_AUTOSTART=1` is what turns `server-host.mjs` from a
 *   importable module into a self-starting entry point.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import type { ServerTransport } from "./server-bridge.mjs";

export type ForkServerProcessOptions = {
  /** Absolute path to the built `server-host.mjs`. */
  modulePath: string;
  /** Extra environment on top of this process's own (nami-mail.env is already loaded). */
  env?: Record<string, string | undefined>;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  onExit?: (code: number | null) => void;
};

export type ServerProcessHandle = {
  transport: ServerTransport;
  readonly pid: number | undefined;
  /** Terminates the child. Safe to call more than once. */
  kill(): void;
};

export function forkServerProcess(options: ForkServerProcessOptions): ServerProcessHandle {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
    if (typeof value === "string") env[key] = value;
  }
  env.NAMI_MAIL_SERVER_HOST_AUTOSTART = "1";

  const child: UtilityProcess = utilityProcess.fork(options.modulePath, [], {
    serviceName: "Nami Mail local service",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  child.stdout?.on("data", (chunk: Buffer) => options.onOutput?.("stdout", chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => options.onOutput?.("stderr", chunk.toString("utf8")));
  child.on("exit", (code) => options.onExit?.(typeof code === "number" ? code : null));

  let killed = false;
  return {
    transport: {
      send: (message) => {
        if (killed) return;
        child.postMessage(message);
      },
      onMessage: (listener) => {
        child.on("message", (message: unknown) => listener(message));
      },
      onExit: (listener) => {
        child.on("exit", (code) => listener(typeof code === "number" ? code : null));
      },
      kill: () => {
        if (killed) return;
        killed = true;
        child.kill();
      },
    },
    get pid() {
      return child.pid;
    },
    kill: () => {
      if (killed) return;
      killed = true;
      child.kill();
    },
  };
}
