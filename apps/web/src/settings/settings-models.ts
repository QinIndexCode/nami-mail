import { ApiError } from "../api";
import type {
  AgentMcpServerInput,
  AgentMcpServerSummary,
  AgentProviderInput,
  AgentProviderKind,
  AgentProviderList,
  AgentProviderSummary,
} from "../agentTypes";
import type { Translate } from "../i18n";
import { OLLAMA_DEFAULT_ENDPOINT } from "../agent/agent-utils";

/**
 * Pure form/validation/feedback logic for the settings "models" panel. It holds
 * no React state so the same rules can back both the rendered rows and unit
 * tests; the panel itself lives in SettingsModelsSection.
 */

type ProviderKindMetadata = {
  endpointSuggestion: string;
  endpointHintKey: string;
  modelPlaceholder: string;
};

/** Per-protocol defaults shown in the provider form (placeholders and pre-fill). */
export const providerKindMetadata: Record<AgentProviderKind, ProviderKindMetadata> = {
  "openai-compatible": {
    endpointSuggestion: "",
    endpointHintKey: "agent.providers.fields.endpointHint",
    modelPlaceholder: "gpt-4.1-mini",
  },
  ollama: {
    endpointSuggestion: OLLAMA_DEFAULT_ENDPOINT,
    endpointHintKey: "agent.providers.fields.ollamaEndpointHint",
    modelPlaceholder: "llama3.2",
  },
  anthropic: {
    endpointSuggestion: "https://api.anthropic.com",
    endpointHintKey: "agent.providers.fields.endpointHintAnthropic",
    modelPlaceholder: "claude-sonnet-4-5",
  },
  gemini: {
    endpointSuggestion: "https://generativelanguage.googleapis.com/v1beta",
    endpointHintKey: "agent.providers.fields.endpointHintGemini",
    modelPlaceholder: "gemini-2.5-flash",
  },
  "openai-responses": {
    endpointSuggestion: "https://api.openai.com/v1",
    endpointHintKey: "agent.providers.fields.endpointHintOpenAiResponses",
    modelPlaceholder: "gpt-4.1",
  },
};

/**
 * One outcome line for the panel. `retry` repeats the operation that produced
 * it (a save, a connection check, a delete) rather than refetching a list the
 * user never asked for — a "retry" that only reloads the same rows reads as a
 * button that does nothing.
 */
export type ModelFeedback = {
  kind: "error" | "success";
  message: string;
  retry: (() => Promise<void>) | null;
};

export type ProviderForm = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  timeoutMs: string;
  allowCloudMailContent: boolean;
  makeDefault: boolean;
  contextWindowTokens: string;
  maxOutputTokens: string;
};

export function providerFormFor(provider: AgentProviderSummary | null, defaultProviderId: string | null): ProviderForm {
  if (!provider) {
    return {
      label: "",
      kind: "openai-compatible",
      endpoint: "",
      model: "",
      apiKey: "",
      clearApiKey: false,
      timeoutMs: "45000",
      allowCloudMailContent: false,
      makeDefault: defaultProviderId === null,
      contextWindowTokens: "8192",
      maxOutputTokens: "2048",
    };
  }
  return {
    label: provider.label,
    kind: provider.kind,
    endpoint: provider.endpoint,
    model: provider.model,
    apiKey: "",
    clearApiKey: false,
    timeoutMs: String(provider.timeoutMs),
    allowCloudMailContent: provider.cloudContentConsent,
    makeDefault: provider.id === defaultProviderId,
    contextWindowTokens: String(provider.contextWindowTokens ?? 8192),
    maxOutputTokens: String(provider.maxOutputTokens ?? 2048),
  };
}

export type ProviderVisualState = "needsSetup" | "configurationComplete" | "verified" | "degraded" | "unavailable";

export function providerVisualState(provider: AgentProviderSummary): ProviderVisualState {
  if (!provider.configured) return "needsSetup";
  if (provider.health?.state === "ready") return "verified";
  if (provider.health?.state === "degraded") return "degraded";
  if (provider.health?.state === "unavailable") return "unavailable";
  return "configurationComplete";
}

