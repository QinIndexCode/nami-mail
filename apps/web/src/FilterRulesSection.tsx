import { Check, Filter, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { mailErrorMessage } from "./errorPresentation";
import { useI18n, type Translate } from "./i18n";
import ThemedSelect from "./ThemedSelect";
import type {
  Account,
  FilterRule,
  FilterRuleAction,
  FilterRuleCondition,
  FilterRuleInput,
} from "./types";

export type FilterRulesSectionProps = {
  accounts: Account[];
  demoMode?: boolean;
  /** Test seam: preloaded rules skip the API load. */
  initialRules?: FilterRule[];
};

type FilterRuleDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  /** null applies the rule to every account. */
  accountId: string | null;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
};

type Notice = { kind: "success" | "error"; message: string } | null;

const conditionKindOptions: Array<{ value: FilterRuleCondition["kind"]; labelKey: string }> = [
  { value: "from", labelKey: "settings.filterRules.condition.from" },
  { value: "to", labelKey: "settings.filterRules.condition.to" },
  { value: "subject", labelKey: "settings.filterRules.condition.subject" },
  { value: "has_attachments", labelKey: "settings.filterRules.condition.hasAttachments" },
];

const actionKindOptions: Array<{ value: FilterRuleAction["kind"]; labelKey: string }> = [
  { value: "mark_seen", labelKey: "settings.filterRules.action.markSeen" },
  { value: "add_flag", labelKey: "settings.filterRules.action.addFlag" },
  { value: "archive", labelKey: "settings.filterRules.action.archive" },
  { value: "move_to_folder", labelKey: "settings.filterRules.action.moveToFolder" },
];

function emptyDraft(): FilterRuleDraft {
  return {
    name: "",
    enabled: true,
    accountId: null,
    conditions: [{ kind: "from", value: "" }],
    actions: [{ kind: "mark_seen" }],
  };
}

/** Folders selectable for a move_to_folder action under the given account scope. */
export function filterFolderOptions(
  accounts: Account[],
  accountId: string | null,
): Array<{ path: string; label: string }> {
  const scoped = accountId ? accounts.filter((account) => account.id === accountId) : accounts;
  const seen = new Set<string>();
  const options: Array<{ path: string; label: string }> = [];
  for (const account of scoped) {
    for (const folder of account.folders) {
      if (seen.has(folder.path)) continue;
      seen.add(folder.path);
      const duplicated = scoped.some((other) => other !== account
        && other.folders.some((candidate) => candidate.path === folder.path));
      options.push({ path: folder.path, label: duplicated ? `${account.email} — ${folder.name}` : folder.name });
    }
  }
  return options;
}

export function describeCondition(condition: FilterRuleCondition, t: Translate): string {
  switch (condition.kind) {
    case "from":
      return t("settings.filterRules.condition.summary.from", { value: condition.value });
    case "to":
      return t("settings.filterRules.condition.summary.to", { value: condition.value });
    case "subject":
      return t("settings.filterRules.condition.summary.subject", { value: condition.value });
    case "has_attachments":
      return t(condition.value
        ? "settings.filterRules.condition.summary.attachments"
        : "settings.filterRules.condition.summary.noAttachments");
  }
}

export function describeAction(action: FilterRuleAction, t: Translate): string {
  switch (action.kind) {
    case "mark_seen":
      return t("settings.filterRules.action.summary.markSeen");
    case "add_flag":
      return t("settings.filterRules.action.summary.addFlag");
    case "archive":
      return t("settings.filterRules.action.summary.archive");
    case "move_to_folder":
      return t("settings.filterRules.action.summary.moveToFolder", { folder: action.folderPath });
  }
}

function conditionFromInput(kind: FilterRuleCondition["kind"], value: string): FilterRuleCondition {
  if (kind === "has_attachments") return { kind, value: value === "true" };
  return { kind, value };
}

function actionFromInput(kind: FilterRuleAction["kind"], folderPath: string): FilterRuleAction {
  if (kind === "move_to_folder") return { kind, folderPath };
  return { kind };
}

/**
 * When the account scope changes, move_to_folder targets that no longer exist
 * in the scope are reset to the first available folder so the draft never holds
 * a stale path.
 */
function reanchorFolderActions(actions: FilterRuleAction[], folders: Array<{ path: string }>): FilterRuleAction[] {
  const firstPath = folders[0]?.path ?? "";
  return actions.map((action) => {
    if (action.kind !== "move_to_folder") return action;
    if (action.folderPath && folders.some((folder) => folder.path === action.folderPath)) return action;
    return { kind: "move_to_folder", folderPath: firstPath };
  });
}

