import { randomUUID } from "node:crypto";
import { isLoopbackHostname } from "../endpoint-guard.js";
import {
  isAgentProviderKind,
  modelInputModalitiesSchema,
  providerHealthSchema,
  type AgentProviderKind,
  type AgentProviderRole,
  type AgentProviderSummary,
  type LlmProvider,
  type ModelInputModalities,
  type ProviderHealth,
} from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { canonicalAgentJson, decryptRootAgentRecord, encryptRootAgentRecord } from "./store-crypto.js";
import { AnthropicMessagesProvider } from "./anthropic-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";
import { OpenAiResponsesProvider } from "./openai-responses-provider.js";
import { SystemOneProvider } from "./system-one-provider.js";
import { AgentServiceError, now, requiredText } from "./agent-shared.js";

export const providerConfigurationVersion = 1;
const defaultProviderRecordId = "agent-provider-default";

export const defaultModalities: ModelInputModalities = {
  image: false,
  video: false,
  audio: false,
  pdf: false,
};

/**
 * What each transport can serve. Kept next to the union it mirrors so the two
 * cannot drift silently, and deliberately a plain record so a kind this build
 * does not know (a row from a newer build) simply resolves to no roles instead
 * of throwing on every provider request.
 */
const rolesByKind: Record<string, readonly AgentProviderRole[]> = {
  "openai-compatible": ["chat"],
  "openai-responses": ["chat"],
  "anthropic": ["chat"],
  "gemini": ["chat"],
  "ollama": ["chat"],
  "system-one": ["decision"],
};

export function providerRolesForKind(kind: string): AgentProviderRole[] {
  return [...(rolesByKind[kind] ?? [])];
}

/** Whether this build has an adapter for the kind at all. */
export function providerKindSupported(kind: string): boolean {
  return isAgentProviderKind(kind);
}

// The provider summary shape is single-sourced in @nami/agent-contracts
// (the web consumes the same type); these re-exports keep the historical
// local names for the rest of the server.
export type { AgentProviderKind, AgentProviderSummary, ModelInputModalities };

export type AgentProviderInput = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  embeddingModel?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs: number;
  allowCloudMailContent: boolean;
  makeDefault?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  modalities?: ModelInputModalities;
};

export type AgentProviderList = {
  items: AgentProviderSummary[];
  defaultProviderId: string | null;
};

export type ProviderConfiguration = {
  version: typeof providerConfigurationVersion;
  id: string;
  label: string;
  /**
   * Stored protocol kind. Held as a string, not the write-side union, so a row
   * written by a newer build can still be decrypted, listed and deleted here.
   */
  kind: string;
  endpoint: string;
  model: string;
  embeddingModel?: string;
  apiKey?: string;
  timeoutMs: number;
  allowCloudMailContent: boolean;
  streaming: boolean;
  modalities?: ModelInputModalities;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  health?: ProviderHealth;
};

export type ProviderRow = {
  provider_id: string;
  encrypted_configuration: string;
  crypto_version: number;
  created_at: string;
  updated_at: string;
};

export type DefaultProviderConfiguration = {
  version: typeof providerConfigurationVersion;
  defaultProviderId: string | null;
};


function normalizeEndpoint(value: string): { endpoint: string; cloud: boolean } {
  let url: URL;
  try {
    url = new URL(requiredText(value, "模型服务地址", 2_048));
  } catch {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型服务地址不是有效 URL。", 400, false);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型服务地址必须使用 HTTPS，或指向本机回环 HTTP 服务。", 400, false);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型服务地址不能包含账号、查询参数或片段。", 400, false);
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return { endpoint: url.toString(), cloud: !isLoopbackHostname(url.hostname) };
}

function providerConfigRecordId(id: string): string {
  return `provider-config:${id}`;
}

function validateContextWindow(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 2_000_000) {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型上下文窗口必须介于 1,000 和 2,000,000 Tokens 之间。", 400);
  }
  return value;
}

function validateMaxOutput(value: number): number {
  if (!Number.isInteger(value) || value < 256 || value > 64_000) {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型最大输出必须介于 256 和 64,000 Tokens 之间。", 400);
  }
  return value;
}

