/**
 * Entry point of the local-service utility process.
 *
 * The child owns everything heavy: SQLite (synchronous native calls), IMAP
 * round-trips, payload decryption, the Agent loop and the HTTP server. Main
 * only forwards a handful of desktop-only capabilities (native dialogs,
 * pairing storage) back over the bridge.
 *
 * Startup ordering matters: the server's config module reads HOST / PORT /
 * DATABASE_PATH at import time, so the environment is seeded from the start
 * payload *before* the runtime module is imported.
 *
 * The desktop confirmation capability is minted here, not in main: a Symbol or
 * closure cannot cross a process boundary, and the capability's only job is to
 * prove "the caller is this process's own UI path". Keeping it local to the
 * service preserves exactly that property.
 */
import { Buffer } from "node:buffer";
import {
  isBridgeRequest,
  isBridgeResponse,
  type ServerBridgeSettings,
  type ServerStartParams,
  type ServerTransport,
  PendingRequests,
} from "./server-bridge.mjs";

type RunningServerLike = {
  url: string;
  invokeExternalAgentTool(input: unknown): Promise<unknown>;
  listExternalPairingAccountIds(): string[];
  listExternalPairings(): readonly unknown[] | Promise<readonly unknown[]>;
  getSettings(): ServerBridgeSettings;
  updateSettings(patch: Record<string, unknown>): ServerBridgeSettings;
  resolveAgentConfirmation?(confirmationId: string, decision: "approve" | "reject"): Promise<{ ok: boolean }>;
  close(): Promise<void>;
};

type ServerRuntimeModule = {
  startServer(options: Record<string, unknown>): Promise<RunningServerLike>;
};

type ParentPortLike = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
};

function parentPortTransport(): ServerTransport {
  // utilityProcess exposes process.parentPort; a plain fork() child only has
  // process message events. Both are supported so the host can be exercised
  // (and debugged) outside Electron.
  const candidates: ParentPortLike[] = [];
  const nodeProcess = process as unknown as { parentPort?: ParentPortLike };
  if (nodeProcess.parentPort) candidates.push(nodeProcess.parentPort);
  candidates.push({
    postMessage: (message: unknown) => {
      process.send?.(message);
    },
    on: (_event: "message", listener: (event: { data: unknown }) => void) => {
      process.on("message", (data: unknown) => listener({ data }));
    },
  });

  const listeners = new Set<(message: unknown) => void>();
  const primary = candidates[0];
  primary?.on("message", (event) => {
    for (const listener of listeners) listener(event.data);
  });

  return {
    send: (message) => {
      for (const port of candidates) port.postMessage(message);
    },
    onMessage: (listener) => {
      listeners.add(listener);
    },
    onExit: () => undefined,
    kill: () => process.exit(0),
  };
}

function applyStartEnvironment(params: ServerStartParams): void {
  process.env.HOST = params.host;
  process.env.PORT = params.port;
  process.env.DATABASE_PATH = params.databasePath;
  for (const [key, value] of Object.entries(params.env)) {
    if (value === undefined) continue;
    process.env[key] = value;
  }
}

/**
 * Starts the bridge host. `importRuntime` is injected so tests can substitute a
 * fake server without touching the filesystem or binding a port.
 */
