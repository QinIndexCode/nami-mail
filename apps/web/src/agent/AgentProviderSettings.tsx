import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  CircleHelp,
  Cloud,
  Eye,
  EyeOff,
  HardDrive,
  KeyRound,
  LoaderCircle,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, api } from "../api";
import ThemedSelect from "../ThemedSelect";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useDismissTransition } from "../hooks/useDismissTransition";
import type {
  AgentMcpServerSummary,
  AgentProviderInput,
  AgentProviderKind,
  AgentProviderList,
  AgentProviderSummary,
} from "../agentTypes";
import { useI18n } from "../i18n";
import { AgentMcpServerPane } from "./AgentMcpServerPane";

const ollamaEndpointSuggestion = "http://127.0.0.1:11434/v1";

type ProviderKindMetadata = {
  endpointSuggestion: string;
  endpointHintKey: string;
  modelPlaceholder: string;
  embeddingModelPlaceholder?: string;
};

/** Per-protocol defaults shown in the provider form (placeholders and pre-fill). */
const providerKindMetadata: Record<AgentProviderKind, ProviderKindMetadata> = {
  "openai-compatible": {
    endpointSuggestion: "",
    endpointHintKey: "agent.providers.fields.endpointHint",
    modelPlaceholder: "gpt-4.1-mini",
    embeddingModelPlaceholder: "text-embedding-3-small",
  },
  ollama: {
    endpointSuggestion: ollamaEndpointSuggestion,
    endpointHintKey: "agent.providers.fields.ollamaEndpointHint",
    modelPlaceholder: "llama3.2",
    embeddingModelPlaceholder: "nomic-embed-text",
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

export type ProviderForm = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  embeddingModel: string;
  apiKey: string;
  clearApiKey: boolean;
  timeoutMs: string;
  allowCloudMailContent: boolean;
  makeDefault: boolean;
};

export function configuredProviderId(providers: readonly AgentProviderSummary[], defaultProviderId: string | null): string {
  return providers.find((provider) => provider.id === defaultProviderId)?.id
    ?? providers.filter((provider) => provider.configured)[0]?.id
    ?? providers[0]?.id
    ?? "";
}

export function providerFormFor(provider: AgentProviderSummary | null, defaultProviderId: string | null): ProviderForm {
  if (!provider) {
    return {
      label: "",
      kind: "openai-compatible",
      endpoint: "",
      model: "",
      embeddingModel: "",
      apiKey: "",
      clearApiKey: false,
      timeoutMs: "45000",
      allowCloudMailContent: false,
      makeDefault: defaultProviderId === null,
    };
  }
  return {
    label: provider.label,
    kind: provider.kind,
    endpoint: provider.endpoint,
    model: provider.model,
    embeddingModel: provider.embeddingModel ?? "",
    apiKey: "",
    clearApiKey: false,
    timeoutMs: String(provider.timeoutMs),
    allowCloudMailContent: provider.cloudContentConsent,
    makeDefault: provider.id === defaultProviderId,
  };
}

export function providerVisualState(provider: AgentProviderSummary): "needsSetup" | "configurationComplete" | "verified" | "degraded" | "unavailable" {
  if (!provider.configured) return "needsSetup";
  if (provider.health?.state === "ready") return "verified";
  if (provider.health?.state === "degraded") return "degraded";
  if (provider.health?.state === "unavailable") return "unavailable";
  return "configurationComplete";
}

/** Which settings pane is shown inside the shared provider/MCP dialog. */
export type AgentSettingsPane = "providers" | "mcp";

export function AgentProviderSettings({
  open,
  pane,
  onPaneChange,
  initialProviders,
  initialDefaultProviderId,
  onClose,
  onProvidersChanged,
  restoreFocusRef,
}: {
  open: boolean;
  pane: AgentSettingsPane;
  onPaneChange: (pane: AgentSettingsPane) => void;
  initialProviders: AgentProviderSummary[];
  initialDefaultProviderId: string | null;
  onClose: () => void;
  onProvidersChanged: (providers: AgentProviderList) => void;
  restoreFocusRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const [providers, setProviders] = useState<AgentProviderSummary[]>(initialProviders);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(initialDefaultProviderId);
  const initialProvidersRef = useRef(initialProviders);
  const initialDefaultProviderIdRef = useRef(initialDefaultProviderId);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => providerFormFor(null, initialDefaultProviderId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const selectedProviderIdRef = useRef<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const isDefaultProvider = Boolean(selectedProvider && selectedProvider.id === defaultProviderId);
  const isOllama = form.kind === "ollama";
  // "Send selected mail to the model" is only meaningful for remote endpoints:
  // a loopback service (Ollama, LM Studio, …) never leaves the machine, so the
  // switch is locked off there regardless of kind.
  const isLocalEndpoint = useMemo(() => {
    try {
      const hostname = new URL(form.endpoint.trim()).hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    } catch {
      return false;
    }
  }, [form.endpoint]);
  // These kinds serve the OpenAI-compatible /embeddings endpoint on the same
  // origin as chat, so the optional embedding model is exposed for them.
  const embeddingCapable = form.kind === "openai-compatible" || form.kind === "ollama";
  const kindMeta = providerKindMetadata[form.kind];

  const healthFeedback = (provider: AgentProviderSummary | undefined): string => {
    const errorCode = provider?.health?.error?.code;
    if (errorCode === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
    if (errorCode === "PROVIDER_TIMEOUT") return t("agent.providers.checkError.timeout");
    if (errorCode === "PROVIDER_UNAVAILABLE") return t("agent.providers.checkError.unavailable");
    if (errorCode === "PROVIDER_RATE_LIMITED") return t("agent.providers.checkError.rateLimited");
    return t("agent.providers.checkError.failed");
  };

  const requestFeedback = (error: unknown, fallback: string): string => {
    if (error instanceof ApiError) {
      if (error.code === "PROVIDER_AUTH_FAILED") return t("agent.providers.checkError.auth");
      if (error.code === "PROVIDER_CHANGED") return t("agent.providers.checkError.changed");
      if (error.code === "local_service_unavailable") return t("agent.providers.checkError.localService");
      return error.message || fallback;
    }
    return fallback;
  };

  // The render that opens this panel carries the latest bootstrap summary.
  // Subsequent provider-list updates must not reset an in-progress form.
  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  const selectProvider = useCallback((provider: AgentProviderSummary | null, nextDefaultProviderId = defaultProviderId) => {
    setSelectedProviderId(provider?.id ?? null);
    setForm(providerFormFor(provider, nextDefaultProviderId));
    setDeletePendingId(null);
    setKeyVisible(false);
    setNotice(null);
  }, [defaultProviderId]);

  const onProvidersChangedRef = useRef(onProvidersChanged);
  onProvidersChangedRef.current = onProvidersChanged;

  const applyProviderList = useCallback((snapshot: AgentProviderList, preferredProviderId: string | null = null) => {
    setProviders(snapshot.items);
    setDefaultProviderId(snapshot.defaultProviderId);
    onProvidersChangedRef.current(snapshot);
    const selected = (preferredProviderId ? snapshot.items.find((provider) => provider.id === preferredProviderId) : undefined)
      ?? snapshot.items.find((provider) => provider.id === selectedProviderIdRef.current)
      ?? snapshot.items.find((provider) => provider.id === snapshot.defaultProviderId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedProviderId(selected?.id ?? null);
    setForm(providerFormFor(selected, snapshot.defaultProviderId));
    setDeletePendingId(null);
    setKeyVisible(false);
  }, []);

  const refreshProviders = useCallback(async (preferredProviderId: string | null = null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await api.agentProviders();
      applyProviderList(snapshot, preferredProviderId);
      return snapshot;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.providers.loadFailed"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyProviderList, t]);

  useEffect(() => {
    if (!open) return;
    setProviders(initialProvidersRef.current);
    setDefaultProviderId(initialDefaultProviderIdRef.current);
    setSelectedProviderId(null);
    setForm(providerFormFor(null, initialDefaultProviderIdRef.current));
    setLoadError(null);
    setNotice(null);
    setDeletePendingId(null);
    void refreshProviders();
  }, [open, refreshProviders]);

  const { closing, requestClose } = useDismissTransition(() => {
    onClose();
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [requestClose, open, saving]);

  useDialogFocus(open || closing, dialogRef, { restoreFocusRef });

  const updateForm = <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
    setDeletePendingId(null);
  };

  const updateKind = (kind: AgentProviderKind) => {
    setForm((current) => ({
      ...current,
      kind,
      endpoint: !current.endpoint.trim() ? providerKindMetadata[kind].endpointSuggestion : current.endpoint,
      allowCloudMailContent: kind === "ollama" ? false : current.allowCloudMailContent,
    }));
    setNotice(null);
    setDeletePendingId(null);
  };

  const validationMessage = useMemo(() => {
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
    return null;
  }, [form.endpoint, form.label, form.model, form.timeoutMs, t]);

  const saveProvider = async () => {
    if (saving || validationMessage) return;
    const timeoutMs = Number(form.timeoutMs);
    const input: AgentProviderInput = {
      label: form.label.trim(),
      kind: form.kind,
      endpoint: form.endpoint.trim(),
      model: form.model.trim(),
      ...(form.embeddingModel.trim() ? { embeddingModel: form.embeddingModel.trim() } : {}),
      timeoutMs,
      allowCloudMailContent: isOllama || isLocalEndpoint ? false : form.allowCloudMailContent,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.clearApiKey ? { clearApiKey: true } : {}),
      ...(form.makeDefault ? { makeDefault: true } : {}),
    };
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    let saved: AgentProviderSummary | undefined;
    try {
      saved = selectedProvider
        ? await api.updateAgentProvider(selectedProvider.id, input)
        : await api.createAgentProvider(input);
      setForm((current) => ({ ...current, apiKey: "", clearApiKey: false }));
      const checked = await api.checkAgentProvider(saved.id);
      await refreshProviders(saved.id);
      if (checked.health?.state === "ready") {
        setNotice(t("agent.providers.checked"));
      } else {
        setLoadError(healthFeedback(checked));
      }
    } catch (error) {
      if (saved) await refreshProviders(saved.id);
      setLoadError(requestFeedback(error, saved ? t("agent.providers.checkError.failed") : t("agent.providers.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  // Deletes a provider by id; the first call arms the two-step confirmation
  // (deletePendingId), the second actually removes it. Works both from the
  // catalog list delete button and the form's footer button.
  const deleteProviderById = async (providerId: string) => {
    const target = providers.find((provider) => provider.id === providerId);
    if (!target || saving) return;
    if (deletePendingId !== providerId) {
      setDeletePendingId(providerId);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentProvider(providerId);
      await refreshProviders();
      setNotice(t("agent.providers.deleted"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.providers.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (!open && !closing) return null;

  return (
    <div
      className={`agent-provider-settings-scrim${closing ? " closing" : ""}`}
      onMouseDown={(event) => {
        if (!saving && event.target === event.currentTarget) requestClose();
      }}
    >
      <aside ref={dialogRef} className={`agent-provider-settings${closing ? " closing" : ""}`} role="dialog" aria-modal="true" aria-label={t("agent.providers.title")} tabIndex={-1}>
        <header className="agent-provider-settings-header">
          <div><span className="eyebrow">NAMI AGENT</span><span className="agent-provider-title-line"><h2>{pane === "mcp" ? t("agent.mcpServers.title") : t("agent.providers.title")}</h2><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={pane === "mcp" ? t("agent.mcpServers.description") : t("agent.providers.description")} data-tooltip={pane === "mcp" ? t("agent.mcpServers.description") : t("agent.providers.description")}><CircleHelp size={13} /></button></span></div>
          <div className="agent-provider-settings-actions">
            <div className="agent-provider-settings-tabs" role="tablist" aria-label={t("agent.providers.settings")} data-pane={pane}>
              <span className="agent-provider-settings-thumb" aria-hidden="true" />
              <button className={`agent-provider-settings-tab${pane === "providers" ? " active" : ""}`} type="button" role="tab" aria-selected={pane === "providers"} onClick={() => onPaneChange("providers")}><KeyRound size={13} /><span>{t("agent.providers.open")}</span></button>
              <button className={`agent-provider-settings-tab${pane === "mcp" ? " active" : ""}`} type="button" role="tab" aria-selected={pane === "mcp"} onClick={() => onPaneChange("mcp")}><Server size={13} /><span>{t("agent.mcpServers.open")}</span></button>
            </div>
            <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t("agent.providers.close")} data-tooltip={t("agent.providers.close")} disabled={saving} onClick={requestClose}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-provider-settings-body">
          {pane === "providers" ? (
            <>
              <section className="agent-provider-catalog" aria-label={t("agent.providers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.providers.available")}</span><button className="agent-provider-new" type="button" disabled={saving} onClick={() => selectProvider(null)}><Plus size={15} />{t("agent.providers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.providers.loading")}</div>}
            {!loading && !providers.length && <div className="agent-provider-empty"><Bot size={18} /><strong>{t("agent.providers.empty")}</strong></div>}
            <div className="agent-provider-list">
              {providers.map((provider) => {
                const active = provider.id === selectedProviderId;
                const state = providerVisualState(provider);
                const pending = deletePendingId === provider.id;
                return (
                  <div key={provider.id} className={`agent-provider-list-row${pending ? " delete-pending" : ""}`}>
                    <button className={`agent-provider-list-item ${active ? "active" : ""}`} type="button" aria-pressed={active} disabled={saving} onClick={() => selectProvider(provider)}>
                      <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                      <span><strong>{provider.label}</strong><span className="agent-provider-list-meta">{provider.model && <em className="model" title={provider.model}>{provider.model}</em>}{provider.id === defaultProviderId && <em className="default">{t("agent.providers.status.default")}</em>}</span></span>
                      {provider.cloud ? <Cloud size={14} aria-label={t("agent.providers.status.cloud")} /> : <HardDrive size={14} aria-label={t("agent.providers.status.local")} />}
                    </button>
                    <button className={`agent-provider-list-delete${pending ? " pending" : ""}`} type="button" disabled={saving} aria-label={pending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")} data-tooltip={pending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")} onClick={() => void deleteProviderById(provider.id)}>
                      {pending ? <Check size={14} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
            <div className="agent-provider-form-heading"><h3>{selectedProvider ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}</h3>{selectedProvider && <span className={`agent-provider-form-status ${providerVisualState(selectedProvider)}`}>{providerVisualState(selectedProvider) === "verified" ? <Check size={14} /> : <CircleAlert size={14} />}{t(`agent.providers.status.${providerVisualState(selectedProvider)}`)}</span>}</div>

            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.kind")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.kindHint")} data-tooltip={t("agent.providers.fields.kindHint")}><CircleHelp size={12} /></button></span><ThemedSelect id="agent-provider-kind" value={form.kind} onValueChange={(value) => updateKind(value as AgentProviderKind)} disabled={saving} aria-label={t("agent.providers.fields.kind")}><option value="openai-compatible">{t("agent.providers.kind.openaiCompatible")}</option><option value="ollama">{t("agent.providers.kind.ollama")}</option><option value="anthropic">{t("agent.providers.kind.anthropic")}</option><option value="gemini">{t("agent.providers.kind.gemini")}</option><option value="openai-responses">{t("agent.providers.kind.openaiResponses")}</option></ThemedSelect></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.label")}</strong></span><input value={form.label} maxLength={128} disabled={saving} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.endpoint")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t(kindMeta.endpointHintKey)} data-tooltip={t(kindMeta.endpointHintKey)}><CircleHelp size={12} /></button></span><input value={form.endpoint} placeholder={kindMeta.endpointSuggestion || t("agent.providers.fields.endpointPlaceholder")} disabled={saving} onChange={(event) => updateForm("endpoint", event.target.value)} autoComplete="url" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.model")}</strong></span><input value={form.model} placeholder={kindMeta.modelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("model", event.target.value)} autoComplete="off" spellCheck={false} /></label>
{embeddingCapable && <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.embeddingModel")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.embeddingModelHint")} data-tooltip={t("agent.providers.fields.embeddingModelHint")}><CircleHelp size={12} /></button></span><input value={form.embeddingModel} placeholder={kindMeta.embeddingModelPlaceholder} maxLength={256} disabled={saving} onChange={(event) => updateForm("embeddingModel", event.target.value)} autoComplete="off" spellCheck={false} /></label>}
<label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.providers.fields.timeout")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.providers.fields.timeoutHint")} data-tooltip={t("agent.providers.fields.timeoutHint")}><CircleHelp size={12} /></button></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={saving} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.providers.fields.apiKey")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")} data-tooltip={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}><CircleHelp size={12} /></button></span><div className="agent-provider-secret"><input type={keyVisible ? "text" : "password"} value={form.apiKey} disabled={saving || form.clearApiKey} onChange={(event) => updateForm("apiKey", event.target.value)} placeholder={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyKeep") : t("agent.providers.fields.apiKeyPlaceholder")} autoComplete="new-password" spellCheck={false} /><button className="icon-button" type="button" disabled={saving || form.clearApiKey} aria-label={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} data-tooltip={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} onClick={() => setKeyVisible((visible) => !visible)}>{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{selectedProvider?.apiKeyConfigured && <button className={`agent-provider-inline-toggle ${form.clearApiKey ? "active" : ""}`} type="button" role="switch" aria-checked={form.clearApiKey} disabled={saving || Boolean(form.apiKey)} onClick={() => updateForm("clearApiKey", !form.clearApiKey)}><span aria-hidden="true" /><span>{t("agent.providers.fields.clearApiKey")}</span></button>}</div>
            <button className={`agent-provider-toggle-row ${form.allowCloudMailContent ? "active" : ""}`} type="button" role="switch" aria-checked={form.allowCloudMailContent} disabled={saving || isOllama || isLocalEndpoint} onClick={() => updateForm("allowCloudMailContent", !form.allowCloudMailContent)}><span><strong>{t("agent.providers.cloud.title")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={isOllama || isLocalEndpoint ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")} data-tooltip={isOllama || isLocalEndpoint ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>
            <button className={`agent-provider-toggle-row ${form.makeDefault ? "active" : ""}`} type="button" role="switch" aria-checked={form.makeDefault} disabled={saving || isDefaultProvider} onClick={() => updateForm("makeDefault", !form.makeDefault)}><span><strong>{t("agent.providers.default.title")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")} data-tooltip={isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={saving} onClick={() => void refreshProviders(selectedProviderId)}>{t("agent.providers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}
            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions"><button className="primary-button" type="submit" disabled={saving || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{saving ? t("agent.providers.savingAndChecking") : t("agent.providers.save")}</button>{selectedProvider && <button className={`secondary-button danger-button ${deletePendingId === selectedProvider.id ? "agent-provider-delete-pending" : ""}`} type="button" disabled={saving} onClick={() => void deleteProviderById(selectedProvider.id)}><Trash2 size={15} />{deletePendingId === selectedProvider.id ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")}</button>}</div>
            {deletePendingId !== null && <p className="agent-provider-delete-note">{t("agent.providers.deletePrompt")}</p>}
          </form>
            </>
          ) : (
            <AgentMcpServerPane active={open} />
          )}
        </div>
      </aside>
    </div>
  );
}
