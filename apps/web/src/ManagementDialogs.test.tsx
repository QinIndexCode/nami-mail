import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import AccountsDialog from "./AccountsDialog";
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
