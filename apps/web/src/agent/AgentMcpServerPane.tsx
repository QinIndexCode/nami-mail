import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, api } from "../api";
import type {
  AgentMcpServerInput,
  AgentMcpServerList,
  AgentMcpServerSummary,
} from "../agentTypes";
import { useI18n } from "../i18n";

type McpServerForm = {
  label: string;
  command: string;
  argsText: string;
  cwd: string;
  timeoutMs: string;
  enabled: boolean;
};

type EnvRow = {
  key: string;
  value: string;
};

function mcpServerFormFor(server: AgentMcpServerSummary | null): McpServerForm {
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

function mcpEnvRowsFor(server: AgentMcpServerSummary | null): EnvRow[] {
  const rows = server ? server.envKeys.map((key) => ({ key, value: "" })) : [];
  rows.push({ key: "", value: "" });
  return rows;
}

function parseArgsText(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function mcpServerVisualState(server: AgentMcpServerSummary): "checked" | "failed" | "enabled" | "disabled" {
  if (!server.enabled) return "disabled";
  if (server.lastError) return "failed";
  if (server.toolCount !== undefined) return "checked";
  return "enabled";
}

export function AgentMcpServerPane({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<AgentMcpServerSummary[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [form, setForm] = useState<McpServerForm>(() => mcpServerFormFor(null));
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => [{ key: "", value: "" }]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const selectedServerIdRef = useRef<string | null>(null);

  const selectedServer = servers.find((server) => server.id === selectedServerId) ?? null;

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
  }, [selectedServerId]);

  const selectServer = useCallback((server: AgentMcpServerSummary | null) => {
    setSelectedServerId(server?.id ?? null);
    setForm(mcpServerFormFor(server));
    setEnvRows(mcpEnvRowsFor(server));
    setDeletePending(false);
    setNotice(null);
    setLoadError(null);
  }, []);

  const applyServerList = useCallback((snapshot: AgentMcpServerList, preferredServerId: string | null = null) => {
    setServers(snapshot.items);
    const selected = (preferredServerId ? snapshot.items.find((server) => server.id === preferredServerId) : undefined)
      ?? snapshot.items.find((server) => server.id === selectedServerIdRef.current)
      ?? snapshot.items[0]
      ?? null;
    setSelectedServerId(selected?.id ?? null);
    setForm(mcpServerFormFor(selected));
    setEnvRows(mcpEnvRowsFor(selected));
    setDeletePending(false);
  }, []);

  const refreshServers = useCallback(async (preferredServerId: string | null = null) => {
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await api.agentMcpServers();
      applyServerList(snapshot, preferredServerId);
      return snapshot;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.mcpServers.loadFailed"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyServerList, t]);

  useEffect(() => {
    if (!active) return;
    setSelectedServerId(null);
    setForm(mcpServerFormFor(null));
    setEnvRows([{ key: "", value: "" }]);
    setLoadError(null);
    setNotice(null);
    setDeletePending(false);
    void refreshServers();
  }, [active, refreshServers]);

  const updateForm = <Key extends keyof McpServerForm>(key: Key, value: McpServerForm[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
    setDeletePending(false);
  };

  const validationMessage = useMemo(() => {
    if (!form.label.trim()) return t("agent.mcpServers.validation.label");
    if (!form.command.trim()) return t("agent.mcpServers.validation.command");
    if (parseArgsText(form.argsText).some((arg) => arg.length > 1_024)) return t("agent.mcpServers.validation.args");
    const envPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (key.length > 256 || !envPattern.test(key) || row.value.length > 8_192) return t("agent.mcpServers.validation.env");
    }
    if (form.cwd.length > 2_048) return t("agent.mcpServers.validation.cwd");
    const timeoutMs = Number(form.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) return t("agent.mcpServers.validation.timeout");
    return null;
  }, [envRows, form.argsText, form.command, form.cwd, form.label, form.timeoutMs, t]);

  const requestFeedback = (error: unknown, fallback: string): string => {
    if (error instanceof ApiError) {
      if (error.code === "SERVER_CHANGED") return t("agent.mcpServers.checkError.changed");
      if (error.code === "local_service_unavailable") return t("agent.mcpServers.checkError.localService");
      return error.message || fallback;
    }
    return fallback;
  };

  const checkFeedback = (server: AgentMcpServerSummary): string => {
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
  };

  const buildInput = (): AgentMcpServerInput => {
    const existingEnvKeys = new Set(selectedServer?.envKeys ?? []);
    const env: Record<string, string> = {};
    const envRemove: string[] = [];
    const seenKeys = new Set<string>();
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (row.value.trim()) env[key] = row.value.trim();
    }
    for (const key of existingEnvKeys) {
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
  };

  const saveServer = async () => {
    if (saving || checking || validationMessage) return;
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    let saved: AgentMcpServerSummary | undefined;
    try {
      saved = selectedServer
        ? await api.updateAgentMcpServer(selectedServer.id, buildInput())
        : await api.createAgentMcpServer(buildInput());
      const checked = await api.checkAgentMcpServer(saved.id);
      await refreshServers(saved.id);
      if (checked.lastError) {
        setLoadError(checkFeedback(checked));
      } else {
        setNotice(t("agent.mcpServers.checked"));
      }
    } catch (error) {
      if (saved) await refreshServers(saved.id);
      setLoadError(requestFeedback(error, saved ? t("agent.mcpServers.checkFailed") : t("agent.mcpServers.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const checkServer = async () => {
    if (!selectedServer || saving || checking) return;
    setChecking(true);
    setLoadError(null);
    setNotice(null);
    try {
      const checked = await api.checkAgentMcpServer(selectedServer.id);
      await refreshServers(selectedServer.id);
      if (checked.lastError) {
        setLoadError(checkFeedback(checked));
      } else {
        setNotice(t("agent.mcpServers.checked"));
      }
    } catch (error) {
      setLoadError(requestFeedback(error, t("agent.mcpServers.checkFailed")));
    } finally {
      setChecking(false);
    }
  };

  const deleteServer = async () => {
    if (!selectedServer || saving || checking) return;
    if (!deletePending) {
      setDeletePending(true);
      return;
    }
    setSaving(true);
    setLoadError(null);
    setNotice(null);
    try {
      await api.deleteAgentMcpServer(selectedServer.id);
      await refreshServers();
      setNotice(t("agent.mcpServers.deleted"));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("agent.mcpServers.deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const updateEnvRow = (index: number, patch: Partial<EnvRow>) => {
    setEnvRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
    setNotice(null);
    setDeletePending(false);
  };

  const removeEnvRow = (index: number) => {
    setEnvRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index));
    setNotice(null);
    setDeletePending(false);
  };

  if (!active) return null;

  const busy = saving || checking;
  const selectedState = selectedServer ? mcpServerVisualState(selectedServer) : "enabled";
  const selectedStateLabel = selectedServer ? t(`agent.mcpServers.status.${selectedState}`) : "";

  return (
    <>
      <section className="agent-provider-catalog" aria-label={t("agent.mcpServers.title")}>
            <div className="agent-provider-catalog-header"><span>{t("agent.mcpServers.available")}</span><button className="agent-provider-new" type="button" disabled={busy} onClick={() => selectServer(null)}><Plus size={15} />{t("agent.mcpServers.new")}</button></div>
            {loading && <div className="agent-provider-loading" role="status"><LoaderCircle className="spin" size={16} />{t("agent.mcpServers.loading")}</div>}
            {!loading && !servers.length && <div className="agent-provider-empty"><Server size={18} /><strong>{t("agent.mcpServers.empty")}</strong></div>}
            <div className="agent-provider-list">
              {servers.map((server) => {
                const isSelected = server.id === selectedServerId;
                const state = mcpServerVisualState(server);
                return (
                  <button key={server.id} className={`agent-provider-list-item ${isSelected ? "active" : ""}`} type="button" aria-pressed={isSelected} disabled={busy} title={server.command} onClick={() => selectServer(server)}>
                    <span className={`agent-provider-state ${state}`} aria-hidden="true" />
                    <span>
                      <strong>{server.label}</strong>
                      <span className="agent-provider-list-meta">{server.toolCount !== undefined && <em className="tools">{t("agent.mcpServers.status.tools", { count: server.toolCount })}</em>}</span>
                    </span>
                    <Server size={14} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          </section>

          <form className="agent-provider-form" onSubmit={(event) => { event.preventDefault(); void saveServer(); }}>
            <div className="agent-provider-form-heading"><h3>{selectedServer ? t("agent.mcpServers.form.editTitle") : t("agent.mcpServers.form.newTitle")}</h3>{selectedServer && <span className={`agent-provider-form-status ${selectedState}`}>{selectedState === "checked" ? <Check size={14} /> : <CircleAlert size={14} />}{selectedStateLabel}</span>}</div>

            {loadError && <div className="agent-provider-feedback error" role="alert"><CircleAlert size={16} /><span>{loadError}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => void refreshServers(selectedServerId)}>{t("agent.mcpServers.retry")}</button></div>}
            {notice && <div className="agent-provider-feedback success" role="status"><Check size={16} /><span>{notice}</span></div>}

            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.label")}</strong></span><input value={form.label} maxLength={128} disabled={busy} onChange={(event) => updateForm("label", event.target.value)} autoComplete="off" /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.command")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.commandHint")} data-tooltip={t("agent.mcpServers.fields.commandHint")}><CircleHelp size={12} /></button></span><input value={form.command} placeholder={t("agent.mcpServers.fields.commandPlaceholder")} maxLength={1024} disabled={busy} onChange={(event) => updateForm("command", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.args")}</strong></span><textarea className="agent-mcp-args-input" value={form.argsText} placeholder={t("agent.mcpServers.fields.argsPlaceholder")} rows={3} disabled={busy} onChange={(event) => updateForm("argsText", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <div className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.env")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.envHint")} data-tooltip={t("agent.mcpServers.fields.envHint")}><CircleHelp size={12} /></button></span>
              <div className="agent-mcp-env-editor">
                {envRows.map((row, index) => (
                  <div className="agent-mcp-env-row" key={`${index}:${row.key || ""}:${row.value || ""}`}>
                    <input value={row.key} placeholder={t("agent.mcpServers.fields.envKeyPlaceholder")} maxLength={256} disabled={busy} onChange={(event) => updateEnvRow(index, { key: event.target.value })} autoComplete="off" spellCheck={false} />
                    <input value={row.value} placeholder={selectedServer?.envKeys.includes(row.key.trim()) ? t("agent.mcpServers.fields.envSaved") : t("agent.mcpServers.fields.envValuePlaceholder")} maxLength={8192} disabled={busy} onChange={(event) => updateEnvRow(index, { value: event.target.value })} autoComplete="off" spellCheck={false} />
                    <button className="icon-button" type="button" disabled={busy} aria-label={t("agent.mcpServers.delete")} data-tooltip={t("agent.mcpServers.delete")} onClick={() => removeEnvRow(index)}><X size={14} /></button>
                  </div>
                ))}
                <button className="agent-mcp-add-env" type="button" disabled={busy} onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}><Plus size={13} />{t("agent.mcpServers.fields.addEnv")}</button>
              </div>
            </div>
            <label className="agent-provider-field"><span><strong>{t("agent.mcpServers.fields.cwd")}</strong></span><input value={form.cwd} maxLength={2048} disabled={busy} onChange={(event) => updateForm("cwd", event.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label className="agent-provider-field agent-provider-timeout"><span><strong>{t("agent.mcpServers.fields.timeout")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.timeoutHint")} data-tooltip={t("agent.mcpServers.fields.timeoutHint")}><CircleHelp size={12} /></button></span><input type="text" inputMode="numeric" pattern="[0-9]*" value={form.timeoutMs} disabled={busy} onChange={(event) => updateForm("timeoutMs", event.target.value)} autoComplete="off" /></label>
            <button className={`agent-provider-toggle-row ${form.enabled ? "active" : ""}`} type="button" role="switch" aria-checked={form.enabled} disabled={busy} onClick={() => updateForm("enabled", !form.enabled)}><span><strong>{t("agent.mcpServers.fields.enabled")}</strong><button className="agent-provider-help" type="button" tabIndex={-1} aria-label={t("agent.mcpServers.fields.enabledHint")} data-tooltip={t("agent.mcpServers.fields.enabledHint")}><CircleHelp size={12} /></button></span><span className="agent-provider-switch" aria-hidden="true"><span /></span></button>

            {validationMessage && <p className="agent-provider-validation" role="status"><CircleAlert size={14} />{validationMessage}</p>}
            <div className="agent-provider-form-actions">
              <button className="primary-button" type="submit" disabled={busy || Boolean(validationMessage)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Server size={15} />}{saving ? t("agent.mcpServers.savingAndChecking") : t("agent.mcpServers.save")}</button>
              {selectedServer && <button className="secondary-button" type="button" disabled={busy || Boolean(validationMessage)} onClick={() => void checkServer()}>{checking ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{checking ? t("agent.mcpServers.checking") : t("agent.mcpServers.check")}</button>}
              {selectedServer && <button className={`secondary-button danger-button ${deletePending ? "agent-provider-delete-pending" : ""}`} type="button" disabled={busy} onClick={() => void deleteServer()}><Trash2 size={15} />{deletePending ? t("agent.mcpServers.deleteConfirm") : t("agent.mcpServers.delete")}</button>}
            </div>
            {deletePending && <p className="agent-provider-delete-note">{t("agent.mcpServers.deletePrompt")}</p>}
          </form>
    </>
  );
}
