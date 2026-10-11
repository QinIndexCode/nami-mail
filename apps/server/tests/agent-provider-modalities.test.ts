import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentService } from "../src/agent-service.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { encryptRootAgentRecord } from "../src/agent/store-crypto.js";
import { composeProviderChatMessageContent } from "../src/agent/attachment-content.js";
import { OpenAiCompatibleProvider } from "../src/agent/openai-compatible-provider.js";
import { GeminiProvider } from "../src/agent/gemini-provider.js";
import { AnthropicMessagesProvider } from "../src/agent/anthropic-provider.js";
import type { ProviderChatRequest } from "@nami/agent-contracts";

describe("agent provider modalities and migration", () => {
  function createTestService() {
    const db = openDatabase(":memory:");
    const masterKey = randomBytes(32);
    applyAgentStoreSchema(db, "2026-08-10T10:00:00.000Z");
    const lifecycle = new AccountLifecycleStore(db, masterKey);
    const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
    const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
    return { db, masterKey, service };
  }

  it("persists multimodal configuration and reflects in provider summary", () => {
    const { service } = createTestService();
    const created = service.createProvider({
      label: "Multimodal Gemini",
      kind: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      modalities: {
        image: true,
        video: true,
        audio: true,
        pdf: true,
      },
    });

    expect(created.modalities).toEqual({
      image: true,
      video: true,
      audio: true,
      pdf: true,
    });
    expect(created.vision).toBe(true);

    const listed = service.providerList().items.find((item) => item.id === created.id);
    expect(listed?.modalities).toEqual({
      image: true,
      video: true,
      audio: true,
      pdf: true,
    });
    expect(listed?.vision).toBe(true);
  });

  it("migrates legacy stored configurations without modalities to text-only defaults", () => {
    const { db, masterKey, service } = createTestService();
    const legacyId = "provider-legacy-123";
    const legacyConfig = {
      version: 1,
      id: legacyId,
      label: "Legacy Claude",
      kind: "anthropic",
      endpoint: "https://api.anthropic.com/",
      model: "claude-3-5-sonnet",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      streaming: true,
      // NOTE: No `modalities` field, simulating an older version database record.
    };

    const encrypted = encryptRootAgentRecord(
      masterKey,
      "agent-provider-config",
      `provider-config:${legacyId}`,
      JSON.stringify(legacyConfig),
    );

    db.prepare(`
      INSERT INTO agent_provider_configurations (provider_id, encrypted_configuration, crypto_version, created_at, updated_at)
      VALUES (?, ?, 1, '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:00.000Z')
    `).run(legacyId, encrypted);

    const providers = service.providerList().items;
    const legacyProvider = providers.find((p) => p.id === legacyId);
    expect(legacyProvider).toBeDefined();
    expect(legacyProvider?.modalities).toEqual({
      image: false,
      video: false,
      audio: false,
      pdf: false,
    });
    expect(legacyProvider?.vision).toBe(false);
  });

  it("updates modalities on existing provider", () => {
    const { service } = createTestService();
    const created = service.createProvider({
      label: "Test Provider",
      kind: "openai-compatible",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      modalities: {
        image: false,
        video: false,
        audio: false,
        pdf: false,
      },
    });

    expect(created.vision).toBe(false);

    const updated = service.updateProvider(created.id, {
      label: "Test Provider",
      kind: "openai-compatible",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4o",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      modalities: {
        image: true,
        video: false,
        audio: false,
        pdf: true,
      },
    });

    expect(updated.modalities).toEqual({
      image: true,
      video: false,
      audio: false,
      pdf: true,
    });
    expect(updated.vision).toBe(true);
  });

  describe("composeProviderChatMessageContent", () => {
    it("returns plain string when attachments are text-only", () => {
      const result = composeProviderChatMessageContent("Please summarize", [
        { name: "readme.txt", type: "txt", text: "Hello text content" },
      ]);
      expect(typeof result).toBe("string");
      expect(result).toBe("[file: readme.txt]\nHello text content\n[/file]\n\nPlease summarize");
    });

    it("returns ProviderContentPart[] when multimodal attachments with dataUrl exist", () => {
      const result = composeProviderChatMessageContent("Describe these files", [
        { name: "notes.txt", type: "txt", text: "Text memo" },
        {
          name: "screenshot.png",
          type: "png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
        {
          name: "report.pdf",
          type: "pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERi0xLjQKJ...",
        },
      ]);

      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({
          type: "text",
          text: "[file: notes.txt]\nText memo\n[/file]\n\nDescribe these files",
        });
        expect(result[1]).toEqual({
          type: "image_url",
          imageUrl: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          },
        });
        expect(result[2]).toEqual({
          type: "document",
          document: {
            url: "data:application/pdf;base64,JVBERi0xLjQKJ...",
            mimeType: "application/pdf",
            name: "report.pdf",
          },
        });
      }
    });
  });

  describe("provider multimodal wire format serialization", () => {
    function sseResponse(lines: string[]): Response {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }

    const mockRequest: ProviderChatRequest = {
      requestId: "req-123",
      providerId: "test-provider",
      model: "test-model",
      allowToolCalls: false,
      responseFormat: "text",
      tools: [],
      messages: [
        { role: "system", content: "You are an assistant." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image_url",
              imageUrl: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
            },
            {
              type: "document",
              document: {
                url: "data:application/pdf;base64,JVBERi0xLjQKJ...",
                mimeType: "application/pdf",
                name: "paper.pdf",
              },
            },
          ],
        },
      ],
    };

    it("OpenAiCompatibleProvider serializes image_url and document parts", async () => {
      let interceptedBody: unknown;
      const provider = new OpenAiCompatibleProvider({
        id: "openai-test",
        kind: "openai-compatible",
        endpoint: "https://api.openai.test/v1",
        fetchImpl: async (_input, init) => {
          interceptedBody = JSON.parse(init?.body as string);
          return sseResponse([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: [DONE]',
          ]);
        },
      });

      for await (const event of provider.streamChat(mockRequest)) {
        expect(event).toBeDefined();
      }

      const body = interceptedBody as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1]?.role).toBe("user");
      expect(body.messages[1]?.content).toEqual([
        { type: "text", text: "What is in this image?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
        },
        {
          type: "image_url",
          image_url: { url: "data:application/pdf;base64,JVBERi0xLjQKJ..." },
        },
      ]);
    });

    it("GeminiProvider serializes multimodal parts into inlineData", async () => {
      let interceptedBody: unknown;
      const provider = new GeminiProvider({
        id: "gemini-test",
        endpoint: "https://generativelanguage.googleapis.test/v1beta",
        apiKey: "fake-key",
        fetchImpl: async (_input, init) => {
          interceptedBody = JSON.parse(init?.body as string);
          return sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
          ]);
        },
      });

      for await (const event of provider.streamChat(mockRequest)) {
        expect(event).toBeDefined();
      }

      const body = interceptedBody as { contents: Array<{ role: string; parts: unknown[] }> };
      expect(body.contents).toHaveLength(1);
      expect(body.contents[0]?.role).toBe("user");
      expect(body.contents[0]?.parts).toEqual([
        { text: "What is in this image?" },
        {
          inlineData: {
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          },
        },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: "JVBERi0xLjQKJ...",
          },
        },
      ]);
    });

    it("AnthropicMessagesProvider serializes image and document blocks with base64 source", async () => {
      let interceptedBody: unknown;
      const provider = new AnthropicMessagesProvider({
        id: "anthropic-test",
        endpoint: "https://api.anthropic.test",
        apiKey: "fake-key",
        fetchImpl: async (_input, init) => {
          interceptedBody = JSON.parse(init?.body as string);
          return sseResponse([
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1"}}',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
            'event: message_stop\ndata: {"type":"message_stop"}',
          ]);
        },
      });

      for await (const event of provider.streamChat(mockRequest)) {
        expect(event).toBeDefined();
      }

      const body = interceptedBody as { messages: Array<{ role: string; content: unknown[] }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe("user");
      expect(body.messages[0]?.content).toEqual([
        { type: "text", text: "What is in this image?" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "JVBERi0xLjQKJ...",
          },
        },
      ]);
    });
  });
});
