import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "../db.js";
import { canonicalAgentJson, decryptRootAgentRecord, encryptRootAgentRecord } from "./store-crypto.js";

/**
 * Encrypted root-level MCP server configuration store. The command may be a
 * local binary and the env map frequently carries API keys, so the whole
 * configuration is encrypted with the device master key (mirroring
 * AgentProviderStore). Env values are write-only: summaries expose key names
 * only, and updates merge explicit value changes instead of round-tripping
 * stored secrets.
 */

export const mcpServerConfigurationVersion = 1;
export const mcpServerRecordType = "agent-mcp-server-config";

const maxLabelLength = 128;
const maxCommandLength = 1_024;
const maxArgsCount = 128;
const maxArgLength = 1_024;
const maxEnvKeys = 128;
const maxEnvKeyLength = 256;
const maxEnvValueLength = 8_192;
const maxCwdLength = 2_048;
const maxTimeoutMs = 180_000;
const minTimeoutMs = 5_000;
const maxToolNamesStored = 200;

export type AgentMcpServerCheck = {
  ok: boolean;
  toolCount?: number;
  toolNames: string[];
  serverInfo?: { name: string; version: string };
  checkedAt: string;
  error?: { code: string; message: string; retryable: boolean };
};

export type AgentMcpServerConfiguration = {
  version: typeof mcpServerConfigurationVersion;
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
  enabled: boolean;
  checked?: AgentMcpServerCheck;
};

export type AgentMcpServerInput = {
  label: string;
  command: string;
  args?: string[];
  /** Complete set of env values to set (add or update). Undefined keeps existing keys. */
  env?: Record<string, string>;
  /** Keys to delete from the stored env map. */
  envRemove?: string[];
  cwd?: string;
  timeoutMs: number;
  enabled: boolean;
};

export type AgentMcpServerSummary = {
  id: string;
  label: string;
  command: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  timeoutMs: number;
  enabled: boolean;
  toolCount?: number;
  toolNames: string[];
  serverInfo?: { name: string; version: string };
  lastCheckedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};

export class AgentMcpServerStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentMcpServerStoreError";
  }
}

type McpServerRow = {
  server_id: string;
  encrypted_configuration: string;
  crypto_version: number;
  created_at: string;
  updated_at: string;
};

function requiredText(value: string | undefined, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `${name}不能为空。`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `${name}长度超过限制（最多 ${max} 字符）。`);
  }
  return trimmed;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < minTimeoutMs || timeoutMs > maxTimeoutMs) {
    throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `连接超时时间必须介于 ${minTimeoutMs / 1000} 秒和 ${maxTimeoutMs / 1000} 秒之间。`);
  }
  return timeoutMs;
}

function validateEnv(env: Record<string, string>, envRemove: string[]): { env: Record<string, string>; keys: string[] } {
  const merged: Record<string, string> = {};
  const remove = new Set(envRemove);
  for (const [key, value] of Object.entries(env)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || trimmedKey.length > maxEnvKeyLength) {
      throw new AgentMcpServerStoreError("INVALID_ARGUMENT", "环境变量名无效。");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `环境变量名 ${trimmedKey} 无效（仅允许字母、数字和下划线，且不能以数字开头）。`);
    }
    if (typeof value !== "string" || value.length > maxEnvValueLength) {
      throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `环境变量 ${trimmedKey} 的值无效。`);
    }
    merged[trimmedKey] = value;
  }
  for (const key of remove) {
    if (typeof key !== "string" || !key.trim() || key.trim().length > maxEnvKeyLength) continue;
    delete merged[key.trim()];
  }
  const keys = Object.keys(merged);
  if (keys.length > maxEnvKeys) {
    throw new AgentMcpServerStoreError("INVALID_ARGUMENT", `环境变量数量超过限制（最多 ${maxEnvKeys} 个）。`);
  }
  return { env: merged, keys };
}

function validateArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length > maxArgsCount) {
    throw new AgentMcpServerStoreError("INVALID_ARGUMENT", "启动参数无效。");
  }
  return args.map((arg) => {
    if (typeof arg !== "string" || arg.length > maxArgLength) {
      throw new AgentMcpServerStoreError("INVALID_ARGUMENT", "启动参数无效。");
    }
    return arg;
  });
}

function configurationFingerprint(configuration: AgentMcpServerConfiguration): string {
  return canonicalAgentJson({
    label: configuration.label,
    command: configuration.command,
    args: configuration.args,
    env: configuration.env,
    ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
    timeoutMs: configuration.timeoutMs,
    enabled: configuration.enabled,
  });
}

function summary(configuration: AgentMcpServerConfiguration, createdAt: string, updatedAt: string): AgentMcpServerSummary {
  const checked = configuration.checked;
  return {
    id: configuration.id,
    label: configuration.label,
    command: configuration.command,
    args: [...configuration.args],
    envKeys: Object.keys(configuration.env),
    ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
    timeoutMs: configuration.timeoutMs,
    enabled: configuration.enabled,
    toolCount: checked?.ok ? checked.toolCount : undefined,
    toolNames: checked?.ok ? [...checked.toolNames] : [],
    ...(checked?.ok && checked.serverInfo ? { serverInfo: checked.serverInfo } : {}),
    lastCheckedAt: checked?.checkedAt,
    ...(!checked?.ok && checked?.error ? { lastError: checked.error } : {}),
    createdAt,
    updatedAt,
  };
}

function parseConfiguration(value: unknown, id: string): AgentMcpServerConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置格式无效。", 500);
  }
  const stored = value as Partial<AgentMcpServerConfiguration>;
  if (
    stored.version !== mcpServerConfigurationVersion
    || stored.id !== id
    || typeof stored.label !== "string"
    || typeof stored.command !== "string"
    || !Array.isArray(stored.args)
    || !stored.args.every((arg) => typeof arg === "string")
    || typeof stored.timeoutMs !== "number"
    || typeof stored.enabled !== "boolean"
  ) {
    throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置格式无效。", 500);
  }
  const env: Record<string, string> = {};
  if (stored.env && typeof stored.env === "object" && !Array.isArray(stored.env)) {
    for (const [key, entry] of Object.entries(stored.env)) {
      if (typeof entry !== "string") throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置格式无效。", 500);
      env[key] = entry;
    }
  }
  const configuration: AgentMcpServerConfiguration = {
    version: mcpServerConfigurationVersion,
    id,
    label: stored.label,
    command: stored.command,
    args: [...stored.args],
    env,
    ...(typeof stored.cwd === "string" && stored.cwd ? { cwd: stored.cwd } : {}),
    timeoutMs: stored.timeoutMs,
    enabled: stored.enabled,
    ...(stored.checked ? { checked: stored.checked } : {}),
  };
  return configuration;
}

export class AgentMcpServerStore {
  constructor(private readonly db: DatabaseHandle, private readonly masterKey: Buffer) {}

  private decrypt(id: string, encrypted: string): AgentMcpServerConfiguration {
    let value: unknown;
    try {
      value = JSON.parse(decryptRootAgentRecord(this.masterKey, mcpServerRecordType, id, encrypted)) as unknown;
    } catch {
      throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置无法读取。", 500);
    }
    return parseConfiguration(value, id);
  }

  private encrypt(configuration: AgentMcpServerConfiguration): string {
    return encryptRootAgentRecord(
      this.masterKey,
      mcpServerRecordType,
      configuration.id,
      canonicalAgentJson(configuration),
    );
  }

  get(id: string): AgentMcpServerConfiguration | undefined {
    const row = this.db.prepare(`
      SELECT server_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_mcp_servers WHERE server_id = ?
    `).get(id) as McpServerRow | undefined;
    if (!row) return undefined;
    if (row.crypto_version !== 1) throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置版本不受支持。", 500);
    return this.decrypt(row.server_id, row.encrypted_configuration);
  }

