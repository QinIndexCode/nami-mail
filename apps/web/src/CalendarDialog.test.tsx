// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CalendarDialog from "./CalendarDialog";
import { I18nProvider } from "./i18n";

describe("CalendarDialog escape handling", () => {
  let root: Root;
  let container: HTMLElement;
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onClose = vi.fn();
    root = createRoot(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
  });

  it("closes the dialog on Escape after the dismiss transition", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <CalendarDialog demoMode onClose={onClose} />
        </I18nProvider>,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    // The close is deferred by the 170ms dismiss transition; the listener
    // must survive the re-render triggered by the closing state.
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <CalendarDialog demoMode onClose={onClose} />
        </I18nProvider>,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});