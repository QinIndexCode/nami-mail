import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Code2,
  Copy,
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
import { agentAccessLevelOptions, copyTextToClipboard } from "./settings-utils";

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

const IDE_CONFIGS: Record<IdePreset, {
  labelKey: string;
  pathHint: string;
  filename: string;
  json: string;
}> = {
  claude: {
    labelKey: "settings.connections.mcp.clientClaude",
    pathHint: "%APPDATA%\\Claude\\claude_desktop_config.json",
    filename: "claude_desktop_config.json",
    json: JSON.stringify(
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
    ),
  },
  cursor: {
    labelKey: "settings.connections.mcp.clientCursor",
    pathHint: ".cursor/mcp.json",
    filename: "mcp.json",
    json: JSON.stringify(
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
    ),
  },
  vscode: {
    labelKey: "settings.connections.mcp.clientVscode",
    pathHint: ".vscode/mcp.json",
    filename: "mcp.json",
    json: JSON.stringify(
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
    ),
  },
  windsurf: {
    labelKey: "settings.connections.mcp.clientWindsurf",
    pathHint: "~/.codeium/windsurf/mcp_config.json",
    filename: "mcp_config.json",
    json: JSON.stringify(
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
    ),
  },
  generic: {
    labelKey: "settings.connections.mcp.clientGeneric",
    pathHint: "mcpServers.json",
    filename: "mcpServers.json",
    json: JSON.stringify(
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
    ),
  },
};

const EXPOSED_TOOLS = [
  { name: "namimail_accounts_list", type: "read", descZh: "列出已获批授权的邮箱账户与同步状态", descEn: "List configured email accounts and sync state" },
  { name: "namimail_folders_list", type: "read", descZh: "列出指定账户的邮箱文件夹与树状层级", descEn: "List folders and mailbox tree for an account" },
  { name: "namimail_messages_list", type: "read", descZh: "查询指定文件夹的邮件列表（支持分页、未读筛选）", descEn: "List messages in a folder with paging and filters" },
  { name: "namimail_messages_search", type: "read", descZh: "全文检索邮件（支持发件人、主题、正文、时间范围）", descEn: "Search messages by sender, subject, body, or date range" },
  { name: "namimail_mail_summarize", type: "read", descZh: "分析邮件并提取摘要与待办待处理事项", descEn: "Analyze email content and generate structured summary" },
  { name: "namimail_message_get", type: "read", descZh: "读取指定邮件的完整正文内容与元数据", descEn: "Fetch full message content, body, and headers" },
  { name: "namimail_messages_batch_get", type: "read", descZh: "单次批量读取多封邮件内容（最多 10 封）", descEn: "Batch fetch multiple messages in a single call (up to 10)" },
  { name: "namimail_threads_get", type: "read", descZh: "读取完整邮件来往会话线程与上下文", descEn: "Retrieve complete email conversation thread" },
  { name: "namimail_attachments_list", type: "read", descZh: "查询指定邮件的附件元数据列表", descEn: "List attachment metadata for a given message" },
  { name: "namimail_draft_create", type: "write", descZh: "创建新邮件草稿", descEn: "Create a new draft message" },
  { name: "namimail_draft_update", type: "write", descZh: "更新草稿的主题、收件人或正文内容", descEn: "Update subject, recipients, or body of a draft" },
  { name: "namimail_draft_delete", type: "write", descZh: "删除指定草稿", descEn: "Delete an existing draft message" },
  { name: "namimail_messages_move", type: "write", descZh: "将邮件移动到其他文件夹（如归档、废纸篓）", descEn: "Move message to folder (archive, trash, etc.)" },
  { name: "namimail_messages_set_flag", type: "write", descZh: "修改邮件标志（标为已读/未读、星标）", descEn: "Set message flags (read, unread, starred)" },
  { name: "namimail_messages_send", type: "write", descZh: "直接发送新邮件", descEn: "Send an email immediately" },
  { name: "namimail_mail_reply", type: "write", descZh: "基于原邮件生成并发送回复", descEn: "Reply to an email thread directly" },
] as const;

