/**
 * Cross-process bridge between the Electron main process and the local mail
 * service, which now runs in a separate utility process.
 *
 * Why: the service owns SQLite (synchronous native calls), IMAP round-trips,
 * payload decryption and the Agent loop. When it ran inside main, every one of
 * those shared the main process event loop with window management, IPC and
 * every renderer request that travels through it — a busy mailbox froze the
 * whole window (measured: flag updates waiting 16s, requests averaging
 * 258-426ms of synchronous work on the UI thread's host).
 *
 * The bridge keeps the `RunningServer` surface main already consumed: method
 * calls become correlated requests over a MessagePort, and server-initiated
 * callbacks (new mail, auto-reply, startup timings, settings changes, external
 * confirmations) flow back the same way.
 *
 * Everything crossing the boundary is structured-cloned, so no function,
 * Symbol or class instance survives. Two consequences shape this contract:
 *
 * 1. The desktop confirmation capability is created *inside* the service
 *    process (see `server-host.mts`); a capability can never be serialized.
 * 2. Settings are cached. `getSettings()` is called from synchronous main-
 *    process paths (native tray menus and dialogs, notification gating) where
 *    an await is impossible, so the client keeps the last snapshot the service
 *    pushed and refreshes it asynchronously.
 *
 * The module is transport-agnostic on purpose: `server-process.mts` supplies
 * the Electron `utilityProcess` transport, tests supply an in-memory one.
 */
import type { AgentResponseEnvelope, BrokerJsonValue, ExternalPairingSummary } from "@nami/agent-contracts";

export type BridgeRequest = { id: number; method: string; params?: unknown[] };
export type BridgeResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
export type BridgeEvent = { event: string; payload: unknown };

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  return Boolean(value) && typeof value === "object" && typeof (value as BridgeRequest).method === "string" && typeof (value as BridgeRequest).id === "number";
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  return Boolean(value) && typeof value === "object" && typeof (value as BridgeResponse).id === "number" && typeof (value as BridgeResponse).ok === "boolean";
}

export function isBridgeEvent(value: unknown): value is BridgeEvent {
  return Boolean(value) && typeof value === "object" && typeof (value as BridgeEvent).event === "string";
}

/**
 * Correlates request ids with their pending promises. Bounded by construction:
 * every request either settles or is rejected when the transport dies, so a
 * lost response can never leak a promise.
 */
export class PendingRequests {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextIdValue = 1;

  nextId(): number {
    return this.nextIdValue++;
  }

  create<T>(id: number): { promise: Promise<T> } {
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    return { promise };
  }

  settle(response: BridgeResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.value);
    else entry.reject(new Error(response.error || "The local service request failed."));
    return true;
  }

  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export type CloseBehavior = "ask" | "tray" | "quit";
export type NotificationSound = "system" | "soft" | "bright" | "none";

/**
 * The settings subset the main process needs *synchronously*. It mirrors the
 * fields of the service's `AppSettings` that native code reads directly; the
 * service returns the full object and the extra keys are simply carried along.
 */
export type ServerBridgeSettings = {
  locale: string;
  notificationsEnabled: boolean;
  notifyWhenFocused: boolean;
  notificationSound: NotificationSound;
  closeBehavior: CloseBehavior;
  launchAtStartup: boolean;
  globalShortcutEnabled: boolean;
};

/** Used until the service reports its real settings (or if it never does). */
export const defaultServerBridgeSettings: ServerBridgeSettings = {
  locale: "zh-CN",
  notificationsEnabled: true,
  notifyWhenFocused: false,
  notificationSound: "soft",
  closeBehavior: "ask",
  launchAtStartup: false,
  globalShortcutEnabled: false,
};

export type ServerStartParams = {
  host: string;
  port: string;
  databasePath: string;
  /** Raw key bytes transferred as a typed array (Buffers do not survive structured clone). */
  masterKey: Uint8Array;
  localApiAccessToken?: string;
  userDataPath?: string;
  env: Record<string, string | undefined>;
};

export type ServerTransport = {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};

/** New-mail payload forwarded to the tray/notification pipeline. */
export type ServerNewMailPayload = {
  id: string;
  accountId: string;
  subject: string;
  fromName: string;
  fromAddress: string;
};

export type ServerBridgeHandle = {
  readonly url: string;
  invokeExternalAgentTool: (input: unknown) => Promise<AgentResponseEnvelope<BrokerJsonValue>>;
  /** Round-trips to the service: pairings must be current at approval time. */
  listExternalPairingAccountIds: () => Promise<string[]>;
  listExternalPairings: () => Promise<readonly ExternalPairingSummary[]>;
  /** Synchronous: served from the last settings snapshot the service pushed. */
  getSettings: () => ServerBridgeSettings;
  /** Round-trips to the service and refreshes the snapshot on success. */
  updateSettings: (patch: Record<string, unknown>) => Promise<ServerBridgeSettings>;
  resolveAgentConfirmation?: (confirmationId: string, decision: "approve" | "reject") => Promise<{ ok: boolean }>;
  close: () => Promise<void>;
};

