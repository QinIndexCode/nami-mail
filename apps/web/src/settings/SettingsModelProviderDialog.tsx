import { useState } from "react";
import { Check, ChevronDown, CircleAlert, CircleHelp, Eye, EyeOff, Lock } from "lucide-react";
import type { AgentProviderKind, ModelInputModalities } from "../agentTypes";
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

const MODALITY_ITEMS: ReadonlyArray<{
  key: keyof ModelInputModalities;
  labelKey: string;
  hintKey: string;
}> = [
  { key: "image", labelKey: "agent.providers.modalities.image", hintKey: "agent.providers.modalities.imageHint" },
  { key: "video", labelKey: "agent.providers.modalities.video", hintKey: "agent.providers.modalities.videoHint" },
  { key: "audio", labelKey: "agent.providers.modalities.audio", hintKey: "agent.providers.modalities.audioHint" },
  { key: "pdf", labelKey: "agent.providers.modalities.pdf", hintKey: "agent.providers.modalities.pdfHint" },
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

  const [advancedOpen, setAdvancedOpen] = useState(() =>
    Boolean(form.modalities.image || form.modalities.video || form.modalities.audio || form.modalities.pdf)
  );

  return (
    <SettingsModelFormDialog
      busy={busy}
      dirty={providers.formDirty}
      t={t}
      title={editing ? t("agent.providers.form.editTitle") : t("agent.providers.form.newTitle")}
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
          <div className="calendar-field-grid">
            <ModelField id="agent-provider-kind" label={t("agent.providers.fields.kind")} help={t("agent.providers.fields.kindHint")}>
              <ThemedSelect
                id="agent-provider-kind"
                className="settings-model-select"
                value={form.kind}
                aria-label={t("agent.providers.fields.kind")}
                disabled={busy}
                onValueChange={(value) => providers.updateKind(value as AgentProviderKind)}
              >
                {PROVIDER_KIND_OPTIONS.map(({ kind, labelKey }) => <option key={kind} value={kind}>{t(labelKey)}</option>)}
              </ThemedSelect>
            </ModelField>

            <ModelField id="agent-provider-label" label={t("agent.providers.fields.label")}>
              <input
                id="agent-provider-label"
                type="text"
                value={form.label}
                maxLength={128}
                disabled={busy}
                autoComplete="off"
                placeholder={form.kind === "ollama" ? "本机 Ollama" : "例如：DeepSeek V3"}
                onChange={(event) => providers.updateForm("label", event.target.value)}
              />
            </ModelField>
          </div>

          <div className="calendar-field-grid">
            <ModelField id="agent-provider-model" label={t("agent.providers.fields.model")}>
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

            <ModelField id="agent-provider-endpoint" label={t("agent.providers.fields.endpoint")} help={t(kindMeta.endpointHintKey)}>
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
          </div>

          <ModelField id="agent-provider-key" label={t("agent.providers.fields.apiKey")} help={editing && providers.selectedProvider?.apiKeyConfigured ? t("agent.providers.fields.apiKeyConfigured") : t("agent.providers.fields.apiKeyOptional")}>
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

          {/* Advanced Settings Header Toggle */}
          <div style={{ marginTop: 2, marginBottom: 2 }}>
            <button
              type="button"
              className="settings-model-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((prev) => !prev)}
              style={{
                background: "transparent",
                border: "none",
                padding: "6px 0",
                color: "var(--text-soft)",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <ChevronDown
                size={14}
                style={{
                  transition: "transform 0.28s cubic-bezier(0.16, 1, 0.3, 1)",
                  transform: advancedOpen ? "rotate(0deg)" : "rotate(-90deg)",
                }}
                aria-hidden="true"
              />
              <span>{t("agent.providers.advanced.title")}</span>
            </button>
          </div>

          {/* Collapsible Container with smooth grid-template-rows animation */}
          <div
            className={`settings-model-advanced-wrapper ${advancedOpen ? "open" : ""}`}
            style={{
              display: "grid",
              gridTemplateRows: advancedOpen ? "1fr" : "0fr",
              transition: "grid-template-rows 0.32s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease",
              opacity: advancedOpen ? 1 : 0,
            }}
          >
            <div
              className="settings-model-advanced-inner"
              style={{
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                paddingTop: advancedOpen ? "4px" : 0,
                paddingBottom: advancedOpen ? "4px" : 0,
              }}
            >
              {/* Input Types (输入类型) Pills */}
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", fontWeight: 550, color: "var(--text)" }}>
                  <span>{t("agent.providers.modalities.title")}</span>
                  <span
                    className="field-help-icon"
                    data-tooltip={t("agent.providers.modalities.hint")}
                    aria-label={t("agent.providers.modalities.hint")}
                    tabIndex={0}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <CircleHelp size={12} aria-hidden="true" />
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {/* Locked Text Pill */}
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    aria-checked="true"
                    role="checkbox"
                    data-tooltip={t("agent.providers.modalities.textLocked")}
                    style={{
                      background: "var(--panel-muted)",
                      border: "1px solid var(--line-strong)",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--text)",
                      fontSize: "12px",
                      padding: "5px 12px",
                      cursor: "default",
                      opacity: 0.85,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "7px",
                    }}
                  >
                    <span
                      style={{
                        width: "14px",
                        height: "14px",
                        borderRadius: "3px",
                        border: "1.5px solid var(--focus-ring)",
                        background: "var(--focus-ring)",
                        color: "var(--focus-ring-text)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxSizing: "border-box",
                        flexShrink: 0,
                      }}
                    >
                      <Check size={11} strokeWidth={3.2} />
                    </span>
                    <span>{t("agent.providers.modalities.text")}</span>
                    <Lock size={11} style={{ opacity: 0.7, marginLeft: "1px" }} />
                  </button>

                  {/* Modality Option Pills */}
                  {MODALITY_ITEMS.map((item) => {
                    const isChecked = form.modalities[item.key];
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="checkbox"
                        aria-checked={isChecked}
                        aria-label={t(item.labelKey)}
                        data-modality={item.key}
                        data-tooltip={t(item.hintKey)}
                        disabled={busy}
                        onClick={() => providers.updateForm("modalities", { ...form.modalities, [item.key]: !isChecked })}
                        style={{
                          background: isChecked ? "color-mix(in srgb, var(--focus-ring) 12%, var(--panel-muted))" : "var(--panel-muted)",
                          border: `1px solid ${isChecked ? "var(--focus-ring)" : "var(--line-strong)"}`,
                          borderRadius: "var(--radius-sm)",
                          color: "var(--text)",
                          fontSize: "12px",
                          padding: "5px 12px",
                          cursor: busy ? "default" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "7px",
                          transition: "all 0.15s ease",
                        }}
                      >
                        <span
                          style={{
                            width: "14px",
                            height: "14px",
                            borderRadius: "3px",
                            border: `1.5px solid ${isChecked ? "var(--focus-ring)" : "var(--line-strong)"}`,
                            background: isChecked ? "var(--focus-ring)" : "transparent",
                            color: "var(--focus-ring-text)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            boxSizing: "border-box",
                            flexShrink: 0,
                          }}
                        >
                          {isChecked && <Check size={11} strokeWidth={3.2} />}
                        </span>
                        <span>{t(item.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Advanced Parameters: Timeout & Context Window */}
              <div className="calendar-field-grid">
                <ModelField id="agent-provider-timeout" label={t("agent.providers.fields.timeout")} help={t("agent.providers.fields.timeoutHint")}>
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

                <ModelField id="agent-provider-context-window" label={t("agent.providers.fields.contextWindow")} help={t("agent.providers.fields.contextWindowHint")}>
                  <input
                    id="agent-provider-context-window"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={form.contextWindowTokens}
                    placeholder="8192"
                    disabled={busy}
                    autoComplete="off"
                    onChange={(event) => providers.updateForm("contextWindowTokens", event.target.value)}
                  />
                </ModelField>
              </div>

              {/* Max Output Tokens */}
              <ModelField id="agent-provider-max-output" label={t("agent.providers.fields.maxOutput")} help={t("agent.providers.fields.maxOutputHint")}>
                <input
                  id="agent-provider-max-output"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={form.maxOutputTokens}
                  placeholder="2048"
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => providers.updateForm("maxOutputTokens", event.target.value)}
                />
              </ModelField>
            </div>
          </div>

          <div className="settings-model-switches">
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
              tooltip={isLocal ? t("agent.providers.cloud.localOnly") : t("agent.providers.cloud.description")}
              onChange={() => providers.updateForm("allowCloudMailContent", !form.allowCloudMailContent)}
            />

            <Switch
              checked={form.makeDefault}
              disabled={busy || isCurrentDefault}
              label={t("agent.providers.default.title")}
              tooltip={isCurrentDefault ? t("agent.providers.default.current") : t("agent.providers.default.description")}
              onChange={() => providers.updateForm("makeDefault", !form.makeDefault)}
            />
          </div>

          {providers.touched && providers.validationMessage && (
            <p className="settings-note" role="status"><CircleAlert size={13} aria-hidden="true" />{providers.validationMessage}</p>
          )}
        </>
      }
    />
  );
}