import fs, { appendFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
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
import { registerAvatarRoutes } from "./routes/avatars.js";
import { registerFilterRuleRoutes } from "./routes/filter-rules.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerOutboundAttachmentRoutes } from "./routes/outbound-attachments.js";
import { registerBatchJobRoutes } from "./routes/batch-jobs.js";
import { clearOrphanedPendingFlagsMarkers, clearPendingFlagsMarkers, pushFlagsRemote, type FlagsPushEntry } from "./flags-outbox.js";
import {
  oauthProviderFor,
  providerInfo,
} from "./helpers.js";
import { emitSettingsChanged } from "./events.js";
import { serverLog } from "./logging.js";
import { config, isLoopbackRemoteAddress } from "./config.js";
import {
  migrateMessageStorage,
  ensureAttachmentKinds,
} from "./message-storage.js";
import { ensureMessageFtsIndex } from "./message-search.js";
import { backfillRedactMessageSnippets } from "./sync.js";
import { createOperationQueue } from "./operation-queue.js";
import { inboxMessageFilter } from "./message-filters.js";
import { FLAGGED_PREDICATE_SQL, UNSEEN_PREDICATE_SQL } from "./message-flag-indexes.js";
import {
  migrateOutboundAttachments,
  outboundAttachmentDirectory,
} from "./outbound-attachments.js";
import {
  migrateOutboundSubmissionStorage,
  recoverInterruptedSubmissions,
} from "./outbox.js";
import { normalizeScheduledTimesMigration } from "./scheduled-times-migration.js";
import { providerPresets } from "./providers.js";
import { TranslationConfigurationStore } from "./translation-configuration.js";
import { buildTranslationService } from "./routes/translation.js";
import { batchMoveMessages, moveMessage, type MessageMoveTarget } from "./sync-moves.js";
import {
  updateMessageFlags,
  updateMessageFlagsBatch,
  type MessageFlagsPatch,
} from "./sync-flags.js";
import { seedBuiltinTemplates } from "./templates.js";
import {
  getSyncMessageLimit,
} from "./settings.js";
import { customBackgroundPath } from "./routes/settings.js";
import { type RuntimeContext, type TranslationServiceLike } from "./types.js";

// Re-exported from helpers.ts for backward compatibility (used by tests).
import { MAX_BACKGROUND_UPLOAD_BYTES } from "./helpers.js";
export { MAX_BACKGROUND_UPLOAD_BYTES };

// Bound for the append-only startup request log (startup-request-log.jsonl):
// without it the first-60s capture grows forever (~10-60KB per boot). Each
// line is self-contained, so keeping the trailing window loses nothing
// structural. Runs once per boot; never throws.
const startupRequestLogMaxLines = 5000;
function pruneStartupRequestLog(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return;
    const lines = fs.readFileSync(logPath, "utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= startupRequestLogMaxLines) return;
    fs.writeFileSync(logPath, `${lines.slice(-startupRequestLogMaxLines).join("\n")}\n`, "utf8");
  } catch {
    // Best-effort instrumentation; a read-only data dir must not break boot.
  }
}

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

// Token-less requests previously trusted any loopback socket peer on the
// strength of "a loopback peer is this machine". DNS rebinding breaks that
// assumption: a browser that resolved an attacker's domain to 127.0.0.1 sends
// same-origin fetches whose socket peer is loopback but whose Host header
// still names the attacker's domain, and CORS never sees those requests. The
// Host header is the remaining signal the server can check, so token-less
// requests must name one of this server's own loopback authorities. This
// check deliberately guards only the token-less fallback in the onRequest
// hook below: requests carrying the desktop API token are already
// authenticated with a capability a rebound page cannot obtain, so desktop
// mode is unaffected.
function isTrustedTokenlessHost(value: string | string[] | undefined, allowedPort: number): boolean {
  // Port 0 asks the OS for a free port, which only the desktop host does —
  // and it always pairs that with a generated token (main.mts). A token-less
  // dynamic port is therefore a misconfiguration: the real bound port is
  // unknowable here, so every token-less request is refused (fail closed).
  if (allowedPort <= 0) return false;
  // HTTP/1.1 requires a Host header on every request, so a missing or empty
  // one is rejected instead of trusted. Node's parser collapses duplicate
  // Host headers to the first value, which must still match an allowed form
  // exactly, so duplication cannot smuggle a second authority past this
  // check.
  if (typeof value !== "string") return false;
  const host = value.trim().toLowerCase();
  if (host === "") return false;
  // Exact match against the loopback authorities this server answers on:
  // the IPv4 loopback, the localhost name, and the bracketed IPv6 loopback
  // form ([::1]:port) browsers send. The comparison is case-insensitive
  // because host names are; anything else — a rebound domain, a foreign
  // port, a missing port — is rejected.
  return host === `127.0.0.1:${allowedPort}`
    || host === `localhost:${allowedPort}`
    || host === `[::1]:${allowedPort}`;
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
  // R05: legacy offset-form scheduled times normalize to UTC once; the due
  // queries and the snoozed view compare stored times as strings.
  const normalizedTimes = normalizeScheduledTimesMigration(context.db, context.masterKey);
  if (normalizedTimes.invalid) {
    // serverLog: this runs before the fastify instance exists.
    serverLog.warn({ ...normalizedTimes }, "Found unparseable scheduled times during UTC normalization");
  }
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
  const operationQueue = createOperationQueue(context.db, {
    onOperationSettled: (kind, payload, rowId) => {
      // The marker clear follows the durable settlement of a row, never the
      // executor: an executor abandoned by a write-slot timeout keeps running
      // and would otherwise clear a newer push's protection after its own
      // row had already settled. The clear re-checks pending AND running
      // rows for each message (excluding the settling row itself), so a
      // newer push in either state stays protected. This covers success,
      // exhausted retries, and foreground failures — the former
      // permanent-failure hook's job is a subset.
      if (kind === "flags-push") {
        const { entries } = payload as { entries?: FlagsPushEntry[] };
        if (Array.isArray(entries)) {
          clearPendingFlagsMarkers(context.db, entries.map((entry) => entry.id), rowId);
        }
      }
    },
  });
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
    // (internal callers) and an account-scoped batch (batch jobs).
    const { messageId, ids, patch } = payload as { messageId?: string; ids?: string[]; patch: MessageFlagsPatch };
    if (Array.isArray(ids)) {
      return updateMessageFlagsBatch(context.db, context.masterKey, ids, patch, context.oauthService, context.agentMailEvents);
    }
    await updateMessageFlags(context.db, context.masterKey, messageId as string, patch, context.oauthService, context.agentMailEvents);
    return { updated: 0, failed: 0, changedIds: [] };
  });
  operationQueue.registerRunner("flags-push", async (payload) => {
    // The marker clear lives in the onOperationSettled hook, not here: a
    // late executor completion (after a write-slot timeout already settled
    // this row) must not clear a newer push's protection.
    const push = payload as { accountId: string; entries: FlagsPushEntry[] };
    await pushFlagsRemote({ db: context.db, masterKey: context.masterKey, accessTokenProvider: context.oauthService }, push);
  });
  // Repair `pending_flags_push` markers that no queued push is behind before
  // the resumed queue starts: a marker only syncs ever clears again is a
  // message whose flags stop following the server for good. Runs against the
  // queue exactly as it sits on disk, so every still-pending row counts as its
  // push. Best effort by design — a reconciliation problem must never stop the
  // app from booting.
  try {
    const orphaned = clearOrphanedPendingFlagsMarkers(context.db);
    if (orphaned) app.log.warn({ orphaned }, "Cleared flag push markers with no queued push");
  } catch (reconcileError) {
    app.log.warn({ error: reconcileError }, "Could not reconcile orphaned flag push markers");
  }
  void operationQueue.resumePending().then((resumed) => {
    if (resumed) app.log.warn({ resumed }, "Resumed interrupted write operations");
  });
  const localApiAccessToken = options.localApiAccessToken?.trim() || undefined;

  // Backgrounds and mail attachments use this binary path so image data never
  // expands into a base64 JSON payload.
  //
  // The parser deliberately carries NO bodyLimit. In Fastify a parser-level
  // limit wins whenever a route does not declare one of its own, so the 50 MB
  // that used to live here silently became the effective limit for *every*
  // route in the process — DELETE /api/outbound-attachments, the agent routes
  // and everything else buffered a 40 MB octet-stream body into the heap before
  // the 3 MB server-wide cap could ever apply. Without the override the parser
  // inherits the server's `bodyLimit` (3 MB), and the two routes that genuinely
  // accept large uploads raise their own ceiling in their route options, which
  // take precedence: POST /api/outbound-attachments (10 MB) and
  // POST /api/settings/background (50 MB).
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  // The desktop renderer and its API share one loopback origin. This keeps
  // sanitized mail HTML from loading code or network resources outside it.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("Content-Security-Policy", contentSecurityPolicy);
    if (request.url.startsWith("/api/")) {
      // Note that this runs after every route handler, so it also overrides the
      // `Cache-Control` that GET /api/images/proxy sets for its cached images —
      // that header is currently unreachable, and re-reading a message re-fetches
      // through the proxy even though the bytes are already on disk. `no-store`
      // is the safer default to win: it keeps decrypted mail bodies out of the
      // HTTP cache. Revisit only alongside a decision to exempt that one route.
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
      // Browser development runs without a token. A loopback peer no longer
      // stands alone as the trust boundary — DNS rebinding can present one
      // from an attacker-controlled origin (see isTrustedTokenlessHost) — so
      // the Host header must also name one of this server's own loopback
      // authorities on the configured port.
      if (isTrustedTokenlessHost(request.headers.host, config.port)) return;
      // 403 rather than the 401 below: a missing token is recoverable (the
      // client can present the capability), but a foreign Host header marks
      // the request as a rebinding/spoofing attempt that no credential would
      // legitimize. The distinct code also keeps such attempts separable
      // from ordinary missing-token 401s in logs.
      return reply.code(403).send({
        ok: false,
        code: "local_api_forbidden_host",
        message: "本地服务拒绝了来自未授权来源的请求。",
      });
    }
    return reply.code(401).send({
      ok: false,
      code: "local_api_unauthorized",
      message: "本地服务请求未获授权。",
    });
  });

  // Last-resort net for handler failures that never got wrapped in a try/catch
  // (a new route, a forgotten await, an agent call outside its guard). Every
  // API failure the renderer sees is an `{ ok: false, code, message }` triple,
  // so a client can never receive Fastify's default `{ statusCode, error,
  // message }` shape — which, for a 500, also echoes the raw error message
  // (SQL text, file paths, provider responses) straight to the client.
  //
  // Boundaries, so nothing that already has a deliberate answer changes:
  // - A status the handler sent itself (401/403/404/400/422/…) never reaches
  //   this hook: `reply.send(...)` is a plain response, not an error.
  // - An error that already carries a 4xx status (Fastify's own content-type,
  //   body-size and route-validation errors) keeps Fastify's client-error
  //   semantics, including its exact body, by being handed back to the
  //   default handler. The agent routes' `agentFailure` mapping is unaffected
  //   for the same reason: it converts `AgentServiceError` into a `reply.send`
  //   inside the handler before anything can throw past it.
  // - Only 5xx and status-less failures are re-shaped here, with a fixed
  //   message that carries no internal detail. The stack and the original
  //   error stay in the server log.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode < 500) return reply.send(error);
    serverLog.error({ method: request.method, url: request.url, statusCode }, "Unhandled local API error", error);
    return reply.code(500).send({ ok: false, code: "internal_error", message: "本地服务处理请求时发生错误，请稍后重试。" });
  });

  // Startup request log: capture every request served during the first 60s
  // after boot (plus anything slow later) into the data directory. This shows
  // exactly which renderer API/static loads were slow and whether the server
  // event loop was contended while the window was booting.
  const startupRequestsStartedAt = Date.now();
  const startupRequestLogPath = path.join(path.dirname(config.databasePath), "startup-request-log.jsonl");
  // Kill switch for packaged installs that want no diagnostic file growth:
  // NAMI_MAIL_NO_STARTUP_LOG=1 skips all appends. Pruning is intentionally
  // NOT gated so an old oversized file is trimmed back even when appending
  // is disabled. The desktop host shares its process.env with the in-process
  // server, so one setting covers both logs.
  pruneStartupRequestLog(startupRequestLogPath);
  if (process.env.NAMI_MAIL_NO_STARTUP_LOG !== "1") {
    app.addHook("onResponse", async (request, reply) => {
      const elapsedMs = reply.elapsedTime;
      const elapsedSinceBoot = Date.now() - startupRequestsStartedAt;
      if (elapsedSinceBoot > 60_000 && elapsedMs < 25) return;
      try {
        appendFileSync(
          startupRequestLogPath,
          `${JSON.stringify({ t: new Date().toISOString(), bootMs: elapsedSinceBoot, ms: Math.round(elapsedMs), method: request.method, url: (request.url?.split("?")[0] ?? request.url ?? "").slice(0, 512) })}\n`,
          "utf8",
        );
      } catch {
        // Best-effort instrumentation; a read-only data dir must not break boot.
      }
    });
  }

  app.get("/api/health", async () => ({ ok: true, service: "nami-mail", time: new Date().toISOString() }));

  registerAgentRoutes(app, { context, agentService, memoryStore });
  registerAccountRoutes(app, { context, log: app.log });

  registerFilterRuleRoutes(app, { context, log: app.log });
  registerContactRoutes(app, { context, log: app.log });
  registerAvatarRoutes(app, { context, log: app.log });
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
    // Snoozed messages are hidden from the unified inbox, so the sidebar
    // counts must exclude active snoozes too.
    const nowIso = new Date().toISOString();
    // Only the badges whose predicate is indexable get their own scalar
    // subquery. Wrapping a predicate in SUM(CASE WHEN ...) hides it from the
    // planner: it cannot prove such a CASE implies a partial index's WHERE, so
    // the whole endpoint degraded to one full scan of messages (measured on
    // 50 000 rows: 816ms, EXPLAIN "SCAN m") even though three of the six
    // partial indexes match these predicates exactly. Spelled as a top-level
    // WHERE, the same three badges become index seeks (measured: 0.06-0.17ms
    // each, "SEARCH m USING COVERING INDEX idx_messages_...").
    //
    // The two that stay summed are the ones no index can serve: `messages` and
    // `unread` both test inbox membership, which reads the effective_mailbox
    // generated column and a correlated folders lookup. Their SUM arms also keep
    // this SELECT anchored to `FROM messages m`, which is what makes the whole
    // statement return exactly one row on an empty mailbox; moving them into
    // their own scalar subqueries drops that anchor and the endpoint stops
    // answering at all when there is no mail. Splitting them was also measured
    // *slower* (773ms vs 528ms on 50 000 rows): the unseen index holds ~55% of
    // the mailbox and none of the columns the inbox test reads, so it buys a
    // full walk of that index with a row fetch per entry to save one CASE.
    // SUM returns NULL on an empty table, hence the COALESCE guards.
    const row = context.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounts) AS accounts,
        COALESCE(SUM(CASE WHEN ${inboxMessageFilter} AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?) THEN 1 ELSE 0 END), 0) AS messages,
        COALESCE(SUM(CASE WHEN ${inboxMessageFilter} AND m.${UNSEEN_PREDICATE_SQL} AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?) THEN 1 ELSE 0 END), 0) AS unread,
        (SELECT COUNT(*) FROM messages m WHERE m.${FLAGGED_PREDICATE_SQL}) AS starred,
        (SELECT COUNT(*) FROM messages m WHERE m.snoozed_until IS NOT NULL AND m.snoozed_until > ?) AS snoozed,
        (SELECT COUNT(*) FROM messages m WHERE m.has_attachments = 1) AS attachments
      FROM messages m
    `).get(nowIso, nowIso, nowIso) as { accounts: number; messages: number; unread: number; starred: number; snoozed: number; attachments: number };
    // Sidebar badge counts for the cross-folder views: starred, snoozed and
    // the attachments view (every folder participates, mirroring the messages
    // route's filter semantics for those views).
    return { accounts: row.accounts, messages: row.messages, unread: row.unread, starred: row.starred, snoozed: row.snoozed, attachments: row.attachments };
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
