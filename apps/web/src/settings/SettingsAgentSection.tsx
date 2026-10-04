import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Bot,
  Cable,
  CircleHelp,
  FlaskConical,
  MessageSquareReply,
  MessageSquareX,
  Wrench,
} from "lucide-react";
import { api } from "../api";
import type { Translate } from "../i18n";
import type { Account, AgentAccessLevel, AppSettings } from "../types";
import type { AgentProviderSummary, ExternalPairingSummary } from "../agentTypes";
import AutoReplyScopeEditor from "../AutoReplyScopeEditor";
import { agentAccessLevelOptions } from "./settings-utils";
import { NumberStepper, Switch } from "./SettingsUIComponents";
import ThemedSelect from "../ThemedSelect";

export type SettingsAgentSectionProps = {
  t: Translate;
  formatDate: (value: string) => string;
  accounts: Account[];
  currentSettings: AppSettings;
  controlsBusy: boolean;
  demoMode: boolean;
  /** Switches the settings modal to the models category in place. */
  openModelSettings: () => void;
  openConnectionsSettings?: () => void;
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
  setAutoReplySandboxOpen: React.Dispatch<React.SetStateAction<boolean>>;
  overlayHostRef?: React.RefObject<HTMLElement | null>;
};

export default function SettingsAgentSection({
  t,
  accounts,
  currentSettings,
  controlsBusy,
  demoMode,
  openModelSettings,
  openConnectionsSettings,
  requestAccessLevelChange,
  applyOptimisticSettings,
  setAutoReplyDialogOpen,
  setAutoReplyDecisionsOpen,
  setMemoryDialogOpen,
  setAutoReplySandboxOpen,
  overlayHostRef,
}: SettingsAgentSectionProps) {
  const [providers, setProviders] = useState<AgentProviderSummary[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (demoMode) {
      setProviders([]);
      setDefaultProviderId(null);
      return undefined;
    }
    let active = true;
    api.agentProviders().then((res) => {
      if (active) {
        setProviders(res.items);
        setDefaultProviderId(res.defaultProviderId);
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [demoMode]);

  const defaultProvider = useMemo(
    () => providers.find((p) => p.id === defaultProviderId),
    [providers, defaultProviderId],
  );

  const modelSelectOptions = useMemo(() => {
    const defaultLabel = defaultProvider
      ? `${t("settings.agent.autoReplyFollowDefault")} (${defaultProvider.label})`
      : t("settings.agent.autoReplyFollowDefault");
    const options: Array<{ value: string; label: string }> = [{ value: "", label: defaultLabel }];
    for (const p of providers) {
      if (p.configured) {
        options.push({
          value: p.id,
          label: `${p.label} (${p.model})${p.id === defaultProviderId ? ` · ${t("agent.providers.defaultBadge")}` : ""}`,
        });
      }
    }
    const currentDecision = currentSettings.autoReply.decisionProviderId;
    if (currentDecision && !options.some((opt) => opt.value === currentDecision)) {
      options.push({ value: currentDecision, label: currentDecision });
    }
    const currentDraft = currentSettings.autoReply.draftProviderId;
    if (currentDraft && !options.some((opt) => opt.value === currentDraft)) {
      options.push({ value: currentDraft, label: currentDraft });
    }
    return options;
  }, [providers, defaultProvider, defaultProviderId, currentSettings.autoReply.decisionProviderId, currentSettings.autoReply.draftProviderId, t]);

  return (
    <section className="settings-section" data-settings-nav="agent" aria-labelledby="agent-settings">
      <div className="settings-section-title">
        <Bot size={16} />
        <div>
          <span id="agent-settings">
            {t("agent.launch")}
            <span
              className="field-help-icon"
              data-tooltip={demoMode ? t("agent.demo.description") : t("agent.providers.description")}
              aria-label={demoMode ? t("agent.demo.description") : t("agent.providers.description")}
              tabIndex={0}
            >
              <CircleHelp size={12} aria-hidden="true" />
            </span>
          </span>
        </div>
      </div>
      {demoMode ? (
        <p className="settings-empty" role="status">{t("agent.demo.actionUnavailable")}</p>
      ) : (
        <>
          <div className="setting-row">
            <div>
              <strong>
                {t("agent.providers.title")}
                <span
                  className="field-help-icon"
                  data-tooltip={t("agent.providers.emptyDescription")}
                  aria-label={t("agent.providers.emptyDescription")}
                  tabIndex={0}
                >
                  <CircleHelp size={12} aria-hidden="true" />
                </span>
              </strong>
            </div>
            <button className="secondary-button" type="button" disabled={controlsBusy} onClick={openModelSettings}>
              <Wrench size={15} />{t("agent.providers.configure")}
            </button>
          </div>
          <div className="setting-row">
            <div>
              <strong>
                {t("settings.agent.toolRoundLimit")}
                <span className="field-help-icon" data-tooltip={t("settings.agent.toolRoundLimitDesc")} aria-label={t("settings.agent.toolRoundLimitDesc")} tabIndex={0}>
                  <CircleHelp size={12} aria-hidden="true" />
                </span>
              </strong>
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
          <div className="setting-subheading"><span>{t("settings.agent.autoReplyGroup")}</span></div>
          {currentSettings.autoReplyInvalid && (
            <p className="form-status error" role="alert">{t("settings.agent.autoReplyInvalidWarning")}</p>
          )}
          <Switch
            checked={currentSettings.autoReply.enabled}
            disabled={controlsBusy}
              label={t("settings.agent.autoReplyEnabled")}
              onChange={() => void applyOptimisticSettings(
                { autoReply: { ...currentSettings.autoReply, enabled: !currentSettings.autoReply.enabled } },
                null,
              )}
            />
            {currentSettings.autoReply.enabled && (
              <>
                <div className="setting-row setting-column-row">
                  <div>
                    <strong>
                      {t("settings.agent.autoReplyAccounts")}
                      <span
                        className="field-help-icon"
                        data-tooltip={t("settings.agent.autoReplyAccountsDesc")}
                        aria-label={t("settings.agent.autoReplyAccountsDesc")}
                        tabIndex={0}
                      >
                        <CircleHelp size={12} aria-hidden="true" />
                      </span>
                    </strong>
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
                {currentSettings.autoReply.mode === "llm" && (
                  <>
                    <label className="setting-select-row" htmlFor="agent-auto-reply-decision-provider">
                      <span>
                        <strong>
                          {t("settings.agent.autoReplyDecisionProvider")}
                          <span
                            className="field-help-icon"
                            data-tooltip={t("settings.agent.autoReplyDecisionProviderDesc")}
                            aria-label={t("settings.agent.autoReplyDecisionProviderDesc")}
                            tabIndex={0}
                          >
                            <CircleHelp size={12} aria-hidden="true" />
                          </span>
                        </strong>
                      </span>
                      <ThemedSelect
                        id="agent-auto-reply-decision-provider"
                        value={currentSettings.autoReply.decisionProviderId ?? ""}
                        aria-label={t("settings.agent.autoReplyDecisionProvider")}
                        disabled={controlsBusy}
                        onValueChange={(value) => void applyOptimisticSettings(
                          { autoReply: { ...currentSettings.autoReply, decisionProviderId: value || null } },
                          null,
                        )}
                      >
                        {modelSelectOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </ThemedSelect>
                    </label>
                    <label className="setting-select-row" htmlFor="agent-auto-reply-draft-provider">
                      <span>
                        <strong>
                          {t("settings.agent.autoReplyDraftProvider")}
                          <span
                            className="field-help-icon"
                            data-tooltip={t("settings.agent.autoReplyDraftProviderDesc")}
                            aria-label={t("settings.agent.autoReplyDraftProviderDesc")}
                            tabIndex={0}
                          >
                            <CircleHelp size={12} aria-hidden="true" />
                          </span>
                        </strong>
                      </span>
                      <ThemedSelect
                        id="agent-auto-reply-draft-provider"
                        value={currentSettings.autoReply.draftProviderId ?? ""}
                        aria-label={t("settings.agent.autoReplyDraftProvider")}
                        disabled={controlsBusy}
                        onValueChange={(value) => void applyOptimisticSettings(
                          { autoReply: { ...currentSettings.autoReply, draftProviderId: value || null } },
                          null,
                        )}
                      >
                        {modelSelectOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </ThemedSelect>
                    </label>
                  </>
                )}
                {currentSettings.autoReply.mode === "template" && (
                  <>
                    <div className="setting-row setting-column-row">
                      <div>
                        <strong>
                          {t("settings.agent.autoReplyTemplate")}
                          <span
                            className="field-help-icon"
                            data-tooltip={t("settings.agent.autoReplyTemplateHint")}
                            aria-label={t("settings.agent.autoReplyTemplateHint")}
                            tabIndex={0}
                          >
                            <CircleHelp size={12} aria-hidden="true" />
                          </span>
                        </strong>
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
                    </div>
                    <Switch
                      checked={currentSettings.autoReply.template.skipConfirmation}
                      disabled={controlsBusy}
                      label={t("settings.agent.autoReplySkipConfirmation")}
                      tooltip={t("settings.agent.autoReplySkipConfirmationDesc")}
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
                  overlayHostRef={overlayHostRef}
                  onChange={(scope) => void applyOptimisticSettings(
                    { autoReply: { ...currentSettings.autoReply, scope } },
                    null,
                  )}
                />
                <div className="setting-row">
                  <div>
                    <strong>
                      {t("settings.agent.autoReplyDailyLimit")}
                      <span className="field-help-icon" data-tooltip={t("settings.agent.autoReplyDailyLimitDesc")} aria-label={t("settings.agent.autoReplyDailyLimitDesc")} tabIndex={0}>
                        <CircleHelp size={12} aria-hidden="true" />
                      </span>
                    </strong>
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
                <button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setAutoReplySandboxOpen(true)}>
                  <FlaskConical size={15} />{t("settings.agent.autoReplyToolsSandbox")}
                </button>
              </div>
            </div>
        </>
      )}
      <div className="setting-subheading"><span>{t("settings.agent.accessLevelGroup")}</span></div>
      <label className="setting-select-row" htmlFor="agent-access-level">
        <span><strong>{t("settings.agent.builtinAccessLevel")}</strong></span>
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
      {openConnectionsSettings && (
        <div className="agent-connections-card">
          <div className="agent-connections-card-icon">
            <Cable size={18} />
          </div>
          <div className="agent-connections-card-content">
            <strong>{t("settings.connections.agentLink.title")}</strong>
            <p>{t("settings.connections.agentLink.banner")}</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={openConnectionsSettings}
          >
            <Cable size={13} />
            <span>{t("settings.connections.agentLink.action")}</span>
          </button>
        </div>
      )}
    </section>
  );
}
