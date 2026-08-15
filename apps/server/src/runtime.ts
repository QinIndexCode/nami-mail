import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { migrateAccountCredentialStorage, migrateKnownProviderUsernameCredentials } from "./account-credentials.js";
import {
  AgentService,
  type AgentConfirmationResolution,
  type ExternalAgentToolInvocation,
} from "./agent-service.js";
import type { AgentResponseEnvelope, BrokerJsonValue, ExternalPairingSummary } from "@nami/agent-contracts";
import type { TrustedDesktopConfirmationVerifier } from "./agent/confirmations.js";
import { ImmutableGuiConfirmationStore } from "./agent/confirmations.js";
import { EncryptedAgentAuditStore } from "./agent/audit.js";
import { EncryptedAgentMemoryStore } from "./agent/memory.js";
import { EncryptedAutoReplyDecisionStore } from "./agent/auto-reply-decisions.js";
import { AutoReplyEngine, registerAutoReplyEngine, type AutoReplyUiEvent } from "./agent/auto-reply.js";
import { AccountLifecycleStore } from "./agent/lifecycle.js";
import { AgentMailStateEvents } from "./agent/mail-state-events.js";
import { SqliteMailApplicationService } from "./agent/sqlite-mail-application-service.js";

/**
 * Local web confirmation authority used when Electron does not inject a
 * desktop capability (plain browser / dev-server hosts). The capability is an
 * in-process Symbol that never crosses the HTTP boundary, mirroring the
 * desktop main process; the verifier only accepts a web-ui caller carrying it,
 * so a desktop authority never trusts a web caller and vice versa.
 */
const webConfirmationCapability = Symbol("nami-web-confirmation");
const webConfirmationVerifier: TrustedDesktopConfirmationVerifier = Object.freeze({
  verify: (input: unknown) => {
    if (!input || typeof input !== "object") return undefined;
    const candidate = input as {
      capability?: unknown;
      caller?: { kind?: unknown; interactive?: unknown };
      confirmationId?: unknown;
      requestId?: unknown;
      operation?: unknown;
    };
    if (
      candidate.capability !== webConfirmationCapability
      || candidate.caller?.kind !== "web-ui"
      || candidate.caller?.interactive !== true
      || typeof candidate.confirmationId !== "string"
      || typeof candidate.requestId !== "string"
      || (candidate.operation !== "record-decision" && candidate.operation !== "consume-approval")
    ) return undefined;
    return { principalId: "nami-web-main", surfaceId: "nami-web-browser" };
  },
});
import { applyAgentStoreSchema } from "./agent/schema.js";
import { AgentSourceEventOutbox } from "./agent/source-events.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { loadOrCreateMasterKey } from "./crypto.js";
import { openDatabase, type DatabaseHandle } from "./db.js";
import { ServerEventBus, emitAccountSynced, emitSettingsChanged } from "./events.js";
import { createIdleWatcher, type IdleWatcher } from "./idle.js";
import { OAuthService } from "./oauth.js";
import { cleanupExpiredOutboundAttachments, outboundAttachmentDirectory } from "./outbound-attachments.js";
import { getAppSettings, updateAppSettings, type AppSettings, type AppSettingsPatch } from "./settings.js";
import { submitDueScheduledSubmissions } from "./scheduled-send.js";
import { releaseDueSnoozedMessages } from "./snooze.js";
import { syncAccount, scheduleSentSubmissionVerification, type NewInboxMessage } from "./sync.js";
import type { AccountRecord, RuntimeContext } from "./types.js";

export type RunningServer = {
  app: FastifyInstance;
  url: string;
  port: number;
  /** Present only for the Electron main-process runtime that supplied an opaque capability. */
  resolveAgentConfirmation?: (confirmationId: string, decision: "approve" | "reject") => Promise<AgentConfirmationResolution>;
  /**
   * A transport-free in-process bridge for the desktop Agent Broker. It is
   * deliberately absent from Fastify and cannot expose the renderer token.
   */
  invokeExternalAgentTool: (input: ExternalAgentToolInvocation) => Promise<AgentResponseEnvelope<BrokerJsonValue>>;
  /** Current account IDs captured into a newly approved external pairing. */
  listExternalPairingAccountIds: () => string[];
  /** Non-secret pairing summaries made available to the renderer settings panel. */
  listExternalPairings: () => readonly ExternalPairingSummary[] | Promise<readonly ExternalPairingSummary[]>;
  getSettings: () => AppSettings;
  updateSettings: (patch: AppSettingsPatch) => AppSettings;
  close: () => Promise<void>;
};

