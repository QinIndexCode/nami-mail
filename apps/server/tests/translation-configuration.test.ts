import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { TranslationConfigurationStore } from "../src/translation-configuration.js";

describe("translation configuration storage", () => {
  it("encrypts a user-supplied API key and restores only a safe summary", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 4);
    const endpoint = "https://translate.example.test/translate";
    const apiKey = "translation-key-must-not-be-plain";
    try {
      const store = new TranslationConfigurationStore(db, masterKey);
      expect(store.update({ endpoint, apiKey, timeoutMs: 18_000 })).toEqual({
        enabled: true,
        endpoint,
        timeoutMs: 18_000,
        apiKeyConfigured: true,
        source: "local",
      });

      const row = db.prepare("SELECT translation_configuration FROM app_settings WHERE id = 1").get() as {
        translation_configuration: string;
      };
      expect(row.translation_configuration).not.toContain(apiKey);
      expect(row.translation_configuration).not.toContain(endpoint);
      expect(new TranslationConfigurationStore(db, masterKey).summary()).toEqual({
        enabled: true,
        endpoint,
        timeoutMs: 18_000,
        apiKeyConfigured: true,
        source: "local",
      });
      expect(store.createService().isConfigured()).toBe(true);
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("retains a saved API key until the user explicitly removes it", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 5);
    try {
      const store = new TranslationConfigurationStore(db, masterKey);
      store.update({
        endpoint: "https://translate.example.test/translate",
        apiKey: "saved-key",
        timeoutMs: 25_000,
      });
      expect(store.update({ timeoutMs: 20_000 })).toMatchObject({
        apiKeyConfigured: true,
        timeoutMs: 20_000,
      });
      expect(store.update({ clearApiKey: true })).toEqual({
        enabled: true,
        endpoint: "https://translate.example.test/translate",
        timeoutMs: 20_000,
        apiKeyConfigured: false,
        source: "local",
      });
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("requires an endpoint for updates and clears a saved configuration only through the explicit operation", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 8);
    try {
      const store = new TranslationConfigurationStore(db, masterKey);
      store.update({
        endpoint: "https://translate.example.test/translate",
        apiKey: "saved-key",
        timeoutMs: 25_000,
      });

      expect(() => store.update({ endpoint: "" })).toThrow("translation endpoint is required");
      expect(store.summary()).toMatchObject({
        enabled: true,
        endpoint: "https://translate.example.test/translate",
        apiKeyConfigured: true,
        source: "local",
      });
      expect(store.clear()).toEqual({
        enabled: false,
        endpoint: "",
        timeoutMs: 25_000,
        apiKeyConfigured: false,
        source: "none",
      });
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("uses environment configuration only until the user saves a local configuration", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 6);
    try {
      const store = new TranslationConfigurationStore(db, masterKey, {
        endpoint: "https://environment.example.test/translate",
        apiKey: "environment-key",
        timeoutMs: 15_000,
      });
      expect(store.summary()).toMatchObject({
        enabled: true,
        endpoint: "https://environment.example.test/translate",
        apiKeyConfigured: true,
        source: "environment",
      });
      expect(store.update({ endpoint: "https://local.example.test/translate", timeoutMs: 12_000 })).toMatchObject({
        endpoint: "https://local.example.test/translate",
        apiKeyConfigured: false,
        source: "local",
      });
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("fails closed when an encrypted local configuration cannot be unlocked", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 7);
    try {
      const store = new TranslationConfigurationStore(db, masterKey);
      store.update({ endpoint: "https://translate.example.test/translate", apiKey: "key", timeoutMs: 25_000 });
      db.prepare("UPDATE app_settings SET translation_configuration = ? WHERE id = 1").run("nami-v1.invalid");
      expect(store.summary()).toEqual({
        enabled: false,
        endpoint: "",
        timeoutMs: 25_000,
        apiKeyConfigured: false,
        source: "local",
        configurationError: "unreadable",
      });
      expect(store.createService().isConfigured()).toBe(false);
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });

  it("treats an empty persisted ciphertext as unreadable instead of falling back to environment settings", () => {
    const db = openDatabase(":memory:");
    const masterKey = Buffer.alloc(32, 9);
    try {
      const store = new TranslationConfigurationStore(db, masterKey, {
        endpoint: "https://environment.example.test/translate",
        timeoutMs: 25_000,
      });
      store.update({ endpoint: "https://local.example.test/translate", timeoutMs: 25_000 });
      db.prepare("UPDATE app_settings SET translation_configuration = ? WHERE id = 1").run("");

      expect(store.summary()).toEqual({
        enabled: false,
        endpoint: "",
        timeoutMs: 25_000,
        apiKeyConfigured: false,
        source: "local",
        configurationError: "unreadable",
      });
    } finally {
      masterKey.fill(0);
      db.close();
    }
  });
});
