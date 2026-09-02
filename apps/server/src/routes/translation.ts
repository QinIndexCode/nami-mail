/**
 * Translation route group — extracted from app.ts.
 *
 * Covers: translation status, configuration CRUD, segment translation,
 * single-message translation (external + LLM fallback).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AgentService, AgentServiceError } from "../agent-service.js";
import { BuiltinTranslationChain } from "../builtin-translation.js";
import { TranslationConfigurationStore, type TranslationConfigurationPatch, type TranslationConfigurationSummary } from "../translation-configuration.js";
import { MAX_TRANSLATION_TEXT_LENGTH, TranslationServiceError, splitTranslationChunks, translationErrorStatus, translationLanguageForLocale } from "../translation.js";
import { protectTranslationUrls, restoreTranslationUrls } from "../translation-url-guard.js";
import { buildTranslationBlocks, splitTranslatedBlock } from "../translation-segments.js";
import { messagePayloadById } from "../message-storage.js";
import { messageTranslationSchema, translationConfigurationPatchSchema } from "../schemas.js";
import type { RuntimeContext, TranslationServiceLike } from "../types.js";

export type TranslationRouteDeps = {
  context: RuntimeContext;
  agentService?: AgentService;
  /** Mutable container — the PUT/DELETE config routes reassign .service. */
  translationServiceContainer: { service: TranslationServiceLike };
  translationConfigurationStore: TranslationConfigurationStore;
  translationConfigurationManaged: boolean;
  translationAbortController: AbortController;
};

// ---------------------------------------------------------------------------
// Helpers (moved from app.ts — only used by translation routes)
// ---------------------------------------------------------------------------

/** Strips HTML tags and decodes entities to plain text for translation. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const inner = label.replace(/<[^>]+>/g, "").trim();
      return inner ? `${inner} (${href})` : href;
    })
    .replace(/<(\/?)(p|div|br|h[1-6]|li|tr|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Returns the best available plain-text body for translation. */
function translatableTextFromPayload(payload: { textBody?: string; htmlBody?: string }): string | null {
  const text = payload.textBody?.trim();
  if (text) return text;
  const html = payload.htmlBody?.trim();
  if (html) return htmlToPlainText(html);
  return null;
}

/**
 * Builds the effective translation service from the current configuration:
 * - a custom endpoint exists -> chain routes custom + built-in engines by the
 *   user's primary/backup selection
 * - no custom endpoint -> chain over the built-in Google/MyMemory engines
 * Falls back to Google -> MyMemory when nothing is configured.
 */
