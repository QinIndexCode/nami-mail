// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTypewriter } from "./useTypewriter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TestComponent({
  text,
  speedMs,
  onComplete,
  onState,
}: {
  text: string;
  speedMs?: number;
  onComplete?: () => void;
  onState?: (state: { displayedText: string; isTyping: boolean; complete: () => void }) => void;
}) {
  const result = useTypewriter({ text, speedMs, onComplete });
  onState?.(result);
  return <div data-testid="output">{result.displayedText}</div>;
}

describe("useTypewriter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("progressively reveals text over time", () => {
    let latestState: any;
    act(() => {
      root.render(
        <TestComponent
          text="Hello World"
          speedMs={20}
          onState={(s) => {
            latestState = s;
          }}
        />,
      );
    });

    expect(latestState.displayedText).toBe("");
    expect(latestState.isTyping).toBe(true);

    act(() => {
      vi.advanceTimersByTime(60);
    });

    expect(latestState.displayedText.length).toBeGreaterThan(0);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(latestState.displayedText).toBe("Hello World");
    expect(latestState.isTyping).toBe(false);
  });

  it("immediately completes text when complete() is called", () => {
    const onComplete = vi.fn();
    let latestState: any;

    act(() => {
      root.render(
        <TestComponent
          text="Quick draft response"
          speedMs={50}
          onComplete={onComplete}
          onState={(s) => {
            latestState = s;
          }}
        />,
      );
    });

    expect(latestState.isTyping).toBe(true);

    act(() => {
      latestState.complete();
    });

    expect(latestState.displayedText).toBe("Quick draft response");
    expect(latestState.isTyping).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("handles empty or falsy text without typing", () => {
    let latestState: any;
    act(() => {
      root.render(
        <TestComponent
          text=""
          onState={(s) => {
            latestState = s;
          }}
        />,
      );
    });

    expect(latestState.displayedText).toBe("");
    expect(latestState.isTyping).toBe(false);
  });
});
