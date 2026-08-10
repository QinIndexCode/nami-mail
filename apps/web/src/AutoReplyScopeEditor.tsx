import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "./i18n";
import type { AutoReplyScope, AutoReplyScopeAction, AutoReplyScopeField, AutoReplyScopeOperator, AutoReplyScopeRule } from "./types";

function ruleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyRule(): AutoReplyScopeRule {
  return { id: ruleId(), field: "from", op: "contains", value: "", action: "reply", enabled: true };
}

function Check({ checked, disabled, ariaLabel, onChange }: {
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={`setting-switch${checked ? " active" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

/**
 * Edits the auto-reply eligibility scope: date window, contacts-only,
 * thread-once and the rule table (ignore rules first, then an implicit
 * whitelist of reply rules). Pure UI state; the parent owns persistence.
 */
export default function AutoReplyScopeEditor({
  scope,
  disabled = false,
  onChange,
}: {
  scope: AutoReplyScope;
  disabled?: boolean;
  onChange: (scope: AutoReplyScope) => void;
}) {
  const { t } = useI18n();
  const dateInput = (key: "startDate" | "endDate") => (
    <input
      type="date"
      className="auto-reply-date-input"
      value={scope[key] ?? ""}
      disabled={disabled}
      aria-label={key === "startDate" ? t("settings.agent.autoReplyScopeStartDate") : t("settings.agent.autoReplyScopeEndDate")}
      onChange={(event) => {
        const value = event.target.value || null;
        if (value && scope.startDate && scope.endDate && value < scope.startDate) return;
        onChange({ ...scope, [key]: value });
      }}
    />
  );

  const updateRule = (ruleIdToUpdate: string, patch: Partial<AutoReplyScopeRule>) => {
    onChange({
      ...scope,
      rules: scope.rules.map((rule) => (rule.id === ruleIdToUpdate ? { ...rule, ...patch } : rule)),
    });
  };

  const removeRule = (ruleIdToRemove: string) => {
    onChange({ ...scope, rules: scope.rules.filter((rule) => rule.id !== ruleIdToRemove) });
  };

  const fieldOptions: { value: AutoReplyScopeField; label: string }[] = [
    { value: "from", label: t("settings.agent.autoReplyScopeFieldFrom") },
    { value: "domain", label: t("settings.agent.autoReplyScopeFieldDomain") },
    { value: "subject", label: t("settings.agent.autoReplyScopeFieldSubject") },
  ];
  const opOptions: { value: AutoReplyScopeOperator; label: string }[] = [
    { value: "contains", label: t("settings.agent.autoReplyScopeOpContains") },
    { value: "not-contains", label: t("settings.agent.autoReplyScopeOpNotContains") },
    { value: "equals", label: t("settings.agent.autoReplyScopeOpEquals") },
  ];
  const actionOptions: { value: AutoReplyScopeAction; label: string }[] = [
    { value: "reply", label: t("settings.agent.autoReplyScopeActionReply") },
    { value: "ignore", label: t("settings.agent.autoReplyScopeActionIgnore") },
  ];

  return (
    <div className="auto-reply-scope">
      <div className="setting-row setting-switch-row">
        <div>
          <strong>{t("settings.agent.autoReplyScopeContactsOnly")}</strong>
          <span>{t("settings.agent.autoReplyScopeContactsOnlyDesc")}</span>
        </div>
        <Check
          checked={scope.contactsOnly}
          disabled={disabled}
          ariaLabel={t("settings.agent.autoReplyScopeContactsOnly")}
          onChange={(checked) => onChange({ ...scope, contactsOnly: checked })}
        />
      </div>

      <div className="setting-row setting-column-row">
        <div>
          <strong>{t("settings.agent.autoReplyScopeDates")}</strong>
          <span>{t("settings.agent.autoReplyScopeDatesDesc")}</span>
        </div>
        <div className="auto-reply-date-range">
          {dateInput("startDate")}
          <span className="auto-reply-date-separator" aria-hidden="true">→</span>
          {dateInput("endDate")}
        </div>
      </div>

      <div className="setting-row setting-switch-row">
        <div>
          <strong>{t("settings.agent.autoReplyScopeThreadOnce")}</strong>
          <span>{t("settings.agent.autoReplyScopeThreadOnceDesc")}</span>
        </div>
        <Check
          checked={scope.threadOnce}
          disabled={disabled}
          ariaLabel={t("settings.agent.autoReplyScopeThreadOnce")}
          onChange={(checked) => onChange({ ...scope, threadOnce: checked })}
        />
      </div>

      <div className="setting-row setting-column-row">
        <div>
          <strong>{t("settings.agent.autoReplyScopeRules")}</strong>
          <span>{t("settings.agent.autoReplyScopeRulesDesc")}</span>
        </div>
        <div className="auto-reply-rule-list" role="group" aria-label={t("settings.agent.autoReplyScopeRules")}>
          {scope.rules.length === 0 && <p className="settings-empty">{t("settings.agent.autoReplyScopeRulesEmpty")}</p>}
          {scope.rules.map((rule) => (
            <div className="auto-reply-rule-row" key={rule.id}>
              <Check
                checked={rule.enabled}
                disabled={disabled}
                ariaLabel={t("settings.agent.autoReplyScopeRuleEnabled")}
                onChange={(checked) => updateRule(rule.id, { enabled: checked })}
              />
              <select
                className="auto-reply-rule-select"
                value={rule.field}
                disabled={disabled}
                aria-label={t("settings.agent.autoReplyScopeFieldLabel")}
                onChange={(event) => updateRule(rule.id, { field: event.target.value as AutoReplyScopeField })}
              >
                {fieldOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select
                className="auto-reply-rule-select"
                value={rule.op}
                disabled={disabled}
                aria-label={t("settings.agent.autoReplyScopeOperatorLabel")}
                onChange={(event) => updateRule(rule.id, { op: event.target.value as AutoReplyScopeOperator })}
              >
                {opOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <input
                type="text"
                className="auto-reply-rule-value"
                value={rule.value}
                maxLength={200}
                disabled={disabled}
                placeholder={t("settings.agent.autoReplyScopeRuleValuePlaceholder")}
                aria-label={t("settings.agent.autoReplyScopeRuleValue")}
                onChange={(event) => updateRule(rule.id, { value: event.target.value })}
              />
              <select
                className="auto-reply-rule-select"
                value={rule.action}
                disabled={disabled}
                aria-label={t("settings.agent.autoReplyScopeActionLabel")}
                onChange={(event) => updateRule(rule.id, { action: event.target.value as AutoReplyScopeAction })}
              >
                {actionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <button
                className="icon-button auto-reply-rule-delete"
                type="button"
                disabled={disabled}
                aria-label={t("settings.agent.autoReplyScopeRuleDelete")}
                onClick={() => removeRule(rule.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            className="secondary-button auto-reply-rule-add"
            type="button"
            disabled={disabled}
            onClick={() => onChange({ ...scope, rules: [...scope.rules, emptyRule()] })}
          >
            <Plus size={14} />{t("settings.agent.autoReplyScopeRuleAdd")}
          </button>
        </div>
      </div>
    </div>
  );
}