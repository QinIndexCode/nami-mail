import { Check as CheckIcon, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DatePicker from "./DatePicker";
import ThemedSelect from "./ThemedSelect";
import { FormNotice, type Notice } from "./FormNotice";
import { useDialogFocus } from "./hooks/useDialogFocus";
import { useDismissTransition } from "./hooks/useDismissTransition";
import { useI18n, type Translate } from "./i18n";
import type {
  AutoReplyScope,
  AutoReplyScopeAction,
  AutoReplyScopeField,
  AutoReplyScopeOperator,
  AutoReplyScopeRule,
} from "./types";

function ruleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function Check({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
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

export function describeAutoReplyRule(
  rule: AutoReplyScopeRule,
  t: Translate,
): { fieldLabel: string; opLabel: string; actionLabel: string } {
  const fieldKey =
    rule.field === "from"
      ? "settings.agent.autoReplyScopeFieldFrom"
      : rule.field === "domain"
        ? "settings.agent.autoReplyScopeFieldDomain"
        : "settings.agent.autoReplyScopeFieldSubject";
  const opKey =
    rule.op === "contains"
      ? "settings.agent.autoReplyScopeOpContains"
      : rule.op === "not-contains"
        ? "settings.agent.autoReplyScopeOpNotContains"
        : "settings.agent.autoReplyScopeOpEquals";
  const actionKey =
    rule.action === "reply"
      ? "settings.agent.autoReplyScopeActionReply"
      : "settings.agent.autoReplyScopeActionIgnore";

  return {
    fieldLabel: t(fieldKey),
    opLabel: t(opKey),
    actionLabel: t(actionKey),
  };
}

export type AutoReplyScopeEditorProps = {
  scope: AutoReplyScope;
  disabled?: boolean;
  onChange: (scope: AutoReplyScope) => void;
  overlayHostRef?: React.RefObject<HTMLElement | null>;
};

/**
 * Edits the auto-reply eligibility scope: date window, contacts-only,
 * thread-once and the rule table (ignore rules first, then an implicit
 * whitelist of reply rules). Adding or editing rules uses a dedicated modal
 * dialog to prevent partial/invalid input from rejecting against the API.
 */
export default function AutoReplyScopeEditor({
  scope,
  disabled = false,
  onChange,
  overlayHostRef,
}: AutoReplyScopeEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<AutoReplyScopeRule | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [modalNotice, setModalNotice] = useState<Notice>(null);

  const editorPanel = useRef<HTMLElement>(null);
  const { closing: editorClosing, requestClose: requestEditorClose } = useDismissTransition(() => {
    setDraft(null);
    setModalNotice(null);
  });
  useDialogFocus(Boolean(draft), editorPanel);

  const closeEditor = () => {
    requestEditorClose();
  };

  useEffect(() => {
    if (!draft) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeEditor();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [draft]);

  const dateInput = (key: "startDate" | "endDate") => (
    <DatePicker
      mode="date"
      value={scope[key] ?? ""}
      disabled={disabled}
      aria-label={key === "startDate" ? t("settings.agent.autoReplyScopeStartDate") : t("settings.agent.autoReplyScopeEndDate")}
      minDate={key === "endDate" ? (scope.startDate ?? undefined) : undefined}
      onChange={(value) => onChange({ ...scope, [key]: value || null })}
    />
  );

  const toggleRuleEnabled = (ruleIdToToggle: string) => {
    onChange({
      ...scope,
      rules: scope.rules.map((rule) =>
        rule.id === ruleIdToToggle ? { ...rule, enabled: !rule.enabled } : rule,
      ),
    });
  };

  const removeRule = (ruleIdToRemove: string) => {
    onChange({ ...scope, rules: scope.rules.filter((rule) => rule.id !== ruleIdToRemove) });
  };

  const openAddModal = () => {
    setModalNotice(null);
    setIsEditing(false);
    setDraft({
      id: ruleId(),
      field: "from",
      op: "contains",
      value: "",
      action: "reply",
      enabled: true,
    });
  };

  const openEditModal = (rule: AutoReplyScopeRule) => {
    setModalNotice(null);
    setIsEditing(true);
    setDraft({ ...rule });
  };

  const saveDraft = () => {
    if (!draft) return;
    const trimmedVal = draft.value.trim();
    if (!trimmedVal) {
      setModalNotice({ kind: "error", message: t("settings.agent.autoReplyScopeRuleValueRequired") });
      return;
    }
    const finalRule: AutoReplyScopeRule = {
      ...draft,
      value: trimmedVal,
    };
    let nextRules: AutoReplyScopeRule[];
    if (isEditing) {
      nextRules = scope.rules.map((r) => (r.id === finalRule.id ? finalRule : r));
    } else {
      nextRules = [...scope.rules, finalRule];
    }
    onChange({ ...scope, rules: nextRules });
    closeEditor();
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

  const modalDialog = draft ? (
    <div
      className={`modal-backdrop contact-editor-backdrop${editorClosing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && closeEditor()}
    >
      <section
        ref={editorPanel}
        className={`modal-card contact-editor-modal auto-reply-rule-modal${editorClosing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-reply-rule-editor-title"
        tabIndex={-1}
      >
        <div className="contact-editor-head settings-model-head">
          <h3 id="auto-reply-rule-editor-title" className="contact-editor-title settings-model-title">
            {isEditing ? t("settings.agent.autoReplyScopeRuleEditTitle") : t("settings.agent.autoReplyScopeRuleAddTitle")}
          </h3>
          <button
            className="icon-button settings-model-close-btn"
            type="button"
            aria-label={t("common.close")}
            onClick={closeEditor}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-model-fields">
          <FormNotice notice={modalNotice} onDismiss={() => setModalNotice(null)} />

          <div className="calendar-field-grid">
            <label className="settings-field calendar-field" htmlFor="auto-reply-rule-field">
              <span className="settings-field-label">
                <span className="settings-field-label-text">{t("settings.agent.autoReplyScopeFieldLabel")}</span>
              </span>
              <ThemedSelect
                id="auto-reply-rule-field"
                className="settings-model-select"
                value={draft.field}
                aria-label={t("settings.agent.autoReplyScopeFieldLabel")}
                onValueChange={(val) => setDraft({ ...draft, field: val as AutoReplyScopeField })}
              >
                {fieldOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </ThemedSelect>
            </label>

            <label className="settings-field calendar-field" htmlFor="auto-reply-rule-op">
              <span className="settings-field-label">
                <span className="settings-field-label-text">{t("settings.agent.autoReplyScopeOperatorLabel")}</span>
              </span>
              <ThemedSelect
                id="auto-reply-rule-op"
                className="settings-model-select"
                value={draft.op}
                aria-label={t("settings.agent.autoReplyScopeOperatorLabel")}
                onValueChange={(val) => setDraft({ ...draft, op: val as AutoReplyScopeOperator })}
              >
                {opOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </ThemedSelect>
            </label>
          </div>

          <label className="settings-field calendar-field" htmlFor="auto-reply-rule-value">
            <span className="settings-field-label">
              <span className="settings-field-label-text">{t("settings.agent.autoReplyScopeRuleValue")}</span>
            </span>
            <input
              id="auto-reply-rule-value"
              type="text"
              value={draft.value}
              maxLength={200}
              placeholder={t("settings.agent.autoReplyScopeRuleValuePlaceholder")}
              autoComplete="off"
              spellCheck={false}
              data-dialog-initial-focus
              onChange={(event) => {
                setDraft({ ...draft, value: event.target.value });
                if (modalNotice) setModalNotice(null);
              }}
            />
          </label>

          <label className="settings-field calendar-field" htmlFor="auto-reply-rule-action">
            <span className="settings-field-label">
              <span className="settings-field-label-text">{t("settings.agent.autoReplyScopeActionLabel")}</span>
            </span>
            <ThemedSelect
              id="auto-reply-rule-action"
              className="settings-model-select"
              menuPlacement="top"
              value={draft.action}
              aria-label={t("settings.agent.autoReplyScopeActionLabel")}
              onValueChange={(val) => setDraft({ ...draft, action: val as AutoReplyScopeAction })}
            >
              {actionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </ThemedSelect>
          </label>

          <div className="settings-model-switches">
            <div className="setting-row setting-switch-row">
              <div>
                <strong>{t("settings.agent.autoReplyScopeRuleEnabled")}</strong>
              </div>
              <Check
                checked={draft.enabled}
                ariaLabel={t("settings.agent.autoReplyScopeRuleEnabled")}
                onChange={(checked) => setDraft({ ...draft, enabled: checked })}
              />
            </div>
          </div>
        </div>

        <div className="contact-editor-actions settings-model-actions">
          <button className="secondary-button" type="button" onClick={closeEditor}>
            {t("common.cancel")}
          </button>
          <button className="primary-button" type="button" onClick={saveDraft}>
            <CheckIcon size={15} />{t("settings.agent.autoReplyScopeRuleSave")}
          </button>
        </div>
      </section>
    </div>
  ) : null;

  return (
    <div className="auto-reply-scope">
      <div className="setting-row setting-switch-row">
        <div>
          <strong>{t("settings.agent.autoReplyScopeContactsOnly")}</strong>
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
          {scope.rules.map((rule) => {
            const { fieldLabel, opLabel, actionLabel } = describeAutoReplyRule(rule, t);
            return (
              <div className={`auto-reply-rule-card${rule.enabled ? "" : " disabled"}`} key={rule.id}>
                <div className="auto-reply-rule-main">
                  <Check
                    checked={rule.enabled}
                    disabled={disabled}
                    ariaLabel={t("settings.agent.autoReplyScopeRuleEnabled")}
                    onChange={() => toggleRuleEnabled(rule.id)}
                  />
                  <div className="auto-reply-rule-info">
                    <span className={`auto-reply-rule-badge ${rule.action}`}>
                      {actionLabel}
                    </span>
                    <span className="auto-reply-rule-summary">
                      <strong>{fieldLabel}</strong> {opLabel} <span className="auto-reply-rule-needle">"{rule.value}"</span>
                    </span>
                  </div>
                </div>
                <div className="auto-reply-rule-actions">
                  <button
                    className="icon-button"
                    type="button"
                    disabled={disabled}
                    aria-label={t("settings.agent.autoReplyScopeRuleEdit")}
                    data-tooltip={t("settings.agent.autoReplyScopeRuleEdit")}
                    onClick={() => openEditModal(rule)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-button danger-icon-button"
                    type="button"
                    disabled={disabled}
                    aria-label={t("settings.agent.autoReplyScopeRuleDelete")}
                    data-tooltip={t("settings.agent.autoReplyScopeRuleDelete")}
                    onClick={() => removeRule(rule.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="secondary-button auto-reply-rule-add"
            type="button"
            disabled={disabled}
            onClick={openAddModal}
          >
            <Plus size={14} />{t("settings.agent.autoReplyScopeRuleAdd")}
          </button>
        </div>
      </div>

      {modalDialog && (overlayHostRef?.current ? createPortal(modalDialog, overlayHostRef.current) : modalDialog)}
    </div>
  );
}