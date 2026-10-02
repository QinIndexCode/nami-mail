import { CircleAlert, Eye, EyeOff } from "lucide-react";
import type { AgentProviderKind } from "../agentTypes";
import type { Translate } from "../i18n";
import ThemedSelect from "../ThemedSelect";
import { Switch } from "./SettingsUIComponents";
import { ModelField, SettingsModelFormDialog } from "./SettingsModelDialog";
import { providerFormIsLocal, providerKindMetadata } from "./settings-models";
import type { ModelProvidersController } from "./useSettingsModels";

/** Kind order mirrors the old dialog's protocol select. */
const PROVIDER_KIND_OPTIONS: ReadonlyArray<{ kind: AgentProviderKind; labelKey: string }> = [
  { kind: "openai-compatible", labelKey: "agent.providers.kind.openaiCompatible" },
  { kind: "ollama", labelKey: "agent.providers.kind.ollama" },
  { kind: "anthropic", labelKey: "agent.providers.kind.anthropic" },
  { kind: "gemini", labelKey: "agent.providers.kind.gemini" },
  { kind: "openai-responses", labelKey: "agent.providers.kind.openaiResponses" },
];

export type SettingsModelProviderDialogProps = {
  t: Translate;
  providers: ModelProvidersController;
  onBusyChange: (busy: boolean) => void;
};

/**
 * Add / edit one model connection. The list row stays inert — every control
 * lives here, so a half-filled form can never be mistaken for a saved one.
 */
export default function SettingsModelProviderDialog({
  t,
  providers,
  onBusyChange,
}: SettingsModelProviderDialogProps) {
  const { form } = providers;
  const kindMeta = providerKindMetadata[form.kind];
  const isLocal = providerFormIsLocal(form);
  const isCurrentDefault = providers.selectedProvider?.id === providers.defaultProviderId;
  const editing = providers.selectedProvider !== null;
  const busy = providers.saving || providers.checkingId !== null;

  return (
    <SettingsModelFormDialog
      busy={busy}
      dirty={providers.formDirty}
      t={t}
      eyebrow={editing ? t("agent.providers.form.editEyebrow") : t("agent.providers.form.newEyebrow")}
      title={editing ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}
      hint={t("settings.models.providers.formHint")}
      labelledBy="models-provider-form-title"
      formId="provider"
      feedback={providers.feedback}
      retryLabel={t("agent.providers.retry")}
      submitLabel={t("agent.providers.save")}
      busyLabel={t("agent.providers.savingAndChecking")}
      cancelLabel={t("common.cancel")}
      onBusyChange={onBusyChange}
      onClose={providers.cancelEdit}
      onSubmit={() => void providers.save()}
      fields={
        <>
          <ModelField id="agent-provider-kind" label={t("agent.providers.fields.kind")} hint={t("agent.providers.fields.kindHint")}>
            <ThemedSelect
              id="agent-provider-kind"
              value={form.kind}
              aria-label={t("agent.providers.fields.kind")}
              disabled={busy}
              onValueChange={(value) => providers.updateKind(value as AgentProviderKind)}
            >
              {PROVIDER_KIND_OPTIONS.map(({ kind, labelKey }) => <option key={kind} value={kind}>{t(labelKey)}</option>)}
            </ThemedSelect>
          </ModelField>

          <ModelField id="agent-provider-label" label={t("agent.providers.fields.label")} hint={t("agent.providers.fields.labelHint")}>
            <input
              id="agent-provider-label"
              type="text"
              value={form.label}
              maxLength={128}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => providers.updateForm("label", event.target.value)}
            />
          </ModelField>

          <ModelField id="agent-provider-endpoint" label={t("agent.providers.fields.endpoint")} hint={t(kindMeta.endpointHintKey)}>
            <input
              id="agent-provider-endpoint"
              type="text"
              value={form.endpoint}
              placeholder={kindMeta.endpointSuggestion || t("agent.providers.fields.endpointPlaceholder")}
              disabled={busy}
              autoComplete="url"
              spellCheck={false}
              onChange={(event) => providers.updateForm("endpoint", event.target.value)}
            />
          </ModelField>

          <ModelField id="agent-provider-model" label={t("agent.providers.fields.model")} hint={t("agent.providers.fields.modelHint")}>
            <input
              id="agent-provider-model"
              type="text"
              value={form.model}
              placeholder={kindMeta.modelPlaceholder}
              maxLength={256}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => providers.updateForm("model", event.target.value)}
            />
          </ModelField>

          <ModelField id="agent-provider-key" label={t("agent.providers.fields.apiKey")} hint={editing && providers.selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}>
            <span className="settings-secret-input">
              <input
                id="agent-provider-key"
                type={providers.keyVisible ? "text" : "password"}
                value={form.apiKey}
                disabled={busy || form.clearApiKey}
                autoComplete="new-password"
                spellCheck={false}
                aria-label={t("agent.providers.fields.apiKey")}
                placeholder={editing && providers.selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyKeep") : t("agent.providers.fields.apiKeyPlaceholder")}
                onChange={(event) => providers.updateForm("apiKey", event.target.value)}
              />
              <button
                className="icon-button"
                type="button"
                disabled={busy || form.clearApiKey}
                aria-label={providers.keyVisible ? t("agent.providers.fields.hideKey") : t("agent.providers.fields.showKey")}
                aria-pressed={providers.keyVisible}
                onClick={providers.toggleKeyVisible}
              >
                {providers.keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </span>
          </ModelField>

          {editing && providers.selectedProvider?.apiKeyConfigured && (
            <Switch
              checked={form.clearApiKey}
              disabled={busy || Boolean(form.apiKey)}
              label={t("agent.providers.fields.clearApiKey")}
              onChange={() => providers.updateForm("clearApiKey", !form.clearApiKey)}
            />
          )}

          <Switch
            checked={form.allowCloudMailContent}
            disabled={busy || isLocal}
            label={t("agent.providers.cloud.title")}
            description={isLocal ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}
            onChange={() => providers.updateForm("allowCloudMailContent", !form.allowCloudMailContent)}
          />

          <Switch
            checked={form.makeDefault}
            disabled={busy || isCurrentDefault}
            label={t("agent.providers.default.title")}
            description={isCurrentDefault ? t("agent.providers.default.current") : t("agent.providers.default.description")}
            onChange={() => providers.updateForm("makeDefault", !form.makeDefault)}
          />

          <ModelField id="agent-provider-timeout" label={t("agent.providers.fields.timeout")} hint={t("agent.providers.fields.timeoutHint")}>
            <input
              id="agent-provider-timeout"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={form.timeoutMs}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => providers.updateForm("timeoutMs", event.target.value)}
            />
          </ModelField>

          {providers.touched && providers.validationMessage && (
            <p className="settings-note" role="status"><CircleAlert size={13} aria-hidden="true" />{providers.validationMessage}</p>
          )}
        </>
      }
    />
  );
}