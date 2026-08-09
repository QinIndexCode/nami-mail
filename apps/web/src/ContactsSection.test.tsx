import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContactsSection from "./ContactsSection";
import { I18nProvider, translate } from "./i18n";
import type { Contact } from "./types";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const contacts: Contact[] = [
  {
    id: "contact-1",
    email: "alice@example.com",
    name: "Alice L.",
    notes: "design team",
    autoCollected: true,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "contact-2",
    email: "bob@example.com",
    name: "",
    notes: "",
    autoCollected: false,
    createdAt: "",
    updatedAt: "",
  },
];

function renderSection(options: { demoMode?: boolean; initialContacts?: Contact[] } = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ContactsSection demoMode={options.demoMode} initialContacts={options.initialContacts} />
    </I18nProvider>,
  );
}

describe("contacts section", () => {
  it("renders the section header and an empty-state hint when there are no contacts", () => {
    const markup = renderSection({ initialContacts: [] });

    expect(markup).toContain('id="contacts-settings"');
    expect(markup).toContain(zh("settings.contacts.title"));
    expect(markup).toContain(zh("settings.contacts.description"));
    expect(markup).toContain(zh("settings.contacts.empty"));
    expect(markup).toContain(zh("settings.contacts.addContact"));
  });

  it("renders each contact with its name, email, notes and auto-collected badge", () => {
    const markup = renderSection({ initialContacts: contacts });

    expect(markup).toContain("alice@example.com");
    expect(markup).toContain("Alice L.");
    expect(markup).toContain("design team");
    expect(markup).toContain(zh("settings.contacts.autoCollected"));
    expect(markup).toContain("bob@example.com");
    expect(markup).toContain(zh("settings.contacts.edit"));
    expect(markup).toContain(zh("settings.contacts.delete"));
  });

  it("shows the search / pagination toolbar and only the first page of rows once there are more contacts than one page holds", () => {
    const many: Contact[] = Array.from({ length: 7 }, (_, index) => ({
      id: `contact-${index}`,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
      notes: "",
      autoCollected: false,
      createdAt: "",
      updatedAt: "",
    }));
    const markup = renderSection({ initialContacts: many });

    // Toolbar with search, select-all and pagination appears.
    expect(markup).toContain("contacts-toolbar");
    expect(markup).toContain(zh("settings.contacts.searchPlaceholder"));
    expect(markup).toContain(zh("settings.contacts.selectAll"));
    expect(markup).toContain(zh("settings.contacts.pagerPrevious"));
    expect(markup).toContain(zh("settings.contacts.pagerNext"));
    expect(markup).toContain(zh("settings.contacts.pagerLabel", { page: 1, total: 2 }));

    // Only the first page (5 rows) renders.
    for (let index = 0; index < 5; index += 1) expect(markup).toContain(`person${index}@example.com`);
    for (let index = 5; index < 7; index += 1) expect(markup).not.toContain(`person${index}@example.com`);
  });

  it("declines to offer the address book in demo mode", () => {
    const markup = renderSection({ demoMode: true, initialContacts: [] });

    expect(markup).toContain(zh("settings.contacts.demoUnavailable"));
    expect(markup).not.toContain(zh("settings.contacts.addContact"));
  });
});
