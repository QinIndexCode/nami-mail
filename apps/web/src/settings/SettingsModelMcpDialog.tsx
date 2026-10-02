import { CircleAlert, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import type { Translate } from "../i18n";
import { Switch } from "./SettingsUIComponents";
import { ModelField, SettingsModelFormDialog } from "./SettingsModelDialog";
import type { McpServersController } from "./useSettingsModels";

export type SettingsModelMcpDialogProps = {
  t: Translate;
  mcp: McpServersController;
  onBusyChange: (busy: boolean) => void;
};

/**
 * Add / edit one MCP server. Environment values are write-only, so a saved key
 * only ever comes back as its name — the row for it starts blank on purpose.
 */
export default function SettingsModelMcpDialog({
  t,
  mcp,
  onBusyChange,
}: SettingsModelMcpDialogProps) {
  const { form } = mcp;
  const editing = mcp.selectedServer !== null;
  const busy = mcp.saving || mcp.checkingId !== null;

  return (
    <SettingsModelFormDialog
      busy={busy}
      dirty={mcp.formDirty}
      t={t}
      eyebrow={editing ? t("agent.mcpServers.form.editEyebrow") : t("agent.mcpServers.form.newEyebrow")}
      title={editing ? t("agent.mcpServers.form.editTitle") : t("agent.mcpServers.form.newTitle")}
      hint={t("settings.models.mcp.formHint")}
      labelledBy="models-mcp-form-title"
      formId="mcp"
      feedback={mcp.feedback}
      retryLabel={t("agent.mcpServers.retry")}
      submitLabel={t("agent.mcpServers.save")}
      busyLabel={t("agent.mcpServers.savingAndChecking")}
      cancelLabel={t("common.cancel")}
      onBusyChange={onBusyChange}
      onClose={mcp.cancelEdit}
      onSubmit={() => void mcp.save()}
      fields={
        <>
          <ModelField id="mcp-server-label" label={t("agent.mcpServers.fields.label")} hint={t("agent.mcpServers.fields.labelHint")}>
            <input
              id="mcp-server-label"
              type="text"
              value={form.label}
              maxLength={128}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => mcp.updateForm("label", event.target.value)}
            />
          </ModelField>

          <ModelField id="mcp-server-command" label={t("agent.mcpServers.fields.command")} hint={t("agent.mcpServers.fields.commandHint")}>
            <input
              id="mcp-server-command"
              type="text"
              value={form.command}
              placeholder={t("agent.mcpServers.fields.commandPlaceholder")}
              maxLength={1024}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => mcp.updateForm("command", event.target.value)}
            />
          </ModelField>

          <ModelField id="mcp-server-args" label={t("agent.mcpServers.fields.args")} hint={t("agent.mcpServers.fields.argsHint")}>
            <textarea
              id="mcp-server-args"
              value={form.argsText}
              placeholder={t("agent.mcpServers.fields.argsPlaceholder")}
              rows={3}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => mcp.updateForm("argsText", event.target.value)}
            />
          </ModelField>

          <ModelField label={t("agent.mcpServers.fields.env")} hint={t("agent.mcpServers.fields.envHint")}>
            <div className="settings-model-env-editor">
              {mcp.envRows.map((row, index) => (
                <div className="settings-model-env-line" key={row.id}>
                  <input
                    type="text"
                    value={row.key}
                    placeholder={t("agent.mcpServers.fields.envKeyPlaceholder")}
                    maxLength={256}
                    aria-label={t("agent.mcpServers.fields.envKeyPlaceholder")}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => mcp.updateEnvRow(index, { key: event.target.value })}
                  />
                  <input
                    type="text"
                    value={row.value}
                    placeholder={mcp.selectedServer?.envKeys.includes(row.key.trim()) ? t("agent.mcpServers.fields.envSaved") : t("agent.mcpServers.fields.envValuePlaceholder")}
                    maxLength={8192}
                    aria-label={t("agent.mcpServers.fields.envValuePlaceholder")}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => mcp.updateEnvRow(index, { value: event.target.value })}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={t("agent.mcpServers.delete")}
                    onClick={() => mcp.removeEnvRow(index)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button className="settings-model-add-env" type="button" disabled={busy} onClick={mcp.addEnvRow}>
                <Plus size={13} />{t("agent.mcpServers.fields.addEnv")}
              </button>
            </div>
          </ModelField>

          <ModelField id="mcp-server-cwd" label={t("agent.mcpServers.fields.cwd")} hint={t("agent.mcpServers.fields.cwdHint")}>
            <input
              id="mcp-server-cwd"
              type="text"
              value={form.cwd}
              maxLength={2048}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => mcp.updateForm("cwd", event.target.value)}
            />
          </ModelField>

          <ModelField id="mcp-server-timeout" label={t("agent.mcpServers.fields.timeout")} hint={t("agent.mcpServers.fields.timeoutHint")}>
            <input
              id="mcp-server-timeout"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={form.timeoutMs}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => mcp.updateForm("timeoutMs", event.target.value)}
            />
          </ModelField>

          <Switch
            checked={form.enabled}
            disabled={busy}
            label={t("agent.mcpServers.fields.enabled")}
            description={t("agent.mcpServers.fields.enabledHint")}
            onChange={() => mcp.updateForm("enabled", !form.enabled)}
          />

          {editing && (
            <div className="settings-inline-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void mcp.check()}>
                {mcp.checkingId !== null ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {mcp.checkingId !== null ? t("agent.mcpServers.checking") : t("agent.mcpServers.check")}
              </button>
            </div>
          )}

          {mcp.touched && mcp.validationMessage && (
            <p className="settings-note" role="status"><CircleAlert size={13} aria-hidden="true" />{mcp.validationMessage}</p>
          )}
        </>
      }
    />
  );
}