export type ServerBridgeHostHandlers = {
  /** Server announces new mail (tray badge / notification). */
  onNewInboxMessages?: (messages: ServerNewMailPayload[]) => void;
  /** Payload is structured-cloned and therefore untrusted; the caller narrows it. */
  onAutoReplyEvent?: (event: unknown) => void;
  onStartupTiming?: (stage: string, elapsedMs: number) => void;
  /** Fired after the cached settings snapshot was refreshed. */
  onSettingsChanged?: () => void;
  /** Server asks main for the persisted external pairing list. */
  listExternalPairings?: () => Promise<unknown[]>;
  /** Server asks main to show the native external-confirmation dialog. */
  requestExternalConfirmation?: (input: unknown) => Promise<"approve" | "reject">;
};

/** Methods the host exposes to main once the server is up. */
const HANDLE_METHODS = {
  invokeExternalAgentTool: "invokeExternalAgentTool",
  listExternalPairingAccountIds: "listExternalPairingAccountIds",
  listExternalPairings: "listExternalPairings",
  getSettings: "getSettings",
  updateSettings: "updateSettings",
  resolveAgentConfirmation: "resolveAgentConfirmation",
  close: "close",
} as const;

/**
 * Main-side client: exposes the service over a transport and answers the
 * callbacks the service needs from the desktop (dialogs, pairing storage).
 */
export function createServerBridgeClient(
  transport: ServerTransport,
  handlers: ServerBridgeHostHandlers = {},
): {
  start(params: ServerStartParams): Promise<{ url: string }>;
  handle: ServerBridgeHandle;
} {
  const pending = new PendingRequests();
  let url = "";
  let settings: ServerBridgeSettings = { ...defaultServerBridgeSettings };
  let dead = false;
  let closed = false;

  const request = <T,>(method: string, params: unknown[] = []): Promise<T> => {
    if (dead) return Promise.reject(new Error("The local service is no longer running."));
    const id = pending.nextId();
    const { promise } = pending.create<T>(id);
    transport.send({ id, method, params } satisfies BridgeRequest);
    return promise;
  };

  const refreshSettings = async (): Promise<void> => {
    try {
      settings = await request<ServerBridgeSettings>(HANDLE_METHODS.getSettings);
      handlers.onSettingsChanged?.();
    } catch {
      // The service is gone or not ready: keep the last snapshot rather than
      // resetting native menus to defaults.
    }
  };

  transport.onMessage((raw) => {
    if (isBridgeResponse(raw)) {
      pending.settle(raw);
      return;
    }
    if (isBridgeEvent(raw)) {
      switch (raw.event) {
        case "new-inbox-messages":
          handlers.onNewInboxMessages?.(Array.isArray(raw.payload) ? (raw.payload as ServerNewMailPayload[]) : []);
          break;
        case "auto-reply-event":
          handlers.onAutoReplyEvent?.(raw.payload);
          break;
        case "startup-timing": {
          const payload = (raw.payload ?? {}) as { stage?: unknown; elapsedMs?: unknown };
          if (typeof payload.stage === "string" && typeof payload.elapsedMs === "number") {
            handlers.onStartupTiming?.(payload.stage, payload.elapsedMs);
          }
          break;
        }
        case "settings-changed":
          void refreshSettings();
          break;
        default:
          break;
      }
      return;
    }
    if (!isBridgeRequest(raw)) return;
    // Host-initiated calls: pairing storage and native confirmations.
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      transport.send({ id: raw.id, ...result } satisfies BridgeResponse);
    };
    void (async () => {
      try {
        if (raw.method === "listExternalPairings") {
          reply({ ok: true, value: (await handlers.listExternalPairings?.()) ?? [] });
          return;
        }
        if (raw.method === "requestExternalConfirmation") {
          const decision = await handlers.requestExternalConfirmation?.(raw.params?.[0]);
          reply({ ok: true, value: decision ?? "reject" });
          return;
        }
        reply({ ok: false, error: `Unknown host method "${raw.method}".` });
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  transport.onExit(() => {
    dead = true;
    pending.rejectAll(new Error("The local service exited."));
  });

  return {
    async start(params) {
      const result = await request<{ url: string }>("start", [params]);
      url = result.url;
      // Prime the synchronous snapshot before main starts reading it (tray
      // menu, close prompt, notification gating).
      settings = await request<ServerBridgeSettings>(HANDLE_METHODS.getSettings);
      return result;
    },
    handle: {
      get url() {
        return url;
      },
      invokeExternalAgentTool: (input) => request<AgentResponseEnvelope<BrokerJsonValue>>(HANDLE_METHODS.invokeExternalAgentTool, [input]),
      listExternalPairingAccountIds: () => request<string[]>(HANDLE_METHODS.listExternalPairingAccountIds),
      listExternalPairings: () => request<readonly ExternalPairingSummary[]>(HANDLE_METHODS.listExternalPairings),
      getSettings: () => settings,
      updateSettings: async (patch) => {
        const next = await request<ServerBridgeSettings>(HANDLE_METHODS.updateSettings, [patch]);
        settings = next;
        return next;
      },
      resolveAgentConfirmation: (confirmationId, decision) => request<{ ok: boolean }>(HANDLE_METHODS.resolveAgentConfirmation, [confirmationId, decision]),
      close: async () => {
        if (closed) return;
        closed = true;
        await request<void>(HANDLE_METHODS.close);
      },
    },
  };
}