  list(): AgentMcpServerSummary[] {
    const rows = this.db.prepare(`
      SELECT server_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_mcp_servers
      ORDER BY updated_at DESC, server_id
    `).all() as McpServerRow[];
    return rows.map((row) => {
      if (row.crypto_version !== 1) throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置版本不受支持。", 500);
      return summary(this.decrypt(row.server_id, row.encrypted_configuration), row.created_at, row.updated_at);
    });
  }

  /** Full decrypted configurations (including env values) for lifecycle wiring. */
  listAll(): AgentMcpServerConfiguration[] {
    const rows = this.db.prepare(`
      SELECT server_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_mcp_servers
      ORDER BY updated_at DESC, server_id
    `).all() as McpServerRow[];
    return rows.map((row) => {
      if (row.crypto_version !== 1) throw new AgentMcpServerStoreError("INTERNAL", "MCP 服务器配置版本不受支持。", 500);
      return this.decrypt(row.server_id, row.encrypted_configuration);
    });
  }

  save(input: AgentMcpServerInput, id = `mcp-server-${randomUUID()}`): AgentMcpServerSummary {
    const existing = this.get(id);
    const label = requiredText(input.label, "服务器名称", maxLabelLength);
    const command = requiredText(input.command, "启动命令", maxCommandLength);
    const args = validateArgs(input.args ?? []);
    // Env values are write-only (summaries expose key names only), so an
    // update must merge with the stored map: input env replaces or updates
    // matching keys, envRemove deletes keys, and untouched keys keep their
    // stored values. A label-only edit must not silently wipe secrets.
    const envResult = validateEnv({ ...(existing?.env ?? {}), ...(input.env ?? {}) }, input.envRemove ?? []);
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined;
    if (cwd && cwd.length > maxCwdLength) {
      throw new AgentMcpServerStoreError("INVALID_ARGUMENT", "工作目录长度超过限制。");
    }
    const configuration: AgentMcpServerConfiguration = {
      version: mcpServerConfigurationVersion,
      id,
      label,
      command,
      args,
      env: envResult.env,
      ...(cwd ? { cwd } : {}),
      timeoutMs: validateTimeout(input.timeoutMs),
      enabled: Boolean(input.enabled),
      ...(existing?.checked ? { checked: existing.checked } : {}),
    };
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO agent_mcp_servers (server_id, encrypted_configuration, crypto_version, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        encrypted_configuration = excluded.encrypted_configuration,
        crypto_version = excluded.crypto_version,
        updated_at = excluded.updated_at
    `).run(id, this.encrypt(configuration), timestamp, timestamp);
    return summary(configuration, timestamp, timestamp);
  }

  saveCheck(id: string, expectedFingerprint: string, check: AgentMcpServerCheck): AgentMcpServerSummary {
    const row = this.db.prepare(`
      SELECT server_id, encrypted_configuration, crypto_version, created_at, updated_at
      FROM agent_mcp_servers WHERE server_id = ?
    `).get(id) as McpServerRow | undefined;
    if (!row) throw new AgentMcpServerStoreError("NOT_FOUND", "MCP 服务器配置不存在。", 404);
    const configuration = this.decrypt(id, row.encrypted_configuration);
    if (configurationFingerprint(configuration) !== expectedFingerprint) {
      throw new AgentMcpServerStoreError("SERVER_CHANGED", "MCP 服务器配置在连接检查期间已更新，请重新检查。", 409, true);
    }
    const updated: AgentMcpServerConfiguration = { ...configuration, checked: check };
    const timestamp = now();
    this.db.prepare(`
      UPDATE agent_mcp_servers
      SET encrypted_configuration = ?, crypto_version = 1, updated_at = ?
      WHERE server_id = ?
    `).run(this.encrypt(updated), timestamp, id);
    return summary(updated, row.created_at, timestamp);
  }

  remove(id: string): boolean {
    return this.db.prepare(`
      DELETE FROM agent_mcp_servers WHERE server_id = ?
    `).run(id).changes > 0;
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Stable identity used for the optimistic-concurrency check of connection tests. */
export { configurationFingerprint, maxToolNamesStored };
