import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Code2,
  Download,
  Laptop,
  LoaderCircle,
  RefreshCw,
  Server,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import { triggerBlobDownload } from "../attachmentZip";
import type {
  AgentAccessLevel,
  AppSettings,
  AppSettingsPatch,
  Account,
} from "../types";
import type { ExternalPairingSummary } from "../agentTypes";
import type { Translate } from "../i18n";
import ThemedSelect from "../ThemedSelect";
import CopyButton from "../CopyButton";
import { agentAccessLevelOptions } from "./settings-utils";

export type SettingsConnectionsSectionProps = {
  t: Translate;
  formatDate: (iso: string) => string;
  accounts: Account[];
  currentSettings: AppSettings;
  controlsBusy: boolean;
  demoMode: boolean;
  applyOptimisticSettings: (patch: AppSettingsPatch, successMessage: string | null) => Promise<unknown>;
  requestAccessLevelChange: (patch: AppSettingsPatch, value: AgentAccessLevel, successMessage: string | null) => void;
  onOverlayOpenChange?: (open: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  overlayHostRef: RefObject<HTMLElement | null>;
};

type IdePreset = "claude" | "cursor" | "vscode" | "windsurf" | "generic";
type ShellKind = "powershell" | "cmd" | "bash";

/**
 * One stanza for every preset: the mcpServers block is byte-identical across
 * clients, only the file it lives in differs, so a copied config never depends
 * on which preset generated it.
 */
const IDE_MCP_SERVER_JSON = JSON.stringify(
  {
    mcpServers: {
      namimail: {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "namimail mcp start"],
      },
    },
  },
  null,
  2,
);

const IDE_CONFIGS: Record<IdePreset, {
  labelKey: string;
  pathHint: string;
  filename: string;
}> = {
  claude: {
    labelKey: "settings.connections.mcp.clientClaude",
    pathHint: "%APPDATA%\\Claude\\claude_desktop_config.json",
    filename: "claude_desktop_config.json",
  },
  cursor: {
    labelKey: "settings.connections.mcp.clientCursor",
    pathHint: ".cursor/mcp.json",
    filename: "mcp.json",
  },
  vscode: {
    labelKey: "settings.connections.mcp.clientVscode",
    pathHint: ".vscode/mcp.json",
    filename: "mcp.json",
  },
  windsurf: {
    labelKey: "settings.connections.mcp.clientWindsurf",
    pathHint: "~/.codeium/windsurf/mcp_config.json",
    filename: "mcp_config.json",
  },
  generic: {
    labelKey: "settings.connections.mcp.clientGeneric",
    pathHint: "mcpServers.json",
    filename: "mcpServers.json",
  },
};

/**
 * The tool catalogue the settings page shows. Names mirror the External Mail
 * v1 contract tables one-for-one (the installer smoke pins that contract at
 * exactly sixteen tools); descriptions live in the locale catalog under
 * `settings.connections.mcp.tool.<key>.desc` so they pass the parity check
 * like every other piece of user-facing copy.
 */
const EXPOSED_TOOLS = [
  { name: "namimail_accounts_list", type: "read", key: "accountsList" },
  { name: "namimail_folders_list", type: "read", key: "foldersList" },
  { name: "namimail_messages_list", type: "read", key: "messagesList" },
  { name: "namimail_messages_search", type: "read", key: "messagesSearch" },
  { name: "namimail_mail_summarize", type: "read", key: "mailSummarize" },
  { name: "namimail_message_get", type: "read", key: "messageGet" },
  { name: "namimail_messages_batch_get", type: "read", key: "messagesBatchGet" },
  { name: "namimail_threads_get", type: "read", key: "threadsGet" },
  { name: "namimail_attachments_list", type: "read", key: "attachmentsList" },
  { name: "namimail_draft_create", type: "write", key: "draftCreate" },
  { name: "namimail_draft_update", type: "write", key: "draftUpdate" },
  { name: "namimail_draft_delete", type: "write", key: "draftDelete" },
  { name: "namimail_messages_move", type: "write", key: "messagesMove" },
  { name: "namimail_messages_set_flag", type: "write", key: "messagesSetFlag" },
  { name: "namimail_messages_send", type: "write", key: "messagesSend" },
  { name: "namimail_mail_reply", type: "write", key: "mailReply" },
] as const;

