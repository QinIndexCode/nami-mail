import fs from "node:fs";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { friendlyMailError, sendMail, testMailboxConnection } from "./mail.js";
import { detectProvider, providerPresets, resolveProvider } from "./providers.js";
import { markMessageSeen, syncAccount } from "./sync.js";
import { publicAccount, type AccountRecord, type RuntimeContext } from "./types.js";

const credentialsSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).max(512),
});

const sendSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).optional(),
  subject: z.string().max(998).default(""),
  text: z.string().max(2_000_000).default(""),
  html: z.string().max(2_000_000).optional(),
});

function messageRow(row: Record<string, unknown>) {
  const flags = JSON.parse(String(row.flags_json ?? "[]")) as string[];
  return {
    id: row.id,
    accountId: row.account_id,
    accountEmail: row.account_email,
    providerName: row.provider_name,
    mailbox: row.mailbox,
    uid: row.uid,
    subject: row.subject,
    from: { name: row.from_name, address: row.from_address },
    to: JSON.parse(String(row.to_json ?? "[]")),
    sentAt: row.sent_at,
    snippet: row.snippet,
    textBody: row.text_body,
    htmlBody: row.html_body,
    flags,
    seen: flags.includes("\\Seen"),
    flagged: flags.includes("\\Flagged"),
    hasAttachments: Boolean(row.has_attachments),
    size: row.size,
  };
}

function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "请求参数无效。";
}

const inboxMessageFilter = `(
  UPPER(m.mailbox) = 'INBOX'
  OR EXISTS (
    SELECT 1 FROM folders f
    WHERE f.account_id = m.account_id
      AND f.path = m.mailbox
      AND f.special_use = '\\Inbox'
  )
)`;

function folderRank(folder: Record<string, unknown>): number {
  const ranks: Record<string, number> = {
    "\\Inbox": 0,
    "\\Sent": 1,
    "\\Drafts": 2,
    "\\Flagged": 3,
    "\\Important": 4,
    "\\All": 5,
    "\\Archive": 6,
    "\\Junk": 7,
    "\\Spam": 7,
    "\\Trash": 8,
  };
  return ranks[String(folder.special_use ?? "")] ?? 20;
}