export type ServerRuntimeOptions = {
  onNewInboxMessages?: (messages: NewInboxMessage[]) => void | Promise<void>;
  /** Fired for auto-reply drafts created and replies actually sent (desktop popup). */
  onAutoReplyEvent?: (event: AutoReplyUiEvent) => void;
  // Electron supplies a DPAPI-unwrapped copy directly in memory. The
  // command-line runtime intentionally keeps its file-backed development key.
  masterKey?: Buffer;
  /**
   * Desktop-only confirmation authority. This object is passed directly from
   * Electron main and intentionally never enters Fastify's runtime context.
   */
  desktopConfirmation?: Readonly<{
    capability: unknown;
    verifier: TrustedDesktopConfirmationVerifier;
  }>;
  /**
   * Desktop-only external confirmation bridge. Electron main injects a native
   * dialog so paired CLI/MCP write operations at the confirm level ask the
   * user for a visible decision. `--yes` or any CLI flag cannot bypass it.
   */
  externalConfirmation?: Readonly<{
    request: (input: {
      confirmationId: string;
      requestId: string;
      toolName: string;
      callerLabel: string;
      title: string;
      summary: string;
      fields: readonly { label: string; value: string }[];
    }) => Promise<"approve" | "reject">;
  }>;
  /**
   * Desktop-injected pairing summaries for the renderer's external access
   * panel. Absent in browser-only and test hosts, whose API then reports an
   * empty list.
   */
  listExternalPairings?: () => readonly ExternalPairingSummary[] | Promise<readonly ExternalPairingSummary[]>;
};

export type SyncScheduler = {
  reschedule: () => void;
  close: () => Promise<void>;
};

export type SyncSchedulerOptions = {
  getIntervalSeconds: () => number;
  sync: () => Promise<void>;
  onError?: (error: unknown) => void;
};

export const MICROSOFT_OAUTH_CALLBACK_PATH = "/api/oauth/microsoft/callback";

function sendBridgeResponse(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function copyCallbackResponseHeaders(response: ServerResponse, headers: OutgoingHttpHeaders): void {
  for (const name of ["content-type", "content-security-policy", "cache-control", "content-length"] as const) {
    const value = headers[name];
    if (value !== undefined) response.setHeader(name, value);
  }
}

async function forwardMicrosoftOAuthCallback(
  app: FastifyInstance,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    sendBridgeResponse(response, 405, "Method Not Allowed");
    return;
  }

  const rawUrl = request.url;
  if (!rawUrl || !rawUrl.startsWith("/") || rawUrl.startsWith("//")) {
    sendBridgeResponse(response, 404, "Not Found");
    return;
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(rawUrl, "http://localhost");
  } catch {
    sendBridgeResponse(response, 404, "Not Found");
    return;
  }
  if (callbackUrl.pathname !== MICROSOFT_OAUTH_CALLBACK_PATH) {
    sendBridgeResponse(response, 404, "Not Found");
    return;
  }

  try {
    // The browser-provided Host is intentionally discarded. Fastify receives
    // only the fixed callback path and query string, and builds its callback
    // URL from the runtime-owned localhost origin.
    const delegated = await app.inject({
      method: "GET",
      url: `${MICROSOFT_OAUTH_CALLBACK_PATH}${callbackUrl.search}`,
    });
    response.statusCode = delegated.statusCode;
    copyCallbackResponseHeaders(response, delegated.headers);
    response.end(delegated.body);
  } catch (error) {
    app.log.warn({ error }, "Microsoft OAuth callback bridge failed");
    sendBridgeResponse(response, 502, "OAuth callback unavailable");
  }
}

function listenOnIpv6Loopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen({ host: "::1", ipv6Only: true, port });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function createMicrosoftOAuthCallbackBridge(app: FastifyInstance, port: number): Promise<Server> {
  const bridge = createServer((request, response) => {
    void forwardMicrosoftOAuthCallback(app, request, response);
  });
  await listenOnIpv6Loopback(bridge, port);
  return bridge;
}