const SHELL_LABEL_KEYS: Record<ShellKind, string> = {
  powershell: "settings.connections.cli.shellPowershell",
  cmd: "settings.connections.cli.shellCmd",
  bash: "settings.connections.cli.shellBash",
};

/** Pairing status → its locale key, so the row renderer cannot compose a key
 * the locale catalog does not carry. */
const PAIRING_STATUS_KEYS: Record<"active" | "revoked" | "expired", string> = {
  active: "settings.connections.pairings.statusActive",
  revoked: "settings.connections.pairings.statusRevoked",
  expired: "settings.connections.pairings.statusExpired",
};

/** The full quick-start script per shell, localized (comments included). */
const shellScriptKey = (shell: ShellKind): string => `settings.connections.cli.script.${shell}`;

const COMMON_CLI_COMMANDS = [
  { cmd: "namimail status", key: "status" },
  { cmd: "namimail pair", key: "pair" },
  { cmd: "namimail doctor", key: "doctor" },
  { cmd: "namimail accounts list", key: "accountsList" },
  { cmd: "namimail folders list", key: "foldersList" },
  { cmd: "namimail messages list", key: "messagesList" },
  { cmd: "namimail messages search", key: "messagesSearch" },
  { cmd: "namimail mail summarize", key: "mailSummarize" },
  { cmd: "namimail draft create", key: "draftCreate" },
  { cmd: "namimail messages send", key: "messagesSend" },
  { cmd: "namimail service start", key: "serviceStart" },
  { cmd: "namimail service stop", key: "serviceStop" },
] as const;

