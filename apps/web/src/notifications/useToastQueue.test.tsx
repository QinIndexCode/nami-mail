// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastQueue, type ToastAction } from "./useToastQueue";

function TestComponent({
  onHook,
}: {
  onHook: (hook: ReturnType<typeof useToastQueue>) => void;
}) {
  const hook = useToastQueue();
  useEffect(() => {
    onHook(hook);
  });
  return null;
}

describe("useToastQueue", () => {
  let root: Root;
  let container: HTMLElement;
  let hookValue: ReturnType<typeof useToastQueue>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const mountHook = () => {
    act(() => {
      root.render(<TestComponent onHook={(val) => { hookValue = val; }} />);
    });
  };

  it("displays a single toast and auto-dismisses after timeout", () => {
    mountHook();

    act(() => {
      hookValue.showToast("Message 1", "success");
    });

    expect(hookValue.toast?.message).toBe("Message 1");
    expect(hookValue.toast?.kind).toBe("success");

    // Fast-forward 3200ms
    act(() => {
      vi.advanceTimersByTime(3200);
    });

    expect(hookValue.toast).toBeNull();
  });

  it("protects actionable toast (e.g. Undo) from being overwritten by normal toast", () => {
    mountHook();
    const undoAction: ToastAction = { label: "Undo", run: vi.fn() };

    // Trigger actionable toast
    act(() => {
      hookValue.showToast("Mail sent", "success", undoAction);
    });

    expect(hookValue.toast?.message).toBe("Mail sent");
    expect(hookValue.toast?.action).toBe(undoAction);

    // Normal toast arrives (e.g. background sync or new mail)
    act(() => {
      hookValue.showToast("1 new mail", "info");
    });

    // Actionable toast is protected and remains on screen
    expect(hookValue.toast?.message).toBe("Mail sent");
    expect(hookValue.toast?.action).toBe(undoAction);

    // When the actionable toast's 6000ms duration finishes:
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    // The queued normal toast now appears
    expect(hookValue.toast?.message).toBe("1 new mail");
    expect(hookValue.toast?.kind).toBe("info");

    // When normal toast's 3200ms duration finishes:
    act(() => {
      vi.advanceTimersByTime(3200);
    });

    expect(hookValue.toast).toBeNull();
  });

  it("manual dismiss immediately advances to next queued toast", () => {
    mountHook();
    const undoAction: ToastAction = { label: "Undo", run: vi.fn() };

    act(() => {
      hookValue.showToast("Mail sent", "success", undoAction);
      hookValue.showToast("Next message", "info");
    });

    expect(hookValue.toast?.message).toBe("Mail sent");

    // Manually dismiss
    act(() => {
      hookValue.dismissToast();
    });

    // Immediately shows queued message
    expect(hookValue.toast?.message).toBe("Next message");
  });
});
