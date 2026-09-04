import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { oauthErrorBody, mailFailure, validationMessage } from "../helpers.js";
import { OAuthError, isSupportedOAuthProvider } from "../oauth.js";
import { config } from "../config.js";
import { normalizeLocale, oauthCallbackCopy } from "../localization.js";
import { syncAccount } from "../sync.js";
import { emitAccountSynced } from "../events.js";
import { getAppSettings, getSyncMessageLimit } from "../settings.js";
import { emptyBodySchema } from "../schemas.js";

export type OAuthRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

function oauthCallbackOrigin(
  app: FastifyInstance,
  context: RuntimeContext,
  provider: "google" | "microsoft",
): string {
  if (provider === "microsoft") {
    if (context.microsoftOAuthCallbackUnavailable) {
      throw new OAuthError("oauth_callback_unavailable", context.microsoftOAuthCallbackUnavailable);
    }
    if (context.microsoftOAuthCallbackOrigin) return context.microsoftOAuthCallbackOrigin;
  }
  if (context.oauthCallbackOrigin) return context.oauthCallbackOrigin;
  const address = app.server.address();
  const port = address && typeof address !== "string" ? address.port : config.port;
  if (!port) throw new OAuthError("oauth_failed", "本地服务尚未监听，无法开始 OAuth 授权。");
  return `http://127.0.0.1:${port}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function oauthCallbackDocument(locale: unknown, success: boolean): string {
  const normalizedLocale = normalizeLocale(locale);
  const copy = oauthCallbackCopy(normalizedLocale, success);
  const title = escapeHtml(copy.title);
  const message = escapeHtml(copy.message);
  return `<!doctype html><html lang="${normalizedLocale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main><script>try{window.close()}catch(e){}</script></body></html>`;
}

function startOAuthInitialSync(app: FastifyInstance, context: RuntimeContext, accountId: string): void {
  void syncAccount(
    context.db,
    context.masterKey,
    accountId,
    getSyncMessageLimit(context.db),
    context.oauthService,
    context.agentMailEvents,
  )
    .then(() => emitAccountSynced(context.db, context.serverEvents, accountId))
    .catch((error) => {
      const failure = mailFailure(error);
      app.log.warn({ accountId, code: failure.body.code }, "Initial OAuth mailbox sync failed");
    });
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  const { context, log } = deps;

  app.post<{ Params: { provider: string } }>("/api/oauth/:provider/start", async (request, reply) => {
    const body = emptyBodySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: validationMessage(body.error) });
    if (!isSupportedOAuthProvider(request.params.provider)) {
      return reply.code(404).send({ ok: false, code: "oauth_provider_unsupported", message: "不支持该 OAuth 服务商。" });
    }
    const oauthService = context.oauthService;
    if (!oauthService || !oauthService.isConfigured(request.params.provider)) {
      return reply.code(503).send({ ok: false, code: "oauth_not_configured", message: "此安全登录尚未配置，请使用应用专用密码或联系管理员。" });
    }
    try {
      const started = await oauthService.start(request.params.provider, oauthCallbackOrigin(app, context, request.params.provider));
      return { ok: true, provider: request.params.provider, ...started };
    } catch (error) {
      const details = oauthErrorBody(error);
      const unavailable = details.code === "oauth_not_configured" || details.code === "oauth_callback_unavailable";
      return reply.code(unavailable ? 503 : 422).send({ ok: false, ...details });
    }
  });
  app.get<{ Params: { provider: string } }>("/api/oauth/:provider/callback", async (request, reply) => {
    const locale = getAppSettings(context.db).locale;
    if (!isSupportedOAuthProvider(request.params.provider) || !context.oauthService) {
      return reply.code(404).type("text/html; charset=utf-8").send(oauthCallbackDocument(locale, false));
    }
    try {
      const callbackUrl = new URL(
        request.raw.url ?? `/api/oauth/${request.params.provider}/callback`,
        oauthCallbackOrigin(app, context, request.params.provider),
      );
      const attempt = await context.oauthService.finish(request.params.provider, callbackUrl);
      if (attempt.accountId) startOAuthInitialSync(app, context, attempt.accountId);
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'")
        .send(oauthCallbackDocument(locale, true));
    } catch (error) {
      const details = oauthErrorBody(error);
      log.warn({ provider: request.params.provider, code: details.code }, "OAuth callback failed");
      return reply
        .type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'")
        .send(oauthCallbackDocument(locale, false));
    }
  });

  app.get<{ Params: { attemptId: string } }>("/api/oauth/attempts/:attemptId", async (request, reply) => {
    const attemptId = z.uuid().safeParse(request.params.attemptId);
    if (!attemptId.success) return reply.code(400).send({ ok: false, code: "invalid_request", message: "授权请求标识无效。" });
    if (!context.oauthService) {
      return reply.code(503).send({ ok: false, code: "oauth_not_configured", message: "安全登录尚未配置。" });
    }
    return { ok: true, attemptId: attemptId.data, ...context.oauthService.getAttempt(attemptId.data) };
  });
}