export async function buildApp(context: RuntimeContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 3 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  app.get("/api/health", async () => ({ ok: true, service: "nami-mail", time: new Date().toISOString() }));

  app.get("/api/providers", async () =>
    providerPresets.map((provider) => ({
      id: provider.id,
      name: provider.name,
      domains: provider.domains,
      credentialHint: provider.credentialHint,
      credentialName: provider.credentialName,
      setupSteps: provider.setupSteps,
      helpUrl: provider.helpUrl,
      helpLabel: provider.helpLabel,
      basicAuthLimited: Boolean(provider.basicAuthLimited),
    })),
  );

  app.post("/api/accounts/test", async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const provider = await resolveProvider(parsed.data.email);
    try {
      const result = await testMailboxConnection(parsed.data.email, parsed.data.password, provider);
      return {
        ok: true,
        provider: provider.name,
        folders: result.folders,
        warning: provider.basicAuthLimited ? provider.credentialHint : null,
      };
    } catch (error) {
      const message = friendlyMailError(error, provider.credentialHint);
      app.log.warn({ provider: provider.id, domain: provider.domain }, message);
      return reply.code(422).send({
        ok: false,
        provider: provider.name,
        message,
      });
    }
  });

  app.get("/api/accounts", async () => {
    const rows = context.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRecord[];
    const folderRows = context.db.prepare("SELECT * FROM folders ORDER BY account_id, name").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...publicAccount(row),
      folders: folderRows
        .filter((folder) => folder.account_id === row.id)
        .sort((a, b) => folderRank(a) - folderRank(b) || String(a.name).localeCompare(String(b.name)))
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
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const existing = context.db.prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE").get(parsed.data.email);
    if (existing) return reply.code(409).send({ ok: false, message: "该邮箱已经添加。" });
    const provider = await resolveProvider(parsed.data.email);
    try {
      await testMailboxConnection(parsed.data.email, parsed.data.password, provider);
    } catch (error) {
      const message = friendlyMailError(error, provider.credentialHint);
      app.log.warn({ provider: provider.id, domain: provider.domain }, message);
      return reply.code(422).send({
        ok: false,
        provider: provider.name,
        message,
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    context.db
      .prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password,
          imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `)
      .run(
        id,
        parsed.data.email,
        provider.id,
        provider.name,
        encryptSecret(parsed.data.password, context.masterKey),
        provider.imap.host,
        provider.imap.port,
        provider.imap.secure ? 1 : 0,
        provider.smtp.host,
        provider.smtp.port,
        provider.smtp.secure ? 1 : 0,
        provider.usernameMode ?? "email",
        now,
      );

    let sync: Awaited<ReturnType<typeof syncAccount>> | null = null;
    let syncWarning: string | null = null;
    try {
      sync = await syncAccount(context.db, context.masterKey, id, config.syncMessageLimit);
      if (sync.failedFolders > 0) {
        syncWarning = `${sync.failedFolders} 个文件夹同步失败，其他邮件已完成同步`;
      }
    } catch (error) {
      syncWarning = friendlyMailError(error, provider.credentialHint);
      app.log.warn({ accountId: id, error }, "Initial mailbox sync failed");
    }
    const row = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    return reply.code(201).send({ ok: true, account: publicAccount(row), sync, syncWarning });
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const result = context.db.prepare("DELETE FROM accounts WHERE id = ?").run(request.params.id);
    if (!result.changes) return reply.code(404).send({ ok: false, message: "邮箱不存在。" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/sync", async (request, reply) => {
    try {
      const result = await syncAccount(context.db, context.masterKey, request.params.id, config.syncMessageLimit);
      return { ok: true, ...result };
    } catch (error) {
      const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(request.params.id) as AccountRecord | undefined;
      return reply.code(422).send({
        ok: false,
        message: friendlyMailError(error, account ? detectProvider(account.email).credentialHint : undefined),
      });
    }
  });

  app.get<{ Querystring: { accountId?: string; folder?: string; q?: string; page?: string; pageSize?: string } }>(
    "/api/messages",
    async (request) => {
      const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(10, Number.parseInt(request.query.pageSize ?? "40", 10) || 40));
      const filters: string[] = [];
      const params: unknown[] = [];
      if (request.query.accountId) {
        filters.push("m.account_id = ?");
        params.push(request.query.accountId);
      }
      if (request.query.folder) {
        filters.push("m.mailbox = ?");
        params.push(request.query.folder);
      } else {
        filters.push(inboxMessageFilter);
      }
      if (request.query.q?.trim()) {
        filters.push("(m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_address LIKE ? ESCAPE '\\' OR m.text_body LIKE ? ESCAPE '\\')");
        const escaped = request.query.q.trim().replace(/[\\%_]/g, "\\$&");
        params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const total = Number(
        (context.db.prepare(`SELECT COUNT(*) AS count FROM messages m ${where}`).get(...params) as { count: number }).count,
      );
      const rows = context.db
        .prepare(`
          SELECT m.*, a.email AS account_email, a.provider_name
          FROM messages m JOIN accounts a ON a.id = m.account_id
          ${where}
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC
          LIMIT ? OFFSET ?
        `)
        .all(...params, pageSize, (page - 1) * pageSize) as Array<Record<string, unknown>>;
      return { items: rows.map(messageRow), total, page, pageSize };
    },
  );

  app.get<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const row = context.db
      .prepare(`
        SELECT m.*, a.email AS account_email, a.provider_name
        FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?
      `)
      .get(request.params.id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ ok: false, message: "邮件不存在。" });
    return messageRow(row);
  });

  app.patch<{ Params: { id: string } }>("/api/messages/:id", async (request, reply) => {
    const parsed = z.object({ seen: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    try {
      await markMessageSeen(context.db, context.masterKey, request.params.id, parsed.data.seen);
      return { ok: true };
    } catch (error) {
      return reply.code(422).send({ ok: false, message: friendlyMailError(error) });
    }
  });

  app.post("/api/messages/send", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const account = context.db.prepare("SELECT * FROM accounts WHERE id = ?").get(parsed.data.accountId) as AccountRecord | undefined;
    if (!account) return reply.code(404).send({ ok: false, message: "发件邮箱不存在。" });
    try {
      const result = await sendMail(account, context.masterKey, parsed.data);
      return { ok: true, messageId: result.messageId };
    } catch (error) {
      return reply.code(422).send({ ok: false, message: friendlyMailError(error, detectProvider(account.email).credentialHint) });
    }
  });

  app.get("/api/stats", async () => {
    const accounts = (context.db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as { count: number }).count;
    const messages = (
      context.db.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter}`).get() as { count: number }
    ).count;
    const unread = (
      context.db
        .prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${inboxMessageFilter} AND flags_json NOT LIKE '%\\\\Seen%'`)
        .get() as { count: number }
    ).count;
    return { accounts, messages, unread };
  });

  if (fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, { root: config.webDistPath, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ ok: false, message: "接口不存在。" });
      return reply.type("text/html").sendFile("index.html");
    });
  }

  return app;
}
