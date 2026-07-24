import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { migrateAccountCredentialStorage, migrateKnownProviderUsernameCredentials } from "./account-credentials.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { loadOrCreateMasterKey } from "./crypto.js";
import { openDatabase, type DatabaseHandle } from "./db.js";
import { OAuthService } from "./oauth.js";
import { cleanupExpiredOutboundAttachments, outboundAttachmentDirectory } from "./outbound-attachments.js";
import { getAppSettings, updateAppSettings, type AppSettings, type AppSettingsPatch } from "./settings.js";
import { syncAccount, type NewInboxMessage } from "./sync.js";
import type { AccountRecord, RuntimeContext } from "./types.js";

export type RunningServer = {
  app: FastifyInstance;
  url: string;
  port: number;
  getSettings: () => AppSettings;
  updateSettings: (patch: AppSettingsPatch) => AppSettings;
  close: () => Promise<void>;
};

export type ServerRuntimeOptions = {
  onNewInboxMessages?: (messages: NewInboxMessage[]) => void | Promise<void>;
  // Electron supplies a DPAPI-unwrapped copy directly in memory. The
  // command-line runtime intentionally keeps its file-backed development key.
  masterKey?: Buffer;
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
  let microsoftOAuthCallbackBridge: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let masterKey: Buffer | undefined;
  const translationAbortController = new AbortController();

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
    const oauthService = new OAuthService(database, runtimeMasterKey);
    const outboundDirectory = outboundAttachmentDirectory({});
    try {
      cleanupExpiredOutboundAttachments(database, outboundDirectory);
    } catch (error) {
      console.warn("Nami Mail could not clean stale outbound attachments", error);
    }
    const syncAll = async () => {
      const accounts = database.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRecord[];
      const results = await Promise.allSettled(
        accounts.map((account) => syncAccount(database, runtimeMasterKey, account.id, config.syncMessageLimit, oauthService)),
      );
      const newInboxMessages = results.flatMap((result) => result.status === "fulfilled" ? result.value.newInboxMessages : []);
      if (newInboxMessages.length && options.onNewInboxMessages) {
        try {
          await options.onNewInboxMessages(newInboxMessages);
        } catch (error) {
          fastify.log.warn({ error }, "New-mail notification callback failed");
        }
      }
    };

    const runtimeContext: RuntimeContext = {
      db: database,
      masterKey: runtimeMasterKey,
      outboundAttachmentDirectory: outboundDirectory,
      onRefreshIntervalChanged: () => scheduler?.reschedule(),
      oauthService,
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
        try {
          await closeMicrosoftOAuthCallbackBridge(microsoftOAuthCallbackBridge);
        } finally {
          try {
            await Promise.all([
              scheduler?.close(),
              fastify.close(),
            ]);
          } finally {
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
      getSettings: () => getAppSettings(database),
      updateSettings: (patch) => updateAppSettings(database, patch),
      close,
    };
  } catch (error) {
    translationAbortController.abort();
    await closeMicrosoftOAuthCallbackBridge(microsoftOAuthCallbackBridge).catch(() => undefined);
    await scheduler?.close();
    if (app) await app.close().catch(() => undefined);
    db?.close();
    masterKey?.fill(0);
    throw error;
  }
}
