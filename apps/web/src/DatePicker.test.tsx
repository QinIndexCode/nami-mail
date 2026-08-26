// @vitest-environment jsdom
import { act } from "react";
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

  it("opens the month grid and picks a date in the current month", () => {
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
    // In date mode the panel closes after picking.
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

  it("closes the panel on Escape", () => {
    mount();
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")?.click();
    });
    expect(document.querySelector(".date-picker-panel")).not.toBeNull();
    act(() => {
      document.querySelector<HTMLButtonElement>(".date-picker-trigger")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
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

  it("jumps to today via the today shortcut", () => {
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
    // date mode closes after picking.
    expect(document.querySelector(".date-picker-panel")).toBeNull();
  });
});