export function providerSummary(configuration: ProviderConfiguration): AgentProviderSummary {
  const cloud = normalizeEndpoint(configuration.endpoint).cloud;
  const apiKeyConfigured = Boolean(configuration.apiKey);
  const supported = providerKindSupported(configuration.kind);
  // A kind this build cannot speak to is never "configured": every call site
  // gates on this flag, and a silent chat request to a decision endpoint is
  // exactly the failure this prevents.
  const configured = supported && Boolean(configuration.model && configuration.endpoint && (!cloud || apiKeyConfigured));
  const modalities = configuration.modalities ?? defaultModalities;
  return {
    id: configuration.id,
    label: configuration.label,
    kind: configuration.kind,
    roles: providerRolesForKind(configuration.kind),
    supported,
    endpoint: configuration.endpoint,
    model: configuration.model,
    ...(configuration.embeddingModel ? { embeddingModel: configuration.embeddingModel } : {}),
    timeoutMs: configuration.timeoutMs,
    apiKeyConfigured,
    configured,
    cloud,
    cloudContentConsent: cloud && configuration.allowCloudMailContent,
    streaming: configuration.streaming,
    vision: Boolean(modalities.image),
    modalities,
    contextWindowTokens: configuration.contextWindowTokens ?? 8_192,
    maxOutputTokens: configuration.maxOutputTokens ?? 2_048,
    ...(configuration.health ? { health: configuration.health } : {}),
  };
}

function parseProviderConfiguration(value: unknown, id: string): ProviderConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentServiceError("INTERNAL", "模型配置无法读取。", 500);
  }
  const input = value as Partial<ProviderConfiguration>;
  if (
    input.version !== providerConfigurationVersion
    || input.id !== id
    // Only the shape is checked here. Which kinds exist is a write-side
    // concern (route schema + union); reading must tolerate a kind added by a
    // newer build so the row stays listable and deletable instead of taking
    // every other provider down with it.
    || typeof input.kind !== "string"
    || !input.kind.trim()
    || typeof input.label !== "string"
    || typeof input.endpoint !== "string"
    || typeof input.model !== "string"
    || (input.embeddingModel !== undefined && typeof input.embeddingModel !== "string")
    || typeof input.timeoutMs !== "number"
    || typeof input.allowCloudMailContent !== "boolean"
    || typeof input.streaming !== "boolean"
    || (input.apiKey !== undefined && typeof input.apiKey !== "string")
    || (input.contextWindowTokens !== undefined && (typeof input.contextWindowTokens !== "number" || !Number.isInteger(input.contextWindowTokens)))
    || (input.maxOutputTokens !== undefined && (typeof input.maxOutputTokens !== "number" || !Number.isInteger(input.maxOutputTokens)))
  ) throw new AgentServiceError("INTERNAL", "模型配置格式无效。", 500);
  const health = input.health === undefined ? undefined : providerHealthSchema.safeParse(input.health);
  if (health && !health.success) throw new AgentServiceError("INTERNAL", "模型连接状态格式无效。", 500);
  const modalitiesResult = input.modalities !== undefined ? modelInputModalitiesSchema.safeParse(input.modalities) : undefined;
  if (modalitiesResult && !modalitiesResult.success) throw new AgentServiceError("INTERNAL", "模型配置格式无效。", 500);
  const modalities = modalitiesResult ? modalitiesResult.data : { ...defaultModalities };
  const endpoint = normalizeEndpoint(input.endpoint).endpoint;
  return {
    version: providerConfigurationVersion,
    id,
    label: requiredText(input.label, "模型名称", 128),
    kind: input.kind.trim(),
    endpoint,
    model: requiredText(input.model, "模型标识", 256),
    ...(input.embeddingModel?.trim() ? { embeddingModel: input.embeddingModel.trim() } : {}),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    timeoutMs: validateTimeout(input.timeoutMs),
    allowCloudMailContent: input.allowCloudMailContent,
    streaming: input.streaming,
    modalities,
    ...(input.contextWindowTokens !== undefined ? { contextWindowTokens: validateContextWindow(input.contextWindowTokens) } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: validateMaxOutput(input.maxOutputTokens) } : {}),
    ...(health?.success ? { health: health.data } : {}),
  };
}

