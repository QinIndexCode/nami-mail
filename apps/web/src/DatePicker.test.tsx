// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import DatePicker from "./DatePicker";
import { useDialogFocus } from "./hooks/useDialogFocus";
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

  it("keeps exactly one tab entry when paging into a month that starts past minDate", () => {
    // minDate lands mid-September while the selected day is in August, so the
    // whole rendered August grid is disabled and the nav arrow carries focus
    // across the boundary. The seed and month navigation have to agree on the
    // bounds: when they disagreed, September opened on a disabled 1st and only
    // ArrowRight could walk out of it, leaving ArrowLeft stuck for good.
    mount("date", "2026-08-31", { minDate: "2026-09-15" });
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    const tabbable = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"))
      .filter((button) => button.getAttribute("tabindex") === "0");

    act(() => {
      document.querySelectorAll<HTMLButtonElement>(".date-picker-nav-button")[1]?.click();
    });
    expect(tabbable().length).toBe(1);
    expect(tabbable()[0]?.disabled).toBe(false);

    // Focus must be able to move in either direction from the seeded day.
    const grid = document.querySelector<HTMLDivElement>(".date-picker-grid");
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(document.querySelectorAll('.date-picker-day[tabindex="0"]').length).toBe(1);
    act(() => {
      grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.querySelectorAll('.date-picker-day[tabindex="0"]').length).toBe(1);
  });

  it("leaves the grid unenterable when every rendered day is out of range", () => {
    // Nothing here is a legal day, so there is deliberately no entry point;
    // what matters is that this is the only state in which that holds.
    mount("date", "", { minDate: "2027-01-01" });
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    expect(document.querySelectorAll('.date-picker-day[tabindex="0"]').length).toBe(0);
    expect(document.querySelectorAll<HTMLButtonElement>(".date-picker-day:disabled").length).toBe(42);
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
  // The real useDialogFocus is mounted here, not a stand-in: the whole point of
  // panelHost is that the trap must not yank focus out of the panel, and only
  // the actual trap decides that.
  function Dialog({ trap = true }: { trap?: boolean }): React.ReactElement {
    const ref = useRef<HTMLElement>(null);
    dialogRef = ref;
    useDialogFocus(trap, ref, { suspended: !trap });
    return (
      <section ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
        <I18nProvider>
          <DatePicker mode="date" value="2026-08-14" onChange={() => undefined} aria-label="选择日期" panelHost={ref} />
        </I18nProvider>
      </section>
    );
  }

  function mountInDialog(options: { trap?: boolean } = {}): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<Dialog {...options} />);
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

  it("portals the panel to the body so no dialog overflow can clip it", () => {
    mountInDialog();
    const panel = document.querySelector(".date-picker-panel");
    expect(panel).not.toBeNull();
    // In-dialog placement is what the clipping bug was: every host card has
    // overflow (hidden on .compose-card, a scroll container on .modal-card and
    // .calendar-editor-modal), and position:absolute cannot escape it. The
    // panel stays fixed against the viewport instead.
    expect(panel?.parentElement).toBe(document.body);
    // Nothing may re-scope it to the dialog box (the dialogs' entry animation
    // leaves a transform, which would become the containing block).
    expect(panel?.classList.contains("hosted")).toBe(false);
  });

  it("keeps day buttons focusable under the real focus trap", () => {
    mountInDialog();
    const panel = document.querySelector(".date-picker-panel");
    const day = panel?.querySelector<HTMLButtonElement>(".date-picker-day");
    expect(day).not.toBeNull();
    act(() => { day?.focus(); });
    // The trap listens for focusin on document and pulls focus back to the
    // dialog when the target is outside its scope. The panel is portaled to the
    // body, so only the portal registration keeps this from being an escape.
    expect(document.activeElement).toBe(day);
  });

  it("yanks focus back out of an unregistered panel, proving the registration is load-bearing", () => {
    // The inverse of the test above: an unhosted panel inside the same real trap
    // DOES lose focus. Without this, the passing test above could be satisfied
    // by a trap that was never mounted at all.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    function Bare(): React.ReactElement {
      const ref = useRef<HTMLElement>(null);
      dialogRef = ref;
      useDialogFocus(true, ref);
      return (
        <section ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
          <I18nProvider>
            {/* No panelHost: the panel is not registered with this trap. */}
            <DatePicker mode="date" value="2026-08-14" onChange={() => undefined} aria-label="选择日期" />
          </I18nProvider>
        </section>
      );
    }
    act(() => { root.render(<Bare />); });
    const dialog = dialogRef.current as HTMLElement;
    act(() => { dialog.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click(); });

    const day = document.querySelector<HTMLButtonElement>(".date-picker-panel .date-picker-day");
    expect(day).not.toBeNull();
    act(() => { day?.focus(); });
    expect(document.activeElement).not.toBe(day);
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

describe("DatePicker (cross-month keyboard navigation)", () => {
  let host: HTMLDivElement;
  let root: Root;

  function mount(value = "2026-08-14", extra: Record<string, unknown> = {}): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <I18nProvider>
          <DatePicker mode="date" value={value} onChange={() => undefined} aria-label="选择日期" {...extra} />
        </I18nProvider>,
      );
    });
  }

  const openPanel = () => act(() => {
    document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
  });
  const grid = () => document.querySelector<HTMLDivElement>(".date-picker-grid");
  const press = (key: string) => act(() => {
    grid()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  /** The focused cell's aria-label: locale-independent, unlike its text. */
  const focusedLabel = () => document.querySelector(".date-picker-day.focused")?.getAttribute("aria-label");
  const monthLabel = () => grid()?.getAttribute("aria-label");
  const tabbable = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-day"))
    .filter((button) => button.tabIndex === 0);

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  // Arrowing out of the displayed month changes viewMonth, which is exactly the
  // dependency the focus-seeding effect used to carry. Re-running it reset the
  // focus to the selected day — a day the new grid does not even render — so
  // the grid ended up with no tabbable cell and keyboard navigation was dead.
  it("follows the focus across a month boundary instead of resetting it", () => {
    mount();
    openPanel();
    expect(focusedLabel()).toBe("2026年8月14日");

    // Walk to the 31st: 17 steps of ArrowRight from the 14th.
    for (let step = 0; step < 17; step += 1) press("ArrowRight");
    expect(focusedLabel()).toBe("2026年8月31日");
    expect(monthLabel()).toContain("8");

    // One more crosses into September, and the focus must go with it.
    press("ArrowRight");
    expect(monthLabel()).toContain("9");
    expect(focusedLabel()).toBe("2026年9月1日");
    // Still exactly one entry point, and it is the cell the focus is on.
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]?.getAttribute("aria-label")).toBe("2026年9月1日");

    // And back the other way, which is the case that used to strand the reader.
    press("ArrowLeft");
    expect(monthLabel()).toContain("8");
    expect(focusedLabel()).toBe("2026年8月31日");
    expect(tabbable()).toHaveLength(1);
  });

  it("keeps a tabbable cell after a multi-step walk across several months", () => {
    mount();
    openPanel();
    // 42 cells is six weeks, so this walks well past a single boundary.
    for (let step = 0; step < 20; step += 1) press("ArrowRight");
    expect(monthLabel()).toContain("9");
    expect(focusedLabel()).toBe("2026年9月3日");
    expect(tabbable()).toHaveLength(1);
  });

  it("keeps a tabbable cell when the nav arrows step to another month", () => {
    mount();
    openPanel();
    // The nav arrows move the month without moving the focus at all, so
    // nothing but the component itself can restore the roving tabindex.
    act(() => {
      const navs = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-nav-button"));
      navs[1]?.click();
    });
    expect(monthLabel()).toContain("9");
    expect(tabbable()).toHaveLength(1);
    // The same day-of-month carries over.
    expect(focusedLabel()).toBe("2026年9月14日");
  });

  it("carries the day across a nav step without wrapping past a short month", () => {
    // 31 January + 1 month has no 31st; the focus must land on the 28th rather
    // than on nothing at all.
    mount("2027-01-31");
    openPanel();
    expect(focusedLabel()).toContain("1");
    act(() => {
      const navs = Array.from(document.querySelectorAll<HTMLButtonElement>(".date-picker-nav-button"));
      navs[1]?.click();
    });
    expect(tabbable()).toHaveLength(1);
    expect(focusedLabel()).toContain("28");
  });

  it("never rests the roving tabindex on a day outside minDate/maxDate", () => {
    // A disabled button is skipped by Tab and refuses programmatic focus, so a
    // focused one is unreachable: the grid would have no entry point at all.
    mount("2026-08-14", { minDate: "2026-08-10" });
    openPanel();
    // Four steps back from the 14th lands on the 10th, the first enabled day.
    for (let step = 0; step < 4; step += 1) press("ArrowLeft");
    expect(focusedLabel()).toBe("2026年8月10日");

    // One more would be the 9th, which is disabled: the step is refused and the
    // focus holds, rather than parking on an unpickable cell.
    press("ArrowLeft");
    expect(focusedLabel()).toBe("2026年8月10日");
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]?.disabled).toBe(false);
    expect(document.querySelector(".date-picker-day.focused")?.getAttribute("aria-label")).toBe("2026年8月10日");
  });

  it("skips a disabled day rather than stopping on it", () => {
    // Only the 12th is excluded, so arrowing back from the 14th steps over it.
    mount("2026-08-14", { minDate: "2026-08-13" });
    openPanel();
    press("ArrowLeft");
    expect(focusedLabel()).toBe("2026年8月13日");
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]?.disabled).toBe(false);
  });
});
