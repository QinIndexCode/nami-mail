import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTranslationService } from "../src/local-translation.js";
import { TranslationServiceError } from "../src/translation.js";

describe("LocalTranslationService", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "nami-local-translation-"));
  });

  afterEach(async () => {
    // The system eventually removes the temporary directory; discard the reference.
  });

  describe("constructor", () => {
    it("is configured when a cache directory is provided", () => {
      const service = new LocalTranslationService({ cacheDir });
      expect(service.isConfigured()).toBe(true);
      expect(service.configurationIssue()).toBeUndefined();
    });

    it("reports a configuration error when the cache directory is empty", () => {
      const service = new LocalTranslationService({ cacheDir: "" });
      expect(service.isConfigured()).toBe(false);
      expect(service.configurationIssue()?.code).toBe("translation_not_configured");
    });

    it("reports a configuration error when the cache directory is whitespace", () => {
      const service = new LocalTranslationService({ cacheDir: "   " });
      expect(service.isConfigured()).toBe(false);
      expect(service.configurationIssue()?.code).toBe("translation_not_configured");
    });
  });

  describe("translate validation", () => {
    it("rejects text exceeding the maximum length", async () => {
      const service = new LocalTranslationService({ cacheDir });
      const oversized = "a".repeat(50_001);
      await expect(service.translate(oversized, "zh-CN")).rejects.toMatchObject({
        code: "translation_request_too_large",
      });
    });

    it("rejects empty text", async () => {
      const service = new LocalTranslationService({ cacheDir });
      await expect(service.translate("   ", "zh-CN")).rejects.toMatchObject({
        code: "translation_content_unavailable",
      });
    });

    it("rejects when the service is not configured", async () => {
      const service = new LocalTranslationService({ cacheDir: "" });
      await expect(service.translate("Hello", "zh-CN")).rejects.toMatchObject({
        code: "translation_not_configured",
      });
    });

    it("rejects an invalid target locale", async () => {
      const service = new LocalTranslationService({ cacheDir });
      await expect(service.translate("Hello", "invalid-locale!")).rejects.toMatchObject({
        code: "translation_invalid_target",
      });
    });

    it("aborts immediately when the shutdown signal is already set", async () => {
      const service = new LocalTranslationService({ cacheDir });
      const controller = new AbortController();
      controller.abort();
      await expect(service.translate("Hello", "zh-CN", controller.signal)).rejects.toMatchObject({
        code: "translation_service_unavailable",
      });
    });
  });

  describe("TranslationServiceLike interface conformance", () => {
    it("exposes isConfigured, configurationIssue, and translate", () => {
      const service = new LocalTranslationService({ cacheDir });
      expect(typeof service.isConfigured).toBe("function");
      expect(typeof service.configurationIssue).toBe("function");
      expect(typeof service.translate).toBe("function");
    });

    it("returns TranslationServiceError instances from configurationIssue", () => {
      const service = new LocalTranslationService({ cacheDir: "" });
      const issue = service.configurationIssue();
      expect(issue).toBeInstanceOf(TranslationServiceError);
    });
  });
});
