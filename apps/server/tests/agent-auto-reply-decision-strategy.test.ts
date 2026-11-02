import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "../src/db.js";
import { openDatabase } from "../src/db.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentService } from "../src/agent-service.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { SystemOneProvider } from "../src/agent/system-one-provider.js";

/**
 * The auto-reply decision stage has two strategies: the chat JSON prompt
 * (existing) and the typed `decide()` call against a decision model such as
 * System One. These tests pin the strategy selection, the threshold, the
 * bounded retry and the draft-stage role guard.
 */

const timestamp = "2026-08-10T10:00:00.000Z";
// Assembled at runtime so secret scanners do not flag the synthetic test value.
const PROVIDER_SECRET = ["provider", "secret", "canary"].join("-");

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES ('account-1', 'account-1@example.test', 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
      'smtp.example.test', 465, 1, 'email', 'connected', ?)
  `).run(timestamp);
}

function createTestService() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  applyAgentStoreSchema(db, timestamp);
  insertAccount(db);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
  return { db, service };
}

function stubDraftStream(service: AgentService, reply: string): void {
  const internals = service as unknown as {
    runtime: { streamChat: () => AsyncIterable<Record<string, unknown>> };
  };
  vi.spyOn(internals.runtime, "streamChat").mockImplementation(async function* () {
    yield { type: "text_delta", delta: reply };
    yield { type: "completed", reason: "stop" };
  });
}

const evaluationInput = (decisionProviderId: string, draftProviderId: string | null) => ({
  accountEmail: "account-1@example.test",
  fromName: "Sender",
  fromAddress: "sender@example.test",
  subject: "季度报告",
  textBody: "请查收本季度的报告。",
  snippet: "请查收本季度的报告。",
  sensitiveKeywords: [],
  memoryContext: "",
  decisionProviderId,
  draftProviderId,
});

function jevAnswer(probability: number): Record<string, unknown> {
  return {
    model: "jev-1.13.0",
    answers: {
      "worth-replying": { type: "noul", noul: probability >= 0.5, probabilities: { yes: probability, no: 1 - probability } },
      "is-sensitive": { type: "noul", noul: false, probabilities: { yes: 0.02, no: 0.98 } },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auto-reply typed decision strategy", () => {
  it("routes the decision stage through decide() and thresholds the worth-replying probability", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      const chat = service.createProvider({
        label: "Cloud chat", kind: "openai-compatible", endpoint: "https://api.example.test/v1",
        model: "chat-model", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET, makeDefault: true,
      });
      const decideSpy = vi.spyOn(SystemOneProvider.prototype, "decide").mockResolvedValue(jevAnswer(0.92) as never);
      stubDraftStream(service, "好的，已收到，谢谢。");

      const result = await service.evaluateAutoReply(evaluationInput(jev.id, chat.id));

      expect(decideSpy).toHaveBeenCalledTimes(1);
      const request = decideSpy.mock.calls[0]?.[0];
      expect(request?.questions["worth-replying"]?.type).toBe("noul");
      expect(request?.questions["is-sensitive"]?.type).toBe("noul");
      expect(result.replyValue).toBe("high");
      expect(result.sensitive).toBe(false);
      expect(result.replyText).toBe("好的，已收到，谢谢。");
      // The decision audit rides on the result so the engine can attribute it.
      expect(result.decision).toEqual({
        providerId: jev.id,
        strategy: "typed",
        score: 0.92,
      });
    } finally {
      await service.close();
      db.close();
    }
  });

  it("ignores below-threshold mail without contacting the draft model", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      const chat = service.createProvider({
        label: "Cloud chat", kind: "openai-compatible", endpoint: "https://api.example.test/v1",
        model: "chat-model", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET, makeDefault: true,
      });
      const decideSpy = vi.spyOn(SystemOneProvider.prototype, "decide").mockResolvedValue(jevAnswer(0.31) as never);
      const internals = service as unknown as { runtime: { streamChat: () => AsyncIterable<unknown> } };
      const streamSpy = vi.spyOn(internals.runtime, "streamChat");

      const result = await service.evaluateAutoReply(evaluationInput(jev.id, chat.id));

      expect(result.replyValue).toBe("low");
      expect(result.replyText).toBeUndefined();
      expect(streamSpy).not.toHaveBeenCalled();
      expect(decideSpy).toHaveBeenCalledTimes(1);
      expect(result.decision).toMatchObject({ providerId: jev.id, strategy: "typed", score: 0.31 });
    } finally {
      await service.close();
      db.close();
    }
  });

  it("honours the caller's decision threshold over the default 0.7", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      const chat = service.createProvider({
        label: "Cloud chat", kind: "openai-compatible", endpoint: "https://api.example.test/v1",
        model: "chat-model", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET, makeDefault: true,
      });
      vi.spyOn(SystemOneProvider.prototype, "decide").mockResolvedValue(jevAnswer(0.55) as never);
      stubDraftStream(service, "好的。");

      // 0.55 passes a 0.5 threshold but fails the 0.7 default.
      const lenient = await service.evaluateAutoReply({ ...evaluationInput(jev.id, chat.id), decisionThreshold: 0.5 });
      expect(lenient.replyValue).toBe("high");
      const strict = await service.evaluateAutoReply(evaluationInput(jev.id, chat.id));
      expect(strict.replyValue).toBe("low");
    } finally {
      await service.close();
      db.close();
    }
  });

  it("retries a transient decision failure once and then succeeds", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      const chat = service.createProvider({
        label: "Cloud chat", kind: "openai-compatible", endpoint: "https://api.example.test/v1",
        model: "chat-model", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET, makeDefault: true,
      });
      const decideSpy = vi.spyOn(SystemOneProvider.prototype, "decide")
        .mockRejectedValueOnce({ code: "PROVIDER_RATE_LIMITED", message: "slow down", retryable: true })
        .mockResolvedValue(jevAnswer(0.9) as never);
      stubDraftStream(service, "好的。");

      const result = await service.evaluateAutoReply(evaluationInput(jev.id, chat.id));

      expect(decideSpy).toHaveBeenCalledTimes(2);
      expect(result.replyValue).toBe("high");
    } finally {
      await service.close();
      db.close();
    }
  });

  it("rejects a decision-only draft provider with an explicit 422 instead of failing mid-stream", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      vi.spyOn(SystemOneProvider.prototype, "decide").mockResolvedValue(jevAnswer(0.9) as never);

      await expect(service.evaluateAutoReply(evaluationInput(jev.id, jev.id))).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        statusCode: 422,
      });
    } finally {
      await service.close();
      db.close();
    }
  });

  it("validateAutoReplyProviders rejects unknown ids and role mismatches at the write boundary", async () => {
    const { db, service } = createTestService();
    try {
      const jev = service.createProvider({
        label: "Jev", kind: "system-one", endpoint: "https://api.typesafe.ai/v1/",
        model: "jev-latest", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET,
      });
      const chat = service.createProvider({
        label: "Cloud chat", kind: "openai-compatible", endpoint: "https://api.example.test/v1",
        model: "chat-model", timeoutMs: 30_000, allowCloudMailContent: true, apiKey: PROVIDER_SECRET, makeDefault: true,
      });

      // A decision-only model may decide; it may not draft.
      expect(() => service.validateAutoReplyProviders({ decisionProviderId: jev.id })).not.toThrow();
      expect(() => service.validateAutoReplyProviders({ draftProviderId: chat.id })).not.toThrow();
      expect(() => service.validateAutoReplyProviders({ draftProviderId: jev.id }))
        .toThrow("所选回复生成模型不支持文本生成。");
      expect(() => service.validateAutoReplyProviders({ decisionProviderId: "provider-missing" }))
        .toThrow("不存在。");
    } finally {
      await service.close();
      db.close();
    }
  });
});
