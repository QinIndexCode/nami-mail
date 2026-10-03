// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FormNotice } from "./FormNotice";
import { I18nProvider } from "./i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FormNotice component", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders null when notice is null", () => {
    act(() => {
      root.render(<FormNotice notice={null} />);
    });
    expect(container.querySelector(".form-status")).toBeNull();
  });

  it("renders a success notice with role status and check icon", () => {
    act(() => {
      root.render(<FormNotice notice={{ kind: "success", message: "All changes saved." }} />);
    });
    const status = container.querySelector(".form-status.success");
    expect(status).not.toBeNull();
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent).toContain("All changes saved.");
  });

  it("renders an error notice with role alert", () => {
    act(() => {
      root.render(<FormNotice notice={{ kind: "error", message: "Failed to connect." }} />);
    });
    const alert = container.querySelector(".form-status.error");
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("Failed to connect.");
  });

  it("automatically dismisses success notices after 4000ms delay and 200ms exit transition", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <FormNotice
          notice={{ kind: "success", message: "Restored defaults." }}
          onDismiss={onDismiss}
        />,
      );
    });

    expect(onDismiss).not.toHaveBeenCalled();

    // Fast-forward 3999ms: still not called and not closing
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector(".form-status.closing")).toBeNull();

    // Fast-forward past 4000ms: closing starts with exit transition!
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector(".form-status.closing")).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    // Fast-forward 200ms exit animation: onDismiss is invoked
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not automatically dismiss error notices by default", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <FormNotice
          notice={{ kind: "error", message: "Network error occurred." }}
          onDismiss={onDismiss}
        />,
      );
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("triggers exit transition and calls onDismiss after 200ms when clicking the close button", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <FormNotice
            notice={{ kind: "success", message: "Notification test sent." }}
            onDismiss={onDismiss}
          />
        </I18nProvider>,
      );
    });

    const dismissBtn = container.querySelector(".form-status-dismiss") as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();

    act(() => {
      dismissBtn.click();
    });
    // Immediately enters closing transition
    expect(container.querySelector(".form-status.closing")).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    // After 200ms exit animation finishes: onDismiss called!
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("respects custom autoDismissMs override before exit transition", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <FormNotice
          notice={{ kind: "error", message: "Temporary warning." }}
          onDismiss={onDismiss}
          autoDismissMs={2000}
        />,
      );
    });

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector(".form-status.closing")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector(".form-status.closing")).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("resets closing state if notice prop changes", () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <FormNotice
            notice={{ kind: "success", message: "Message 1" }}
            onDismiss={onDismiss}
          />
        </I18nProvider>,
      );
    });

    const dismissBtn = container.querySelector(".form-status-dismiss") as HTMLButtonElement;
    act(() => {
      dismissBtn.click();
    });
    expect(container.querySelector(".form-status.closing")).not.toBeNull();

    // Before exit timer fires, parent provides a new notice
    act(() => {
      root.render(
        <I18nProvider>
          <FormNotice
            notice={{ kind: "error", message: "Message 2" }}
            onDismiss={onDismiss}
          />
        </I18nProvider>,
      );
    });
    expect(container.querySelector(".form-status.closing")).toBeNull();
    expect(container.querySelector(".form-status.error")?.textContent).toContain("Message 2");

    // Advance 200ms - old onDismiss should not have been called
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
