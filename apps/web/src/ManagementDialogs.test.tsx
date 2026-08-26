import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import AccountsDialog, { syncResultNoticeMessage } from "./AccountsDialog";
import { ContactsDialog, TemplatesDialog } from "./ManagementDialogs";
import type { Account } from "./types";

const zh = (key: string) => translate("zh-CN", key);

const demoAccount: Account = {
  id: "acc-1",
  email: "nami@example.com",
  provider: "demo",
  providerName: "Demo",
  status: "connected",
  lastError: null,
  lastSyncedAt: null,
  signature: "",
  createdAt: new Date().toISOString(),
  folders: [],
};

describe("management dialogs", () => {
  it("renders the contacts dialog with its own heading", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ContactsDialog demoMode onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(markup).toContain('id="contacts-dialog-title"');
    expect(markup).toContain(zh("navigation.management"));
    expect(markup).toContain(zh("settings.contacts.title"));
  });

  it("renders the templates dialog with its own heading", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <TemplatesDialog demoMode onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(markup).toContain('id="templates-dialog-title"');
    expect(markup).toContain(zh("settings.templates.title"));
  });

  it("lists accounts with edit and remove controls in the accounts dialog", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AccountsDialog
          accounts={[demoAccount]}
          demoMode
          onClose={() => undefined}
          onAccountRemoved={() => undefined}
          onAccountSignatureChanged={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('id="accounts-dialog-title"');
    expect(markup).toContain(zh("settings.account.title"));
    expect(markup).toContain("nami@example.com");
    expect(markup).toContain(zh("settings.account.edit"));
    expect(markup).toContain(zh("settings.account.removeAriaLabel").replace("{email}", "nami@example.com"));
    // The signature editor is collapsed behind the edit button until opened.
    expect(markup).not.toContain(zh("settings.account.signatureLabel"));
  });

  it("unlocks search, pagination and bulk controls once accounts exceed one page", () => {
    const manyAccounts: Account[] = Array.from({ length: 7 }, (_, index) => ({
      ...demoAccount,
      id: `acc-${index + 1}`,
      email: `nami${index + 1}@example.com`,
    }));
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AccountsDialog
          accounts={manyAccounts}
          demoMode
          onClose={() => undefined}
          onAccountRemoved={() => undefined}
          onAccountSignatureChanged={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain(zh("settings.account.searchPlaceholder"));
    expect(markup).toContain(zh("settings.account.selectAll"));
    expect(markup).toContain(zh("settings.account.pagerLabel").replace("{page}", "1").replace("{total}", "2"));
    expect(markup).toContain(zh("settings.account.pagerNext"));
    // Only one page of rows is rendered at a time.
    expect(markup.match(/class="accounts-row"/g)?.length).toBe(5);
  });
});

describe("accounts dialog sync warning", () => {
  const warningAccount: Account = {
    ...demoAccount,
    lastSyncWarningCode: "sync_limit",
  };

  function renderAccount(account: Account): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <AccountsDialog
          accounts={[account]}
          demoMode
          onClose={() => undefined}
          onAccountRemoved={() => undefined}
          onAccountSignatureChanged={() => undefined}
        />
      </I18nProvider>,
    );
  }

  it("shows a sync-cap warning on the row without error styling or retry", () => {
    const markup = renderAccount(warningAccount);

    expect(markup).toContain('class="accounts-row has-issue has-warning"');
    expect(markup).toContain('class="status-dot warning"');
    expect(markup).toContain('class="account-warning"');
    expect(markup).not.toContain('class="account-error"');
    expect(markup).toContain(zh("account.syncLimit.title"));
    expect(markup).toContain(zh("account.syncLimit.guidance"));
    // Warnings are not retryable, so no resync control appears.
    expect(markup).not.toContain(zh("settings.account.resync"));
  });

  it("keeps errors styled as errors with the resync control on the same row", () => {
    const markup = renderAccount({
      ...demoAccount,
      status: "degraded",
      lastErrorCode: "partial_sync",
      lastError: "1 个文件夹未完成同步，其他文件夹的邮件仍可使用。",
    });

    expect(markup).toContain('class="accounts-row has-issue"');
    expect(markup).not.toContain("has-warning");
    expect(markup).toContain('class="status-dot error"');
    expect(markup).toContain('class="account-error"');
    expect(markup).toContain(zh("settings.account.resync"));
  });

  it("appends the cap explanation to a manual sync summary that hit the limit", () => {
    const summary = translate("zh-CN", "settings.account.syncCompleted", { email: "nami@example.com" });
    expect(syncResultNoticeMessage(summary, true, zh)).toBe(`${summary} ${zh("settings.account.syncLimitReached")}`);
    expect(syncResultNoticeMessage(summary, false, zh)).toBe(summary);
    expect(syncResultNoticeMessage(summary, undefined, zh)).toBe(summary);
  });
});
