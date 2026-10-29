import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Calendar,
  CircleHelp,
  Cpu,
  LoaderCircle,
  Lock,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  Trash2,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { Translate } from "../i18n";
import type { AppSettings } from "../types";
import {
  BUILTIN_AGENT_TOOLS,
  type BuiltinAgentTool,
  type BuiltinToolDomain,
} from "./builtin-tools-data";
import { type SettingsCategoryId } from "./settings-categories";
import { ModelFeedbackLine } from "./SettingsModelDialog";
import SettingsModelMcpDialog from "./SettingsModelMcpDialog";
import { mcpDotClass, mcpSummary } from "./settings-models";
import { useMcpServers } from "./useSettingsModels";

export type SettingsToolsSectionProps = {
  t: Translate;
  demoMode?: boolean;
  currentSettings?: AppSettings;
  onSelectCategory?: (category: SettingsCategoryId) => void;
  onOverlayOpenChange?: (open: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  overlayHostRef?: React.RefObject<HTMLElement | null>;
};

export default function SettingsToolsSection({
  t,
  demoMode = false,
  currentSettings,
  onSelectCategory,
  onOverlayOpenChange,
  onBusyChange,
  overlayHostRef,
}: SettingsToolsSectionProps) {
  const [activeTab, setActiveTab] = useState<"builtin" | "mcp">("builtin");
  const [selectedDomain, setSelectedDomain] = useState<"all" | BuiltinToolDomain>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const accessLevel = currentSettings?.agentAccessLevel ?? "send-confirmed";
  const writesLocked = accessLevel === "read-only";
  const isConfirm = accessLevel === "send-confirmed";
  const accessLevelKey = accessLevel === "read-only" ? "readOnly" : accessLevel === "full-access" ? "fullAccess" : "sendConfirmed";

  const mcp = useMcpServers({
    enabled: !demoMode,
    t,
  });

  const mcpBusy = mcp.saving || mcp.checkingId !== null;

  useEffect(() => {
    onOverlayOpenChange?.(mcp.editing);
    return () => onOverlayOpenChange?.(false);
  }, [mcp.editing, onOverlayOpenChange]);

  useEffect(() => {
    onBusyChange?.(mcpBusy);
    return () => onBusyChange?.(false);
  }, [mcpBusy, onBusyChange]);

  const reportBusy = (busy: boolean) => {
    onBusyChange?.(busy || mcpBusy);
  };

  const domainCounts = useMemo(() => {
    const counts: Record<BuiltinToolDomain, number> = {
      mail: 0,
      calendar: 0,
      contacts: 0,
      system: 0,
    };
    for (const tool of BUILTIN_AGENT_TOOLS) {
      counts[tool.domain]++;
    }
    return counts;
  }, []);

  const filteredTools = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return BUILTIN_AGENT_TOOLS.filter((tool) => {
      if (selectedDomain !== "all" && tool.domain !== selectedDomain) {
        return false;
      }
      if (!query) {
        return true;
      }
      const desc = t(`settings.tools.builtin.${tool.descKey}.desc`).toLowerCase();
      return tool.name.toLowerCase().includes(query) || desc.includes(query);
    });
  }, [selectedDomain, searchQuery, t]);

  const formDialog = mcp.editing && (
    <SettingsModelMcpDialog t={t} mcp={mcp} onBusyChange={reportBusy} />
  );

  return (
    <section
      className="settings-section"
      data-settings-nav="mcp"
      aria-labelledby="tools-settings-title"
    >
      <div className="settings-section-title">
        <Server size={16} />
        <div>
          <span id="tools-settings-title">
            {t("settings.tools.title")}
            <span
              className="field-help-icon"
              data-tooltip={t("settings.tools.desc")}
              aria-label={t("settings.tools.desc")}
              tabIndex={0}
              onMouseDown={(e) => e.preventDefault()}
            >
              <CircleHelp size={12} aria-hidden="true" />
            </span>
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="connections-tabs" role="tablist" aria-label={t("settings.tools.title")}>
        <button
          type="button"
          role="tab"
          id="tab-tools-builtin"
          aria-selected={activeTab === "builtin"}
          aria-controls="panel-tools-builtin"
          className={`connections-tab-btn${activeTab === "builtin" ? " active" : ""}`}
          onClick={() => setActiveTab("builtin")}
        >
          <Cpu size={14} aria-hidden="true" />
          <span>{t("settings.tools.tabs.builtin")}</span>
          <span className="connections-tab-count">{BUILTIN_AGENT_TOOLS.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-tools-mcp"
          aria-selected={activeTab === "mcp"}
          aria-controls="panel-tools-mcp"
          className={`connections-tab-btn${activeTab === "mcp" ? " active" : ""}`}
          onClick={() => setActiveTab("mcp")}
        >
          <Server size={14} aria-hidden="true" />
          <span>{t("settings.tools.tabs.mcp")}</span>
          <span className="connections-tab-count">{mcp.servers.length}</span>
        </button>
      </div>

      {/* Tab 1: Built-in Native Tools */}
      {activeTab === "builtin" && (
        <div id="panel-tools-builtin" role="tabpanel" aria-labelledby="tab-tools-builtin" className="connections-tab-panel">
          {/* Permission Policy Banner */}
          <div className="connections-guide-banner">
            <div className="connections-guide-status">
              <div className="connections-guide-status-left">
                {writesLocked ? (
                  <Shield size={14} style={{ color: "var(--warning)" }} aria-hidden="true" />
                ) : isConfirm ? (
                  <ShieldAlert size={14} style={{ color: "var(--focus-ring)" }} aria-hidden="true" />
                ) : (
                  <Zap size={14} style={{ color: "var(--success)" }} aria-hidden="true" />
                )}
                <span>{t("settings.tools.access.title")}</span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>
                  {t(`settings.tools.access.${accessLevelKey}`)}
                </span>
              </div>
              {onSelectCategory && (
                <button
                  type="button"
                  className="secondary-button"
                  style={{ minHeight: 24, padding: "2px 8px", fontSize: 11 }}
                  onClick={() => onSelectCategory("agent")}
                >
                  <span>{t("settings.tools.access.configureBtn")}</span>
                </button>
              )}
            </div>
          </div>

          {/* Domain Filter Pills & Search */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 2, marginBottom: 2 }}>
            <div className="connections-shell-tabs" role="tablist" aria-label={t("settings.tools.filterLabel")}>
              <button
                type="button"
                className={`secondary-button connections-shell-tab${selectedDomain === "all" ? " active" : ""}`}
                aria-pressed={selectedDomain === "all"}
                onClick={() => setSelectedDomain("all")}
              >
                {t("settings.tools.filter.all")} ({BUILTIN_AGENT_TOOLS.length})
              </button>
              <button
                type="button"
                className={`secondary-button connections-shell-tab${selectedDomain === "mail" ? " active" : ""}`}
                aria-pressed={selectedDomain === "mail"}
                onClick={() => setSelectedDomain("mail")}
              >
                <Mail size={12} aria-hidden="true" style={{ marginRight: 4 }} />
                {t("settings.tools.filter.mail")} ({domainCounts.mail})
              </button>
              <button
                type="button"
                className={`secondary-button connections-shell-tab${selectedDomain === "calendar" ? " active" : ""}`}
                aria-pressed={selectedDomain === "calendar"}
                onClick={() => setSelectedDomain("calendar")}
              >
                <Calendar size={12} aria-hidden="true" style={{ marginRight: 4 }} />
                {t("settings.tools.filter.calendar")} ({domainCounts.calendar})
              </button>
              <button
                type="button"
                className={`secondary-button connections-shell-tab${selectedDomain === "contacts" ? " active" : ""}`}
                aria-pressed={selectedDomain === "contacts"}
                onClick={() => setSelectedDomain("contacts")}
              >
                <Users size={12} aria-hidden="true" style={{ marginRight: 4 }} />
                {t("settings.tools.filter.contacts")} ({domainCounts.contacts})
              </button>
              <button
                type="button"
                className={`secondary-button connections-shell-tab${selectedDomain === "system" ? " active" : ""}`}
                aria-pressed={selectedDomain === "system"}
                onClick={() => setSelectedDomain("system")}
              >
                <Wrench size={12} aria-hidden="true" style={{ marginRight: 4 }} />
                {t("settings.tools.filter.system")} ({domainCounts.system})
              </button>
            </div>

            {/* Quick Search */}
            <div style={{ position: "relative", minWidth: 200, flex: "0 1 220px" }}>
              <Search
                size={12}
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-faint)",
                  pointerEvents: "none",
                }}
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("settings.tools.search.placeholder")}
                style={{
                  width: "100%",
                  padding: "4px 26px 4px 26px",
                  fontSize: 11,
                  height: 28,
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  background: "var(--panel-muted)",
                  color: "var(--text)",
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  data-tooltip={t("settings.tools.search.clear")}
                  aria-label={t("settings.tools.search.clear")}
                  style={{
                    position: "absolute",
                    right: 6,
                    top: "50%",
                    transform: "translateY(-50%)",
                    background: "transparent",
                    border: 0,
                    padding: 2,
                    cursor: "pointer",
                    color: "var(--text-soft)",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {/* Tools Grid */}
          {filteredTools.length === 0 ? (
            <p className="settings-empty" role="status" style={{ padding: "32px 16px" }}>
              {t("settings.tools.emptyFilter")}
            </p>
          ) : (
            <div className="connections-tools-grid">
              {filteredTools.map((tool: BuiltinAgentTool) => {
                const isWrite = tool.type === "write";
                const isLocked = isWrite && writesLocked;
                const isConfirmTool = isWrite && isConfirm;

                let badgeLabel = t("settings.tools.tag.read");
                let badgeTooltip: string | undefined = undefined;

                if (isWrite) {
                  if (isLocked) {
                    badgeLabel = `${t("settings.tools.tag.write")} · ${t("settings.tools.tag.locked")}`;
                    badgeTooltip = t("settings.tools.tag.lockedTip");
                  } else if (isConfirmTool) {
                    badgeLabel = `${t("settings.tools.tag.write")} · ${t("settings.tools.tag.confirm")}`;
                    badgeTooltip = t("settings.tools.tag.confirmTip");
                  } else {
                    badgeLabel = t("settings.tools.tag.write");
                  }
                }

                return (
                  <div key={tool.name} className="connections-tool-card">
                    <div className="connections-tool-head">
                      <span className="connections-tool-name">{tool.name}</span>
                    </div>
                    <span className="connections-tool-desc">
                      {t(`settings.tools.builtin.${tool.descKey}.desc`)}
                    </span>
                    <div className="connections-tool-footer">
                      <span
                        className={`connections-tool-badge ${tool.type}${isLocked ? " locked" : ""}`}
                        data-tooltip={badgeTooltip}
                      >
                        {isLocked ? <Lock size={10} aria-hidden="true" /> : null}
                        {isConfirmTool ? <ShieldAlert size={10} aria-hidden="true" /> : null}
                        <span>{badgeLabel}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: MCP Server Extensions */}
      {activeTab === "mcp" && (
        <div id="panel-tools-mcp" role="tabpanel" aria-labelledby="tab-tools-mcp" data-models-card="mcp" className="connections-tab-panel">
          {mcp.loading && mcp.servers.length === 0 && (
            <p className="settings-empty" role="status">
              <LoaderCircle className="spin" size={14} aria-hidden="true" />
              {t("agent.mcpServers.loading")}
            </p>
          )}
          {!mcp.loading && mcp.servers.length === 0 && (
            <p className="settings-empty" role="status">
              {t("agent.mcpServers.empty")}
              <br />
              {t("agent.mcpServers.emptyDescription")}
            </p>
          )}
          {mcp.servers.map((server) => {
            const rowDeletePending = mcp.deletePendingId === server.id;
            const rowChecking = mcp.checkingId === server.id;
            return (
              <div key={server.id} className="setting-row" data-model-row="mcp" data-mcp-id={server.id}>
                <div>
                  <strong>
                    {server.label}
                    {!server.enabled && (
                      <span className="settings-model-badge disabled">
                        {t("agent.mcpServers.status.disabled")}
                      </span>
                    )}
                  </strong>
                  <span>{mcpSummary(server, t)}</span>
                </div>
                <div className="settings-row-actions">
                  <span className={`status-dot${mcpDotClass(server)}`} aria-hidden="true" />
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={mcpBusy}
                    onClick={() => void mcp.check(server)}
                  >
                    {rowChecking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
                    {t("agent.mcpServers.check")}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={mcpBusy}
                    onClick={() => mcp.startEdit(server)}
                  >
                    <Pencil size={13} />
                    {t("settings.models.edit")}
                  </button>
                  <button
                    className={`secondary-button danger-button${rowDeletePending ? " settings-model-delete-pending" : ""}`}
                    type="button"
                    disabled={mcpBusy}
                    onClick={() =>
                      rowDeletePending
                        ? void mcp.confirmDelete(server.id)
                        : mcp.requestDelete(server.id)
                    }
                  >
                    <Trash2 size={13} />
                    {rowDeletePending ? t("agent.mcpServers.deleteConfirm") : t("agent.mcpServers.delete")}
                  </button>
                </div>
              </div>
            );
          })}
          {mcp.deletePendingId !== null && (
            <p className="settings-model-delete-note">{t("agent.mcpServers.deletePrompt")}</p>
          )}
          <div className="settings-inline-actions">
            <button className="secondary-button" type="button" disabled={mcpBusy} onClick={mcp.startCreate}>
              <Plus size={15} />
              {t("agent.mcpServers.new")}
            </button>
          </div>
          {mcp.listError && (
            <ModelFeedbackLine
              feedback={{ kind: "error", message: mcp.listError, retry: () => mcp.retryList() }}
              retryLabel={t("agent.mcpServers.retry")}
              busy={mcpBusy}
            />
          )}
          {!mcp.editing && mcp.feedback && (
            <ModelFeedbackLine
              feedback={mcp.feedback}
              retryLabel={t("agent.mcpServers.retry")}
              busy={mcpBusy}
            />
          )}
        </div>
      )}

      {overlayHostRef?.current
        ? createPortal(formDialog, overlayHostRef.current)
        : formDialog}
    </section>
  );
}
