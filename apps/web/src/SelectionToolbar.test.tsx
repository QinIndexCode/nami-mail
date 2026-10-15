// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "./i18n";
import { SelectionToolbar, type SelectionToolbarProps } from "./SelectionToolbar";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

/** Every control that starts a batch, by the label it renders. */
const ACTION_KEYS = [
  "mail.action.markRead",
  "mail.action.markUnread",
  "mail.action.star",
  "mail.action.unstar",
  "mail.action.archive",
  "mail.action.reportSpam",
  "mail.action.moveToTrash",
];

const RUNNING_JOB: NonNullable<SelectionToolbarProps["job"]> = {
  id: "j1", kind: "flags", status: "running", total: 12, done: 3, updated: 0, failed: 0, createdAt: 1,
};

/** The opening tag of a button, so `disabled` is read where it is decided
 *  rather than anywhere else in the markup. */
function openingTag(markup: string, at: number): string {
  return markup.slice(markup.lastIndexOf("<button", at), markup.indexOf(">", at));
}

/** The opening tag of the button carrying `key`'s label, or of the button whose
 *  class list starts with `classNamePrefix`. */
function buttonTag(markup: string, key: string | { classNamePrefix: string }): string {
  const at = typeof key === "string" ? markup.indexOf(`aria-label="${zh(key)}"`) : markup.indexOf(`class="${key.classNamePrefix}`);
  expect(at, `${String(key)} is not in the markup at all`).toBeGreaterThan(-1);
  return openingTag(markup, at);
}

function disabled(markup: string, key: string | { classNamePrefix: string }): boolean {
  return buttonTag(markup, key).includes("disabled");
}

function renderToolbar(overrides: Partial<SelectionToolbarProps> = {}): string {
  const props: SelectionToolbarProps = {
    visible: true,
    selectAllPaged: false,
    selectedCount: 3,
    selectableCount: 3,
    matchingCount: 3,
    job: null,
    busy: false,
    onSelectAll: vi.fn(),
    onSetSeen: vi.fn(),
    onSetFlagged: vi.fn(),
    onMove: vi.fn(),
    onTrash: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <SelectionToolbar {...props} />
    </I18nProvider>,
  );
}

describe("SelectionToolbar", () => {
  it("makes every batch action inert while a job owns the selection", () => {
    const markup = renderToolbar({ job: RUNNING_JOB });

    for (const key of ACTION_KEYS) {
      expect(disabled(markup, key), `${key} could start a second batch over the same rows`).toBe(true);
    }
    // The count line reports the job instead of the selection, so the bar does
    // say why the actions are inert.
    expect(markup).toContain(zh("mail.selection.batchProcessing", { done: 3, total: 12 }));
    // Leaving multi-select stays available: the job keeps running server-side,
    // and there is nothing else the user can do about it from here.
    expect(disabled(markup, { classNamePrefix: "selection-done" })).toBe(false);
  });

  it("leaves the batch actions available when no job owns the selection", () => {
    const markup = renderToolbar();

    for (const key of ACTION_KEYS) {
      expect(disabled(markup, key), `${key} must be usable with rows selected`).toBe(false);
    }
    expect(markup).toContain(zh("mail.selection.count", { count: 3 }));
  });

  it("holds the batch actions back until something is selected", () => {
    const idle = renderToolbar({ selectedCount: 0, selectableCount: 0, matchingCount: 0 });

    for (const key of ACTION_KEYS) {
      expect(disabled(idle, key), `${key} has nothing to act on`).toBe(true);
    }
  });

  it("answers to the server's total once the selection covers the whole view", () => {
    // A predicate selection reaches rows the renderer never loaded, so the count
    // and the select-all label both report the matching total rather than the
    // rows on screen.
    const paged = renderToolbar({ selectAllPaged: true, matchingCount: 40 });

    expect(disabled(paged, "mail.action.markRead"), "a predicate selection has rows to act on").toBe(false);
    expect(disabled(paged, "mail.action.moveToTrash")).toBe(false);
    expect(paged).toContain(zh("mail.selection.selectAllMatching", { count: 40 }));
    expect(paged).toContain(zh("mail.selection.count", { count: 40 }));
  });

  it("stays out of the way when multi-select is not active", () => {
    expect(renderToolbar({ visible: false })).toContain('aria-hidden="true"');
    expect(renderToolbar({ visible: true })).toContain('aria-hidden="false"');
  });

  it("holds the done button while a request is in flight", () => {
    expect(disabled(renderToolbar({ busy: true }), { classNamePrefix: "selection-done" })).toBe(true);
    expect(disabled(renderToolbar({ busy: false }), { classNamePrefix: "selection-done" })).toBe(false);
  });
});
