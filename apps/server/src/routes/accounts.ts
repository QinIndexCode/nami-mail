import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  folderRank,
  isOAuthOnlyProvider,
  mailFailure,
  manualProvider,
  oauthProviderFor,
  oauthRequiredBody,
  passwordCredentialIdentity,
  providerDiscovery,
  validationMessage,
} from "../helpers.js";
import {
  accountDiscoverySchema,
  accountSignaturePatchSchema,
  credentialsSchema,
  manualAccountSchema,
  submissionsQuerySchema,
} from "../schemas.js";
import { detectProvider, loginUsername, resolveProvider, type DetectedProvider } from "../providers.js";
import { testAccountConnection } from "../mail.js";
import {
  discardOutboundAttachmentsForAccount,
  outboundAttachmentDirectory,
} from "../outbound-attachments.js";
import { submissionForId, submissionsForAccount } from "../outbox.js";
import { emitAccountSynced } from "../events.js";
import { getSyncMessageLimit, updateAppSettings } from "../settings.js";
import { syncAccount } from "../sync.js";
import {
  publicAccount,
  type AccountRecord,
  type RuntimeContext,
} from "../types.js";
import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  encryptAccountPassword,
} from "../account-credentials.js";

export type AccountRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: AccountRouteDeps,
): void {
  const { context, log } = deps;

  app.post("/api/accounts/discover", async (request, reply) => {
    const parsed = accountDiscoverySchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          ok: false,
          code: "invalid_request",
          message: validationMessage(parsed.error),
        });
    try {
      const provider = await resolveProvider(parsed.data.email);
      const oauthProvider = oauthProviderFor(provider);
      return {
        ok: true,
        provider: providerDiscovery(provider),
        oauthProvider: oauthProvider ?? null,
        oauthAvailable: Boolean(
          oauthProvider && context.oauthService?.isConfigured(oauthProvider),
        ),
      };
    } catch (error) {
      log.warn(
        { domain: parsed.data.email.slice(parsed.data.email.lastIndexOf("@") + 1) },
        "Mailbox provider discovery failed",
      );
      return reply
        .code(422)
        .send({
          ok: false,
          code: "discovery_failed",
          message: "无法完成服务商发现，请改用手动配置。",
        });
    }
  });

  app.post("/api/accounts/manual", async (request, reply) => {
    const parsed = manualAccountSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          ok: false,
          code: "invalid_request",
          message: validationMessage(parsed.error),
        });
    const existing = context.db
      .prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
      .get(parsed.data.email);
    if (existing)
      return reply
        .code(409)
        .send({ ok: false, code: "account_exists", message: "该邮箱已经添加。" });

    let detected: DetectedProvider;
    try {
      detected = await resolveProvider(parsed.data.email);
    } catch {
      detected = detectProvider(parsed.data.email);
    }
    if (isOAuthOnlyProvider(detected))
      return reply.code(422).send(oauthRequiredBody(detected));

    const provider = manualProvider(detected, parsed.data);
    const imapUsername =
      parsed.data.imapUsername ?? loginUsername(parsed.data.email, provider, "imap");
    const smtpUsername =
      parsed.data.smtpUsername ?? loginUsername(parsed.data.email, provider, "smtp");
    try {
      await testAccountConnection(parsed.data.email, parsed.data.password, provider, {
        imap: imapUsername,
        smtp: smtpUsername,
      });
    } catch (error) {
      const failure = mailFailure(error, detected.credentialHint);
      log.warn(
        { provider: detected.id, domain: detected.domain, code: failure.body.code },
        failure.body.message,
      );
      return reply
        .code(failure.statusCode)
        .send({ ...failure.body, provider: detected.name });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const credentialIdentity = passwordCredentialIdentity(
      id,
      parsed.data.email,
      provider,
      { imap: imapUsername, smtp: smtpUsername },
    );
    context.db
      .prepare(
        `
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `,
      )
      .run(
        id,
        parsed.data.email,
        provider.id,
        provider.name,
        encryptAccountPassword(credentialIdentity, parsed.data.password, context.masterKey),
        ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        provider.imap.host,
        provider.imap.port,
        provider.imap.secure ? 1 : 0,
        provider.imap.transport,
        imapUsername,
        provider.smtp.host,
        provider.smtp.port,
        provider.smtp.secure ? 1 : 0,
        provider.smtp.transport,
        smtpUsername,
        provider.usernameMode ?? "email",
        now,
      );

    void syncAccount(
      context.db,
      context.masterKey,
      id,
      getSyncMessageLimit(context.db),
      context.oauthService,
      context.agentMailEvents,
    )
      .then(() => emitAccountSynced(context.db, context.serverEvents, id))
      .catch((error) => {
        const failure = mailFailure(error, detected.credentialHint);
        log.warn(
          { accountId: id, code: failure.body.code },
          "Initial manually configured mailbox sync failed",
        );
      });
    const row = context.db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id) as AccountRecord;
    return reply
      .code(201)
      .send({
        ok: true,
        account: publicAccount(row),
        sync: null,
        syncWarning: row.last_sync_warning_code,
      });
  });

  app.post("/api/accounts/test", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, message: validationMessage(parsed.error) });
    const provider = await resolveProvider(parsed.data.email);
    if (isOAuthOnlyProvider(provider))
      return reply.code(422).send(oauthRequiredBody(provider));
    try {
      const result = await testAccountConnection(
        parsed.data.email,
        parsed.data.password,
        provider,
      );
      return {
        ok: true,
        provider: provider.name,
        folders: result.folders,
        smtp: result.smtp,
        warning: provider.basicAuthLimited ? provider.credentialHint : null,
      };
    } catch (error) {
      const failure = mailFailure(error, provider.credentialHint);
      log.warn(
        { provider: provider.id, domain: provider.domain, code: failure.body.code },
        failure.body.message,
      );
      return reply
        .code(failure.statusCode)
        .send({ ...failure.body, provider: provider.name });
    }
  });

  app.get("/api/accounts", async () => {
    const rows = context.db
      .prepare("SELECT * FROM accounts ORDER BY created_at ASC")
      .all() as AccountRecord[];
    const folderRows = context.db
      .prepare("SELECT * FROM folders ORDER BY account_id, name")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...publicAccount(row),
      folders: folderRows
        .filter((folder) => folder.account_id === row.id)
        .sort(
          (a, b) =>
            folderRank(a) - folderRank(b) ||
            String(a.name).localeCompare(String(b.name)),
        )
        .map((folder) => ({
          path: folder.path,
          name: folder.name,
          specialUse: folder.special_use,
          total: folder.total,
          unseen: folder.unseen,
        })),
    }));
  });

  app.post("/api/accounts", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, message: validationMessage(parsed.error) });
    const existing = context.db
      .prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
      .get(parsed.data.email);
    if (existing)
      return reply
        .code(409)
        .send({ ok: false, message: "该邮箱已经添加。" });
    const provider = await resolveProvider(parsed.data.email);
    if (isOAuthOnlyProvider(provider))
      return reply.code(422).send(oauthRequiredBody(provider));
    try {
      await testAccountConnection(parsed.data.email, parsed.data.password, provider);
    } catch (error) {
      const failure = mailFailure(error, provider.credentialHint);
      log.warn(
        { provider: provider.id, domain: provider.domain, code: failure.body.code },
        failure.body.message,
      );
      return reply
        .code(failure.statusCode)
        .send({ ...failure.body, provider: provider.name });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const imapUsername = loginUsername(parsed.data.email, provider, "imap");
    const smtpUsername = loginUsername(parsed.data.email, provider, "smtp");
    const credentialIdentity = passwordCredentialIdentity(
      id,
      parsed.data.email,
      provider,
      { imap: imapUsername, smtp: smtpUsername },
    );
    context.db
      .prepare(
        `
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `,
      )
      .run(
        id,
        parsed.data.email,
        provider.id,
        provider.name,
        encryptAccountPassword(credentialIdentity, parsed.data.password, context.masterKey),
        ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        provider.imap.host,
        provider.imap.port,
        provider.imap.secure ? 1 : 0,
        provider.imap.transport,
        imapUsername,
        provider.smtp.host,
        provider.smtp.port,
        provider.smtp.secure ? 1 : 0,
        provider.smtp.transport,
        smtpUsername,
        provider.usernameMode ?? "email",
        now,
      );

    void syncAccount(
      context.db,
      context.masterKey,
      id,
      getSyncMessageLimit(context.db),
      context.oauthService,
      context.agentMailEvents,
    )
      .then(() => emitAccountSynced(context.db, context.serverEvents, id))
      .catch((error) => {
        const failure = mailFailure(error, provider.credentialHint);
        log.warn(
          { accountId: id, code: failure.body.code },
          "Initial mailbox sync failed",
        );
      });
    const row = context.db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id) as AccountRecord;
    return reply
      .code(201)
      .send({
        ok: true,
        account: publicAccount(row),
        sync: null,
        syncWarning: row.last_sync_warning_code,
      });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    async (request, reply) => {
      const account = context.db
        .prepare("SELECT id FROM accounts WHERE id = ?")
        .get(request.params.id);
      if (!account)
        return reply
          .code(404)
          .send({ ok: false, message: "邮箱不存在。" });
      try {
        discardOutboundAttachmentsForAccount(
          context.db,
          outboundAttachmentDirectory(context),
          request.params.id,
        );
      } catch (error) {
        log.warn(
          { error, accountId: request.params.id },
          "Could not clean outbound attachments while removing account",
        );
      }
      if (context.agentMailEvents) {
        const deletion = context.agentMailEvents.beginAccountDeletion(
          request.params.id,
          () => {
            const result = context.db
              .prepare("DELETE FROM accounts WHERE id = ?")
              .run(request.params.id);
            if (!result.changes)
              throw new Error(
                "Account deletion did not remove the primary account row.",
              );
          },
        );
        try {
          context.agentMailEvents.completeAccountDeletion(
            request.params.id,
            deletion.deletionGeneration,
          );
        } catch (error) {
          log.error(
            { error, accountId: request.params.id },
            "Agent account deletion finalization deferred",
          );
        }
      } else {
        const result = context.db
          .prepare("DELETE FROM accounts WHERE id = ?")
          .run(request.params.id);
        if (!result.changes)
          return reply
            .code(404)
            .send({ ok: false, message: "邮箱不存在。" });
      }
      return { ok: true };
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/accounts/:id/signature",
    async (request, reply) => {
      const parsed = accountSignaturePatchSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ ok: false, message: validationMessage(parsed.error) });
      const result = context.db
        .prepare("UPDATE accounts SET signature = ? WHERE id = ?")
        .run(parsed.data.signature, request.params.id);
      if (!result.changes)
        return reply
          .code(404)
          .send({ ok: false, message: "邮箱不存在。" });
      return { ok: true };
    },
  );

  app.get<{
    Querystring: { accountId?: string; limit?: string };
  }>("/api/submissions", async (request, reply) => {
    const parsed = submissionsQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, message: validationMessage(parsed.error) });
    const account = context.db
      .prepare("SELECT 1 FROM accounts WHERE id = ?")
      .get(parsed.data.accountId);
    if (!account)
      return reply
        .code(404)
        .send({ ok: false, message: "发件邮箱不存在。" });
    return {
      items: submissionsForAccount(
        context.db,
        context.masterKey,
        parsed.data.accountId,
        parsed.data.limit,
      ),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/submissions/:id",
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success)
        return reply
          .code(400)
          .send({ ok: false, message: "发送记录标识无效。" });
      const submission = submissionForId(
        context.db,
        context.masterKey,
        id.data,
      );
      if (!submission)
        return reply
          .code(404)
          .send({ ok: false, message: "发送记录不存在。" });
      return { ok: true, submission };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/sync",
    async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success)
        return reply
          .code(400)
          .send({ ok: false, message: "账号标识无效。" });
      const accountId = id.data;
      const syncController = new AbortController();
      const syncRuntimeCap = setTimeout(() => syncController.abort(), 3 * 60_000);
      request.raw.once("aborted", () => syncController.abort());
      try {
        const result = await syncAccount(
          context.db,
          context.masterKey,
          accountId,
          getSyncMessageLimit(context.db),
          context.oauthService,
          context.agentMailEvents,
          syncController.signal,
        );
        emitAccountSynced(context.db, context.serverEvents, accountId);
        return { ok: true, ...result };
      } catch (error) {
        if (syncController.signal.aborted) {
          return reply
            .code(499)
            .send({
              ok: false,
              code: "cancelled",
              message: "同步已取消或超时。",
            });
        }
        const account = context.db
          .prepare("SELECT * FROM accounts WHERE id = ?")
          .get(accountId) as AccountRecord | undefined;
        const failure = mailFailure(
          error,
          account ? detectProvider(account.email).credentialHint : undefined,
        );
        return reply.code(failure.statusCode).send(failure.body);
      } finally {
        clearTimeout(syncRuntimeCap);
      }
    },
  );
}
