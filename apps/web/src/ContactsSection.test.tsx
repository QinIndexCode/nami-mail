import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContactsSection, { applySourceFilter, orderContactsBySource } from "./ContactsSection";
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

  it("renders each contact with its name, email, notes and a source badge for both origins", () => {
    const markup = renderSection({ initialContacts: contacts });

    expect(markup).toContain("alice@example.com");
    expect(markup).toContain("Alice L.");
    expect(markup).toContain("design team");
    expect(markup).toContain(zh("settings.contacts.autoCollected"));
    expect(markup).toContain(zh("settings.contacts.manualAdded"));
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

  it("renders the source filter tabs with live counts for each origin", () => {
    const mixed: Contact[] = [
      ...Array.from({ length: 3 }, (_, index) => manualContact(`m${index}@example.com`, `Manual ${index}`)),
      ...Array.from({ length: 4 }, (_, index) => autoContact(`a${index}@example.com`, `Auto ${index}`)),
    ];
    const markup = renderSection({ initialContacts: mixed });

    expect(markup).toContain(zh("settings.contacts.sourceFilterLabel"));
    expect(markup).toContain(zh("settings.contacts.filterAll"));
    expect(markup).toContain(zh("settings.contacts.filterManual"));
    expect(markup).toContain(zh("settings.contacts.filterAuto"));
    expect(markup).toContain(`<span class="source-filter-count">${mixed.length}</span>`);
    expect(markup).toContain(`<span class="source-filter-count">3</span>`);
    expect(markup).toContain(`<span class="source-filter-count">4</span>`);
  });

  it("groups the all-view into manual-first and auto-added sections with group counts", () => {
    const mixed: Contact[] = [
      ...Array.from({ length: 3 }, (_, index) => manualContact(`m${index}@example.com`, `Manual ${index}`)),
      ...Array.from({ length: 4 }, (_, index) => autoContact(`a${index}@example.com`, `Auto ${index}`)),
    ];
    const markup = renderSection({ initialContacts: mixed });

    // First page holds the manual section (3 rows) and the first 2 auto rows.
    expect(markup).toContain(`contact-group-head`);
    expect(markup).toContain(`${zh("settings.contacts.filterManual")}<span class="contact-group-count">(3)</span>`);
    expect(markup).toContain(`${zh("settings.contacts.filterAuto")}<span class="contact-group-count">(4)</span>`);
    expect(markup.indexOf(`Manual 0`)).toBeLessThan(markup.indexOf(`Auto 0`));
  });

  it("keeps manual-first / auto-second ordering inside pages when the toolbar is active", () => {
    const mixed: Contact[] = [
      ...Array.from({ length: 3 }, (_, index) => manualContact(`m${index}@example.com`, `Manual ${index}`)),
      ...Array.from({ length: 7 }, (_, index) => autoContact(`a${index}@example.com`, `Auto ${index}`)),
    ];
    const markup = renderSection({ initialContacts: mixed });

    // Page 1 (5 rows): the 3 manual rows precede the first 2 auto rows; the
    // auto group head still belongs to the group's first row on this page.
    expect(markup.indexOf(`Manual 2`)).toBeLessThan(markup.indexOf(`Auto 0`));
    expect(markup).toContain(`<span class="contact-group-count">(7)</span>`);
    // Page 2 keeps only auto rows; no manual head is rendered for it.
    expect(markup).not.toContain("a6@example.com");
  });
});

function manualContact(email: string, name: string): Contact {
  return { id: `manual-${email}`, email, name, notes: "", autoCollected: false, createdAt: "", updatedAt: "" };
}

function autoContact(email: string, name: string): Contact {
  return { id: `auto-${email}`, email, name, notes: "", autoCollected: true, createdAt: "", updatedAt: "" };
}

describe("contact source helpers", () => {
  const manual = (id: string): Contact => ({ id, email: `${id}@example.com`, name: "", notes: "", autoCollected: false, createdAt: "", updatedAt: "" });
  const auto = (id: string): Contact => ({ id, email: `${id}@example.com`, name: "", notes: "", autoCollected: true, createdAt: "", updatedAt: "" });

  it("applySourceFilter partitions by origin and keeps the all-view whole", () => {
    const list = [manual("m1"), auto("a1"), manual("m2"), auto("a2")];
    expect(applySourceFilter(list, "all").map((c) => c.id)).toEqual(["m1", "a1", "m2", "a2"]);
    expect(applySourceFilter(list, "manual").map((c) => c.id)).toEqual(["m1", "m2"]);
    expect(applySourceFilter(list, "auto").map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("orderContactsBySource moves manual rows before auto-added rows within each group's original order", () => {
    const list = [auto("a1"), manual("m1"), auto("a2"), manual("m2")];
    expect(orderContactsBySource(list).map((c) => c.id)).toEqual(["m1", "m2", "a1", "a2"]);
    expect(orderContactsBySource([auto("a1"), auto("a2")]).map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(orderContactsBySource([manual("m1")]).map((c) => c.id)).toEqual(["m1"]);
  });
});
