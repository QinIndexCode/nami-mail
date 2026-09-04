import fs, { appendFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { AgentService } from "./agent-service.js";
import { SqliteMailApplicationService } from "./agent/sqlite-mail-application-service.js";
import { EncryptedAgentMemoryStore } from "./agent/memory.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerTranslationRoutes } from "./routes/translation.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerFilterRuleRoutes } from "./routes/filter-rules.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerOutboundAttachmentRoutes } from "./routes/outbound-attachments.js";
import { registerBatchJobRoutes } from "./routes/batch-jobs.js";
import {
  oauthProviderFor,
  providerInfo,
} from "./helpers.js";
import { emitSettingsChanged } from "./events.js";
import { config, isLoopbackRemoteAddress } from "./config.js";
import {
  migrateMessageStorage,
  ensureAttachmentKinds,
} from "./message-storage.js";
import { ensureMessageFtsIndex } from "./message-search.js";
import { backfillRedactMessageSnippets } from "./sync.js";
import { createOperationQueue } from "./operation-queue.js";
import { inboxMessageFilter } from "./message-filters.js";
import {
  migrateOutboundAttachments,
  outboundAttachmentDirectory,
} from "./outbound-attachments.js";
import {
  migrateOutboundSubmissionStorage,
  recoverInterruptedSubmissions,
} from "./outbox.js";
import { providerPresets } from "./providers.js";
import { TranslationConfigurationStore } from "./translation-configuration.js";
import { buildTranslationService } from "./routes/translation.js";
import {
  batchMoveMessages,
  moveMessage,
  updateMessageFlags,
  updateMessageFlagsBatch,
  type MessageFlagsPatch,
  type MessageMoveTarget,
} from "./sync.js";
import { seedBuiltinTemplates } from "./templates.js";
import {
  getSyncMessageLimit,
} from "./settings.js";
import { customBackgroundPath } from "./routes/settings.js";
import { type RuntimeContext, type TranslationServiceLike } from "./types.js";

// Re-exported from helpers.ts for backward compatibility (used by tests).
import { MAX_BACKGROUND_UPLOAD_BYTES } from "./helpers.js";
export { MAX_BACKGROUND_UPLOAD_BYTES };

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export type BuildAppOptions = {
  // Empty in browser-only development. The desktop host passes a fresh token
  // through this option rather than persisting it with the mail database.
  localApiAccessToken?: string;
  // The owning runtime aborts in-flight external translation requests before
  // Fastify begins waiting for open request handlers during shutdown.
  translationAbortSignal?: AbortSignal;
  // Startup instrumentation: buildApp reports the elapsed time of each of its
  // internal phases (migrations, service construction, route registration,
  // static file serving) so a slow boot can be attributed precisely.
  onStartupTiming?: (stage: string, elapsedMs: number) => void;
};

const localApiAccessHeader = "x-nami-api-token";