const SHELL_SCRIPTS: Record<ShellKind, string> = {
  powershell: `# 1. 检查宿主状态与当前配对活跃情况
namimail status

# 2. 为当前终端发起客户端配对授权（首次需在桌面窗口批准）
namimail pair

# 3. 列出已授权的邮箱账户
namimail accounts list

# 4. 全文检索最近邮件
namimail messages search "发票" --limit 5

# 5. 调用本地 AI 生成邮件内容摘要
namimail mail summarize --message <message_id>`,

  cmd: `rem 1. 检查宿主状态
namimail status

rem 2. 为当前终端发起客户端配对授权
namimail pair

rem 3. 列出授权的邮箱账户
namimail accounts list

rem 4. 全文检索最近邮件
namimail messages search "发票" --limit 5`,

  bash: `# 1. Check AgentHost status and active pairings
namimail status

# 2. Authorize terminal pairing with Nami Mail desktop
namimail pair

# 3. List authorized accounts
namimail accounts list

# 4. Search recent messages
namimail messages search "invoice" --limit 5`,
};

const COMMON_CLI_COMMANDS = [
  { cmd: "namimail status", descZh: "查看 AgentHost 运行状态与配对活跃情况", descEn: "Check AgentHost status and active pairings" },
  { cmd: "namimail pair", descZh: "为当前终端发起客户端配对授权（必要前置）", descEn: "Pair current terminal client with desktop broker" },
  { cmd: "namimail doctor", descZh: "全面诊断本地数据库、网络与 Broker 通信", descEn: "Diagnose local database, broker, and network" },
  { cmd: "namimail accounts list", descZh: "列出已获批授权的全部邮箱账户及同步状态", descEn: "List all authorized accounts and sync states" },
  { cmd: "namimail folders list", descZh: "查询指定邮箱账户的文件夹与树状层级", descEn: "List mailbox folders for an account" },
  { cmd: "namimail messages list", descZh: "查询最近收到的邮件元数据列表", descEn: "List recent messages in mailbox" },
  { cmd: "namimail messages search", descZh: "全文检索邮件（支持主题、发件人、正文）", descEn: "Search messages across mailbox" },
  { cmd: "namimail mail summarize", descZh: "调用本地 AI 提取邮件要点与待办事项", descEn: "Summarize a message using local AI" },
  { cmd: "namimail draft create", descZh: "在指定账户中创建新邮件草稿", descEn: "Create a new draft in mailbox" },
  { cmd: "namimail messages send", descZh: "发送邮件（需对应写操作权限许可）", descEn: "Send an email (requires write permissions)" },
  { cmd: "namimail service start", descZh: "在无界面环境中显式启动后台服务（AgentHost）", descEn: "Start headless AgentHost background service" },
  { cmd: "namimail service stop", descZh: "停止后台运行的 AgentHost 服务", descEn: "Stop headless AgentHost background service" },
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
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
      setPairingsError(t("settings.connections.pairings.revokeFailed", { error: String(err) }));
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

  const copyResetTimer = useRef<number | null>(null);
  const [copyAnnouncement, setCopyAnnouncement] = useState("");

  useEffect(() => {
    return () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    };
  }, []);

  const handleCopy = (id: string, text: string, announcement?: string) => {
    void copyTextToClipboard(text).then((copied) => {
      if (!copied) return;
      setCopiedId(id);
      if (announcement) setCopyAnnouncement(announcement);
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1_500);
    });
  };

  const handleDownloadConfig = (preset: IdePreset) => {
    triggerBlobDownload(new Blob([IDE_CONFIGS[preset].json], { type: "application/json;charset=utf-8" }), IDE_CONFIGS[preset].filename);
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

  const isZh = t("settings.nav.connections.title") === "外部连接";

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
      <span className="visually-hidden" role="status" aria-live="polite">{copyAnnouncement}</span>

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
                  <span>{t("settings.connections.mcp.step1Title")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("settings.connections.mcp.step1Desc")}
                    aria-label={t("settings.connections.mcp.step1Desc")}
                    tabIndex={0}
                  >
                    <CircleHelp size={11} aria-hidden="true" />
                  </span>
                </span>
                <button
                  type="button"
                  className={`secondary-button connections-inline-copy settings-copy-btn${copiedId === "step-pair" ? " copied" : ""}`}
                  onClick={() => handleCopy("step-pair", "namimail pair", t("settings.connections.mcp.copiedCommand"))}
                  title={t("settings.connections.mcp.copyCommand")}
                  aria-label={t("settings.connections.mcp.copyCommand")}
                >
                  <code>namimail pair</code>
                  {copiedId === "step-pair" ? <Check size={10} aria-hidden="true" /> : <Copy size={10} aria-hidden="true" />}
                </button>
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
                <button
                  type="button"
                  className={`secondary-button settings-copy-btn${copiedId === `path-${selectedIde}` ? " copied" : ""}`}
                  onClick={() => handleCopy(`path-${selectedIde}`, IDE_CONFIGS[selectedIde].pathHint, t("settings.connections.mcp.copiedPath"))}
                  aria-label={copiedId === `path-${selectedIde}` ? t("settings.connections.mcp.copiedPath") : t("settings.connections.mcp.copyPath")}
                >
                  {copiedId === `path-${selectedIde}` ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                  <span>{copiedId === `path-${selectedIde}` ? t("settings.connections.mcp.copiedPath") : t("settings.connections.mcp.copyPath")}</span>
                </button>
                <button
                  type="button"
                  className={`secondary-button settings-copy-btn${copiedId === `json-${selectedIde}` ? " copied" : ""}`}
                  onClick={() => handleCopy(`json-${selectedIde}`, IDE_CONFIGS[selectedIde].json, t("settings.connections.mcp.copiedJson"))}
                  aria-label={copiedId === `json-${selectedIde}` ? t("settings.connections.mcp.copiedJson") : t("settings.connections.mcp.copyJson")}
                >
                  {copiedId === `json-${selectedIde}` ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                  <span>{copiedId === `json-${selectedIde}` ? t("settings.connections.mcp.copiedJson") : t("settings.connections.mcp.copyJson")}</span>
                </button>
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
              <code>{IDE_CONFIGS[selectedIde].json}</code>
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
                      <span className={`connections-tool-badge ${tool.type}`}>
                        {tool.type === "read" ? t("settings.connections.mcp.tagRead") : t("settings.connections.mcp.tagWrite")}
                      </span>
                    </div>
                    <span className="connections-tool-desc">{isZh ? tool.descZh : tool.descEn}</span>
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
                    {t(`settings.connections.cli.shell${shell.charAt(0).toUpperCase() + shell.slice(1)}` as any)}
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
            <button
              type="button"
              className={`secondary-button connections-shell-copy-btn settings-copy-btn${copiedId === `shell-${selectedShell}` ? " copied" : ""}`}
              onClick={() => handleCopy(`shell-${selectedShell}`, SHELL_SCRIPTS[selectedShell], t("settings.connections.cli.copiedScript"))}
              aria-label={copiedId === `shell-${selectedShell}` ? t("settings.connections.cli.copiedScript") : t("settings.connections.cli.copyScript")}
            >
              {copiedId === `shell-${selectedShell}` ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              <span>{copiedId === `shell-${selectedShell}` ? t("settings.connections.cli.copiedScript") : t("settings.connections.cli.copyScript")}</span>
            </button>
            <pre className="connections-code-block">
              <code>{SHELL_SCRIPTS[selectedShell]}</code>
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
                      <span className="connections-cmd-desc">{isZh ? item.descZh : item.descEn}</span>
                    </div>
                    <button
                      type="button"
                      className={`secondary-button settings-copy-btn${copiedId === item.cmd ? " copied" : ""}`}
                      style={{ minHeight: 26, padding: "2px 8px" }}
                      title={t("settings.connections.mcp.copyCommand")}
                      aria-label={t("settings.connections.mcp.copyCommand")}
                      onClick={() => handleCopy(item.cmd, item.cmd, t("settings.connections.mcp.copiedCommand"))}
                    >
                      {copiedId === item.cmd ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    </button>
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
              <div className="connections-step-cmd" style={{ marginTop: 6 }}>
                <code>namimail pair</code>
                <button
                  type="button"
                  className={`secondary-button settings-copy-btn${copiedId === "empty-pair" ? " copied" : ""}`}
                  style={{ minHeight: 24, padding: "2px 8px", fontSize: 11 }}
                  onClick={() => handleCopy("empty-pair", "namimail pair", t("settings.connections.mcp.copiedCommand"))}
                  aria-label={copiedId === "empty-pair" ? t("settings.connections.mcp.copiedCommand") : t("settings.connections.mcp.copyCommand")}
                >
                  {copiedId === "empty-pair" ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
                  <span>{copiedId === "empty-pair" ? t("settings.connections.mcp.copiedCommand") : t("settings.connections.mcp.copyCommand")}</span>
                </button>
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
                          {t(`settings.connections.pairings.status${pairing.status.charAt(0).toUpperCase() + pairing.status.slice(1)}` as any)}
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