/** The connection state must never survive a change to the checked settings. */
function providerConnectionFingerprint(configuration: ProviderConfiguration): string {
  const { health: _health, ...connection } = configuration;
  return canonicalAgentJson(connection);
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new AgentServiceError("INVALID_ARGUMENT", "模型超时时间必须介于 1 秒和 120 秒之间。", 400);
  }
  return value;
}

class AgentProviderStore {
  constructor(private readonly db: DatabaseHandle, private readonly masterKey: Buffer) {}

  private decrypt(id: string, encrypted: string): unknown {
    return JSON.parse(decryptRootAgentRecord(this.masterKey, "agent-provider-config", providerConfigRecordId(id), encrypted)) as unknown;
  }

  private encrypt(id: string, configuration: ProviderConfiguration): string {
    return encryptRootAgentRecord(
      this.masterKey,
      "agent-provider-config",
      providerConfigRecordId(id),
      canonicalAgentJson(configuration),
    );
  }

  private defaultConfiguration(): DefaultProviderConfiguration {
    const row = this.db.prepare(`
      SELECT encrypted_configuration FROM agent_provider_configurations WHERE provider_id = ?
    `).get(defaultProviderRecordId) as Pick<ProviderRow, "encrypted_configuration"> | undefined;
    if (!row) return { version: providerConfigurationVersion, defaultProviderId: null };
    let value: unknown;
    try {
      value = JSON.parse(decryptRootAgentRecord(this.masterKey, "agent-provider-default", defaultProviderRecordId, row.encrypted_configuration)) as unknown;
    } catch {
      throw new AgentServiceError("INTERNAL", "默认模型配置无法读取。", 500);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentServiceError("INTERNAL", "默认模型配置格式无效。", 500);
    }
    const stored = value as Partial<DefaultProviderConfiguration>;
    if (stored.version !== providerConfigurationVersion || (stored.defaultProviderId !== null && typeof stored.defaultProviderId !== "string")) {
      throw new AgentServiceError("INTERNAL", "默认模型配置格式无效。", 500);
    }
    return { version: providerConfigurationVersion, defaultProviderId: stored.defaultProviderId };
  }

  private setDefault(providerId: string | null): void {
    const timestamp = now();
    const configuration: DefaultProviderConfiguration = { version: providerConfigurationVersion, defaultProviderId: providerId };
    const encrypted = encryptRootAgentRecord(
      this.masterKey,
      "agent-provider-default",
      defaultProviderRecordId,
      canonicalAgentJson(configuration),
    );
    this.db.prepare(`
      INSERT INTO agent_provider_configurations (provider_id, encrypted_configuration, crypto_version, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        encrypted_configuration = excluded.encrypted_configuration,
        crypto_version = excluded.crypto_version,
        updated_at = excluded.updated_at
    `).run(defaultProviderRecordId, encrypted, timestamp, timestamp);
  }

  get(id: string): ProviderConfiguration | undefined {
    const row = this.db.prepare(`
      SELECT provider_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_provider_configurations WHERE provider_id = ? AND provider_id <> ?
    `).get(id, defaultProviderRecordId) as ProviderRow | undefined;
    if (!row) return undefined;
    if (row.crypto_version !== 1) throw new AgentServiceError("INTERNAL", "模型配置版本不受支持。", 500);
    try {
      return parseProviderConfiguration(this.decrypt(row.provider_id, row.encrypted_configuration), row.provider_id);
    } catch (error) {
      if (error instanceof AgentServiceError) throw error;
      throw new AgentServiceError("INTERNAL", "模型配置无法读取。", 500);
    }
  }