function localApiPath(request: FastifyRequest): string | undefined {
  try {
    return new URL(request.raw.url ?? request.url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function isOAuthCallbackPath(pathname: string): boolean {
  return /^\/api\/oauth\/(?:google|microsoft)\/callback$/.test(pathname);
}

function requiresLocalApiAccessToken(request: FastifyRequest): boolean {
  const pathname = localApiPath(request);
  if (!pathname || (pathname !== "/api" && !pathname.startsWith("/api/"))) return false;

  // Health probes do not expose mailbox data. OAuth redirects originate in an
  // external browser, so the one-time, state-validated GET callback cannot
  // carry a renderer-only header. OPTIONS has no application side effect and
  // must remain available for CORS preflight handling.
  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/api/health") return false;
  if (request.method === "GET" && isOAuthCallbackPath(pathname)) return false;
  if (request.method === "OPTIONS") return false;
  return true;
}

function hasMatchingLocalApiAccessToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const received = Buffer.from(value, "utf8");
  const token = Buffer.from(expected, "utf8");
  return received.length === token.length && timingSafeEqual(received, token);
}

export async function buildApp(context: RuntimeContext, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const buildPhaseStart = performance.now();
  const notePhase = (stage: string): void => {
    options.onStartupTiming?.(stage, Math.round(performance.now() - buildPhaseStart));
  };
  migrateMessageStorage(context.db, context.masterKey);
  ensureAttachmentKinds(context.db, context.masterKey);
  ensureMessageFtsIndex(context.db, context.masterKey);
  backfillRedactMessageSnippets(context.db);
  migrateOutboundAttachments(context.db, outboundAttachmentDirectory(context), context.masterKey);
  migrateOutboundSubmissionStorage(context.db, context.masterKey);
  notePhase("build:message-migrations");
  const ownedAgentMailApplication = !context.agentService && context.agentLifecycle && context.agentSourceEvents
    ? new SqliteMailApplicationService({
      db: context.db,
      masterKey: context.masterKey,
      oauthService: context.oauthService,
      agentMailEvents: context.agentMailEvents,
      syncMessageLimit: getSyncMessageLimit(context.db),
      outboundAttachmentDirectory: outboundAttachmentDirectory(context),
    })
    : undefined;
  const ownedAgentService = !context.agentService && context.agentLifecycle && context.agentSourceEvents
    ? new AgentService({
      db: context.db,
      masterKey: context.masterKey,
      lifecycle: context.agentLifecycle,
      sourceEvents: context.agentSourceEvents,
      mailApplication: ownedAgentMailApplication,
      hasCustomBackground: (filename) => Boolean(customBackgroundPath(context, filename) && fs.existsSync(customBackgroundPath(context, filename)!)),
      onSettingsChanged: () => emitSettingsChanged(context.serverEvents),
    })
    : undefined;
  const agentService = context.agentService ?? ownedAgentService;
  agentService?.start();
  notePhase("build:agent-service");
  const memoryStore = new EncryptedAgentMemoryStore(context.db, context.masterKey);
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
    bodyLimit: 3 * 1024 * 1024,
    // The agent RAG backfill can hold the event loop for tens of seconds on a
    // large mailbox (every message is scanned on first startup); the default
    // 10s avvio timeout would then kill the fastify-static registration and
    // the server would fail to boot.
    pluginTimeout: 60_000,
  });
  const translationConfigurationStore = new TranslationConfigurationStore(context.db, context.masterKey, {
    endpoint: config.translationEndpoint,
    apiKey: config.translationApiKey,
    timeoutMs: config.translationTimeoutMs,
  });
  const translationConfigurationManaged = !context.translationService;
  // A single translate-capable service honoring the user's primary/backup
  // provider selection. When no custom endpoint is configured it is a built-in
  // chain (Google -> MyMemory); once the user stores a custom endpoint or
  // chooses a built-in provider explicitly, the chain routes accordingly.
  const translationServiceContainer: { service: TranslationServiceLike } = {
    service: context.translationService ?? buildTranslationService(translationConfigurationStore.summary()),
  };
  const translationAbortController = new AbortController();
  const abortTranslationsForShutdown = () => translationAbortController.abort();
  const externalTranslationAbortSignal = options.translationAbortSignal;
  if (externalTranslationAbortSignal?.aborted) abortTranslationsForShutdown();
  else externalTranslationAbortSignal?.addEventListener("abort", abortTranslationsForShutdown, { once: true });
  // Fastify runs onClose only after active handlers have drained. Abort first
  // so a translation request cannot make application shutdown wait for its timeout.
  app.addHook("preClose", () => {
    abortTranslationsForShutdown();
  });
  app.addHook("onClose", async () => {
    externalTranslationAbortSignal?.removeEventListener("abort", abortTranslationsForShutdown);
    await agentService?.close();
  });
  const recoveredSubmissions = recoverInterruptedSubmissions(context.db, context.masterKey);
  if (recoveredSubmissions) {
    app.log.warn({ recoveredSubmissions }, "Marked interrupted SMTP submissions as unknown delivery");
  }
  // Durable write-operation queue. User moves and flag updates are recorded
  // before they dispatch, so a shutdown while an operation is queued or in
  // flight never loses it: pending/running rows are re-enqueued here.
  const operationQueue = createOperationQueue(context.db);
  operationQueue.registerRunner("move", async (payload) => {
    const { messageId, target } = payload as { messageId: string; target: MessageMoveTarget };
    return moveMessage(context.db, context.masterKey, messageId, target, context.oauthService, context.agentMailEvents);
  });
  operationQueue.registerRunner("batch-move", async (payload) => {
    const { ids, target } = payload as { ids: string[]; target: MessageMoveTarget };
    return batchMoveMessages(context.db, context.masterKey, ids, target, context.oauthService, context.agentMailEvents);
  });
  operationQueue.registerRunner("flags", async (payload) => {
    // One executor serves both payload shapes: a single-message patch
    // (PATCH /api/messages/:id) and an account-scoped batch (the batch flags
    // route groups ids per account before enqueueing).
    const { messageId, ids, patch } = payload as { messageId?: string; ids?: string[]; patch: MessageFlagsPatch };
    if (Array.isArray(ids)) {
      return updateMessageFlagsBatch(context.db, context.masterKey, ids, patch, context.oauthService, context.agentMailEvents);
    }
    await updateMessageFlags(context.db, context.masterKey, messageId as string, patch, context.oauthService, context.agentMailEvents);
    return { updated: 0, failed: 0, changedIds: [] };
  });
  void operationQueue.resumePending().then((resumed) => {
    if (resumed) app.log.warn({ resumed }, "Resumed interrupted write operations");
  });
  const localApiAccessToken = options.localApiAccessToken?.trim() || undefined;

  // Backgrounds and mail attachments use this binary path so image data never
  // expands into a base64 JSON payload. Each route still applies its own cap.
  app.addContentTypeParser("application/octet-stream", {
    parseAs: "buffer",
    bodyLimit: MAX_BACKGROUND_UPLOAD_BYTES,
  }, (_request, body, done) => done(null, body));

  // The desktop renderer and its API share one loopback origin. This keeps
  // sanitized mail HTML from loading code or network resources outside it.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Content-Security-Policy", contentSecurityPolicy);
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    }
    return payload;
  });

  await app.register(cors, {
    origin: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  notePhase("build:register-cors");

  app.addHook("onRequest", async (request, reply) => {
    if (!requiresLocalApiAccessToken(request)) return;
    if (localApiAccessToken) {
      if (hasMatchingLocalApiAccessToken(request.headers[localApiAccessHeader], localApiAccessToken)) return;
    } else if (isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      // Browser development runs without a token; a loopback peer is still
      // this machine, which is the documented trust boundary. Any other
      // source is rejected so a non-loopback bind misconfiguration cannot
      // silently expose mailbox data or send capability on the network.
      return;
    }
    return reply.code(401).send({
      ok: false,
      code: "local_api_unauthorized",
      message: "本地服务请求未获授权。",
    });
  });

  // Startup request log: capture every request served during the first 60s
  // after boot (plus anything slow later) into the data directory. This shows
  // exactly which renderer API/static loads were slow and whether the server
  // event loop was contended while the window was booting.
  const startupRequestsStartedAt = Date.now();
  const startupRequestLogPath = path.join(path.dirname(config.databasePath), "startup-request-log.jsonl");
  app.addHook("onResponse", async (request, reply) => {
    const elapsedMs = reply.elapsedTime;
    const elapsedSinceBoot = Date.now() - startupRequestsStartedAt;
    if (elapsedSinceBoot > 60_000 && elapsedMs < 25) return;
    try {
      appendFileSync(
        startupRequestLogPath,
        `${JSON.stringify({ t: new Date().toISOString(), bootMs: elapsedSinceBoot, ms: Math.round(elapsedMs), method: request.method, url: request.url?.split("?")[0] })}\n`,
        "utf8",
      );
    } catch {
      // Best-effort instrumentation; a read-only data dir must not break boot.
    }
  });

  app.get("/api/health", async () => ({ ok: true, service: "nami-mail", time: new Date().toISOString() }));

  registerAgentRoutes(app, { context, agentService, memoryStore });
  registerAccountRoutes(app, { context, log: app.log });

  registerFilterRuleRoutes(app, { context, log: app.log });
  registerContactRoutes(app, { context, log: app.log });
  registerTemplateRoutes(app, { context, log: app.log });
  registerCalendarRoutes(app, { context, log: app.log });
  notePhase("build:register-core-routes");

  app.get("/api/providers", async () =>
    providerPresets.map((provider) => {
      const oauthProvider = oauthProviderFor(provider);
      return {
        ...providerInfo(provider),
        domains: provider.domains,
        oauthProvider: oauthProvider ?? null,
        oauthAvailable: Boolean(oauthProvider && context.oauthService?.isConfigured(oauthProvider)),
      };
    }),
  );

  registerEventsRoutes(app, { context, log: app.log });

  registerSettingsRoutes(app, { context, log: app.log });

  registerOutboundAttachmentRoutes(app, { context, log: app.log });

  registerOAuthRoutes(app, { context, log: app.log });

  // Seed the app's starter templates idempotently on every startup. Existing
  // rows (edited or deleted by the user) are never overwritten.
  seedBuiltinTemplates(context.db, context.masterKey);

  registerMessageRoutes(app, { context, log: app.log, operationQueue });

  registerTranslationRoutes(app, {
    context,
    agentService,
    translationServiceContainer,
    translationConfigurationStore,
    translationConfigurationManaged,
    translationAbortController,
  });

  registerBackupRoutes(app, { context, log: app.log });

  registerBatchJobRoutes(app, { context, log: app.log });
  notePhase("build:register-remaining-routes");

  app.get("/api/stats", async () => {
    const accounts = (context.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count;
    // Snoozed messages are hidden from the unified inbox, so the sidebar
    // counts must exclude active snoozes too.
    const nowIso = new Date().toISOString();
    const messages = (
      context.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)`).get(nowIso) as { count: number }
    ).count;
    const unread = (
      context.db
        .prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND flags_json NOT LIKE '%\\\\Seen%' AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)`)
        .get(nowIso) as { count: number }
    ).count;
    return { accounts, messages, unread };
  });

  const hasWebDist = fs.existsSync(config.webDistPath);
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
  }
  notePhase("build:register-static");

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = localApiPath(request);
    if (pathname === "/api" || pathname?.startsWith("/api/")) {
      return reply.code(404).send({ ok: false, message: "接口不存在。" });
    }
    if (hasWebDist) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ ok: false, message: "页面不存在。" });
  });

  return app;
}
