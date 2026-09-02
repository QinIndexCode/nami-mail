import {
  BookOpen,
  Bot,
  LoaderCircle,
  MessageSquareReply,
  MessageSquareX,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { Translate } from "../i18n";
import type { Account, AgentAccessLevel, AppSettings } from "../types";
import type { ExternalPairingSummary } from "../agentTypes";
import AutoReplyScopeEditor from "../AutoReplyScopeEditor";
import {
  agentAccessLevelOptions,
  externalCliGuideCode,
  externalMcpGuideCode,
  externalServiceGuideCode,
  externalDocsUrl,
  copyGuideTextToClipboard,
} from "./settings-utils";
import { ExternalGuideBlock, NumberStepper, Switch } from "./SettingsUIComponents";
import ThemedSelect from "../ThemedSelect";

export type SettingsAgentSectionProps = {
  t: Translate;
  formatDate: (value: string) => string;
  accounts: Account[];
  currentSettings: AppSettings;
  controlsBusy: boolean;
  demoMode: boolean;
  requestAgentProviderSettings: () => void;
  requestAccessLevelChange: (patch: { agentAccessLevel?: AgentAccessLevel; agentCliAccessLevel?: AgentAccessLevel; agentMcpAccessLevel?: AgentAccessLevel }, value: AgentAccessLevel, successMessage: string | null) => void;
  applyOptimisticSettings: (patch: Record<string, unknown>, successMessage: string | null) => Promise<unknown>;
  externalGuideCopied: string | null;
  setExternalGuideCopied: React.Dispatch<React.SetStateAction<string | null>>;
  externalPairings: ExternalPairingSummary[] | null;
  externalPairingsError: unknown;
  setExternalPairingsReload: React.Dispatch<React.SetStateAction<number>>;
  setAutoReplyDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setAutoReplyDecisionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMemoryDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export default function SettingsAgentSection({
  t,
  formatDate,
  accounts,
  currentSettings,
  controlsBusy,
  demoMode,
  requestAgentProviderSettings,
  requestAccessLevelChange,
  applyOptimisticSettings,
  externalGuideCopied,
  setExternalGuideCopied,
  externalPairings,
  externalPairingsError,
  setExternalPairingsReload,
  setAutoReplyDialogOpen,
  setAutoReplyDecisionsOpen,
  setMemoryDialogOpen,
}: SettingsAgentSectionProps) {
  const copyExternalGuide = (text: string, id: string) => {
    void copyGuideTextToClipboard(text).then((copied) => {
      if (!copied) return;
      setExternalGuideCopied(id);
      window.setTimeout(() => {
        setExternalGuideCopied((current) => current === id ? null : current);
      }, 1_800);
    });
  };

  return (
    <section className="settings-section" data-settings-nav="agent" aria-labelledby="agent-settings">
      <div className="settings-section-title">
        <Bot size={16} />
        <div><span>{t("agent.launch")}</span><p id="agent-settings">{demoMode ? t("agent.demo.description") : t("agent.providers.description")}</p></div>
      </div>
      {demoMode ? (
        <p className="settings-empty" role="status">{t("agent.demo.actionUnavailable")}</p>
      ) : (
        <>
          <div className="setting-row agent-provider-settings-row">
            <div>
              <strong>{t("agent.providers.title")}</strong>
              <span>{t("agent.providers.emptyDescription")}</span>
            </div>
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={requestAgentProviderSettings}>
              <Wrench size={15} />{t("agent.providers.configure")}
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>{t("settings.agent.toolRoundLimit")}</strong>
              <span>{t("settings.agent.toolRoundLimitDesc")}</span>
            </div>
            <NumberStepper
              value={currentSettings.agentToolRoundLimit}
              min={1}
              max={50}
              disabled={controlsBusy}
              decreaseLabel={t("settings.agent.toolRoundLimitDecrease")}
              increaseLabel={t("settings.agent.toolRoundLimitIncrease")}
              onChange={(value) => void applyOptimisticSettings({ agentToolRoundLimit: value }, null)}
            />
          </div>
          <div className="setting-subheading"><span>{t("settings.agent.autoReplyGroup")}</span><small>{t("settings.agent.autoReplyGroupDesc")}</small></div>
          <Switch
            checked={currentSettings.autoReply.enabled}
            disabled={controlsBusy}
              label={t("settings.agent.autoReplyEnabled")}
              description={t("settings.agent.autoReplyEnabledDesc")}
              onChange={() => void applyOptimisticSettings(
                { autoReply: { ...currentSettings.autoReply, enabled: !currentSettings.autoReply.enabled } },
                null,
              )}
            />
            {currentSettings.autoReply.enabled && (
              <>
                <div className="setting-row setting-column-row">
                  <div>
                    <strong>{t("settings.agent.autoReplyAccounts")}</strong>
                    <span>{t("settings.agent.autoReplyAccountsDesc")}</span>
                  </div>
                  <div className="auto-reply-account-list" role="group" aria-label={t("settings.agent.autoReplyAccounts")}>
                    {accounts.length === 0 && <p className="settings-empty">{t("settings.agent.autoReplyNoAccounts")}</p>}
                    {accounts.map((account) => {
                      const checked = currentSettings.autoReply.accountIds.includes(account.id);
                      return (
                        <label className="accounts-row-check" key={account.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={controlsBusy}
                            onChange={() => {
                              const accountIds = checked
                                ? currentSettings.autoReply.accountIds.filter((id) => id !== account.id)
                                : [...currentSettings.autoReply.accountIds, account.id];
                              void applyOptimisticSettings({ autoReply: { ...currentSettings.autoReply, accountIds } }, null);
                            }}
                            aria-label={t("settings.agent.autoReplyAccountAriaLabel", { email: account.email })}
                          />
                          {account.email}
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="setting-row setting-column-row">
                  <div>
                    <strong>{t("settings.agent.autoReplyMode")}</strong>
                    <span>{t("settings.agent.autoReplyModeDesc")}</span>
                  </div>
                  <div className="auto-reply-mode-toggle" role="group" aria-label={t("settings.agent.autoReplyMode")}>
                    <button
                      className={`secondary-button${currentSettings.autoReply.mode === "llm" ? " active" : ""}`}
                      type="button"
                      disabled={controlsBusy}
                      onClick={() => void applyOptimisticSettings(
                        { autoReply: { ...currentSettings.autoReply, mode: "llm" } },
                        null,
                      )}
                    >
                      {t("settings.agent.autoReplyModeLlm")}
                    </button>
                    <button
                      className={`secondary-button${currentSettings.autoReply.mode === "template" ? " active" : ""}`}
                      type="button"
                      disabled={controlsBusy}
                      onClick={() => void applyOptimisticSettings(
                        { autoReply: { ...currentSettings.autoReply, mode: "template" } },
                        null,
                      )}
                    >
                      {t("settings.agent.autoReplyModeTemplate")}
                    </button>
                  </div>
                </div>
                {currentSettings.autoReply.mode === "template" && (
                  <>
                    <div className="setting-row setting-column-row">
                      <div>
                        <strong>{t("settings.agent.autoReplyTemplate")}</strong>
                        <span>{t("settings.agent.autoReplyTemplateDesc")}</span>
                      </div>
                      <textarea
                        className="auto-reply-template-input"
                        value={currentSettings.autoReply.template.text}
                        rows={5}
                        maxLength={2000}
                        disabled={controlsBusy}
                        placeholder={t("settings.agent.autoReplyTemplatePlaceholder")}
                        aria-label={t("settings.agent.autoReplyTemplate")}
                        onChange={(event) => void applyOptimisticSettings(
                          { autoReply: { ...currentSettings.autoReply, template: { ...currentSettings.autoReply.template, text: event.target.value } } },
                          null,
                        )}
                      />
                      <p className="auto-reply-template-hint">{t("settings.agent.autoReplyTemplateHint")}</p>
                    </div>
                    <Switch
                      checked={currentSettings.autoReply.template.skipConfirmation}
                      disabled={controlsBusy}
                      label={t("settings.agent.autoReplySkipConfirmation")}
                      description={t("settings.agent.autoReplySkipConfirmationDesc")}
                      onChange={() => void applyOptimisticSettings(
                        { autoReply: { ...currentSettings.autoReply, template: { ...currentSettings.autoReply.template, skipConfirmation: !currentSettings.autoReply.template.skipConfirmation } } },
                        null,
                      )}
                    />
                  </>
                )}
                <AutoReplyScopeEditor
                  scope={currentSettings.autoReply.scope}
                  disabled={controlsBusy}
                  onChange={(scope) => void applyOptimisticSettings(
                    { autoReply: { ...currentSettings.autoReply, scope } },
                    null,
                  )}
                />
                <div className="setting-row">
                  <div>
                    <strong>{t("settings.agent.autoReplyDailyLimit")}</strong>
                    <span>{t("settings.agent.autoReplyDailyLimitDesc")}</span>
                  </div>
                  <NumberStepper
                    value={currentSettings.autoReply.dailyLimitPerAccount}
                    min={0}
                    max={500}
                    disabled={controlsBusy}
                    decreaseLabel={t("settings.agent.autoReplyDailyLimitDecrease")}
                    increaseLabel={t("settings.agent.autoReplyDailyLimitIncrease")}
                    onChange={(value) => void applyOptimisticSettings(
                      { autoReply: { ...currentSettings.autoReply, dailyLimitPerAccount: value } },
                      null,
                    )}
                  />
                </div>
              </>
            )}
            <div className="setting-row agent-tools-row">
              <div>
                <strong>{t("settings.agent.autoReplyTools")}</strong>
                <span>{t("settings.agent.autoReplyToolsDesc")}</span>
              </div>
              <div className="agent-tools-actions">
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setAutoReplyDialogOpen(true)}>
                  <MessageSquareReply size={15} />{t("settings.agent.autoReplyToolsPending")}
                </button>
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setAutoReplyDecisionsOpen(true)}>
                  <MessageSquareX size={15} />{t("settings.agent.autoReplyToolsDeclined")}
                </button>
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setMemoryDialogOpen(true)}>
                  <BookOpen size={15} />{t("settings.agent.autoReplyToolsMemory")}
                </button>
              </div>
            </div>
        </>
      )}
      <div className="setting-subheading"><span>{t("settings.agent.accessLevelGroup")}</span><small>{t("settings.agent.accessLevelGroupDesc")}</small></div>
      <label className="setting-select-row" htmlFor="agent-access-level">
        <span><strong>{t("settings.agent.builtinAccessLevel")}</strong><small>{t("settings.agent.builtinAccessLevelDesc")}</small></span>
        <ThemedSelect
          id="agent-access-level"
          value={currentSettings.agentAccessLevel}
          aria-label={t("settings.agent.builtinAccessLevel")}
          disabled={controlsBusy}
          onValueChange={(value) => requestAccessLevelChange({ agentAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, null)}
        >
          {agentAccessLevelOptions.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </ThemedSelect>
      </label>
      <label className="setting-select-row" htmlFor="agent-cli-access-level">
        <span><strong>{t("settings.agent.cliAccessLevel")}</strong><small>{t("settings.agent.cliAccessLevelDesc")}</small></span>
        <ThemedSelect
          id="agent-cli-access-level"
          value={currentSettings.agentCliAccessLevel}
          aria-label={t("settings.agent.cliAccessLevel")}
          disabled={controlsBusy}
          onValueChange={(value) => requestAccessLevelChange({ agentCliAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, null)}
        >
          {agentAccessLevelOptions.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </ThemedSelect>
      </label>
      <label className="setting-select-row" htmlFor="agent-mcp-access-level">
        <span><strong>{t("settings.agent.mcpAccessLevel")}</strong><small>{t("settings.agent.mcpAccessLevelDesc")}</small></span>
        <ThemedSelect
          id="agent-mcp-access-level"
          value={currentSettings.agentMcpAccessLevel}
          aria-label={t("settings.agent.mcpAccessLevel")}
          disabled={controlsBusy}
          onValueChange={(value) => requestAccessLevelChange({ agentMcpAccessLevel: value as AgentAccessLevel }, value as AgentAccessLevel, null)}
        >
          {agentAccessLevelOptions.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </ThemedSelect>
      </label>
      <div className="setting-subheading"><span>{t("settings.agent.externalGuide.title")}</span><small>{t("settings.agent.externalGuide.desc")}</small></div>
      <div className="external-guide">
        <p className="external-guide-note">{t("settings.agent.externalGuide.steps.intro")}</p>
        <ol className="external-guide-steps">
          <li>{t("settings.agent.externalGuide.steps.1")}</li>
          <li>{t("settings.agent.externalGuide.steps.2")} <code>namimail service start</code></li>
          <li>{t("settings.agent.externalGuide.steps.3")}</li>
          <li>{t("settings.agent.externalGuide.steps.4")}</li>
        </ol>
        <ExternalGuideBlock
          id="cli"
          label={t("settings.agent.externalGuide.cli.label")}
          hint={t("settings.agent.externalGuide.cli.hint", { cmd: "namimail accounts list" })}
          code={externalCliGuideCode}
          copiedId={externalGuideCopied}
          onCopy={copyExternalGuide}
        />
        <ExternalGuideBlock
          id="mcp"
          label={t("settings.agent.externalGuide.mcp.label")}
          hint={t("settings.agent.externalGuide.mcp.hint")}
          code={externalMcpGuideCode}
          copiedId={externalGuideCopied}
          onCopy={copyExternalGuide}
        />
        <ExternalGuideBlock
          id="service"
          label={t("settings.agent.externalGuide.service.label")}
          hint={t("settings.agent.externalGuide.service.hint")}
          code={externalServiceGuideCode}
          copiedId={externalGuideCopied}
          onCopy={copyExternalGuide}
        />
        <p className="external-guide-docs">{t("settings.agent.externalGuide.docs")}<a href={externalDocsUrl} target="_blank" rel="noopener noreferrer">github.com/QinIndexCode/nami-mail</a></p>
      </div>
      <div className="setting-subheading">
        <span>{t("settings.agent.externalPairings.title")}</span>
        <small>{t("settings.agent.externalPairings.desc")}</small>
      </div>
      <div className="external-pairings">
        {externalPairingsError ? (
          <p className="external-pairings-empty">{t("settings.agent.externalPairings.loadError")}</p>
        ) : externalPairings === null ? (
          <p className="external-pairings-empty" role="status"><LoaderCircle className="spin" size={13} aria-hidden="true" />{t("common.loading")}</p>
        ) : externalPairings.length === 0 ? (
          <p className="external-pairings-empty">{t("settings.agent.externalPairings.empty", { cmd: "namimail pair" })}</p>
        ) : (
          <ul className="external-pairings-list">
            {externalPairings.map((pairing) => {
              const currentIds = new Set(accounts.map((account) => account.id));
              const drifted = pairing.status === "active"
                && (pairing.accountIds.length !== currentIds.size || pairing.accountIds.some((id) => !currentIds.has(id)));
              return (
                <li key={pairing.clientId} className={`external-pairing-row external-pairing-${pairing.status}`}>
                  <span className="external-pairing-id" title={pairing.clientId}>{pairing.clientId.slice(0, 20)}</span>
                  <span className="external-pairing-meta">
                    {t("settings.agent.externalPairings.created", { date: formatDate(pairing.createdAt) })}
                    {pairing.expiresAt ? ` · ${t("settings.agent.externalPairings.expires", { date: formatDate(pairing.expiresAt) })}` : ""}
                    {` · ${t("settings.agent.externalPairings.accountCount", { count: pairing.accountIds.length })}`}
                  </span>
                  <span className="external-pairing-status">{t(`settings.agent.externalPairings.status.${pairing.status}`)}</span>
                  {drifted ? <span className="external-pairing-drift">{t("settings.agent.externalPairings.drift")}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button
        className="secondary-button external-pairings-refresh"
        type="button"
        onClick={() => setExternalPairingsReload((value) => value + 1)}
      >
        {t("settings.agent.externalPairings.refresh")}
      </button>
    </section>
  );
}