export async function closeMicrosoftOAuthCallbackBridge(bridge: Server | undefined): Promise<void> {
  if (!bridge?.listening) return;
  await new Promise<void>((resolve, reject) => {
    bridge.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

/**
 * Schedules the next pass only after the current pass completes. This avoids
 * overlapping IMAP work and lets a settings update replace the pending delay.
 */
export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  let timer: NodeJS.Timeout | undefined;
  let activeSync: Promise<void> | undefined;
  let closed = false;

  const scheduleNext = () => {
    if (closed || activeSync || timer) return;
    const seconds = Math.max(1, Math.floor(options.getIntervalSeconds()));
    timer = setTimeout(() => {
      timer = undefined;
      runSync();
    }, seconds * 1_000);
    timer.unref?.();
  };

  const runSync = () => {
    if (closed || activeSync) return;
    const currentSync = Promise.resolve()
      .then(() => options.sync())
      .catch((error) => {
        try {
          options.onError?.(error);
        } catch {
          // Error reporting must not strand shutdown with an unsettled sync.
        }
      });
    activeSync = currentSync;
    void currentSync.then(() => {
      if (activeSync === currentSync) activeSync = undefined;
      scheduleNext();
    });
  };

  const reschedule = () => {
    if (closed) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!activeSync) scheduleNext();
  };

  scheduleNext();
  return {
    reschedule,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await activeSync;
    },
  };
}

