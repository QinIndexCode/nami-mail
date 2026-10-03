import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AgentService,
  AgentServiceError,
  type AgentConversationScope,
  type AgentMcpServerInput,
  type AgentMessageInput,
  type AgentProviderInput,
} from "../agent-service.js";
import { EncryptedAgentMemoryStore } from "../agent/memory.js";
import { MAX_POLISH_TEXT_LENGTH } from "../agent/writing-polish.js";
import { getAutoReplyEngine } from "../agent/auto-reply.js";
import { autoReplyDecisionReasons, type AutoReplyDecisionReason } from "../agent/auto-reply-decisions.js";
import { agentMemoryPatchSchema } from "@nami/agent-contracts";
import {
  agentConfirmationDecisionSchema,
  agentConversationCreateSchema,
  agentConversationPatchSchema,
  agentConversationQuerySchema,
  agentMessageSchema,
  agentMemoryCreateSchema,
  agentMemoryParamsSchema,
  agentMemoryQuerySchema,
  agentMcpServerSchema,
  agentProviderSchema,
  autoReplySimulateSchema,
  emptyBodySchema,
} from "../schemas.js";
import { simulateAutoReply } from "../agent/auto-reply-simulator.js";
import { getAppSettings } from "../settings.js";
import { listContacts } from "../contacts.js";
import type { RuntimeContext } from "../types.js";
import { ROUTE_ERROR_CODES } from "./error-codes.js";

export type AgentRouteDeps = {
  context: RuntimeContext;
  agentService?: AgentService;
  memoryStore: EncryptedAgentMemoryStore;
};

function validationMessage(error: { issues: Array<{ message?: string }> }): string {
  return error.issues[0]?.message ?? "请求参数无效。";
}

function agentFailure(reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof AgentServiceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    });
  }
  return reply.code(500).send({ ok: false, code: ROUTE_ERROR_CODES.agent_internal, message: "Agent 本地服务未能完成请求，请稍后重试。", retryable: true });
}

/**
 * Declared next to its route, as `routes/translation.ts` does for its own
 * bodies: this shape exists for one endpoint and its cap is the one that
 * endpoint enforces, so keeping the two together is what stops them drifting.
 * Over-long bodies fail here (400 `invalid_argument`) and never reach the
 * model call.
 */
const polishBodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_POLISH_TEXT_LENGTH, "正文过长，无法润色。"),
  locale: z.string().trim().min(2).max(32).optional(),
}).strict();

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { context, agentService, memoryStore } = deps;

  app.get("/api/agent/providers", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      return agentService.providerList();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/providers", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentProviderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createProvider(parsed.data as AgentProviderInput));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/providers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentProviderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return agentService.updateProvider(request.params.id, parsed.data as AgentProviderInput);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/providers/:id/check", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      return await agentService.checkProvider(request.params.id, controller.signal);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/providers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteProvider(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/mcp-servers", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      return agentService.mcpServerList();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/mcp-servers", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createMcpServer(parsed.data as AgentMcpServerInput));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/mcp-servers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentMcpServerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return agentService.updateMcpServer(request.params.id, parsed.data as AgentMcpServerInput);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/mcp-servers/:id/check", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      return await agentService.checkMcpServer(request.params.id, controller.signal);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/mcp-servers/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteMcpServer(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/bootstrap", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      return agentService.bootstrap();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/rag/verify", async (_request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      return agentService.verifyRag();
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  /**
   * Language-only polish of the body the user is composing. A host-initiated
   * model call with no conversation and no tools: `polishDraft` reaches the
   * default provider through the same runtime seam every other auxiliary chat
   * uses, so this route opens no connection of its own.
   *
   * "No model configured" is answered here rather than from the service
   * because it is the one outcome the renderer must be able to tell apart from
   * a real failure: the compose window uses it to offer configuration advice
   * instead of an error toast. `providerList()` already reports a null
   * `defaultProviderId` unless that provider is fully configured, so this test
   * is the same question the service asks a moment later.
   */
  app.post("/api/agent/polish", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = polishBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    if (!agentService.providerList().defaultProviderId) {
      return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.no_model_configured, message: "该功能需要配置模型。" });
    }
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    try {
      const result = await agentService.polishDraft({
        text: parsed.data.text,
        ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
      }, { signal: controller.signal });
      return { ok: true as const, text: result.text };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/conversations", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentConversationQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return { items: agentService.listConversations(parsed.data.query ?? "") };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/conversations", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentConversationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return reply.code(201).send(agentService.createConversation(parsed.data as { title?: string; providerId?: string; scope?: AgentConversationScope }));
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      return agentService.getConversation(request.params.id);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentConversationPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return agentService.renameConversation(request.params.id, parsed.data.title);
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/conversations/:id", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    try {
      agentService.deleteConversation(request.params.id);
      return { ok: true as const };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  // Mark a conversation message as revoked (or restore it). Idempotent: the
  // server stores the latest intent per message and filters revoked turns out
  // of the model context, so the client can optimistically update the UI and
  // reconcile here without conflict.
  app.post<{ Params: { id: string }; Body: { messageId?: unknown; revoked?: unknown } }>("/api/agent/conversations/:id/messages/revoke", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const { messageId, revoked } = request.body ?? {};
    if (typeof messageId !== "string" || !messageId) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "缺少消息 ID。" });
    if (revoked !== undefined && typeof revoked !== "boolean") return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "revoked 必须是布尔值。" });
    try {
      const summary = agentService.revokeMessage(request.params.id, messageId, revoked !== false);
      return { ok: true as const, conversation: summary };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/messages", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = agentMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    let deliveryStopped = false;
    // A client disconnect stops DELIVERY only — the run keeps draining and its
    // completed turn is persisted. That is the contract the web client relies
    // on: closing the Agent panel is a "leave", not a "cancel" (see the
    // useAgentSession cleanup comment), and the finished reply is picked up by
    // its pickup poll when the panel reopens. Cancelling is an explicit action
    // that goes through POST /cancel, which the client does call on stop,
    // send-interrupt, session teardown and slot rebind.
    //
    // Do not wire `streamMessage`'s requestSignal to this handler: the route
    // cannot tell "leave" from "stop" (both are a socket close), and aborting
    // on every disconnect would make a closed panel discard the finished
    // reply — the aborted run's finally skips persisting the assistant row.
    const stopDelivery = () => { deliveryStopped = true; };
    request.raw.once("aborted", stopDelivery);
    reply.raw.once("close", stopDelivery);
    request.raw.on("error", stopDelivery);
    reply.raw.on("error", stopDelivery);
    const responseSocket = reply.raw.socket;
    responseSocket?.once("close", stopDelivery);
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("cache-control", "no-store, no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    try {
      const locale = getAppSettings(context.db).locale;
      for await (const event of agentService.streamMessage(request.params.id, parsed.data as AgentMessageInput, undefined, locale)) {
        if (deliveryStopped || reply.raw.destroyed) continue;
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          deliveryStopped = true;
        }
      }
    } catch (error) {
      if (!deliveryStopped && !reply.raw.destroyed) {
        const body = error instanceof AgentServiceError
          ? { type: "error", error: { code: error.code, message: error.message, retryable: error.retryable } }
          : { type: "error", error: { code: ROUTE_ERROR_CODES.agent_internal, message: "Agent local service failed to complete the request.", retryable: true } };
        reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
        reply.raw.write(`data: ${JSON.stringify({ type: "completed", reason: "error" })}\n\n`);
      }
    } finally {
      request.raw.removeListener("aborted", stopDelivery);
      reply.raw.removeListener("close", stopDelivery);
      request.raw.removeListener("error", stopDelivery);
      reply.raw.removeListener("error", stopDelivery);
      responseSocket?.removeListener("close", stopDelivery);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post<{ Params: { id: string } }>("/api/agent/conversations/:id/cancel", async (request, reply) => {
    if (!agentService) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 服务当前不可用。" });
    const parsed = emptyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    agentService.cancelRun(request.params.id);
    return { ok: true as const };
  });

  app.post<{ Params: { id: string } }>("/api/agent/confirmations/:id", async (request, reply) => {
    const parsed = agentConfirmationDecisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.auto_reply_unavailable, message: "自动回复引擎当前不可用。" });
    const resolution = engine.resolveConfirmation(request.params.id, parsed.data.decision, "web");
    if ("ok" in resolution) return { ok: resolution.ok };
    if (resolution.decision === "expired") {
      return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.confirmation_expired, message: "该自动回复确认已过期。" });
    }
    if (resolution.decision === "failed") {
      return reply.code(409).send({ ok: false, code: ROUTE_ERROR_CODES.confirmation_record_failed, message: "自动回复确认记录失败。" });
    }
    return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "未找到该自动回复确认。" });
  });

  app.get("/api/agent/memory", async (request, reply) => {
    const parsed = agentMemoryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      return { items: memoryStore.list({
        kind: parsed.data.kind,
        accountId: parsed.data.accountId,
        query: parsed.data.query,
        limit: parsed.data.limit,
      }) };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete("/api/agent/memory", async (_request, reply) => {
    try {
      return { cleared: memoryStore.clear() };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/memory", async (request, reply) => {
    const parsed = agentMemoryCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      const item = memoryStore.create(parsed.data);
      return reply.code(201).send({ item });
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agent/memory/:id", async (request, reply) => {
    const params = agentMemoryParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(params.error) });
    const parsed = agentMemoryPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    try {
      const item = memoryStore.update(params.data.id, parsed.data);
      return { item };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/memory/:id", async (request, reply) => {
    const params = agentMemoryParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(params.error) });
    try {
      memoryStore.delete(params.data.id);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof Error && error.message.includes("was not found")) {
        return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "记忆条目不存在。" });
      }
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/auto-reply/pending", async (_request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.auto_reply_unavailable, message: "自动回复引擎当前不可用。" });
    try {
      return { items: engine.listPending() };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/auto-reply/decisions", async (request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.auto_reply_unavailable, message: "自动回复引擎当前不可用。" });
    const query = request.query as Record<string, string | undefined>;
    const reason = query.reason ?? undefined;
    if (reason && !autoReplyDecisionReasons.includes(reason as AutoReplyDecisionReason)) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "无效的自动回复决策类型。" });
    }
    const limit = query.limit === undefined ? 100 : Number.parseInt(query.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: "limit 必须是 1-500 之间的整数。" });
    }
    try {
      return {
        items: engine.listDecisions({
          ...(reason ? { reason: reason as AutoReplyDecisionReason } : {}),
          ...(query.query ? { query: query.query } : {}),
          ...(query.fromAddress ? { fromAddress: query.fromAddress } : {}),
          ...(query.subject ? { subject: query.subject } : {}),
          limit,
        }),
      };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/agent/auto-reply/decisions/:id", async (request, reply) => {
    const engine = getAutoReplyEngine();
    if (!engine) return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.auto_reply_unavailable, message: "自动回复引擎当前不可用。" });
    try {
      const deleted = engine.deleteDecision(request.params.id);
      if (!deleted) return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "该记录不存在或已被删除。" });
      return { ok: true };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.post("/api/agent/auto-reply/simulate", async (request, reply) => {
    if (!agentService) {
      return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "Agent 当前不可用。" });
    }
    const parsed = autoReplySimulateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: ROUTE_ERROR_CODES.invalid_argument, message: validationMessage(parsed.error) });
    }
    try {
      const config = getAppSettings(context.db).autoReply;
      let contacts: Set<string> | undefined;
      if (config.scope?.contactsOnly) {
        try {
          const loaded = listContacts(context.db, context.masterKey);
          contacts = new Set(loaded.map((c) => c.email.trim().toLowerCase()).filter(Boolean));
        } catch {
          contacts = new Set();
        }
      }
      const result = await simulateAutoReply(agentService, parsed.data, config, contacts);
      return { ok: true, result };
    } catch (error) {
      return agentFailure(reply, error);
    }
  });

  app.get("/api/agent/pairings", async (_request, reply) => {
    const pairings = (await context.listExternalPairings?.()) ?? [];
    const now = Date.now();
    return {
      pairings: [...pairings].map((pairing) => {
        const expired = pairing.expiresAt !== undefined && !pairing.revokedAt && Date.parse(pairing.expiresAt) <= now;
        return {
          clientId: pairing.clientId,
          createdAt: pairing.createdAt,
          ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
          ...(pairing.revokedAt ? { revokedAt: pairing.revokedAt } : {}),
          accountIds: [...pairing.accountIds],
          status: pairing.revokedAt ? "revoked" : expired ? "expired" : "active",
        };
      }),
    };
  });

  app.delete<{ Params: { clientId: string } }>("/api/agent/pairings/:clientId", async (request, reply) => {
    if (!context.revokeExternalPairing) {
      return reply.code(503).send({ ok: false, code: ROUTE_ERROR_CODES.agent_unavailable, message: "当前环境不支持撤销外部连接配对。" });
    }
    const revoked = await context.revokeExternalPairing(request.params.clientId);
    if (!revoked) {
      return reply.code(404).send({ ok: false, code: ROUTE_ERROR_CODES.not_found, message: "未找到该配对记录。" });
    }
    return { ok: true as const };
  });
}