export async function startServerHost(
  transport: ServerTransport,
  importRuntime: () => Promise<ServerRuntimeModule>,
  onReady?: (server: RunningServerLike) => void,
): Promise<void> {
  let server: RunningServerLike | undefined;
  const pending = new PendingRequests();

  const requestMain = <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const id = pending.nextId();
    const { promise } = pending.create<T>(id);
    transport.send({ id, method, params });
    return promise;
  };

  const reply = (id: number, result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
    transport.send({ id, ...result });
  };

  transport.onMessage(async (raw) => {
    if (isBridgeResponse(raw)) {
      pending.settle(raw);
      return;
    }
    if (!isBridgeRequest(raw)) return;
    try {
      if (raw.method === "start") {
        const params = (raw.params?.[0] ?? {}) as ServerStartParams;
        applyStartEnvironment(params);
        const runtime = await importRuntime();
        server = await runtime.startServer({
          masterKey: Buffer.from(params.masterKey),
          localApiAccessToken: params.localApiAccessToken,
          onNewInboxMessages: (messages: unknown) => {
            transport.send({ event: "new-inbox-messages", payload: messages });
          },
          onAutoReplyEvent: (event: unknown) => {
            transport.send({ event: "auto-reply-event", payload: event });
          },
          onStartupTiming: (stage: string, elapsedMs: number) => {
            transport.send({ event: "startup-timing", payload: { stage, elapsedMs } });
          },
          // Settings live in the child's database; main keeps a synchronous
          // snapshot (tray menus, close prompt, notification gating) and needs
          // to hear about every change, whichever path made it — the settings
          // page, the Agent settings tool, or main itself.
          onSettingsChanged: () => {
            transport.send({ event: "settings-changed", payload: { at: new Date().toISOString() } });
          },
          listExternalPairings: () => requestMain<unknown[]>("listExternalPairings"),
          externalConfirmation: {
            request: async (input: unknown) => {
              const decision = await requestMain<"approve" | "reject">("requestExternalConfirmation", [input]);
              return decision === "approve" ? "approve" : "reject";
            },
          },
          // The capability never leaves this process: only the desktop main
          // process can reach this child, and it does so over a private port.
          desktopConfirmation: {
            capability: DESKTOP_CONFIRMATION_CAPABILITY,
            verifier: {
              verify: (input: unknown) => {
                const candidate = input as { capability?: unknown } | undefined;
                if (!candidate || candidate.capability !== DESKTOP_CONFIRMATION_CAPABILITY) return undefined;
                return { principalId: "nami-desktop-main", surfaceId: "nami-main-window" };
              },
            },
          },
        });
        onReady?.(server);
        reply(raw.id, { ok: true, value: { url: server.url } });
        return;
      }

      if (!server) {
        reply(raw.id, { ok: false, error: "The local service has not started." });
        return;
      }
      switch (raw.method) {
        case "invokeExternalAgentTool":
          reply(raw.id, { ok: true, value: await server.invokeExternalAgentTool(raw.params?.[0]) });
          return;
        case "listExternalPairingAccountIds":
          reply(raw.id, { ok: true, value: server.listExternalPairingAccountIds() });
          return;
        case "listExternalPairings":
          reply(raw.id, { ok: true, value: await server.listExternalPairings() });
          return;
        case "getSettings":
          reply(raw.id, { ok: true, value: server.getSettings() });
          return;
        case "updatedSettings":
        case "updateSettings":
          reply(raw.id, { ok: true, value: server.updateSettings((raw.params?.[0] ?? {}) as Record<string, unknown>) });
          return;
        case "resolveAgentConfirmation": {
          const decision = raw.params?.[1] === "approve" ? "approve" : "reject";
          const result = await server.resolveAgentConfirmation?.(String(raw.params?.[0] ?? ""), decision);
          reply(raw.id, { ok: true, value: result ?? { ok: false } });
          return;
        }
        case "close":
          await server.close();
          reply(raw.id, { ok: true, value: null });
          return;
        default:
          reply(raw.id, { ok: false, error: `Unknown method "${raw.method}".` });
      }
    } catch (error) {
      reply(raw.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

const DESKTOP_CONFIRMATION_CAPABILITY = Object.freeze({ __namiDesktopConfirmation: true });

// Auto-start when loaded as the utility-process entry (the default export is
// exported separately so tests can drive startServerHost() directly).
if (process.env.NAMI_MAIL_SERVER_HOST_AUTOSTART === "1") {
  const runtimePath = "../../server/dist/runtime.js";
  void startServerHost(
    parentPortTransport(),
    () => import(runtimePath) as unknown as Promise<ServerRuntimeModule>,
  ).catch((error) => {
    process.stderr.write(`Nami Mail local service failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
