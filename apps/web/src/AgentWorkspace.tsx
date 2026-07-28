import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Bot,
  Check,
  CheckCheck,
  ChevronLeft,
  Cloud,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderSearch,
  KeyRound,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  SendHorizontal,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { ApiError, api } from "./api";
import { AgentMarkdown } from "./AgentMarkdown";
import { desktopBridge } from "./desktop";
import type {
  AgentBootstrap,
  AgentCitation,
  AgentConfirmation,
  AgentConversation,
  AgentConversationScope,
  AgentMessage,
  AgentProviderInput,
  AgentProviderKind,
  AgentProviderList,
  AgentProviderSummary,
  AgentScopeMode,
  AgentStreamEvent,
  AgentToolActivity,
} from "./agentTypes";
import { agentScopeFor, sameAgentScope } from "./agentContext";
import ThemedSelect from "./ThemedSelect";
import type { Account, Message } from "./types";
import { useI18n } from "./i18n";
import { useDialogFocus } from "./useDialogFocus";

type AgentWorkspaceProps = {
  accounts: Account[];
  messages: Message[];
  currentMessage?: Message;
  onClose: () => void;
  onOpenMessage: (messageId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  demoMode?: boolean;
  providerSettingsRequestId?: number;
};

type AgentMode = "agent" | "chat";

function newLocalId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function currentTime(): string {
  return new Date().toISOString();
}

function shortDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" }).format(date);
}

function sourceLabel(citation: AgentCitation): string {
  return citation.sender ? `${citation.sender} · ${citation.subject}` : citation.subject;
}

function messageWithEvent(message: AgentMessage, event: AgentStreamEvent): AgentMessage {
  switch (event.type) {
    case "text_delta":
      return { ...message, content: `${message.content}${event.delta}` };
    case "citation":
      return { ...message, citations: [...message.citations, event.citation] };
    case "tool": {
      const previous = message.toolActivities.filter((activity) => activity.id !== event.activity.id);
      return { ...message, toolActivities: [...previous, event.activity] };
    }
    case "confirmation":
      return { ...message, confirmation: event.confirmation, toolActivities: message.toolActivities.map((activity) => activity.state === "awaiting_confirmation" ? activity : activity) };
    case "error":
      return { ...message, state: "error", error: event.error };
    case "completed":
      return { ...message, state: event.reason === "error" ? "error" : "complete" };
    default:
      return message;
  }
}

const toolLabelKeys: Readonly<Record<string, string>> = {
  "rag.search": "agent.tool.ragSearch",
  "accounts.list": "agent.tool.accountsList",
  "folders.list": "agent.tool.foldersList",
  "messages.list": "agent.tool.messagesList",
  "messages.get": "agent.tool.messageGet",
  "threads.get": "agent.tool.threadGet",
  "attachments.list": "agent.tool.attachmentsList",
  "mail.draft.create": "agent.tool.draftCreate",
  "mail.draft.update": "agent.tool.draftUpdate",
  "mail.draft.delete": "agent.tool.draftDelete",
};

function AgentToolCard({ activity }: { activity: AgentToolActivity }) {
  const { t } = useI18n();
  const icon = activity.state === "failed" ? <CircleAlert size={15} /> : activity.state === "completed" ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />;
  const title = toolLabelKeys[activity.toolName] ? t(toolLabelKeys[activity.toolName]) : activity.title;
  const summary = activity.state === "failed"
    ? activity.error?.message ?? activity.summary ?? t("agent.tool.failed")
    : activity.state === "completed"
      ? t("agent.tool.completed")
      : activity.state === "awaiting_confirmation"
        ? t("agent.confirmation.waiting")
        : t("agent.tool.running");
  return (
    <div className={`agent-tool-card ${activity.state}`}>
      <span className="agent-tool-icon" aria-hidden="true">{icon}</span>
      <span className="agent-tool-copy"><strong>{title}</strong><small>{summary}</small></span>
      {activity.state === "awaiting_confirmation" && <span className="agent-tool-waiting">{t("agent.confirmation.waiting")}</span>}
    </div>
  );
}

