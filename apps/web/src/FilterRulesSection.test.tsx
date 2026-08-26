import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FilterRulesSection, { describeAction, describeCondition, filterFolderOptions } from "./FilterRulesSection";
import { I18nProvider, translate, type TranslationValues } from "./i18n";
import type { Account, FilterRule } from "./types";

const zh = (key: string, values?: TranslationValues) => translate("zh-CN", key, values);

const accounts: Account[] = [
  {
    id: "account-1",
    email: "demo@example.com",
    provider: "custom",
    providerName: "Demo",
    status: "connected",
    lastError: null,
    lastSyncedAt: null,
    signature: "",
    createdAt: "",
    folders: [
      { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 1, unseen: 0 },
      { path: "Archive", name: "Archive", specialUse: "\\Archive", total: 0, unseen: 0 },
    ],
  },
  {
    id: "account-2",
    email: "other@example.com",
    provider: "custom",
    providerName: "Demo",
    status: "connected",
    lastError: null,
    lastSyncedAt: null,
    signature: "",
    createdAt: "",
    folders: [
      { path: "INBOX", name: "Inbox", specialUse: "\\Inbox", total: 1, unseen: 0 },
      { path: "Projects", name: "Projects", specialUse: null, total: 0, unseen: 0 },
    ],
  },
];

function renderSection(options: { demoMode?: boolean; initialRules?: FilterRule[] } = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <FilterRulesSection accounts={accounts} demoMode={options.demoMode} initialRules={options.initialRules} />
    </I18nProvider>,
  );
}

describe("filter rules section", () => {
  it("renders the section header and an empty-state hint when there are no rules", () => {
    const markup = renderSection({ initialRules: [] });

    expect(markup).toContain('id="filter-rules-settings"');
    expect(markup).toContain(zh("settings.filterRules.title"));
    expect(markup).toContain(zh("settings.filterRules.description"));
    expect(markup).toContain(zh("settings.filterRules.empty"));
    expect(markup).toContain(zh("settings.filterRules.addRule"));
  });

  it("renders each rule with its conditions, actions and account scope", () => {
    const rules: FilterRule[] = [
      {
        id: "rule-1",
        name: "Newsletter archive",
        enabled: true,
        accountId: null,
        conditions: [{ kind: "from", value: "newsletter" }],
        actions: [{ kind: "archive" }],
        position: 1,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "rule-2",
        name: "Project mail",
        enabled: false,
        accountId: "account-1",
        conditions: [{ kind: "subject", value: "report" }],
        actions: [{ kind: "mark_seen" }, { kind: "add_flag" }],
        position: 2,
        createdAt: "",
        updatedAt: "",
      },
    ];

    const markup = renderSection({ initialRules: rules });

    expect(markup).toContain("Newsletter archive");
    expect(markup).toContain("发件人包含 newsletter");
    expect(markup).toContain(zh("settings.filterRules.action.summary.archive"));
    expect(markup).toContain(zh("settings.filterRules.accountAll"));
    expect(markup).toContain("Project mail");
    expect(markup).toContain("主题包含 report");
    expect(markup).toContain(zh("settings.filterRules.action.summary.markSeen"));
    expect(markup).toContain(zh("settings.filterRules.action.summary.addFlag"));
    expect(markup).toContain("demo@example.com");
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-checked="false"');
  });

  it("declines to offer the editor in demo mode", () => {
    const markup = renderSection({ demoMode: true, initialRules: [] });

    expect(markup).toContain(zh("settings.filterRules.demoUnavailable"));
    expect(markup).not.toContain(zh("settings.filterRules.addRule"));
  });
});

describe("filter rule summaries", () => {
  it("describes every condition kind", () => {
    expect(describeCondition({ kind: "from", value: "newsletter" }, zh)).toBe("发件人包含 newsletter");
    expect(describeCondition({ kind: "to", value: "demo@example.com" }, zh)).toBe("收件人包含 demo@example.com");
    expect(describeCondition({ kind: "subject", value: "digest" }, zh)).toBe("主题包含 digest");
    expect(describeCondition({ kind: "has_attachments", value: true }, zh)).toBe(zh("settings.filterRules.condition.summary.attachments"));
    expect(describeCondition({ kind: "has_attachments", value: false }, zh)).toBe(zh("settings.filterRules.condition.summary.noAttachments"));
  });

  it("describes every action kind", () => {
    expect(describeAction({ kind: "mark_seen" }, zh)).toBe(zh("settings.filterRules.action.summary.markSeen"));
    expect(describeAction({ kind: "add_flag" }, zh)).toBe(zh("settings.filterRules.action.summary.addFlag"));
    expect(describeAction({ kind: "archive" }, zh)).toBe(zh("settings.filterRules.action.summary.archive"));
    expect(describeAction({ kind: "move_to_folder", folderPath: "[Gmail]/All Mail" }, zh))
      .toBe("移动到 [Gmail]/All Mail");
  });
});

describe("filter folder options", () => {
  it("deduplicates shared folder paths and disambiguates their labels", () => {
    expect(filterFolderOptions(accounts, null)).toEqual([
      { path: "INBOX", label: "demo@example.com — Inbox" },
      { path: "Archive", label: "Archive" },
      { path: "Projects", label: "Projects" },
    ]);
  });

  it("restricts options to the bound account without disambiguation", () => {
    expect(filterFolderOptions(accounts, "account-2")).toEqual([
      { path: "INBOX", label: "Inbox" },
      { path: "Projects", label: "Projects" },
    ]);
  });
});