export async function startServer(options: ServerRuntimeOptions = {}): Promise<RunningServer> {
  let db: DatabaseHandle | undefined;
  let app: FastifyInstance | undefined;
  let scheduler: SyncScheduler | undefined;
  let idleWatcher: IdleWatcher | undefined;
  let microsoftOAuthCallbackBridge: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let masterKey: Buffer | undefined;
  let agentService: AgentService | undefined;
  let autoReplyEngine: AutoReplyEngine | undefined;
  const translationAbortController = new AbortController();
  const scheduledSendAbortController = new AbortController();

  try {
    const database = openDatabase(config.databasePath);
    db = database;
    const runtimeMasterKey = options.masterKey ? Buffer.from(options.masterKey) : loadOrCreateMasterKey(config.masterKeyPath);
    if (runtimeMasterKey.length !== 32) throw new Error("Master key must be exactly 32 bytes.");
    masterKey = runtimeMasterKey;
    // Legacy credentials are rewrapped before OAuth, sync scheduling, Fastify
    // routes, or any mail client can initiate a network connection.
    migrateAccountCredentialStorage(database, runtimeMasterKey);
    migrateKnownProviderUsernameCredentials(database, runtimeMasterKey);
    applyAgentStoreSchema(database);
    // The settings tool needs to broadcast changes over SSE and decide whether
    // a "custom" background preset is selectable, so the bus and the background
    // directory are resolved before the Agent service is constructed.
    const serverEvents = new ServerEventBus();
    const backgroundDirectory = path.join(path.dirname(config.databasePath), "backgrounds");
    const customBackgroundPattern = /^custom-background-[a-f0-9-]+\.(jpg|png|webp)$/;
    const agentLifecycle = new AccountLifecycleStore(database, runtimeMasterKey);
    const agentSourceEvents = new AgentSourceEventOutbox(database, runtimeMasterKey, agentLifecycle);
    const agentMailEvents = new AgentMailStateEvents(runtimeMasterKey, agentLifecycle, agentSourceEvents);
    const oauthService = new OAuthService(database, runtimeMasterKey);
    const mailApplication = new SqliteMailApplicationService({
      db: database,
      masterKey: runtimeMasterKey,
      oauthService,
      agentMailEvents,
      syncMessageLimit: config.syncMessageLimit,
      outboundAttachmentDirectory: outboundAttachmentDirectory({}),
    });
    agentService = new AgentService({
      db: database,
      masterKey: runtimeMasterKey,
      lifecycle: agentLifecycle,
      sourceEvents: agentSourceEvents,
      mailApplication,
      hasCustomBackground: (filename) => Boolean(filename && customBackgroundPattern.test(filename) && fs.existsSync(path.join(backgroundDirectory, filename))),
      onSettingsChanged: () => emitSettingsChanged(serverEvents),
      ...(options.desktopConfirmation ? { desktopConfirmation: options.desktopConfirmation } : {}),
      ...(options.externalConfirmation ? { externalConfirmation: options.externalConfirmation } : {}),
    });
    agentService.start();
    const autoReplyConfirmationAuthority = options.desktopConfirmation ?? {
      capability: webConfirmationCapability,
      verifier: webConfirmationVerifier,
    };
    autoReplyEngine = new AutoReplyEngine({
      db: database,
      masterKey: runtimeMasterKey,
      evaluate: (input) => agentService!.evaluateAutoReply(input),
      mail: mailApplication,
      audit: new EncryptedAgentAuditStore(database, runtimeMasterKey, agentLifecycle),
      memory: new EncryptedAgentMemoryStore(database, runtimeMasterKey),
      decisions: new EncryptedAutoReplyDecisionStore(database, runtimeMasterKey),
      confirmationStore: new ImmutableGuiConfirmationStore(
        database,
        runtimeMasterKey,
        agentLifecycle,
        undefined,
        autoReplyConfirmationAuthority.verifier,
      ),
      ...(options.desktopConfirmation
        ? { desktopConfirmation: options.desktopConfirmation }
        : { webConfirmation: { capability: webConfirmationCapability } }),
      onEvent: options.onAutoReplyEvent,
    });
    registerAutoReplyEngine(autoReplyEngine);
    const outboundDirectory = outboundAttachmentDirectory({});
    try {
      cleanupExpiredOutboundAttachments(database, outboundDirectory);
    } catch (error) {
      console.warn("Nami Mail could not clean stale outbound attachments", error);
    }
    const broadcastNewInboxMessages = (messages: NewInboxMessage[]) => {
      if (!messages.length) return;
      const byAccount = new Map<string, NewInboxMessage[]>();
      for (const message of messages) {
        const group = byAccount.get(message.accountId) ?? [];
        group.push(message);
        byAccount.set(message.accountId, group);
      }
      for (const [accountId, accountMessages] of byAccount) {
        serverEvents.emit({
          type: "mail.received",
          payload: { accountId, count: accountMessages.length, messages: accountMessages },
        });
      }
    };
    const broadcastSyncedAccounts = (accounts: AccountRecord[], results: PromiseSettledResult<{ synced: number; folders: number; failedFolders: number; newInboxMessages: NewInboxMessage[] }>[]) => {
      for (let i = 0; i < accounts.length; i += 1) {
        const account = accounts[i];
        if (!account || results[i]?.status !== "fulfilled") continue;
        emitAccountSynced(database, serverEvents, account.id);
      }
    };
    const syncAll = async () => {
      // Keep the live watcher in step with the account list; new accounts get
      // an IDLE connection on the next pass, removed ones are dropped.
      if (getAppSettings(database).realtimePushEnabled) {
        await idleWatcher?.ensureAccounts();
      }
      const accounts = database.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRecord[];
      const results = await Promise.allSettled(
        accounts.map((account) => syncAccount(
          database,
          runtimeMasterKey,
          account.id,
          config.syncMessageLimit,
          oauthService,
          agentMailEvents,
        )),
      );
      const newInboxMessages = results.flatMap((result) => result.status === "fulfilled" ? result.value.newInboxMessages : []);
      // Snoozes whose time arrived return to the Inbox and join the same
      // notification pipeline as newly synced messages.
      try {
        newInboxMessages.push(...releaseDueSnoozedMessages(database, runtimeMasterKey));
      } catch (error) {
        fastify.log.warn({ error }, "Could not release due snoozed messages");
      }
      if (newInboxMessages.length && options.onNewInboxMessages) {
        try {
          await options.onNewInboxMessages(newInboxMessages);
        } catch (error) {
          fastify.log.warn({ error }, "New-mail notification callback failed");
        }
      }
      broadcastNewInboxMessages(newInboxMessages);
      broadcastSyncedAccounts(accounts, results);
      // Submit scheduled sends whose time has arrived through the outbox queue.
      try {
        const outcome = await submitDueScheduledSubmissions(database, runtimeMasterKey, {
          outboundAttachmentDirectory: outboundDirectory,
          accessTokenProvider: oauthService,
          agentMailEvents,
          scheduleSentVerification: (submissionId) => {
            scheduleSentSubmissionVerification(database, runtimeMasterKey, submissionId, oauthService, {
              abortSignal: scheduledSendAbortController.signal,
              onDeferred: (error) => {
                fastify.log.info({ submissionId, error }, "Scheduled-send Sent verification deferred");
              },
            });
          },
          onFailure: (submissionId, error) => {
            fastify.log.error({ submissionId, error }, "Scheduled send failed");
          },
        });
        if (outcome.submitted || outcome.failed) {
          fastify.log.info({ ...outcome }, "Scheduled send pass completed");
        }
      } catch (error) {
        fastify.log.error({ error }, "Scheduled-send pass failed");
      }
    };

    idleWatcher = createIdleWatcher({
      db: database,
      masterKey: runtimeMasterKey,
      accessTokenProvider: oauthService,
      // A reported INBOX change runs the account through the same pipeline as
      // a poll pass (re-entrancy guarded by syncAccount), so notifications,
      // rules, and SSE all stay in one code path.
      onChange: (accountId) => {
        void (async () => {
          try {
            const result = await syncAccount(database, runtimeMasterKey, accountId, config.syncMessageLimit, oauthService, agentMailEvents);
            if (result.newInboxMessages.length) {
              if (options.onNewInboxMessages) {
                await options.onNewInboxMessages(result.newInboxMessages);
              }
              broadcastNewInboxMessages(result.newInboxMessages);
            }
            emitAccountSynced(database, serverEvents, accountId);
          } catch (error) {
            fastify.log.warn({ accountId, error }, "IDLE-triggered mailbox sync failed");
          }
        })();
      },
      log: { warn: (message, meta) => fastify.log.warn(meta ?? {}, message) },
    });

    const runtimeContext: RuntimeContext = {
      db: database,
      masterKey: runtimeMasterKey,
      agentMailEvents,
      agentLifecycle,
      agentSourceEvents,
      agentService,
      outboundAttachmentDirectory: outboundDirectory,
      onRefreshIntervalChanged: () => scheduler?.reschedule(),
      oauthService,
      serverEvents,
      onRealtimePushChanged: (enabled) => {
        if (enabled) void idleWatcher?.ensureAccounts();
        else void idleWatcher?.close();
      },
      ...(options.listExternalPairings ? { listExternalPairings: options.listExternalPairings } : {}),
    };
    const fastify = await buildApp(runtimeContext, {
      localApiAccessToken: config.localApiAccessToken,
      translationAbortSignal: translationAbortController.signal,
    });
    app = fastify;

    scheduler = createSyncScheduler({
      getIntervalSeconds: () => getAppSettings(database).refreshIntervalSeconds,
      sync: syncAll,
      onError: (error) => fastify.log.error({ error }, "Background mailbox sync failed"),
    });

    await fastify.listen({ host: config.host, port: config.port });
    const address = fastify.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Nami Mail local service did not provide a TCP address.");
    }

    const port = (address as AddressInfo).port;
    if (oauthService.isConfigured("microsoft")) {
      try {
        microsoftOAuthCallbackBridge = await createMicrosoftOAuthCallbackBridge(fastify, port);
        runtimeContext.microsoftOAuthCallbackOrigin = `http://localhost:${port}`;
      } catch (error) {
        runtimeContext.microsoftOAuthCallbackUnavailable = "Microsoft 安全登录暂不可用：无法启动本机 IPv6 授权回调。请确认 IPv6 回环可用后重试。";
        fastify.log.warn({ error }, "Microsoft OAuth callback bridge unavailable");
      }
    }

    const close = () => {
      closePromise ??= (async () => {
        translationAbortController.abort();
        scheduledSendAbortController.abort();
        try {
          await closeMicrosoftOAuthCallbackBridge(microsoftOAuthCallbackBridge);
        } finally {
          try {
            await Promise.all([
              scheduler?.close(),
              idleWatcher?.close(),
              fastify.close(),
              agentService?.close(),
            ]);
          } finally {
            autoReplyEngine?.close();
            registerAutoReplyEngine(undefined);
            database.close();
            masterKey?.fill(0);
          }
        }
      })();
      return closePromise;
    };

    return {
      app: fastify,
      url: `http://${config.host}:${port}`,
      port,
      invokeExternalAgentTool: (input: ExternalAgentToolInvocation) => agentService!.invokeExternalTool(input),
      listExternalPairingAccountIds: () => agentService!.listExternalPairingAccountIds(),
      listExternalPairings: () => options.listExternalPairings?.() ?? [],
      getSettings: () => getAppSettings(database),
      updateSettings: (patch) => updateAppSettings(database, patch),
      ...(options.desktopConfirmation ? {
        resolveAgentConfirmation: async (confirmationId: string, decision: "approve" | "reject") => {
          // Auto-reply confirmations live outside conversation runs; resolve
          // those first, then fall back to the conversational desktop path.
          const engineResolution = autoReplyEngine?.resolveConfirmation(confirmationId, decision);
          if (engineResolution && "ok" in engineResolution) return { ok: engineResolution.ok };
          return agentService!.resolveDesktopConfirmation(confirmationId, decision);
        },
      } : {}),
      close,
    };
  } catch (error) {
    translationAbortController.abort();
    await closeMicrosoftOAuthCallbackBridge(microsoftOAuthCallbackBridge).catch(() => undefined);
    await scheduler?.close();
    await idleWatcher?.close();
    await agentService?.close();
    autoReplyEngine?.close();
    registerAutoReplyEngine(undefined);
    if (app) await app.close().catch(() => undefined);
    db?.close();
    masterKey?.fill(0);
    throw error;
  }
}