  list(): AgentProviderList {
    const rows = this.db.prepare(`
      SELECT provider_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_provider_configurations
      WHERE provider_id <> ?
      ORDER BY updated_at DESC, provider_id
    `).all(defaultProviderRecordId) as ProviderRow[];
    const items = rows.map((row) => {
      if (row.crypto_version !== 1) throw new AgentServiceError("INTERNAL", "模型配置版本不受支持。", 500);
      return providerSummary(parseProviderConfiguration(this.decrypt(row.provider_id, row.encrypted_configuration), row.provider_id));
    });
    const configuredIds = new Set(items.map((item) => item.id));
    const storedDefaultId = this.defaultConfiguration().defaultProviderId;
    // Report a default only when it still exists *and* can serve chat; a stored
    // pointer at a decision-only provider would otherwise be handed to every
    // text call site as if it were usable.
    const defaultChatCapable = storedDefaultId !== null
      && items.some((item) => item.id === storedDefaultId && item.roles.includes("chat"));
    if (storedDefaultId !== null && !defaultChatCapable) {
      // Heal the stale pointer instead of only hiding it: the pointer is what
      // `save()` consults for the auto-claim, so a hidden-but-alive pointer at
      // a decision-only row would keep the default slot vacant forever. The
      // write is idempotent and runs once — afterwards the pointer is null.
      this.setDefault(null);
    }
    const defaultProviderId = defaultChatCapable ? storedDefaultId : null;
    return { items, defaultProviderId: defaultProviderId && configuredIds.has(defaultProviderId) ? defaultProviderId : null };
  }