export default function FilterRulesSection({
  accounts,
  demoMode = false,
  initialRules,
}: FilterRulesSectionProps) {
  const { t } = useI18n();
  const [rules, setRules] = useState<FilterRule[]>(initialRules ?? []);
  const [loading, setLoading] = useState(!demoMode && initialRules === undefined);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<FilterRuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [armedDeleteId, setArmedDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (demoMode || initialRules !== undefined) return undefined;
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.filterRules().then((result) => {
      if (!active) return;
      setRules(result.rules);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(error);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [demoMode, initialRules, loadAttempt]);

  if (demoMode) {
    return (
      <section className="settings-section" aria-labelledby="filter-rules-settings">
        <div className="settings-section-title">
          <Filter size={16} />
          <div><span>{t("settings.filterRules.title")}</span><p id="filter-rules-settings">{t("settings.filterRules.description")}</p></div>
        </div>
        <p className="settings-empty" role="status">{t("settings.filterRules.demoUnavailable")}</p>
      </section>
    );
  }

  const replaceRule = (updated: FilterRule) => {
    setRules((current) => current.map((rule) => rule.id === updated.id ? updated : rule));
  };

  const saveDraft = async () => {
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name) {
      setNotice({ kind: "error", message: t("settings.filterRules.validation.nameRequired") });
      return;
    }
    if (draft.conditions.length === 0) {
      setNotice({ kind: "error", message: t("settings.filterRules.validation.conditionRequired") });
      return;
    }
    if (draft.actions.length === 0) {
      setNotice({ kind: "error", message: t("settings.filterRules.validation.actionRequired") });
      return;
    }
    setBusy(true);
    setNotice(null);
    const input: FilterRuleInput = {
      name,
      accountId: draft.accountId,
      enabled: draft.enabled,
      conditions: draft.conditions,
      actions: draft.actions,
    };
    try {
      if (draft.id) {
        const result = await api.updateFilterRule(draft.id, input);
        replaceRule(result.rule);
        setNotice({ kind: "success", message: t("settings.filterRules.updated") });
      } else {
        const result = await api.createFilterRule(input);
        setRules((current) => [...current, result.rule]);
        setNotice({ kind: "success", message: t("settings.filterRules.saved") });
      }
      setDraft(null);
    } catch (error) {
      setNotice({
        kind: "error",
        message: mailErrorMessage(error, t(draft.id ? "settings.filterRules.updateFailed" : "settings.filterRules.saveFailed"), t),
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule: FilterRule) => {
    if (busyRuleId) return;
    const previous = rule;
    const optimistic = { ...rule, enabled: !rule.enabled };
    setRules((current) => current.map((item) => item.id === rule.id ? optimistic : item));
    setBusyRuleId(rule.id);
    try {
      const result = await api.updateFilterRule(rule.id, { enabled: optimistic.enabled });
      replaceRule(result.rule);
    } catch (error) {
      setRules((current) => current.map((item) => item.id === rule.id ? previous : item));
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.filterRules.updateFailed"), t) });
    } finally {
      setBusyRuleId(null);
    }
  };

  const deleteRule = async (ruleId: string) => {
    if (busyRuleId) return;
    setBusyRuleId(ruleId);
    setNotice(null);
    try {
      await api.deleteFilterRule(ruleId);
      setRules((current) => current.filter((rule) => rule.id !== ruleId));
      setArmedDeleteId(null);
      setNotice({ kind: "success", message: t("settings.filterRules.deleted") });
    } catch (error) {
      setNotice({ kind: "error", message: mailErrorMessage(error, t("settings.filterRules.deleteFailed"), t) });
    } finally {
      setBusyRuleId(null);
    }
  };

  const updateDraftAccount = (accountId: string) => {
    if (!draft) return;
    const nextAccountId = accountId || null;
    const folders = filterFolderOptions(accounts, nextAccountId);
    setDraft({
      ...draft,
      accountId: nextAccountId,
      actions: reanchorFolderActions(draft.actions, folders),
    });
  };

  const updateDraftCondition = (index: number, condition: FilterRuleCondition) => {
    if (!draft) return;
    setDraft({
      ...draft,
      conditions: draft.conditions.map((item, itemIndex) => itemIndex === index ? condition : item),
    });
  };

  const updateDraftAction = (index: number, action: FilterRuleAction) => {
    if (!draft) return;
    setDraft({
      ...draft,
      actions: draft.actions.map((item, itemIndex) => itemIndex === index ? action : item),
    });
  };

  const draftFolders = draft ? filterFolderOptions(accounts, draft.accountId) : [];

  return (
    <section className="settings-section" aria-labelledby="filter-rules-settings">
      <div className="settings-section-title">
        <Filter size={16} />
        <div><span>{t("settings.filterRules.title")}</span><p id="filter-rules-settings">{t("settings.filterRules.description")}</p></div>
      </div>

      {notice && <div className={`form-status ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.kind === "success" ? <Check size={17} /> : <X size={17} />}{notice.message}</div>}

      {loading ? (
        <p className="settings-empty" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />{t("common.loading")}</p>
      ) : loadError ? (
        <div className="settings-empty translation-configuration-load-error" role="alert">
          <span>{mailErrorMessage(loadError, t("settings.filterRules.loadFailed"), t)}</span>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            <RefreshCw size={15} aria-hidden="true" />{t("common.retry")}
          </button>
        </div>
      ) : (
        <>
          {rules.length === 0 && !draft ? (
            <p className="settings-empty">{t("settings.filterRules.empty")}</p>
          ) : (
            <div className="filter-rules-list">
              {rules.map((rule) => {
                const accountScope = rule.accountId
                  ? accounts.find((account) => account.id === rule.accountId)?.email ?? rule.accountId
                  : t("settings.filterRules.accountAll");
                const deleting = busyRuleId === rule.id;
                return (
                  <div className="filter-rule-row" key={rule.id}>
                    <div className="filter-rule-head">
                      <div className="filter-rule-copy">
                        <strong>{rule.name}</strong>
                        <small>{rule.conditions.map((condition) => describeCondition(condition, t)).join(" · ")} → {rule.actions.map((action) => describeAction(action, t)).join(" · ")}</small>
                        <small className="filter-rule-scope">{accountScope}</small>
                      </div>
                      <div className="filter-rule-actions">
                        <button
                          className={`setting-switch${rule.enabled ? " active" : ""}`}
                          type="button"
                          role="switch"
                          aria-checked={rule.enabled}
                          aria-label={t("settings.filterRules.enabled")}
                          disabled={Boolean(busyRuleId)}
                          onClick={() => void toggleRule(rule)}
                        >
                          <span aria-hidden="true" />
                        </button>
                        <button className="icon-button" type="button" aria-label={t("settings.filterRules.edit")} data-tooltip={t("settings.filterRules.edit")} disabled={Boolean(busyRuleId)} onClick={() => {
                          setArmedDeleteId(null);
                          setDraft({
                            id: rule.id,
                            name: rule.name,
                            enabled: rule.enabled,
                            accountId: rule.accountId,
                            conditions: rule.conditions,
                            actions: rule.actions,
                          });
                        }}>
                          <Pencil size={15} />
                        </button>
                        {armedDeleteId === rule.id ? (
                          <>
                            <button className="secondary-button danger-button" type="button" disabled={Boolean(busyRuleId)} onClick={() => void deleteRule(rule.id)}>
                              {deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{t("settings.filterRules.confirmDelete")}
                            </button>
                            <button className="secondary-button" type="button" disabled={Boolean(busyRuleId)} onClick={() => setArmedDeleteId(null)}>
                              {t("common.cancel")}
                            </button>
                          </>
                        ) : (
                          <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.filterRules.delete")} data-tooltip={t("settings.filterRules.delete")} disabled={Boolean(busyRuleId)} onClick={() => setArmedDeleteId(rule.id)}>
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {draft && (
            <div className="filter-rule-editor">
              <label className="translation-setting-field" htmlFor="filter-rule-name">
                <span><strong>{t("settings.filterRules.nameLabel")}</strong></span>
                <input
                  id="filter-rule-name"
                  type="text"
                  value={draft.name}
                  placeholder={t("settings.filterRules.namePlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>

              <label className="setting-select-row" htmlFor="filter-rule-account">
                <span><strong>{t("settings.filterRules.accountLabel")}</strong><small>{t("settings.filterRules.accountDescription")}</small></span>
                <ThemedSelect
                  id="filter-rule-account"
                  value={draft.accountId ?? ""}
                  aria-label={t("settings.filterRules.accountLabel")}
                  disabled={busy}
                  onValueChange={updateDraftAccount}
                >
                  <option value="">{t("settings.filterRules.accountAll")}</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
                </ThemedSelect>
              </label>

              <div className="setting-subheading"><span>{t("settings.filterRules.conditionsLabel")}</span><small>{t("settings.filterRules.conditionsDescription")}</small></div>
              <div className="filter-rule-rows">
                {draft.conditions.map((condition, index) => (
                  <div className="filter-rule-row-editor" key={index}>
                    <ThemedSelect
                      id={`filter-rule-condition-kind-${index}`}
                      value={condition.kind}
                      aria-label={t("settings.filterRules.condition.kindLabel")}
                      disabled={busy}
                      className="filter-rule-kind-select"
                      onValueChange={(kind) => {
                        const nextKind = kind as FilterRuleCondition["kind"];
                        updateDraftCondition(index, conditionFromInput(nextKind, condition.kind === "has_attachments" ? String(condition.value) : condition.value));
                      }}
                    >
                      {conditionKindOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
                    </ThemedSelect>
                    {condition.kind === "has_attachments" ? (
                      <ThemedSelect
                        id={`filter-rule-condition-value-${index}`}
                        value={condition.value ? "true" : "false"}
                        aria-label={t("settings.filterRules.condition.hasAttachments")}
                        disabled={busy}
                        className="filter-rule-value-select"
                        onValueChange={(value) => updateDraftCondition(index, { kind: "has_attachments", value: value === "true" })}
                      >
                        <option value="true">{t("settings.filterRules.condition.yes")}</option>
                        <option value="false">{t("settings.filterRules.condition.no")}</option>
                      </ThemedSelect>
                    ) : (
                      <input
                        type="text"
                        value={condition.value}
                        placeholder={t("settings.filterRules.condition.valuePlaceholder")}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        onChange={(event) => updateDraftCondition(index, { ...condition, value: event.target.value })}
                      />
                    )}
                    <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.filterRules.removeCondition")} data-tooltip={t("settings.filterRules.removeCondition")} disabled={busy || draft.conditions.length <= 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, itemIndex) => itemIndex !== index) })}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { kind: "from", value: "" }] })}>
                <Plus size={14} />{t("settings.filterRules.addCondition")}
              </button>

              <div className="setting-subheading"><span>{t("settings.filterRules.actionsLabel")}</span><small>{t("settings.filterRules.actionsDescription")}</small></div>
              <div className="filter-rule-rows">
                {draft.actions.map((action, index) => (
                  <div className="filter-rule-row-editor" key={index}>
                    <ThemedSelect
                      id={`filter-rule-action-kind-${index}`}
                      value={action.kind}
                      aria-label={t("settings.filterRules.action.kindLabel")}
                      disabled={busy}
                      className="filter-rule-action-kind-select"
                      onValueChange={(kind) => {
                        const nextKind = kind as FilterRuleAction["kind"];
                        updateDraftAction(index, actionFromInput(nextKind, action.kind === "move_to_folder" ? action.folderPath : draftFolders[0]?.path ?? ""));
                      }}
                    >
                      {actionKindOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
                    </ThemedSelect>
                    {action.kind === "move_to_folder" && (
                      <ThemedSelect
                        id={`filter-rule-action-folder-${index}`}
                        value={action.folderPath}
                        aria-label={t("settings.filterRules.folderSelectLabel")}
                        disabled={busy || draftFolders.length === 0}
                        className="filter-rule-folder-select"
                        onValueChange={(folderPath) => updateDraftAction(index, { kind: "move_to_folder", folderPath })}
                      >
                        {action.folderPath && !draftFolders.some((folder) => folder.path === action.folderPath) && <option value={action.folderPath}>{action.folderPath}</option>}
                        {draftFolders.map((folder) => <option key={folder.path} value={folder.path}>{folder.label}</option>)}
                      </ThemedSelect>
                    )}
                    <button className="icon-button danger-icon-button" type="button" aria-label={t("settings.filterRules.removeAction")} data-tooltip={t("settings.filterRules.removeAction")} disabled={busy || draft.actions.length <= 1} onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, itemIndex) => itemIndex !== index) })}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setDraft({ ...draft, actions: [...draft.actions, { kind: "mark_seen" }] })}>
                <Plus size={14} />{t("settings.filterRules.addAction")}
              </button>

              <div className="settings-inline-actions filter-rule-editor-actions">
                <button className="primary-button" type="button" disabled={busy} onClick={() => void saveDraft()}>
                  {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t("settings.filterRules.save")}
                </button>
                <button className="secondary-button" type="button" disabled={busy} onClick={() => setDraft(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          )}

          {!draft && (
            <div className="settings-inline-actions">
              <button className="secondary-button" type="button" disabled={Boolean(busyRuleId)} onClick={() => {
                setArmedDeleteId(null);
                setDraft(emptyDraft());
              }}>
                <Plus size={15} />{t("settings.filterRules.addRule")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
