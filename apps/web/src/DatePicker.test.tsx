// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import DatePicker from "./DatePicker";
import { I18nProvider } from "./i18n";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("DatePicker (SSR)", () => {
  it("renders a trigger button without the browser-native input", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <DatePicker mode="date" value="2026-08-14" onChange={() => undefined} aria-label="选择日期" />
      </I18nProvider>,
    );
    expect(markup).not.toContain('type="date"');
    expect(markup).not.toContain('type="datetime-local"');
    expect(markup).toContain("date-picker-trigger");
    expect(markup).toContain("aria-expanded=\"false\"");
  });
});

describe("DatePicker (client)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onChange: (value: string) => void;

  function mount(mode: "date" | "datetime" = "date", value = "2026-08-14", extra: Partial<Parameters<typeof DatePicker>[0]> = {}): void {
    onChange = extra.onChange ?? vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <I18nProvider>
          <DatePicker mode={mode} value={value} onChange={onChange} aria-label="选择日期" {...extra} />
        </I18nProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  it("opens the month grid and picks a date in the current month", async () => {
    mount();
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    expect(document.querySelector(".date-picker-panel")).not.toBeNull();
    expect(document.querySelectorAll(".date-picker-day").length).toBe(42);

    // Pick the 15th day of the displayed month (August 2026).
    const dayButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"));
    const day15 = dayButtons.find((button) => button.textContent === "15" && !button.classList.contains("outside"));
    expect(day15).not.toBeUndefined();
    act(() => day15?.click());

    expect(onChange).toHaveBeenCalledWith("2026-08-15");
    // In date mode the panel plays its exit transition before unmounting.
    expect(document.querySelector(".date-picker-panel.closing")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(document.querySelector(".date-picker-panel")).toBeNull();
  });

  it("keeps the time when a datetime value is edited and closes only after picking", () => {
    mount("datetime", "2026-08-14T14:30");
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    expect(document.querySelector(".date-picker-time")).not.toBeNull();

    const dayButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"));
    const day15 = dayButtons.find((button) => button.textContent === "15" && !button.classList.contains("outside"));
    act(() => day15?.click());

    // Time is preserved from the previous value; the panel stays open in datetime mode.
    expect(onChange).toHaveBeenCalledWith("2026-08-15T14:30");
    expect(document.querySelector(".date-picker-panel")).not.toBeNull();
  });

  it("honours minDate by disabling earlier days", () => {
    mount("date", "2026-08-14", { minDate: "2026-08-10" });
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    const day9 = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"))
      .find((button) => button.textContent === "9" && !button.classList.contains("outside"));
    expect(day9?.disabled).toBe(true);
  });

  it("closes the panel on Escape", async () => {
    mount();
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    expect(document.querySelector(".date-picker-panel")).not.toBeNull();
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".date-picker-panel.closing")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(document.querySelector(".date-picker-panel")).toBeNull();
  });

  it("navigates to a far year through the month and year views", () => {
    mount("date", "2026-08-14");
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });

    // Day view -> click the nav title to open the month view.
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click();
    });
    expect(document.querySelectorAll(".date-picker-month").length).toBe(12);

    // Month view -> click the title (year) to open the year view.
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click();
    });
    expect(document.querySelectorAll(".date-picker-year").length).toBe(12);

    // Pick a year from the rolling window (2021).
    const yearButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-year"))
      .find((button) => button.textContent === "2021");
    act(() => yearButton?.click());
    // Back in month view, pick September (the 9th month, index 8).
    const monthButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-month"));
    expect(monthButtons.length).toBe(12);
    act(() => monthButtons[8]?.click());
    // Back in day view the label reflects September 2021.
    expect(document.querySelector<HTMLElement>(".date-picker-panel")?.textContent).toContain("2021");
    const dayButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"));
    const day15 = dayButtons.find((button) => button.textContent === "15" && !button.classList.contains("outside"));
    act(() => day15?.click());
    expect(onChange).toHaveBeenCalledWith("2021-09-15");
  });

  it("moves the focus with arrow keys and selects with Enter", () => {
    mount("date", "2026-08-14");
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    const grid = document.querySelector<HTMLDivElement>(".date-picker-grid");
    const focused = document.querySelector<HTMLButtonElement>(".date-picker-day.focused");
    expect(focused).not.toBeNull();

    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const moved = document.querySelector<HTMLButtonElement>(".date-picker-day.focused");
    expect(moved?.textContent).toBe("15");

    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("2026-08-15");
  });

  it("jumps to today via the today shortcut", async () => {
    mount("date", "2026-08-14");
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-today")?.click();
    });
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(onChange).toHaveBeenCalledWith(expected);
    // date mode closes after picking, with the exit transition in between.
    expect(document.querySelector(".date-picker-panel.closing")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(document.querySelector(".date-picker-panel")).toBeNull();
  });
});