function AgentConfirmationCard({
  confirmation,
  desktopConfirmationAvailable,
  resolutionError,
}: {
  confirmation: AgentConfirmation;
  desktopConfirmationAvailable: boolean;
  resolutionError?: string;
}) {
  const { locale, t } = useI18n();
  const statusText = confirmation.state === "approved"
    ? t("agent.confirmation.approved")
    : confirmation.state === "expired"
      ? t("agent.confirmation.expired")
      : t("agent.confirmation.rejected");
  return (
    <section
      className="agent-confirmation-card"
      aria-label={confirmation.title}
      data-nami-agent-confirmation-card
      data-nami-agent-confirmation-id={confirmation.id}
    >
      <div className="agent-confirmation-heading"><ShieldAlert size={17} /><span><strong>{confirmation.title}</strong><small>{confirmation.summary}</small></span></div>
      <dl>
        {confirmation.fields.map((field) => <div key={`${field.label}:${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      </dl>
      {confirmation.state === "pending" ? (
        <div className="agent-confirmation-actions">
          <button className="secondary-button" type="button" disabled={!desktopConfirmationAvailable} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="reject">{t("agent.confirmation.reject")}</button>
          <button className="primary-button" type="button" disabled={!desktopConfirmationAvailable} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="approve"><CheckCheck size={15} />{t("agent.confirmation.approve")}</button>
        </div>
      ) : <small className="agent-confirmation-status">{statusText}</small>}
      {confirmation.state === "pending" && resolutionError && <div className="agent-message-error" role="alert"><CircleAlert size={15} /><span>{resolutionError}</span></div>}
      <small className="agent-confirmation-expiry">{t("agent.confirmation.expires", { time: shortDate(confirmation.expiresAt, locale) })}</small>
    </section>
  );
}

const ollamaEndpointSuggestion = "http://127.0.0.1:11434/v1";

type ProviderForm = {
  label: string;
  kind: AgentProviderKind;
  endpoint: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  timeoutMs: string;
  allowCloudMailContent: boolean;
  makeDefault: boolean;
};

function configuredProviderId(providers: readonly AgentProviderSummary[], defaultProviderId: string | null): string {
  const configured = providers.filter((provider) => provider.configured);
  return configured.find((provider) => provider.id === defaultProviderId)?.id ?? configured[0]?.id ?? "";
}

function providerFormFor(provider: AgentProviderSummary | null, defaultProviderId: string | null): ProviderForm {
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
  };
}

function providerVisualState(provider: AgentProviderSummary): "needsSetup" | "configurationComplete" | "verified" | "degraded" | "unavailable" {
  if (!provider.configured) return "needsSetup";
  if (provider.health?.state === "ready") return "verified";
  if (provider.health?.state === "degraded") return "degraded";
  if (provider.health?.state === "unavailable") return "unavailable";
  return "configurationComplete";
}

function AgentProviderSettings({
  open,
  initialProviders,
  initialDefaultProviderId,
  onClose,
  onProvidersChanged,
  restoreFocusRef,
}: {
  open: boolean;
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
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => providerFormFor(null, initialDefaultProviderId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const selectedProviderIdRef = useRef<string | null>(null);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const isDefaultProvider = Boolean(selectedProvider && selectedProvider.id === defaultProviderId);
  const isOllama = form.kind === "ollama";

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
    setDeletePending(false);
    setKeyVisible(false);
    setNotice(null);
  }, [defaultProviderId]);

  const applyProviderList = useCallback((snapshot: AgentProviderList, preferredProviderId: string | null = null) => {
    setProviders(snapshot.items);
    setDefaultProviderId(snapshot.defaultProviderId);
    onProvidersChanged(snapshot);
    const selected = (preferredProviderId ? snapshot.items.find((provider) => provider.id === preferredProviderId) : undefined)
      ?? snapshot.items.find((provider) => provider.id === selectedProviderIdRef.current)
      ?? snapshot.items.find((provider) => provider.id === snapshot.defaultProviderId)
      ?? snapshot.items[0]
      ?? null;
    setSelectedProviderId(selected?.id ?? null);
    setForm(providerFormFor(selected, snapshot.defaultProviderId));
    setDeletePending(false);
    setKeyVisible(false);
  }, [onProvidersChanged]);

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
    setProviders(initialProviders);
    setDefaultProviderId(initialDefaultProviderId);
    setSelectedProviderId(null);
    setForm(providerFormFor(null, initialDefaultProviderId));
    setLoadError(null);
    setNotice(null);
    setDeletePending(false);
    void refreshProviders();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose, open, saving]);

  useDialogFocus(open, dialogRef, { restoreFocusRef });

  const updateForm = <Key extends keyof ProviderForm>(key: Key, value: ProviderForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
    setDeletePending(false);
  };

  const updateKind = (kind: AgentProviderKind) => {
    setForm((current) => ({
      ...current,
      kind,
      endpoint: kind === "ollama" && !current.endpoint.trim() ? ollamaEndpointSuggestion : current.endpoint,
      allowCloudMailContent: kind === "ollama" ? false : current.allowCloudMailContent,
    }));
    setNotice(null);
    setDeletePending(false);
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
      timeoutMs,
      allowCloudMailContent: isOllama ? false : form.allowCloudMailContent,
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

  const deleteProvider = async () => {
    if (!selectedProvider || saving) return;
    if (!deletePending) {
      setDeletePending(true);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentProvider(selectedProvider.id);
      await refreshProviders();
      setNotice(t("agent.providers.deleted"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.providers.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="agent-provider-settings-scrim"
      onMouseDown={(event) => {
        if (!saving && event.target === event.currentTarget) onClose();
      }}
    >
      <aside ref={dialogRef} className="agent-provider-settings" role="dialog" aria-modal="true" aria-label={t("agent.providers.title")} tabIndex={-1}>
        <header className="agent-provider-settings-header">
          <div><span className="eyebrow">NAMI AGENT</span><h2>{t("agent.providers.title")}</h2><p>{t("agent.providers.description")}</p></div>
          <button className="icon-button" type="button" data-dialog-initial-focus aria-label={t("agent.providers.close")} data-tooltip={t("agent.providers.close")} disabled={saving} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="agent-provider-settings-body">
          <section className="agent-provider-catalog" aria-label={t("agent.providers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.providers.available")}</span><button className="agent-provider-new" type="button" disabled={saving} onClick={() => selectProvider(null)}><Plus size={15} />{t("agent.providers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.providers.loading")}</div>}
            {!loading && !providers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.providers.empty")}</strong><small>{t("agent.providers.emptyDescription")}</small></div>}
            <div className="agent-provider-list">
              {providers.map((provider) => {
                const active = provider.id === selectedProviderId;
                const state = providerVisualState(provider);
                return (
                  <button key={provider.id} className={`agent-provider-list-item ${active ? "active" : ""}`} type="button" aria-pressed={active} disabled={saving} onClick={() => selectProvider(provider)}>
                    <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                    <span><strong>{provider.label}</strong><small>{provider.model}</small><span className="agent-provider-list-meta">{provider.id === defaultProviderId && <em className="default">{t("agent.providers.status.default")}</em>}<em className={state}>{t(`agent.providers.status.${state}`)}</em></span></span>
                    {provider.cloud ? <Cloud size={14} aria-label={t("agent.providers.status.cloud")} /> : <Server size={14} aria-label={t("agent.providers.status.local")} />}
                  </button>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
            <div className="agent-provider-form-heading"><div><span className="eyebrow">{selectedProvider ? t("agent.providers.form.editEyebrow") : t("agent.providers.form.newEyebrow")}</span><h3>{selectedProvider ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}</h3></div>{selectedProvider && <span className={`agent-provider-form-status ${providerVisualState(selectedProvider)}`}>{providerVisualState(selectedProvider) === "verified" ? <Check size={14} /> : <CircleAlert size={14} />}{t(`agent.providers.status.${providerVisualState(selectedProvider)}`)}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={saving} onClick={() => void refreshProviders(selectedProviderId)}>{t("agent.providers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.kind")}</strong><small>{t("agent.providers.fields.kindHint")}</small></span><ThemedSelect id="agent-provider-kind" value={form.kind} onValueChange={(value) => updateKind(value as AgentProviderKind)} disabled={saving} aria-label={t("agent.providers.fields.kind")}><option value="openai-compatible">{t("agent.providers.kind.openaiCompatible")}</option><option value="ollama">{t("agent.providers.kind.ollama")}</option></ThemedSelect></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.label")}</strong><small>{t("agent.providers.fields.labelHint")}</small></span><input value={form.label} maxLength={128} disabled={saving} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.endpoint")}</strong><small>{isOllama ? t("agent.providers.fields.ollamaEndpointHint") : t("agent.providers.fields.endpointHint")}</small></span><input value={form.endpoint} placeholder={isOllama ? ollamaEndpointSuggestion : t("agent.providers.fields.endpointPlaceholder")} disabled={saving} onChange={(event) => updateForm("endpoint", event.target.value)} autoComplete="url" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.providers.fields.model")}</strong><small>{t("agent.providers.fields.modelHint")}</small></span><input value={form.model} placeholder={isOllama ? "llama3.2" : "gpt-4.1-mini"} maxLength={256} disabled={saving} onChange={(event) => updateForm("model", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.providers.fields.timeout")}</strong><small>{t("agent.providers.fields.timeoutHint")}</small></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={saving} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.providers.fields.apiKey")}</strong><small>{selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}</small></span><div className="agent-provider-secret"><input type={keyVisible ? "text" : "password"} value={form.apiKey} disabled={saving || form.clearApiKey} onChange={(event) => updateForm("apiKey", event.target.value)} placeholder={selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyKeep") : t("agent.providers.fields.apiKeyPlaceholder")} autoComplete="new-password" spellCheck={false} /><button className="icon-button" type="button" disabled={saving || form.clearApiKey} aria-label={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} data-tooltip={keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")} onClick={() => setKeyVisible((visible) => !visible)}>{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>{selectedProvider?.apiKeyConfigured && <button className={`agent-provider-inline-toggle ${form.clearApiKey ? "active" : ""}`} type="button" role="switch" aria-checked={form.clearApiKey} disabled={saving || Boolean(form.apiKey)} onClick={() => updateForm("clearApiKey", !form.clearApiKey)}><span aria-hidden="true" /><span>{t("agent.providers.fields.clearApiKey")}</span></button>}</div>
            <button className={`agent-provider-toggle-row ${form.allowCloudMailContent ? "active" : ""}`} type="button" role="switch" aria-checked={form.allowCloudMailContent} disabled={saving || isOllama} onClick={() => updateForm("allowCloudMailContent", !form.allowCloudMailContent)}><span><strong>{t("agent.providers.cloud.title")}</strong><small>{isOllama ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}</small></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>
            <button className={`agent-provider-toggle-row ${form.makeDefault ? "active" : ""}`} type="button" role="switch" aria-checked={form.makeDefault} disabled={saving || isDefaultProvider} onClick={() => updateForm("makeDefault", !form.makeDefault)}><span><strong>{t("agent.providers.default.title")}</strong><small>{isDefaultProvider ? t("agent.providers.default.current") : t("agent.providers.default.description")}</small></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions"><button className="primary-button" type="submit" disabled={saving || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{saving ? t("agent.providers.savingAndChecking") : t("agent.providers.save")}</button>{selectedProvider && <button className={`secondary-button danger-button ${deletePending ? "agent-provider-delete-pending" : ""}`} type="button" disabled={saving} onClick={() => void deleteProvider()}><Trash2 size={15} />{deletePending ? t("agent.providers.deleteConfirm") : t("agent.providers.delete")}</button>}</div>
            {deletePending && <p className="agent-provider-delete-note">{t("agent.providers.deletePrompt")}</p>}
          </form>
        </div>
      </aside>
    </div>
  );
}

export default function AgentWorkspace({ accounts, messages, currentMessage, onClose, onOpenMessage, restoreFocusRef, demoMode = false, providerSettingsRequestId = 0 }: AgentWorkspaceProps) {
  const { locale, t } = useI18n();
  const [bootstrap, setBootstrap] = useState<AgentBootstrap | null>(null);
  const [conversations, setConversations] = useState<AgentBootstrap["conversations"]>([]);
  const [active, setActive] = useState<AgentConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conversationSearch, setConversationSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<AgentMode>("agent");
  const [providerId, setProviderId] = useState("");
  const [scopeMode, setScopeMode] = useState<AgentScopeMode>(currentMessage ? "current_message" : "all_accounts");
  const [streaming, setStreaming] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
  const [confirmationErrors, setConfirmationErrors] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const providerSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useDialogFocus(true, workspaceRef, { restoreFocusRef, suspended: providerSettingsOpen });

  const scope = useMemo(() => agentScopeFor(scopeMode, currentMessage, messages, accounts), [accounts, currentMessage, messages, scopeMode]);
  const providers = bootstrap?.providers ?? [];
  const configuredProviders = useMemo(() => providers.filter((provider) => provider.configured), [providers]);
  const selectedProvider = configuredProviders.find((provider) => provider.id === providerId)
    ?? configuredProviders.find((provider) => provider.id === bootstrap?.defaultProviderId)
    ?? configuredProviders[0];
  const hasConfiguredProvider = Boolean(selectedProvider);
  const filteredConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase(locale);
    if (!query) return conversations;
    return conversations.filter((conversation) => `${conversation.title} ${conversation.preview}`.toLocaleLowerCase(locale).includes(query));
  }, [conversationSearch, conversations, locale]);

  const refreshConversations = useCallback(async (query = "") => {
    if (demoMode) {
      setConversations([]);
      return;
    }
    const response = await api.agentConversations(query ? new URLSearchParams({ query }).toString() : "");
    setConversations(response.items);
  }, [demoMode]);

  const applyProviderList = useCallback((snapshot: AgentProviderList) => {
    setBootstrap((current) => current ? {
      ...current,
      providers: snapshot.items,
      defaultProviderId: snapshot.defaultProviderId,
      configured: snapshot.items.some((provider) => provider.configured),
    } : current);
    setProviderId(configuredProviderId(snapshot.items, snapshot.defaultProviderId));
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    if (demoMode) {
      setBootstrap({
        enabled: false,
        configured: false,
        providers: [],
        defaultProviderId: null,
        conversations: [],
        notice: t("agent.demo.description"),
      });
      setConversations([]);
      setActive(null);
      setProviderId("");
      setLoading(false);
      return;
    }
    try {
      const value = await api.agentBootstrap();
      setBootstrap(value);
      setConversations(value.conversations);
      setProviderId((current) => {
        const currentProvider = value.providers.find((provider) => provider.id === current && provider.configured);
        return currentProvider?.id ?? configuredProviderId(value.providers, value.defaultProviderId);
      });
      if (value.conversations[0]) {
        const conversation = await api.agentConversation(value.conversations[0].id);
        setActive(conversation);
        setProviderId((current) => value.providers.some((provider) => provider.id === conversation.providerId && provider.configured)
          ? conversation.providerId
          : current || configuredProviderId(value.providers, value.defaultProviderId));
        setScopeMode(conversation.scope.mode);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.load"));
    } finally {
      setLoading(false);
    }
  }, [demoMode, t]);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    if (demoMode || providerSettingsRequestId === 0) return;
    setProviderSettingsOpen(true);
  }, [demoMode, providerSettingsRequestId]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ block: "end" }); }, [active?.messages.length, streaming]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const selectConversation = useCallback(async (id: string) => {
    if (streaming) return;
    try {
      setLoadError(null);
      const conversation = await api.agentConversation(id);
      setActive(conversation);
      setProviderId(providers.some((provider) => provider.id === conversation.providerId && provider.configured)
        ? conversation.providerId
        : configuredProviderId(providers, bootstrap?.defaultProviderId ?? null));
      setScopeMode(conversation.scope.mode);
      setRenaming(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.loadConversation"));
    }
  }, [bootstrap?.defaultProviderId, providers, streaming, t]);

  const createConversation = useCallback(async () => {
    if (streaming) return;
    if (!selectedProvider) {
      setProviderSettingsOpen(true);
      return;
    }
    try {
      const conversation = await api.createAgentConversation({ providerId: selectedProvider.id, scope });
      setActive(conversation);
      setConversations((items) => [{ id: conversation.id, title: conversation.title, preview: conversation.preview, updatedAt: conversation.updatedAt }, ...items.filter((item) => item.id !== conversation.id)]);
      setComposer("");
      setRenaming(false);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.createConversation"));
    }
  }, [scope, selectedProvider, streaming, t]);

  const renameConversation = useCallback(async () => {
    if (!active || !draftTitle.trim()) return;
    try {
      const summary = await api.renameAgentConversation(active.id, draftTitle.trim());
      setActive((current) => current && current.id === summary.id ? { ...current, ...summary } : current);
      setConversations((items) => items.map((item) => item.id === summary.id ? summary : item));
      setRenaming(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.renameConversation"));
    }
  }, [active, draftTitle, t]);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await api.deleteAgentConversation(id);
      const next = conversations.filter((conversation) => conversation.id !== id);
      setConversations(next);
      setPendingDeleteId(null);
      if (active?.id === id) {
        setActive(null);
        if (next[0]) void selectConversation(next[0].id);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.error.deleteConversation"));
    }
  }, [active?.id, conversations, selectConversation, t]);

  const mutateAssistant = useCallback((messageId: string, event: AgentStreamEvent) => {
    setActive((current) => {
      if (!current) return current;
      return {
        ...current,
        messages: current.messages.map((message) => message.id === messageId ? messageWithEvent(message, event) : message),
      };
    });
  }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onAgentConfirmationResult) return;
    return bridge.onAgentConfirmationResult((result) => {
      if (!result.ok) {
        setConfirmationErrors((current) => ({ ...current, [result.confirmationId]: t("agent.error.load") }));
        return;
      }
      setConfirmationErrors((current) => {
        if (!(result.confirmationId in current)) return current;
        const { [result.confirmationId]: _discarded, ...remaining } = current;
        return remaining;
      });
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) => message.confirmation?.id === result.confirmationId
          ? { ...message, confirmation: { ...message.confirmation, state: result.decision === "approve" ? "approved" : "rejected" } }
          : message),
      } : current);
    });
  }, [t]);

  const sendMessage = useCallback(async (contentOverride?: string) => {
    const content = (contentOverride ?? composer).trim();
    if (!content || streaming) return;
    if (!selectedProvider) {
      setProviderSettingsOpen(true);
      return;
    }
    let conversation = active;
    if (!conversation || !sameAgentScope(conversation.scope, scope)) {
      try {
        conversation = await api.createAgentConversation({ providerId: selectedProvider.id, scope });
        setActive(conversation);
        setConversations((items) => [{ id: conversation!.id, title: conversation!.title, preview: conversation!.preview, updatedAt: conversation!.updatedAt }, ...items.filter((item) => item.id !== conversation!.id)]);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : t("agent.error.createConversation"));
        return;
      }
    }
    const userMessage: AgentMessage = { id: newLocalId("user"), role: "user", content, createdAt: currentTime(), state: "complete", citations: [], toolActivities: [] };
    const assistantMessage: AgentMessage = { id: newLocalId("assistant"), role: "assistant", content: "", createdAt: currentTime(), state: "streaming", citations: [], toolActivities: [] };
    setComposer("");
    setStreaming(true);
    setLoadError(null);
    setActive((current) => current && current.id === conversation!.id ? { ...current, providerId: selectedProvider.id, scope, messages: [...current.messages, userMessage, assistantMessage] } : current);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.streamAgentMessage(conversation.id, {
        content,
        providerId: selectedProvider.id,
        mode,
        scope,
        context: {
          ...(currentMessage ? { currentMessageId: currentMessage.id } : {}),
          ...(scope.mode === "current_thread" ? { currentThreadMessageIds: scope.messageIds } : {}),
        },
      }, (event) => mutateAssistant(assistantMessage.id, event), controller.signal);
      await refreshConversations(conversationSearch);
    } catch (error) {
      if (controller.signal.aborted) {
        mutateAssistant(assistantMessage.id, { type: "completed", reason: "cancelled" });
      } else {
        const message = error instanceof Error ? error.message : t("agent.error.stream");
        const code = error instanceof ApiError ? error.code ?? "agent_request_failed" : "agent_request_failed";
        mutateAssistant(assistantMessage.id, { type: "error", error: { code, message, retryable: true } });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  }, [active, composer, conversationSearch, currentMessage, mode, mutateAssistant, refreshConversations, scope, selectedProvider, streaming, t]);

  const stopStreaming = useCallback(() => {
    const conversationId = active?.id;
    abortRef.current?.abort();
    if (conversationId) void api.cancelAgentRun(conversationId).catch(() => undefined);
  }, [active?.id]);

  const copyText = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      const input = document.createElement("textarea");
      input.value = content;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
  }, []);

  const scopeOptions: Array<{ mode: AgentScopeMode; label: string; disabled?: boolean }> = [
    { mode: "all_accounts", label: t("agent.scope.all") },
    { mode: "selected_account", label: t("agent.scope.account"), disabled: accounts.length === 0 },
    { mode: "current_message", label: t("agent.scope.message"), disabled: !currentMessage },
    { mode: "current_thread", label: t("agent.scope.thread"), disabled: !currentMessage },
  ];
  const cloudMailContextBlocked = Boolean(selectedProvider?.cloud && !selectedProvider.cloudContentConsent);
  const composerDisclosure = selectedProvider?.cloud
    ? cloudMailContextBlocked ? t("agent.composer.cloudNoMailDisclosure") : t("agent.composer.cloudDisclosure")
    : t("agent.composer.localDisclosure");

  const desktopConfirmationAvailable = Boolean(desktopBridge()?.onAgentConfirmationResult);

  return (
    <section ref={workspaceRef} className="agent-workspace" role="dialog" aria-modal="true" aria-label={t("agent.workspace.aria")} tabIndex={-1}>
      {mobileConversationsOpen && <button className="agent-mobile-conversation-scrim" type="button" aria-label={t("agent.conversation.closeList")} onClick={() => setMobileConversationsOpen(false)} />}
      <aside className={`agent-conversation-sidebar${mobileConversationsOpen ? " mobile-open" : ""}`}>
        <div className="agent-sidebar-top">
          <button className="agent-title-button" type="button" onClick={onClose} aria-label={t("agent.workspace.backToMail")}><ChevronLeft size={18} /><span>{t("agent.title")}</span></button>
          <button className="agent-new-conversation-button" type="button" onClick={() => { setMobileConversationsOpen(false); void createConversation(); }} disabled={streaming || demoMode} aria-label={t("agent.conversation.new")} data-tooltip={demoMode ? t("agent.demo.actionUnavailable") : t("agent.conversation.new")}><MessageSquarePlus size={15} /><span>{t("agent.conversation.new")}</span></button>
        </div>
        <div className="agent-sidebar-search"><Search size={15} /><label className="visually-hidden" htmlFor="agent-conversation-search">{t("agent.conversation.search")}</label><input id="agent-conversation-search" value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder={t("agent.conversation.searchPlaceholder")} /></div>
        <div className="agent-conversation-list">
          {loading && <div className="agent-sidebar-state"><LoaderCircle className="spin" size={18} />{t("agent.loading")}</div>}
          {!loading && !filteredConversations.length && <div className="agent-sidebar-state"><MessageSquarePlus size={18} />{t("agent.conversation.empty")}</div>}
          {filteredConversations.map((conversation) => (
            <div key={conversation.id} className={`agent-conversation-row ${active?.id === conversation.id ? "active" : ""}`}>
              <button type="button" onClick={() => { setMobileConversationsOpen(false); void selectConversation(conversation.id); }} disabled={streaming}><span><strong>{conversation.title}</strong><small>{conversation.preview || t("agent.conversation.emptyPreview")}</small></span><time>{shortDate(conversation.updatedAt, locale)}</time></button>
              <button className="agent-row-delete" type="button" aria-label={t("agent.conversation.delete")} disabled={streaming} onClick={() => setPendingDeleteId((current) => current === conversation.id ? null : conversation.id)}><Trash2 size={14} /></button>
              {pendingDeleteId === conversation.id && <div className="agent-row-confirm"><span>{t("agent.conversation.deletePrompt")}</span><button type="button" onClick={() => void deleteConversation(conversation.id)}>{t("agent.conversation.delete")}</button><button type="button" onClick={() => setPendingDeleteId(null)}>{t("common.cancel")}</button></div>}
            </div>
          ))}
        </div>
        <div className="agent-sidebar-footer"><Bot size={15} /><span>{t("agent.localBoundary")}</span></div>
      </aside>

      <section className="agent-main-panel">
        <header className="agent-workspace-header">
          <div className="agent-conversation-heading">
            <span className="agent-heading-mark" aria-hidden="true"><Sparkles size={16} /></span>
            {renaming && active ? (
              <form onSubmit={(event) => { event.preventDefault(); void renameConversation(); }}><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label={t("agent.conversation.rename")} autoFocus onBlur={() => setRenaming(false)} /></form>
            ) : <><div className="agent-conversation-title"><span className="eyebrow">{t("agent.eyebrow")}</span><h1>{active?.title ?? t("agent.conversation.newTitle")}</h1></div>{active && <button className="icon-button" type="button" aria-label={t("agent.conversation.rename")} data-tooltip={t("agent.conversation.rename")} onClick={() => { setDraftTitle(active.title); setRenaming(true); }}><Pencil size={15} /></button>}</>}
          </div>
          <div className="agent-header-actions">
            <button className="agent-mobile-conversations-button" type="button" aria-label={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} aria-expanded={mobileConversationsOpen} data-tooltip={mobileConversationsOpen ? t("agent.conversation.closeList") : t("agent.conversation.openList")} onClick={() => setMobileConversationsOpen((open) => !open)}><PanelLeftClose size={17} /></button>
            {hasConfiguredProvider ? <div className="agent-provider-picker"><span className="agent-provider-picker-label"><Bot size={13} />{t("agent.provider.label")}</span><ThemedSelect id="agent-provider" value={selectedProvider?.id ?? ""} onValueChange={setProviderId} disabled={streaming} aria-label={t("agent.provider.label")} containerClassName="agent-provider-select-control" className="agent-provider-select">
              {configuredProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.label} · {provider.model}{provider.cloud ? "" : ` · ${t("agent.provider.local")}`}</option>)}
            </ThemedSelect></div> : demoMode ? <span className="agent-demo-status"><Sparkles size={14} />{t("agent.demo.badge")}</span> : <button ref={providerSettingsTriggerRef} className="agent-configure-provider-action" type="button" onClick={() => setProviderSettingsOpen(true)}><Wrench size={15} />{t("agent.providers.configure")}</button>}
            {hasConfiguredProvider && <button ref={providerSettingsTriggerRef} className="icon-button" type="button" onClick={() => setProviderSettingsOpen(true)} aria-label={t("agent.provider.settings")} data-tooltip={t("agent.provider.settings")}><Wrench size={17} /></button>}
            <button className="icon-button" type="button" onClick={onClose} aria-label={t("agent.workspace.close")} data-tooltip={t("agent.workspace.close")}><X size={18} /></button>
          </div>
        </header>

        <div className="agent-context-strip">
          <div className="agent-mode-switch" role="group" aria-label={t("agent.mode.label")}>
            <button type="button" className={mode === "agent" ? "active" : ""} aria-pressed={mode === "agent"} onClick={() => setMode("agent")}><Sparkles size={14} />{t("agent.mode.agent")}</button>
            <button type="button" className={mode === "chat" ? "active" : ""} aria-pressed={mode === "chat"} onClick={() => setMode("chat")}><Bot size={14} />{t("agent.mode.chat")}</button>
          </div>
          <div className="agent-scope-switch" role="group" aria-label={t("agent.scope.label")}>
            {scopeOptions.map((option) => <button key={option.mode} type="button" className={scopeMode === option.mode ? "active" : ""} aria-pressed={scopeMode === option.mode} disabled={option.disabled} onClick={() => setScopeMode(option.mode)}>{option.label}</button>)}
          </div>
          {selectedProvider?.cloud && !selectedProvider.cloudContentConsent && <span className="agent-privacy-notice"><ShieldAlert size={14} />{t("agent.provider.consentRequired")}</span>}
          {currentMessage && <span className="agent-current-context"><FileText size={14} />{currentMessage.subject || t("agent.context.currentMessage")}</span>}
        </div>

        <div className="agent-transcript" aria-live="polite">
          {loadError && <div className="agent-error-panel" role="status"><CircleAlert size={18} /><span><strong>{t("agent.error.title")}</strong><small>{loadError}</small></span><button className="secondary-button" type="button" onClick={() => void loadBootstrap()}>{t("common.retry")}</button></div>}
          {!loading && !active && <div className="agent-empty-state"><div className="agent-empty-icon"><Sparkles size={28} /></div><h2>{demoMode ? t("agent.demo.title") : hasConfiguredProvider ? t("agent.empty.title") : t("agent.providers.noConfigured")}</h2><p>{demoMode ? t("agent.demo.description") : hasConfiguredProvider ? bootstrap?.notice ?? t("agent.empty.description") : t("agent.providers.noConfiguredDescription")}</p>{hasConfiguredProvider ? <div className="agent-suggestion-list"><button type="button" onClick={() => setComposer(t("agent.suggestion.today"))}>{t("agent.suggestion.today")}</button><button type="button" onClick={() => setComposer(t("agent.suggestion.actionItems"))}>{t("agent.suggestion.actionItems")}</button><button type="button" onClick={() => setComposer(t("agent.suggestion.reply"))}>{t("agent.suggestion.reply")}</button></div> : !demoMode && <button className="agent-configure-provider-button" type="button" onClick={() => setProviderSettingsOpen(true)}><Wrench size={16} />{t("agent.providers.configure")}</button>}</div>}
          {active?.messages.map((message) => (
            <article key={message.id} className={`agent-message ${message.role} ${message.state === "streaming" ? "streaming" : ""}`}>
              <div className="agent-message-meta"><span className="agent-message-role">{message.role === "user" ? t("agent.message.you") : message.role === "assistant" ? t("agent.message.assistant") : t("agent.message.system")}</span><time>{shortDate(message.createdAt, locale)}</time>{message.role === "assistant" && message.content && <button type="button" className="agent-copy-button" onClick={() => void copyText(message.content)} aria-label={t("agent.message.copy")} data-tooltip={t("agent.message.copy")}><Copy size={14} /></button>}</div>
              {message.content ? <AgentMarkdown content={message.content} /> : message.state === "streaming" && <div className="agent-thinking"><LoaderCircle className="spin" size={16} />{t("agent.message.thinking")}</div>}
              {message.toolActivities.length > 0 && <div className="agent-tool-list">{message.toolActivities.map((activity) => <AgentToolCard key={activity.id} activity={activity} />)}</div>}
              {message.citations.length > 0 && <div className="agent-citation-list"><span>{t("agent.citations.title")}</span>{message.citations.map((citation) => <button key={citation.id} type="button" onClick={() => onOpenMessage(citation.messageId)}><FolderSearch size={14} /><span><strong>{sourceLabel(citation)}</strong><small>{citation.excerpt}</small></span></button>)}</div>}
              {message.confirmation && <AgentConfirmationCard confirmation={message.confirmation} desktopConfirmationAvailable={desktopConfirmationAvailable} resolutionError={confirmationErrors[message.confirmation.id]} />}
              {message.error && <div className="agent-message-error"><CircleAlert size={15} /><span>{message.error.message}{message.error.suggestion ? ` ${message.error.suggestion}` : ""}</span>{message.error.retryable && <button type="button" onClick={() => setComposer([...active?.messages ?? []].reverse().find((item) => item.role === "user")?.content ?? "")}>{t("agent.message.retry")}</button>}</div>}
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <footer className="agent-composer-region">
          <div className="agent-composer"><label className="visually-hidden" htmlFor="agent-composer">{t("agent.composer.label")}</label><textarea id="agent-composer" ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={t("agent.composer.placeholder")} disabled={streaming || !bootstrap?.enabled || !hasConfiguredProvider} rows={1} />{streaming ? <button className="agent-send-button stop" type="button" onClick={stopStreaming} aria-label={t("agent.composer.stop")} data-tooltip={t("agent.composer.stop")}><Square size={15} fill="currentColor" /></button> : <button className="agent-send-button" type="button" disabled={!composer.trim() || !bootstrap?.enabled || !hasConfiguredProvider || (mode === "agent" && cloudMailContextBlocked)} onClick={() => void sendMessage()} aria-label={t("agent.composer.send")} data-tooltip={t("agent.composer.send")}><SendHorizontal size={17} /></button>}</div>
          {!hasConfiguredProvider ? <div className="agent-provider-required" role="status"><Wrench size={15} /><span>{demoMode ? t("agent.demo.description") : t("agent.providers.noConfiguredDescription")}</span>{!demoMode && <button type="button" onClick={() => setProviderSettingsOpen(true)}>{t("agent.providers.configure")}</button>}</div> : <div className="agent-composer-meta"><span>{composerDisclosure}</span>{mode === "agent" && <span>{t("agent.composer.confirmationDisclosure")}</span>}</div>}
        </footer>
      </section>
      <AgentProviderSettings
        open={providerSettingsOpen}
        initialProviders={providers}
        initialDefaultProviderId={bootstrap?.defaultProviderId ?? null}
        onClose={() => setProviderSettingsOpen(false)}
        onProvidersChanged={applyProviderList}
        restoreFocusRef={providerSettingsTriggerRef}
      />
    </section>
  );
}
