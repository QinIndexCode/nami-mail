import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import type { DatabaseHandle } from "./db.js";
import { getAppSettings } from "./settings.js";
import { TranslationService, TranslationServiceError, type TranslationServiceOptions } from "./translation.js";

const configurationCryptoVersion = 1;
const configurationKeyPurpose = "translation-service-configuration/v1";
const configurationAad = "nami-mail:translation-service-configuration:v1";
const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 60_000;
const defaultTimeoutMs = 25_000;

export type TranslationConfigurationSource = "environment" | "local" | "none";

export type TranslationConfigurationSummary = {
  enabled: boolean;
  endpoint: string;
  timeoutMs: number;
  apiKeyConfigured: boolean;
  source: TranslationConfigurationSource;
  configurationError?: "invalid" | "unreadable";
};

export type TranslationConfigurationPatch = {
  endpoint?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
};

type PersistedTranslationConfiguration = {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
};

type StoredConfigurationRow = {
  translation_configuration: string | null;
  translation_configuration_version: number;
};

type ResolvedTranslationConfiguration = {
  source: TranslationConfigurationSource;
  options?: TranslationServiceOptions;
  configurationError?: "invalid" | "unreadable";
};

function withConfigurationKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, configurationKeyPurpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

function timeoutValue(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= minimumTimeoutMs
    && value <= maximumTimeoutMs
    ? value
    : undefined;
}

function normalizeOptions(options: TranslationServiceOptions): PersistedTranslationConfiguration {
  const endpoint = options.endpoint?.trim() ?? "";
  const apiKey = options.apiKey?.trim() || undefined;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!timeoutValue(timeoutMs)) {
    throw new TranslationServiceError("translation_not_configured", "The translation timeout is invalid.");
  }
  if (!endpoint) {
    throw new TranslationServiceError("translation_not_configured", "The translation endpoint is required.");
  }

  const service = new TranslationService({ endpoint, apiKey, timeoutMs });
  const issue = service.configurationIssue();
  if (issue) throw issue;
  if (!service.isConfigured()) {
    throw new TranslationServiceError("translation_not_configured", "The translation service is not configured.");
  }
  return { endpoint, ...(apiKey ? { apiKey } : {}), timeoutMs };
}

function parsePersistedConfiguration(payload: string): PersistedTranslationConfiguration {
  const value = JSON.parse(payload) as Partial<PersistedTranslationConfiguration>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Translation configuration is not an object.");
  }
  if (typeof value.endpoint !== "string" || typeof value.timeoutMs !== "number") {
    throw new Error("Translation configuration is incomplete.");
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
    throw new Error("Translation API key is invalid.");
  }
  return normalizeOptions({
    endpoint: value.endpoint,
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
    timeoutMs: value.timeoutMs,
  });
}

function publicSummary(resolved: ResolvedTranslationConfiguration): TranslationConfigurationSummary {
  const endpoint = resolved.options?.endpoint?.trim() ?? "";
  return {
    enabled: Boolean(endpoint) && !resolved.configurationError,
    endpoint,
    timeoutMs: resolved.options?.timeoutMs ?? defaultTimeoutMs,
    apiKeyConfigured: Boolean(resolved.options?.apiKey),
    source: resolved.source,
    ...(resolved.configurationError ? { configurationError: resolved.configurationError } : {}),
  };
}

/**
 * Stores user-entered translation settings in the already encrypted local
 * database. On Windows, that database key is wrapped by Electron DPAPI.
 */
export class TranslationConfigurationStore {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly environmentOptions: TranslationServiceOptions = {},
  ) {}

  private storedRow(): StoredConfigurationRow {
    getAppSettings(this.db);
    return this.db.prepare(`
      SELECT translation_configuration, translation_configuration_version
      FROM app_settings WHERE id = 1
    `).get() as StoredConfigurationRow;
  }

  private environmentResolution(): ResolvedTranslationConfiguration {
    if (!this.environmentOptions.endpoint?.trim()) return { source: "none" };
    try {
      return { source: "environment", options: normalizeOptions(this.environmentOptions) };
    } catch {
      return { source: "environment", configurationError: "invalid" };
    }
  }

  private resolve(): ResolvedTranslationConfiguration {
    const row = this.storedRow();
    if (row.translation_configuration === null) return this.environmentResolution();
    if (row.translation_configuration_version !== configurationCryptoVersion) {
      return { source: "local", configurationError: "unreadable" };
    }
    try {
      const configuration = withConfigurationKey(this.masterKey, (key) =>
        parsePersistedConfiguration(decryptTextEnvelope(row.translation_configuration!, key, configurationAad)),
      );
      return { source: "local", options: configuration };
    } catch {
      return { source: "local", configurationError: "unreadable" };
    }
  }

  summary(): TranslationConfigurationSummary {
    return publicSummary(this.resolve());
  }

  createService(): TranslationService {
    return new TranslationService(this.resolve().options);
  }

  clear(): TranslationConfigurationSummary {
    getAppSettings(this.db);
    this.db.prepare(`
      UPDATE app_settings
      SET translation_configuration = NULL, translation_configuration_version = 0
      WHERE id = 1
    `).run();
    return this.summary();
  }

  update(patch: TranslationConfigurationPatch): TranslationConfigurationSummary {
    const resolved = this.resolve();
    const current = resolved.options ?? this.environmentOptions;
    const endpoint = patch.endpoint === undefined ? current.endpoint?.trim() ?? "" : patch.endpoint.trim();
    if (!endpoint) {
      throw new TranslationServiceError("translation_not_configured", "The translation endpoint is required.");
    }

    const apiKey = patch.clearApiKey
      ? undefined
      : patch.apiKey === undefined
        // An environment key can enable an administrator-provided service,
        // but a user editing an endpoint must never copy that process secret
        // into database storage without explicitly entering a replacement.
        ? resolved.source === "local" ? current.apiKey?.trim() || undefined : undefined
        : patch.apiKey.trim() || undefined;
    const timeoutMs = patch.timeoutMs ?? current.timeoutMs ?? defaultTimeoutMs;
    const configuration = normalizeOptions({ endpoint, apiKey, timeoutMs });
    const encrypted = withConfigurationKey(this.masterKey, (key) =>
      encryptTextEnvelope(JSON.stringify(configuration), key, configurationAad),
    );

    getAppSettings(this.db);
    this.db.prepare(`
      UPDATE app_settings
      SET translation_configuration = ?, translation_configuration_version = ?
      WHERE id = 1
    `).run(encrypted, configurationCryptoVersion);
    return this.summary();
  }
}