describe("DatePicker (panel host)", () => {
  let root: Root;
  let host: HTMLDivElement;
  let dialogRef: React.RefObject<HTMLElement | null>;

  // The dialog element must be rendered by React itself: createRoot().render()
  // clears its container, so a pre-appended element would be wiped on mount.
  function Dialog(): React.ReactElement {
    const ref = useRef<HTMLElement>(null);
    dialogRef = ref;
    return (
      <section ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
        <I18nProvider>
          <DatePicker mode="date" value="2026-08-14" onChange={() => undefined} aria-label="选择日期" panelHost={ref} />
        </I18nProvider>
      </section>
    );
  }

  function mountInDialog(): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<Dialog />);
    });
    const dialog = dialogRef.current as HTMLElement;
    act(() => {
      dialog.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    return dialog;
  }

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  it("portals the panel into the host so it stays inside the dialog subtree", () => {
    const dialog = mountInDialog();
    const panel = document.querySelector(".date-picker-panel");
    expect(panel).not.toBeNull();
    // The whole point of the host: a body-portaled panel sits outside the
    // dialog, and useDialogFocus yanks focus straight back out of it.
    expect(dialog.contains(panel)).toBe(true);
    expect(panel?.parentElement).toBe(dialog);
    // Hosted panels must not stay viewport-fixed, or the dialog's own pinned
    // transform animation would become their containing block.
    expect(panel?.classList.contains("hosted")).toBe(true);
  });

  it("keeps day buttons focusable inside the trap", () => {
    const dialog = mountInDialog();
    const day = dialog.querySelector<HTMLButtonElement>(".date-picker-day");
    expect(day).not.toBeNull();
    act(() => { day?.focus(); });
    // The trap's own guard is `dialog.contains(event.target)`.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("falls back to document.body when no host is given", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const localRoot = createRoot(container);
    act(() => {
      localRoot.render(
        <I18nProvider>
          <DatePicker mode="date" value="2026-08-14" onChange={() => undefined} aria-label="选择日期" />
        </I18nProvider>,
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    const panel = document.querySelector(".date-picker-panel");
    expect(panel?.parentElement).toBe(document.body);
    expect(panel?.classList.contains("hosted")).toBe(false);
    act(() => localRoot.unmount());
    container.remove();
  });
});

describe("DatePicker (grid semantics)", () => {
  let host: HTMLDivElement;
  let root: Root;

  function mount(value = "2026-08-14"): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <I18nProvider>
          <DatePicker mode="date" value={value} onChange={() => undefined} aria-label="选择日期" />
        </I18nProvider>,
      );
    });
  }

  function openPanel(): void {
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
  }

  function press(target: Element | null, key: string): void {
    act(() => {
      target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  it("wraps day gridcells in rows so the grid is grid > row > gridcell", () => {
    mount();
    openPanel();
    const grid = document.querySelector(".date-picker-grid");
    expect(grid?.getAttribute("role")).toBe("grid");
    const rows = Array.from(grid?.children ?? []);
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.getAttribute("role")).toBe("row");
      for (const cell of Array.from(row.children)) expect(cell.getAttribute("role")).toBe("gridcell");
    }
  });

  // Only one view is mounted at a time, so each grid is checked on its own.
  function expectRowWrappedGrid(selector: string): void {
    const grid = document.querySelector(selector);
    expect(grid?.getAttribute("role")).toBe("grid");
    const rows = Array.from(grid?.children ?? []);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.getAttribute("role")).toBe("row");
      for (const cell of Array.from(row.children)) expect(cell.getAttribute("role")).toBe("gridcell");
    }
  }

  it("wraps month gridcells in rows", () => {
    mount();
    openPanel();
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    expectRowWrappedGrid(".date-picker-months");
  });

  it("wraps year gridcells in rows", () => {
    mount();
    openPanel();
    // day -> month -> year.
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    expectRowWrappedGrid(".date-picker-years");
  });

  it("gives each grid exactly one roving-tabindex cell", () => {
    mount();
    openPanel();
    const tabbableDays = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"))
      .filter((button) => button.tabIndex === 0);
    expect(tabbableDays.length).toBe(1);
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    const tabbableMonths = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-month"))
      .filter((button) => button.tabIndex === 0);
    expect(tabbableMonths.length).toBe(1);
  });

  it("moves the focused month with arrow keys and selects it with Enter", () => {
    mount();
    openPanel();
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });

    const months = Array.from(document.querySelectorAll(".date-picker-month"));
    const focusedText = () => document.querySelector(".date-picker-month.focused")?.textContent;
    // August (index 7) is focused on entry, since the value is 2026-08-14.
    expect(focusedText()).toBe(months[7]?.textContent);

    press(document.querySelector(".date-picker-months"), "ArrowRight");
    expect(focusedText()).toBe(months[8]?.textContent);

    // ArrowUp steps back a whole row of 4, not a single cell.
    press(document.querySelector(".date-picker-months"), "ArrowUp");
    expect(focusedText()).toBe(months[4]?.textContent);

    press(document.querySelector(".date-picker-months"), "Enter");
    // Picking a month returns to the day view showing that month.
    expect(document.querySelector(".date-picker-grid")).not.toBeNull();
    expect(document.querySelector(".date-picker-panel")?.textContent).toContain("5月");
  });

  it("moves the focused year with arrow keys", () => {
    mount();
    openPanel();
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });

    const years = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-year"));
    const focusedText = () => document.querySelector(".date-picker-year.focused")?.textContent;
    // The rolling window is centred on the viewed year, so 2026 sits at index 5.
    expect(focusedText()).toBe(years[5]?.textContent);
    press(document.querySelector(".date-picker-years"), "ArrowRight");
    expect(focusedText()).toBe(years[6]?.textContent);
    press(document.querySelector(".date-picker-years"), "ArrowDown");
    expect(focusedText()).toBe(years[10]?.textContent);
    // Stepping past the last cell is a no-op rather than an out-of-range move.
    press(document.querySelector(".date-picker-years"), "ArrowRight");
    expect(focusedText()).toBe(years[11]?.textContent);
  });

  it("closes the panel on Escape from the month and year views", async () => {
    mount();
    openPanel();
    act(() => { document.querySelector<HTMLButtonElement>(".date-picker-nav-title")?.click(); });
    press(document.querySelector(".date-picker-months"), "Escape");
    expect(document.querySelector(".date-picker-panel.closing")).not.toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
    expect(document.querySelector(".date-picker-panel")).toBeNull();
  });
});