export function buildTranslationService(summary: TranslationConfigurationSummary): TranslationServiceLike {
  const customOptions = summary.endpoint.trim()
    ? { endpoint: summary.endpoint, timeoutMs: summary.timeoutMs }
    : undefined;
  // A "custom" selection without a configured endpoint is not meaningful; the
  // chain falls back to the built-in Google engine for that slot.
  const primary = summary.primary === "custom" && !customOptions ? "google" : summary.primary;
  const backup = summary.backup === "custom" && !customOptions ? "mymemory" : summary.backup;
  return new BuiltinTranslationChain(primary, backup, customOptions);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTranslationRoutes(app: FastifyInstance, deps: TranslationRouteDeps): void {
  const {
    context,
    agentService,
    translationServiceContainer,
    translationConfigurationStore,
    translationConfigurationManaged,
    translationAbortController,
  } = deps;

  // This exposes capability only. It deliberately never returns endpoint,
  // provider, credential, model-cache, or file-path details to the reader UI.
  app.get("/api/translation/status", async () => {
    if (!translationConfigurationManaged) return { enabled: translationServiceContainer.service.isConfigured() };
    const summary = translationConfigurationStore.summary();
    // When no external service is configured the built-in free translator
    // (Google Translate + MyMemory fallback) is always available.
    if (!summary.enabled && !summary.configurationError) {
      return { enabled: true, mode: "builtin" as const };
    }
    return {
      enabled: summary.enabled,
      ...(summary.configurationError ? { configurationError: summary.configurationError } : {}),
    };
  });

  // The settings surface is intentionally separate from the reader capability
  // route. It returns the endpoint and whether an API key exists, never the
  // API key itself or any selected mail content.
  app.get("/api/translation/configuration", async (request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    return { ok: true, ...translationConfigurationStore.summary() };
  });

  app.put("/api/translation/configuration", async (request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    const parsed = translationConfigurationPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: "translation_configuration_invalid",
        message: "Translation configuration is invalid.",
      });
    }
    try {
      const summary = translationConfigurationStore.update(parsed.data as TranslationConfigurationPatch);
      translationServiceContainer.service = buildTranslationService(summary);
      return { ok: true, ...summary };
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(400).send({
          ok: false,
          code: "translation_configuration_invalid",
          message: "Translation configuration is invalid.",
        });
      }
      app.log.warn("Could not save translation configuration");
      return reply.code(500).send({
        ok: false,
        code: "translation_configuration_failed",
        message: "Translation configuration could not be saved.",
      });
    }
  });

  app.delete("/api/translation/configuration", async (_request, reply) => {
    if (!translationConfigurationManaged) {
      return reply.code(409).send({
        ok: false,
        code: "translation_configuration_managed",
        message: "Translation configuration is managed by this runtime.",
      });
    }
    try {
      const summary = translationConfigurationStore.clear();
      translationServiceContainer.service = buildTranslationService(summary);
      return { ok: true, ...summary };
    } catch {
      app.log.warn("Could not remove translation configuration");
      return reply.code(500).send({
        ok: false,
        code: "translation_configuration_failed",
        message: "Translation configuration could not be removed.",
      });
    }
  });

  // Translates an array of plain-text segments in parallel. Used by the
  // reader's style-preserving translation: the client extracts the visible
  // text nodes of the sanitized HTML body, sends them here, and writes the
  // translations back into the DOM so markup, links, and inline styles survive.
  app.post<{ Body: { targetLocale?: unknown; segments?: unknown } }>("/api/messages/translate-segments", async (request, reply) => {
    const body = request.body ?? {};
    if (
      typeof body.targetLocale !== "string" || !body.targetLocale
      || !Array.isArray(body.segments) || body.segments.length === 0
      || body.segments.some((segment) => typeof segment !== "string" || !segment.trim())
    ) {
      return reply.code(400).send({
        ok: false,
        code: "translation_invalid_target",
        message: "The translation target or segments are invalid.",
      });
    }
    if (body.segments.length > 1_000) {
      return reply.code(400).send({
        ok: false,
        code: "translation_request_too_large",
        message: "Too many translation segments.",
      });
    }
    const effectiveService = translationServiceContainer.service;
    // Cancel the remaining blocks when the client disconnects or the app
    // shuts down instead of finishing the whole batch on a dead request.
    const requestAbortController = new AbortController();
    const abortForClientDisconnect = () => requestAbortController.abort();
    request.raw.once("aborted", abortForClientDisconnect);
    reply.raw.once("close", abortForClientDisconnect);
    const abortForShutdown = () => requestAbortController.abort();
    if (translationAbortController.signal.aborted) abortForShutdown();
    else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
    try {
      // Merge consecutive segments into engine-safe blocks (see
      // translation-segments.ts) so hundreds of text nodes become a handful of
      // translation requests, staying under the free engines' rate limits.
      const blocks = buildTranslationBlocks(body.segments);
      const translations: string[] = new Array(body.segments.length);
      for (const block of blocks) {
        if (requestAbortController.signal.aborted) break;
        if (block.text.trim() === "") continue;
        const urlGuard = protectTranslationUrls(block.text);
        const result = await effectiveService.translate(urlGuard.text, body.targetLocale as string, requestAbortController.signal);
        const translatedBlock = restoreTranslationUrls(result.translatedText, urlGuard.urls, urlGuard.text);
        splitTranslatedBlock(translatedBlock, block.indices, translations);
      }
      return { ok: true as const, translations };
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({
          ok: false,
          code: error.code,
          message: error.message,
        });
      }
      app.log.warn("Segment translation failed");
      return reply.code(500).send({
        ok: false,
        code: "translation_failed",
        message: "The message text could not be translated.",
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/messages/:id/translate", async (request, reply) => {
    const parsed = messageTranslationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        code: "translation_invalid_target",
        message: "The translation target is invalid.",
      });
    }

    const llmProviders = agentService?.providerList().items.filter((p) => p.configured) ?? [];

    try {
      const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
      if (!stored) {
        return reply.code(404).send({
          ok: false,
          code: "translation_content_unavailable",
          message: "The selected message is no longer available.",
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }

      // Prefer the parser-produced plain-text body; fall back to stripping
      // HTML when the message has no textBody. Never send headers, addresses,
      // attachments, snippets, or raw HTML to a translation provider.
      const translatableText = translatableTextFromPayload(stored.payload);
      if (!translatableText) {
        return reply.code(422).send({
          ok: false,
          code: "translation_content_unavailable",
          message: "The message does not contain translatable text.",
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }
      // translationService already routes through the user's primary/backup
      // chain (built-in Google/MyMemory when nothing is configured), so it is
      // used directly in both single-chunk and streamed multi-chunk paths.
      const effectiveService = translationServiceContainer.service;
      // Protect URLs before chunking so link-only bodies survive translation
      // (see translation-url-guard.ts). Placeholders are single tokens, so a URL
      // never splits across a chunk boundary.
      const urlGuard = protectTranslationUrls(translatableText);
      const chunks = splitTranslationChunks(urlGuard.text);
      const restoreUrls = (value: string) => restoreTranslationUrls(value, urlGuard.urls, urlGuard.text);
      // Single-chunk translations keep the original JSON response for backward
      // compatibility. Multi-chunk translations stream partial results via SSE
      // so the reader sees incremental progress instead of waiting for the
      // whole message to finish.
      // Combine the shutdown signal with client disconnect so cancelling the
      // request stops the translation instead of wasting API calls.
      const requestAbortController = new AbortController();
      const abortForClientDisconnect = () => requestAbortController.abort();
      request.raw.once("aborted", abortForClientDisconnect);
      reply.raw.once("close", abortForClientDisconnect);
      const abortForShutdown = () => requestAbortController.abort();
      if (translationAbortController.signal.aborted) abortForShutdown();
      else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
      if (chunks.length <= 1) {
        const result = await effectiveService.translate(urlGuard.text, parsed.data.targetLocale, requestAbortController.signal);
        return { ok: true, targetLocale: parsed.data.targetLocale, ...result, translatedText: restoreUrls(result.translatedText) };
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const send = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        const parts: string[] = [];
        let detectedLanguage: string | undefined;
        for (const [index, chunk] of chunks.entries()) {
          if (requestAbortController.signal.aborted) break;
          const chunkResult = await effectiveService.translate(chunk, parsed.data.targetLocale, requestAbortController.signal);
          parts.push(chunkResult.translatedText);
          if (!detectedLanguage && chunkResult.detectedLanguage) {
            detectedLanguage = chunkResult.detectedLanguage;
          }
          // Restore URLs on the incremental preview so links stay clickable
          // during streaming too.
          send({ type: "chunk", partial: restoreUrls(parts.join("\n")), chunkIndex: index, totalChunks: chunks.length });
        }
        if (!requestAbortController.signal.aborted) {
          send({ type: "complete", translatedText: restoreUrls(parts.join("\n")), ...(detectedLanguage ? { detectedLanguage } : {}) });
        }
      } catch (error) {
        if (requestAbortController.signal.aborted) {
          // Client cancelled — no error event, just end the stream.
        } else if (!(error instanceof TranslationServiceError)) {
          app.log.warn({ messageId: request.params.id }, "Selected message translation failed");
          const code = "translation_failed";
          const message = "The selected message could not be translated.";
          try { send({ type: "error", message, code }); } catch { /* client may have disconnected */ }
        } else {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        }
      } finally {
        request.raw.removeListener("aborted", abortForClientDisconnect);
        reply.raw.removeListener("close", abortForClientDisconnect);
        translationAbortController.signal.removeEventListener("abort", abortForShutdown);
        try { reply.raw.end(); } catch { /* response already closed */ }
      }
      return reply;
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({
          ok: false,
          code: error.code,
          message: error.message,
          ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
        });
      }
      // Keep message data and provider details out of logs and HTTP errors.
      app.log.warn({ messageId: request.params.id }, "Selected message translation failed");
      return reply.code(500).send({
        ok: false,
        code: "translation_failed",
        message: "The selected message could not be translated.",
        ...(llmProviders.length > 0 ? { llmAvailable: true } : {}),
      });
    }
  });

  // LLM-powered translation fallback. Uses a configured Agent provider to
  // translate the message when the external free service is unavailable.
  app.post<{ Params: { id: string } }>("/api/messages/:id/translate-llm", async (request, reply) => {
    if (!agentService) {
      return reply.code(503).send({ ok: false, code: "agent_unavailable", message: "Agent 服务当前不可用。" });
    }
    const bodySchema = z.object({
      targetLocale: z.string().trim().min(2).max(16),
      providerId: z.string().trim().min(1).max(128),
      model: z.string().trim().min(1).max(256).optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, code: "translation_invalid_target", message: "The translation request is invalid." });
    }

    try {
      // Validate the locale structure but pass the full locale through so the
      // LLM prompt can distinguish variants like zh-CN vs zh-TW.
      translationLanguageForLocale(parsed.data.targetLocale);
      const stored = messagePayloadById(context.db, context.masterKey, request.params.id);
      if (!stored) {
        return reply.code(404).send({ ok: false, code: "translation_content_unavailable", message: "The selected message is no longer available." });
      }
      if (!stored.payload.textBody?.trim() && !stored.payload.htmlBody?.trim()) {
        return reply.code(422).send({ ok: false, code: "translation_content_unavailable", message: "The message does not contain translatable text." });
      }
      const translatableText = translatableTextFromPayload(stored.payload);
      if (!translatableText) {
        return reply.code(422).send({ ok: false, code: "translation_content_unavailable", message: "The message does not contain translatable text." });
      }
      if (translatableText.length > MAX_TRANSLATION_TEXT_LENGTH) {
        return reply.code(413).send({ ok: false, code: "translation_request_too_large", message: "The message is too large to translate." });
      }
      // Combine the shutdown signal with client disconnect so cancelling the
      // request aborts the in-flight LLM call instead of wasting provider quota.
      const requestAbortController = new AbortController();
      const abortForClientDisconnect = () => requestAbortController.abort();
      request.raw.once("aborted", abortForClientDisconnect);
      reply.raw.once("close", abortForClientDisconnect);
      const abortForShutdown = () => requestAbortController.abort();
      if (translationAbortController.signal.aborted) abortForShutdown();
      else translationAbortController.signal.addEventListener("abort", abortForShutdown, { once: true });
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      const send = (data: Record<string, unknown>) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        // Protect URLs so link-only bodies survive LLM translation (placeholders
        // are opaque tokens that stay intact as the model streams).
        const urlGuard = protectTranslationUrls(translatableText);
        const restoreUrls = (value: string) => restoreTranslationUrls(value, urlGuard.urls, urlGuard.text, false);
        // Stream every LLM token through SSE so the reader sees the
        // translation appear incrementally instead of waiting for the whole
        // model response to finish.
        let partial = "";
        const result = await agentService.translateWithProvider(
          parsed.data.providerId,
          urlGuard.text,
          parsed.data.targetLocale,
          {
            ...(parsed.data.model ? { model: parsed.data.model } : {}),
            signal: requestAbortController.signal,
            onDelta: (delta) => {
              partial += delta;
              if (partial.trim()) {
                try { send({ type: "chunk", partial: restoreUrls(partial) }); } catch { /* client may have disconnected */ }
              }
            },
          },
        );
        if (!requestAbortController.signal.aborted) {
          send({ type: "complete", translatedText: restoreUrls(result.translatedText) });
        }
      } catch (error) {
        if (requestAbortController.signal.aborted) {
          // Client cancelled — no error event, just end the stream.
        } else if (error instanceof TranslationServiceError) {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        } else if (error instanceof AgentServiceError) {
          try { send({ type: "error", message: error.message, code: error.code }); } catch { /* client may have disconnected */ }
        } else {
          app.log.warn({ messageId: request.params.id }, "LLM translation failed");
          try { send({ type: "error", message: "The selected message could not be translated.", code: "translation_failed" }); } catch { /* client may have disconnected */ }
        }
      } finally {
        request.raw.removeListener("aborted", abortForClientDisconnect);
        reply.raw.removeListener("close", abortForClientDisconnect);
        translationAbortController.signal.removeEventListener("abort", abortForShutdown);
        try { reply.raw.end(); } catch { /* response already closed */ }
      }
      return reply;
    } catch (error) {
      if (error instanceof TranslationServiceError) {
        return reply.code(translationErrorStatus(error)).send({ ok: false, code: error.code, message: error.message });
      }
      if (error instanceof AgentServiceError) {
        return reply.code(error.statusCode).send({ ok: false, code: error.code, message: error.message });
      }
      app.log.warn({ messageId: request.params.id }, "LLM translation failed");
      return reply.code(500).send({ ok: false, code: "translation_failed", message: "The selected message could not be translated." });
    }
  });
}