/** Loopback endpoints never leave the machine, so cloud-mail consent is moot there. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint.trim()).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function providerFormIsLocal(form: ProviderForm): boolean {
  return form.kind === "ollama" || isLoopbackEndpoint(form.endpoint);
}

export function providerValidationMessage(form: ProviderForm, t: Translate): string | null {
  if (!form.label.trim()) return t("agent.providers.validation.label");
  if (!form.endpoint.trim()) return t("agent.providers.validation.endpoint");
  try {
    const endpoint = new URL(form.endpoint.trim());
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return t("agent.providers.validation.endpoint");
  } catch {
    return t("agent.providers.validation.endpoint");
  }
  if (!form.model.trim()) return t("agent.providers.validation.model");
  const timeoutMs = Number(form.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) return t("agent.providers.validation.timeout");
  if (form.contextWindowTokens.trim()) {
    const ctx = Number(form.contextWindowTokens);
    if (!Number.isInteger(ctx) || ctx < 1_000 || ctx > 2_000_000) return t("agent.providers.validation.contextWindow");
  }
  if (form.maxOutputTokens.trim()) {
    const out = Number(form.maxOutputTokens);
    if (!Number.isInteger(out) || out < 256 || out > 64_000) return t("agent.providers.validation.maxOutput");
  }
  return null;
}

/** The write-only key is omitted unless typed, so saving never clears a stored one by accident. */
export function providerInputFor(form: ProviderForm): AgentProviderInput {
  return {
    label: form.label.trim(),
    kind: form.kind,
    endpoint: form.endpoint.trim(),
    model: form.model.trim(),
    timeoutMs: Number(form.timeoutMs),
    allowCloudMailContent: providerFormIsLocal(form) ? false : form.allowCloudMailContent,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    ...(form.clearApiKey ? { clearApiKey: true } : {}),
    ...(form.makeDefault ? { makeDefault: true } : {}),
    ...(form.contextWindowTokens.trim() && Number(form.contextWindowTokens) > 0
      ? { contextWindowTokens: Number(form.contextWindowTokens) }
      : {}),
    ...(form.maxOutputTokens.trim() && Number(form.maxOutputTokens) > 0
      ? { maxOutputTokens: Number(form.maxOutputTokens) }
      : {}),
  };
}

export function providerHealthFeedback(provider: AgentProviderSummary | undefined, t: Translate): string {
  const errorCode = provider?.health?.error?.code;
  if (errorCode === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
  if (errorCode === "PROVIDER_TIMEOUT") return t("agent.providers.checkError.timeout");
  if (errorCode === "PROVIDER_UNAVAILABLE") return t("agent.providers.checkError.unavailable");
  if (errorCode === "PROVIDER_RATE_LIMITED") return t("agent.providers.checkError.rateLimited");
  return t("agent.providers.checkError.failed");
}

export function providerRequestFeedback(error: unknown, fallback: string, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
    if (error.code === "PROVIDER_CHANGED") return t("agent.providers.checkError.changed");
    if (error.code === "local_service_unavailable" || error.code === "local_service_timeout") return t("agent.providers.checkError.localService");
    return error.message || fallback;
  }
  return fallback;
}

/**
 * The list to publish when a save succeeded but the post-save refresh did not.
 * The saved summary is authoritative about its own row and the rows already on
 * screen are the rest, so the world outside this panel — the default model, the
 * agent model picker, the AI-translation switch — stops depending on a list
 * request that may never arrive. `makeDefault` mirrors what the save actually
 * asked the server for, so the published default matches the request rather
 * than guessing from the snapshot.
 */