export default function SettingsConnectionsSection({
  t,
  formatDate,
  accounts,
  currentSettings,
  controlsBusy,
  demoMode,
  requestAccessLevelChange,
  onOverlayOpenChange,
  onBusyChange,
  overlayHostRef,
}: SettingsConnectionsSectionProps) {
  const [activeTab, setActiveTab] = useState<"mcp" | "cli" | "pairings">("mcp");
  const [selectedIde, setSelectedIde] = useState<IdePreset>("claude");
  const [selectedShell, setSelectedShell] = useState<ShellKind>("powershell");

  // Pairings State
  const [pairings, setPairings] = useState<ExternalPairingSummary[] | null>(null);
  const [pairingsLoading, setPairingsLoading] = useState(false);
  const [pairingsError, setPairingsError] = useState<string | null>(null);
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [revokingBusy, setRevokingBusy] = useState(false);
  const [feedbackNotice, setFeedbackNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const loadPairings = useCallback(async () => {
    if (demoMode) {
      setPairings([]);
      return;
    }
    setPairingsLoading(true);
    setPairingsError(null);
    try {
      const res = await api.agentPairings();
      setPairings(res.pairings);
    } catch (err) {
      setPairingsError(t("settings.connections.pairings.loadFailed", { error: String(err) }));
    } finally {
      setPairingsLoading(false);
    }
  }, [demoMode, t]);

  useEffect(() => {
    void loadPairings();
  }, [loadPairings]);

  // Overlay & Busy propagation
  const isOverlayOpen = Boolean(pendingRevokeId);
  useEffect(() => {
    onOverlayOpenChange?.(isOverlayOpen);
    return () => onOverlayOpenChange?.(false);
  }, [isOverlayOpen, onOverlayOpenChange]);

  const isBusy = revokingBusy || controlsBusy;
  useEffect(() => {
    onBusyChange?.(isBusy);
    return () => onBusyChange?.(false);
  }, [isBusy, onBusyChange]);

  const handleDownloadConfig = (preset: IdePreset) => {
    triggerBlobDownload(new Blob([IDE_MCP_SERVER_JSON], { type: "application/json;charset=utf-8" }), IDE_CONFIGS[preset].filename);
  };

  const handleRevokePairing = async (clientId: string) => {
    if (demoMode) {
      setPairings((list) => list?.filter((p) => p.clientId !== clientId) ?? []);
      setPendingRevokeId(null);
      setFeedbackNotice({ kind: "success", message: t("settings.connections.pairings.revokeSuccess") });
      return;
    }
    setRevokingBusy(true);
    try {
      await api.deleteAgentPairing(clientId);
      setFeedbackNotice({ kind: "success", message: t("settings.connections.pairings.revokeSuccess") });
      setPendingRevokeId(null);
      await loadPairings();
    } catch (err) {
      setFeedbackNotice({
        kind: "error",
        message: t("settings.connections.pairings.revokeFailed", { error: String(err) }),
      });
    } finally {
      setRevokingBusy(false);
    }
  };

  const activePairingsCount = useMemo(() => {
    return pairings?.filter((p) => p.status === "active").length ?? 0;
  }, [pairings]);

  /** Write tools answer to the entry point's tier, so the catalogue can say
   * *why* a write tool is listed but not callable instead of leaving the user
   * to discover the tier gate through a failed call. */
  const mcpWritesLocked = currentSettings.agentMcpAccessLevel === "read-only";

  return (
    <section className="settings-section" data-settings-nav="connections" aria-labelledby="connections-settings">
      <div className="settings-section-title">
        <Cable size={16} />
        <div>
          <span id="connections-settings">
            {t("settings.connections.title")}
            <span
              className="field-help-icon"
              data-tooltip={t("settings.connections.description")}
              aria-label={t("settings.connections.description")}
              tabIndex={0}
            >
              <CircleHelp size={12} aria-hidden="true" />
            </span>
          </span>
        </div>
      </div>

      {feedbackNotice && (
        <div className={`form-status ${feedbackNotice.kind}`} role="alert" style={{ marginBottom: 12 }}>
          {feedbackNotice.kind === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          <span>{feedbackNotice.message}</span>
          <button
            type="button"
            className="icon-button"
            style={{ marginLeft: "auto", minHeight: "auto", padding: 2 }}
            onClick={() => setFeedbackNotice(null)}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Primary Sub-Navigation */}
      <div className="connections-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "mcp"}
          className={`connections-tab-btn${activeTab === "mcp" ? " active" : ""}`}
          onClick={() => setActiveTab("mcp")}
        >
          <Server size={13} />
          <span>{t("settings.connections.tabs.mcp")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "cli"}
          className={`connections-tab-btn${activeTab === "cli" ? " active" : ""}`}
          onClick={() => setActiveTab("cli")}
        >
          <Terminal size={13} />
          <span>{t("settings.connections.tabs.cli")}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "pairings"}
          className={`connections-tab-btn${activeTab === "pairings" ? " active" : ""}`}
          onClick={() => setActiveTab("pairings")}
        >
          <Shield size={13} />
          <span>{t("settings.connections.tabs.pairings")}</span>
          {activePairingsCount > 0 && (
            <span className="connections-tab-count">{activePairingsCount}</span>
          )}
        </button>
      </div>

      {/* Tab 1: External AI MCP Server */}
      {activeTab === "mcp" && (
        <div className="connections-tab-panel">
          {/* Streamlined Setup Steps Banner */}
          <div className="connections-guide-banner">
            <div className="connections-guide-status">
              <div className="connections-guide-status-left">
                <span className="status-dot online" aria-hidden="true" />
                <span>{t("settings.connections.mcp.brokerActive")}</span>
              </div>
              <div className="connections-perm-inline">
                <label htmlFor="agent-mcp-access-level-conn" className="connections-perm-label">
                  <span>{t("settings.connections.mcp.accessLevelTitle")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.accessLevelDesc")}
                    aria-label={t("settings.connections.mcp.accessLevelDesc")}
                    tabIndex={0}
                  >
                    <CircleHelp size={11} aria-hidden="true" />
                  </span>
                </label>
                <ThemedSelect
                  id="agent-mcp-access-level-conn"
                  containerClassName="connections-compact-select"
                  value={currentSettings.agentMcpAccessLevel}
                  aria-label={t("settings.connections.mcp.accessLevelTitle")}
                  disabled={controlsBusy}
                  onValueChange={(value) => requestAccessLevelChange({ agentMcpAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, null)}
                >
                  {agentAccessLevelOptions.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </ThemedSelect>
              </div>
            </div>

            <div className="connections-steps-row">
              <div className="connections-step-pill">
                <span className="connections-step-num">1</span>
                <span className="connections-step-text">
                  <span className="connections-step-title">{t("settings.connections.mcp.step1Title")}</span>
                  {activePairingsCount > 0 ? (
                    <span className="connections-step-done">
                      <Check size={10} aria-hidden="true" />
                      {t("settings.connections.mcp.step1Done")}
                    </span>
                  ) : null}
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.step1Desc")}
                    aria-label={t("settings.connections.mcp.step1Desc")}
                    tabIndex={0}
                  >
                    <CircleHelp size={11} aria-hidden="true" />
                  </span>
                </span>
                <CopyButton
                  className="secondary-button connections-inline-copy settings-copy-btn"
                  text="namimail pair"
                  label={<code>namimail pair</code>}
                  ariaLabel={t("settings.connections.mcp.copyCommand")}
                  tooltip={t("settings.connections.mcp.copyCommand")}
                  announcement={t("settings.connections.mcp.copiedCommand")}
                  size={10}
                />
              </div>

              <div className="connections-step-pill">
                <span className="connections-step-num">2</span>
                <span className="connections-step-text">
                  <span>{t("settings.connections.mcp.step2Title")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.step2Desc")}
                    aria-label={t("settings.connections.mcp.step2Desc")}
                    tabIndex={0}
                  >
                    <CircleHelp size={11} aria-hidden="true" />
                  </span>
                </span>
              </div>

              <div className="connections-step-pill">
                <span className="connections-step-num">3</span>
                <span className="connections-step-text">
                  <span>{t("settings.connections.mcp.step3Title")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.step3Desc")}
                    aria-label={t("settings.connections.mcp.step3Desc")}
                    tabIndex={0}
                  >
                    <CircleHelp size={11} aria-hidden="true" />
                  </span>
                </span>
              </div>
            </div>
          </div>

          {/* IDE Config Selector */}
          <div className="connections-subheading">
            <span className="connections-title-with-help">
              <span>{t("settings.connections.mcp.clientConfigTitle")}</span>
              <span
                className="field-help-icon"
                data-tooltip={t("settings.connections.mcp.clientConfigSubtitle")}
                aria-label={t("settings.connections.mcp.clientConfigSubtitle")}
                tabIndex={0}
              >
                <CircleHelp size={12} aria-hidden="true" />
              </span>
            </span>
          </div>

          <div className="connections-ide-tabs" role="tablist">
            {(["claude", "cursor", "vscode", "windsurf", "generic"] as const).map((key) => {
              const active = selectedIde === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`secondary-button connections-shell-tab${active ? " active" : ""}`}
                  onClick={() => setSelectedIde(key)}
                >
                  {t(IDE_CONFIGS[key].labelKey)}
                </button>
              );
            })}
          </div>

          {/* IDE Config Code Card */}
          <div className="connections-code-card">
            <div className="connections-code-meta">
              <span className="connections-code-path">
                <Code2 size={12} />
                <code>{IDE_CONFIGS[selectedIde].pathHint}</code>
              </span>
              <div className="connections-code-actions">
                <CopyButton
                  className="secondary-button settings-copy-btn"
                  text={IDE_CONFIGS[selectedIde].pathHint}
                  ariaLabel={t("settings.connections.mcp.copyPath")}
                  copiedAriaLabel={t("settings.connections.mcp.copiedPath")}
                  label={t("settings.connections.mcp.copyPath")}
                  copiedLabel={t("settings.connections.mcp.copiedPath")}
                  announcement={t("settings.connections.mcp.copiedPath")}
                  size={12}
                />
                <CopyButton
                  className="secondary-button settings-copy-btn"
                  text={IDE_MCP_SERVER_JSON}
                  ariaLabel={t("settings.connections.mcp.copyJson")}
                  copiedAriaLabel={t("settings.connections.mcp.copiedJson")}
                  label={t("settings.connections.mcp.copyJson")}
                  copiedLabel={t("settings.connections.mcp.copiedJson")}
                  announcement={t("settings.connections.mcp.copiedJson")}
                  size={12}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => handleDownloadConfig(selectedIde)}
                >
                  <Download size={12} />
                  <span>{t("settings.connections.mcp.downloadJson")}</span>
                </button>
              </div>
            </div>
            <pre className="connections-code-block">
              <code>{IDE_MCP_SERVER_JSON}</code>
            </pre>
          </div>

          {/* Exposed Tools Catalog */}
          <details className="connections-collapsible">
            <summary>
              <div className="connections-collapsible-summary-text">
                <span className="connections-collapsible-title">
                  <span>{t("settings.connections.mcp.toolsTitle")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.toolsDesc")}
                    aria-label={t("settings.connections.mcp.toolsDesc")}
                    tabIndex={0}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CircleHelp size={12} aria-hidden="true" />
                  </span>
                </span>
              </div>
              <ChevronDown className="connections-collapsible-chevron" size={15} aria-hidden="true" />
            </summary>
            <div className="connections-collapsible-body">
              <div className="connections-tools-grid">
                {EXPOSED_TOOLS.map((tool) => (
                  <div key={tool.name} className="connections-tool-card">
                    <div className="connections-tool-head">
                      <span className="connections-tool-name">{tool.name}</span>
                      <span
                      className={`connections-tool-badge ${tool.type}`}
                      title={tool.type === "write" && mcpWritesLocked ? t("settings.connections.mcp.writeLocked") : undefined}
                    >
                      {tool.type === "read"
                        ? t("settings.connections.mcp.tagRead")
                        : `${t("settings.connections.mcp.tagWrite")}${mcpWritesLocked ? ` · ${t("settings.connections.mcp.writeLocked")}` : ""}`}
                    </span>
                    </div>
                    <span className="connections-tool-desc">{t(`settings.connections.mcp.tool.${tool.key}.desc`)}</span>
                  </div>
                ))}
              </div>
            </div>
          </details>
        </div>
      )}

      {/* Tab 2: External Terminal CLI */}
      {activeTab === "cli" && (
        <div className="connections-tab-panel">
          {/* Multi-Shell Tabs and Inlined Permission */}
          <div className="connections-subheading">
            <span className="connections-title-with-help">
              <span>{t("settings.connections.cli.quickstartTitle")}</span>
              <span
                className="field-help-icon"
                data-tooltip={t("settings.connections.cli.desc")}
                aria-label={t("settings.connections.cli.desc")}
                tabIndex={0}
              >
                <CircleHelp size={12} aria-hidden="true" />
              </span>
            </span>
          </div>

          <div className="connections-toolbar-row">
            <div className="connections-shell-tabs">
              {(["powershell", "cmd", "bash"] as const).map((shell) => {
                const active = selectedShell === shell;
                return (
                  <button
                    key={shell}
                    type="button"
                    className={`secondary-button connections-shell-tab${active ? " active" : ""}`}
                    onClick={() => setSelectedShell(shell)}
                  >
                    {t(SHELL_LABEL_KEYS[shell])}
                  </button>
                );
              })}
            </div>

            <div className="connections-perm-inline">
              <label htmlFor="agent-cli-access-level-conn" className="connections-perm-label">
                <span>{t("settings.connections.cli.accessLevelTitle")}</span>
                <span
                  className="field-help-icon"
                  data-tooltip={t("settings.connections.cli.accessLevelDesc")}
                  aria-label={t("settings.connections.cli.accessLevelDesc")}
                  tabIndex={0}
                >
                  <CircleHelp size={11} aria-hidden="true" />
                </span>
              </label>
              <ThemedSelect
                id="agent-cli-access-level-conn"
                containerClassName="connections-compact-select"
                value={currentSettings.agentCliAccessLevel}
                aria-label={t("settings.connections.cli.accessLevelTitle")}
                disabled={controlsBusy}
                onValueChange={(value) => requestAccessLevelChange({ agentCliAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, null)}
              >
                {agentAccessLevelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                ))}
              </ThemedSelect>
            </div>
          </div>
          <div className="connections-shell-wrap">
            <CopyButton
              className="secondary-button connections-shell-copy-btn settings-copy-btn"
              text={t(shellScriptKey(selectedShell))}
              ariaLabel={t("settings.connections.cli.copyScript")}
              copiedAriaLabel={t("settings.connections.cli.copiedScript")}
              label={t("settings.connections.cli.copyScript")}
              copiedLabel={t("settings.connections.cli.copiedScript")}
              announcement={t("settings.connections.cli.copiedScript")}
              size={12}
            />
            <pre className="connections-code-block">
              <code>{t(shellScriptKey(selectedShell))}</code>
            </pre>
          </div>

          {/* Common CLI Commands Collapsible */}
          <details className="connections-collapsible">
            <summary>
              <div className="connections-collapsible-summary-text">
                <span className="connections-collapsible-title">
                  <span>{t("settings.connections.cli.commandsTitle")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.cli.commandsDesc")}
                    aria-label={t("settings.connections.cli.commandsDesc")}
                    tabIndex={0}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CircleHelp size={12} aria-hidden="true" />
                  </span>
                </span>
              </div>
              <ChevronDown className="connections-collapsible-chevron" size={15} aria-hidden="true" />
            </summary>
            <div className="connections-collapsible-body">
              <div className="connections-cmd-list">
                {COMMON_CLI_COMMANDS.map((item) => (
                  <div key={item.cmd} className="connections-cmd-row">
                    <div className="connections-cmd-left">
                      <code className="connections-cmd-code">{item.cmd}</code>
                      <span className="connections-cmd-desc">{t(`settings.connections.cli.cmd.${item.key}.desc`)}</span>
                    </div>
                    <CopyButton
                      className="secondary-button settings-copy-btn"
                      text={item.cmd}
                      ariaLabel={t("settings.connections.mcp.copyCommand")}
                      tooltip={t("settings.connections.mcp.copyCommand")}
                      announcement={t("settings.connections.mcp.copiedCommand")}
                      style={{ minHeight: 26, padding: "2px 8px" }}
                      size={12}
                    />
                  </div>
                ))}
              </div>
            </div>
          </details>

          {/* Headless Service Card */}
          <div className="connections-service-card">
            <div className="connections-service-card-head">
              <Laptop size={14} />
              <span className="connections-title-with-help">
                <span>{t("settings.connections.cli.serviceStatus")}</span>
                <span
                  className="field-help-icon"
                  data-tooltip={t("settings.connections.cli.serviceHint")}
                  aria-label={t("settings.connections.cli.serviceHint")}
                  tabIndex={0}
                >
                  <CircleHelp size={12} aria-hidden="true" />
                </span>
              </span>
            </div>
            <div className="connections-service-cmds">
              <code>namimail service start</code>
              <code>namimail service stop</code>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Authorized Client Pairings */}
      {activeTab === "pairings" && (
        <div className="connections-tab-panel">
          <div className="setting-row">
            <div>
              <strong className="connections-title-with-help">
                <span>{t("settings.connections.pairings.title")}</span>
                <span
                  className="field-help-icon"
                  data-tooltip={t("settings.connections.pairings.desc")}
                  aria-label={t("settings.connections.pairings.desc")}
                  tabIndex={0}
                >
                  <CircleHelp size={12} aria-hidden="true" />
                </span>
              </strong>
            </div>
            <button
              type="button"
              className="secondary-button"
              style={{ flexShrink: 0 }}
              disabled={pairingsLoading || isBusy}
              onClick={() => void loadPairings()}
            >
              <RefreshCw size={12} className={pairingsLoading ? "spin" : ""} />
              <span>{t("settings.connections.pairings.refresh")}</span>
            </button>
          </div>

          {pairingsError ? (
            <p className="external-pairings-empty" role="alert">{pairingsError}</p>
          ) : pairingsLoading && pairings === null ? (
            <p className="external-pairings-empty" role="status">
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
              {t("common.loading")}
            </p>
          ) : !pairings || pairings.length === 0 ? (
            <div className="connections-empty-card">
              <Shield size={28} style={{ color: "var(--text-faint)", marginBottom: 4 }} />
              <strong>{t("settings.connections.pairings.empty")}</strong>
              <div className="connections-step-cmd">
                <code>namimail pair</code>
                <CopyButton
                  className="secondary-button settings-copy-btn"
                  text="namimail pair"
                  ariaLabel={t("settings.connections.mcp.copyCommand")}
                  copiedAriaLabel={t("settings.connections.mcp.copiedCommand")}
                  label={t("settings.connections.mcp.copyCommand")}
                  copiedLabel={t("settings.connections.mcp.copiedCommand")}
                  announcement={t("settings.connections.mcp.copiedCommand")}
                  size={11}
                />
              </div>
            </div>
          ) : (
            <ul className="external-pairings-list" style={{ marginTop: 8 }}>
              {pairings.map((pairing) => {
                const currentIds = new Set(accounts.map((acc) => acc.id));
                const drifted = pairing.status === "active"
                  && (pairing.accountIds.length !== currentIds.size || pairing.accountIds.some((id) => !currentIds.has(id)));
                return (
                  <li key={pairing.clientId} className={`external-pairing-row external-pairing-${pairing.status}`}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="external-pairing-id" title={pairing.clientId}>
                          {pairing.clientId.slice(0, 22)}…
                        </span>
                        <span className="external-pairing-status">
                          {t(PAIRING_STATUS_KEYS[pairing.status])}
                        </span>
                        {drifted && (
                          <span className="external-pairing-drift">
                            {t("settings.connections.pairings.drift")}
                          </span>
                        )}
                      </div>
                      <span className="external-pairing-meta">
                        {t("settings.connections.pairings.created", { date: formatDate(pairing.createdAt) })}
                        {pairing.expiresAt ? ` · ${t("settings.connections.pairings.expires", { date: formatDate(pairing.expiresAt) })}` : ""}
                        {` · ${t("settings.connections.pairings.accountsCount", { count: pairing.accountIds.length })}`}
                      </span>
                    </div>

                    <div className="external-pairing-actions">
                      {pairing.status === "active" && (
                        <button
                          type="button"
                          className="danger-button"
                          style={{ minHeight: 26, padding: "2px 8px", fontSize: 11 }}
                          disabled={isBusy}
                          onClick={() => setPendingRevokeId(pairing.clientId)}
                        >
                          <Trash2 size={12} />
                          <span>{t("settings.connections.pairings.revoke")}</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Revoke Confirmation Dialog */}
      {pendingRevokeId && overlayHostRef.current && createPortal(
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => e.target === e.currentTarget && !revokingBusy && setPendingRevokeId(null)}
        >
          <div className="modal-card confirmation-card" role="alertdialog" aria-modal="true">
            <div className="confirmation-card-head">
              <AlertCircle size={18} className="confirmation-card-icon" />
              <h3>{t("settings.connections.pairings.revokeConfirmTitle")}</h3>
            </div>
            <p className="confirmation-card-description">
              {t("settings.connections.pairings.revokeConfirmDesc", { id: pendingRevokeId.slice(0, 16) })}
            </p>
            <div className="confirmation-card-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={revokingBusy}
                onClick={() => setPendingRevokeId(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={revokingBusy}
                onClick={() => handleRevokePairing(pendingRevokeId)}
              >
                {revokingBusy ? <LoaderCircle size={12} className="spin" /> : <Trash2 size={12} />}
                <span>{revokingBusy ? t("settings.connections.pairings.revoking") : t("settings.connections.pairings.revokeConfirmAction")}</span>
              </button>
            </div>
          </div>
        </div>,
        overlayHostRef.current,
      )}
    </section>
  );
}