  save(input: AgentProviderInput, id = `provider-${randomUUID()}`): AgentProviderSummary {
    const existing = this.get(id);
    const endpoint = normalizeEndpoint(input.endpoint);
    const apiKey = input.apiKey?.trim();
    const configuration: ProviderConfiguration = {
      version: providerConfigurationVersion,
      id,
      label: requiredText(input.label, "模型名称", 128),
      kind: input.kind,
      endpoint: endpoint.endpoint,
      model: requiredText(input.model, "模型标识", 256),
      ...(input.embeddingModel?.trim()
        ? { embeddingModel: input.embeddingModel.trim() }
        : input.clearApiKey
          ? {}
          : existing?.embeddingModel
            ? { embeddingModel: existing.embeddingModel }
            : {}),
      ...(apiKey ? { apiKey } : input.clearApiKey ? {} : existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      timeoutMs: validateTimeout(input.timeoutMs),
      allowCloudMailContent: endpoint.cloud && input.kind !== "ollama" && input.allowCloudMailContent,
      streaming: providerRolesForKind(input.kind).includes("chat"),
      modalities: input.modalities ?? existing?.modalities ?? { ...defaultModalities },
      ...(input.contextWindowTokens !== undefined
        ? { contextWindowTokens: validateContextWindow(input.contextWindowTokens) }
        : existing?.contextWindowTokens !== undefined
          ? { contextWindowTokens: existing.contextWindowTokens }
          : {}),
      ...(input.maxOutputTokens !== undefined
        ? { maxOutputTokens: validateMaxOutput(input.maxOutputTokens) }
        : existing?.maxOutputTokens !== undefined
          ? { maxOutputTokens: existing.maxOutputTokens }
          : {}),
    };
    const timestamp = now();
    // The default model is what every chat-shaped call site falls back to
    // (assistant, translation, polish, retrieval expansion, reply drafting), so
    // a provider that cannot generate text must never hold that slot.
    const chatCapable = providerRolesForKind(configuration.kind).includes("chat");
    if (input.makeDefault && !chatCapable) {
      throw new AgentServiceError("INVALID_ARGUMENT", "该模型类型不能设为默认模型。", 400, false);
    }
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_provider_configurations (provider_id, encrypted_configuration, crypto_version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          encrypted_configuration = excluded.encrypted_configuration,
          crypto_version = excluded.crypto_version,
          updated_at = excluded.updated_at
      `).run(id, this.encrypt(id, configuration), timestamp, timestamp);
      const currentDefault = this.defaultConfiguration().defaultProviderId;
      if (input.makeDefault || (!currentDefault && chatCapable)) this.setDefault(id);
      else if (currentDefault === id && !chatCapable) this.setDefault(null);
    })();
    return providerSummary(configuration);
  }

  saveHealth(id: string, expectedConnectionFingerprint: string, health: ProviderHealth): AgentProviderSummary {
    const current = this.get(id);
    if (!current) throw new AgentServiceError("NOT_FOUND", "模型配置不存在。", 404);
    if (providerConnectionFingerprint(current) !== expectedConnectionFingerprint) {
      throw new AgentServiceError("PROVIDER_CHANGED", "模型配置在连接检查期间已更新，请重新检查。", 409, true);
    }
    const configuration: ProviderConfiguration = { ...current, health };
    const timestamp = now();
    const changed = this.db.prepare(`
      UPDATE agent_provider_configurations
      SET encrypted_configuration = ?, crypto_version = 1, updated_at = ?
      WHERE provider_id = ? AND provider_id <> ?
    `).run(this.encrypt(id, configuration), timestamp, id, defaultProviderRecordId).changes;
    if (!changed) throw new AgentServiceError("NOT_FOUND", "模型配置不存在。", 404);
    return providerSummary(configuration);
  }

  remove(id: string): boolean {
    const result = this.db.transaction(() => {
      const removed = this.db.prepare(`
        DELETE FROM agent_provider_configurations WHERE provider_id = ? AND provider_id <> ?
      `).run(id, defaultProviderRecordId).changes > 0;
      if (removed && this.defaultConfiguration().defaultProviderId === id) this.setDefault(null);
      return removed;
    })();
    return result;
  }
}

/**
 * Provider configuration + resolution, extracted from the agent core. Owns
 * the encrypted store and knows how to build a model transport for a
 * configuration.
 */
export class AgentProviderService {
  private readonly store: AgentProviderStore;

  constructor(db: DatabaseHandle, masterKey: Buffer) {
    this.store = new AgentProviderStore(db, masterKey);
  }

  list(): AgentProviderList {
    return this.store.list();
  }

  get(id: string): ProviderConfiguration | undefined {
    return this.store.get(id);
  }

  save(input: AgentProviderInput, id = `provider-${randomUUID()}`): AgentProviderSummary {
    return this.store.save(input, id);
  }

  update(id: string, input: AgentProviderInput): AgentProviderSummary {
    if (!this.store.get(id)) throw new AgentServiceError("NOT_FOUND", "模型配置不存在。", 404);
    return this.store.save(input, id);
  }

  async check(id: string, signal?: AbortSignal): Promise<AgentProviderSummary> {
    const providerId = requiredText(id, "模型", 128);
    const configuration = this.store.get(providerId);
    if (!configuration) throw new AgentServiceError("NOT_FOUND", "模型配置不存在。", 404);
    // Adapter support is reported before the configured gate: "this build
    // cannot speak to that kind" is a different answer from "your settings are
    // incomplete", and the generic message would send the user hunting through
    // fields that are actually fine.
    const adapter = this.adapterFor(configuration);
    if (!adapter) {
      throw new AgentServiceError("NOT_SUPPORTED", "当前版本不支持该模型接入类型。", 422, false);
    }
    if (!providerSummary(configuration).configured) {
      throw new AgentServiceError("PROVIDER_AUTH_FAILED", "模型配置尚未完成。请检查地址、模型名称和 API Key。", 422, false);
    }
    const fingerprint = providerConnectionFingerprint(configuration);
    // A connection probe only needs to confirm the service answers; cap the
    // wait like the MCP check does so a dead endpoint reports back quickly
    // instead of riding out the configured (up to 2 min) request timeout.
    const health = await adapter.healthCheck({ signal, timeoutMs: Math.min(configuration.timeoutMs, 15_000) });
    if (signal?.aborted) throw new AgentServiceError("CANCELLED", "模型连接检查已取消。", 499, true);
    return this.store.saveHealth(configuration.id, fingerprint, health);
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  /**
   * The one place a configuration becomes a transport. Returns `undefined` for
   * a kind this build has no adapter for — the previous fallback handed such
   * rows to the OpenAI-compatible client, which turned an unsupported provider
   * into a stream of failed chat requests against the wrong endpoint.
   */
  adapterFor(configuration: ProviderConfiguration): LlmProvider | undefined {
    const options = {
      id: configuration.id,
      endpoint: configuration.endpoint,
      ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
      timeoutMs: configuration.timeoutMs,
    };
    if (configuration.kind === "anthropic") return new AnthropicMessagesProvider(options);
    if (configuration.kind === "gemini") return new GeminiProvider(options);
    if (configuration.kind === "openai-responses") return new OpenAiResponsesProvider(options);
    if (configuration.kind === "openai-compatible" || configuration.kind === "ollama") {
      return new OpenAiCompatibleProvider({ ...options, kind: configuration.kind });
    }
    if (configuration.kind === "system-one") return new SystemOneProvider(options);
    return undefined;
  }
}