export function providerListAfterSave(
  current: readonly AgentProviderSummary[],
  previousDefaultProviderId: string | null,
  saved: AgentProviderSummary,
  { isNew, makeDefault }: { isNew: boolean; makeDefault: boolean },
): AgentProviderList {
  const items = isNew
    ? [...current.filter((provider) => provider.id !== saved.id), saved]
    : current.map((provider) => (provider.id === saved.id ? saved : provider));
  const keepsPreviousDefault = previousDefaultProviderId !== null
    && items.some((provider) => provider.id === previousDefaultProviderId);
  return {
    items,
    defaultProviderId: makeDefault ? saved.id : keepsPreviousDefault ? previousDefaultProviderId : null,
  };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServerForm = {
  label: string;
  command: string;
  argsText: string;
  cwd: string;
  timeoutMs: string;
  enabled: boolean;
};

/**
 * One environment row. `id` is identity, not content: a React key derived from
 * `key`/`value` changes on every keystroke, which unmounts the <input> mid-edit
 * and drops the caret after the first character typed. Rows are stored and
 * serialized in array order, so the id never affects the saved payload.
 */
export type EnvRow = { id: string; key: string; value: string };

let envRowSequence = 0;

/** Stable row identity; only needs to be unique among the rows on screen. */
export function nextEnvRowId(): string {
  envRowSequence += 1;
  return `env-row-${envRowSequence}`;
}

export function mcpServerFormFor(server: AgentMcpServerSummary | null): McpServerForm {
  if (!server) return { label: "", command: "", argsText: "", cwd: "", timeoutMs: "30000", enabled: true };
  return {
    label: server.label,
    command: server.command,
    argsText: server.args.join("\n"),
    cwd: server.cwd ?? "",
    timeoutMs: String(server.timeoutMs),
    enabled: server.enabled,
  };
}

export function mcpEnvRowsFor(server: AgentMcpServerSummary | null): EnvRow[] {
  const rows: EnvRow[] = server ? server.envKeys.map((key) => ({ id: nextEnvRowId(), key, value: "" })) : [];
  rows.push({ id: nextEnvRowId(), key: "", value: "" });
  return rows;
}

export function parseArgsText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export type McpVisualState = "checked" | "failed" | "enabled" | "disabled";

export function mcpServerVisualState(server: AgentMcpServerSummary): McpVisualState {
  if (!server.enabled) return "disabled";
  if (server.lastError) return "failed";
  if (server.toolCount !== undefined) return "checked";
  return "enabled";
}

const MCP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function mcpValidationMessage(form: McpServerForm, envRows: readonly EnvRow[], t: Translate): string | null {
  if (!form.label.trim()) return t("agent.mcpServers.validation.label");
  if (!form.command.trim()) return t("agent.mcpServers.validation.command");
  if (parseArgsText(form.argsText).some((arg) => arg.length > 1_024)) return t("agent.mcpServers.validation.args");
  for (const row of envRows) {
    const key = row.key.trim();
    if (!key) continue;
    if (key.length > 256 || !MCP_ENV_KEY_PATTERN.test(key) || row.value.length > 8_192) return t("agent.mcpServers.validation.env");
  }
  if (form.cwd.length > 2_048) return t("agent.mcpServers.validation.cwd");
  const timeoutMs = Number(form.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) return t("agent.mcpServers.validation.timeout");
  return null;
}

/**
 * Env values are write-only: a blank value keeps the stored secret, and keys the
 * user deleted from the form are listed in `envRemove`.
 */
export function mcpServerInputFor(
  form: McpServerForm,
  envRows: readonly EnvRow[],
  existingEnvKeys: readonly string[] = [],
): AgentMcpServerInput {
  const existing = new Set(existingEnvKeys);
  const env: Record<string, string> = {};
  const envRemove: string[] = [];
  const seenKeys = new Set<string>();
  for (const row of envRows) {
    const key = row.key.trim();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (row.value.trim()) env[key] = row.value.trim();
  }
  for (const key of existing) {
    if (!seenKeys.has(key)) envRemove.push(key);
  }
  return {
    label: form.label.trim(),
    command: form.command.trim(),
    args: parseArgsText(form.argsText),
    env,
    ...(envRemove.length ? { envRemove } : {}),
    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    timeoutMs: Number(form.timeoutMs),
    enabled: form.enabled,
  };
}

export function mcpCheckFeedback(server: AgentMcpServerSummary, t: Translate): string {
  switch (server.lastError?.code) {
    case "CONNECT_TIMEOUT":
    case "TIMEOUT":
      return t("agent.mcpServers.checkError.timeout");
    case "PROTOCOL_ERROR":
      return t("agent.mcpServers.checkError.protocol");
    case "CONNECTION_FAILED":
    case "CLOSED":
    case "NOT_CONNECTED":
      return t("agent.mcpServers.checkError.unavailable");
    default:
      return t("agent.mcpServers.checkError.failed");
  }
}

export function mcpRequestFeedback(error: unknown, fallback: string, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.code === "SERVER_CHANGED") return t("agent.mcpServers.checkError.changed");
    if (error.code === "local_service_unavailable" || error.code === "local_service_timeout") return t("agent.mcpServers.checkError.localService");
    return error.message || fallback;
  }
  return fallback;
}