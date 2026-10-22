// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CopyButton, { COPY_FEEDBACK_MS } from "./CopyButton";

describe("CopyButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("copies, shows a checkmark, announces, then returns to the copy icon", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => {
      root.render(
        <CopyButton text="hello" ariaLabel="Copy hello" label="Copy" copiedLabel="Copied" announcement="Copied hello" />,
      );
    });

    const button = container.querySelector("button")!;
    expect(button.classList.contains("copy-button")).toBe(true);
    expect(button.classList.contains("copied")).toBe(false);
    // The icon leads the label (the order every pre-refactor copy control had).
    // Both glyphs are mounted so CSS can cross-fade between them in either
    // direction; `.copied` selects which one is visible.
    const icon = button.firstElementChild!;
    expect(icon.classList.contains("copy-button-icon")).toBe(true);
    expect(icon.querySelector(".lucide-copy")).not.toBeNull();
    expect(icon.querySelector(".lucide-check")).not.toBeNull();
    expect(button.lastElementChild?.textContent).toBe("Copy");

    await act(async () => button.click());

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.textContent).toBe("Copied");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Copied hello");

    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 100));
    expect(button.classList.contains("copied")).toBe(true);

    act(() => vi.advanceTimersByTime(100));
    expect(button.classList.contains("copied")).toBe(false);
    expect(button.firstElementChild?.querySelector(".lucide-copy")).not.toBeNull();
    expect(container.querySelector('[role="status"]')!.textContent).toBe("");
  });

  it("reports a failed copy without showing the checkmark", async () => {
    const copy = vi.fn(async (_text: string) => false);
    const onFailed = vi.fn();
    await act(async () => {
      root.render(<CopyButton text="x" ariaLabel="Copy" copy={copy} onFailed={onFailed} />);
    });

    await act(async () => container.querySelector("button")!.click());

    expect(copy).toHaveBeenCalledWith("x");
    expect(onFailed).toHaveBeenCalledTimes(1);
    const button = container.querySelector("button")!;
    expect(button.classList.contains("copied")).toBe(false);
    expect(button.firstElementChild?.querySelector(".lucide-check")).not.toBeNull();
    // The checkmark stays mounted (CSS hides it), so the assertion that matters
    // is that the button never entered the copied state.
  });

  it("drops the copied state when the text changes", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => {
      root.render(<CopyButton text="first" ariaLabel="Copy" />);
    });
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")!.classList.contains("copied")).toBe(true);

    await act(async () => {
      root.render(<CopyButton text="second" ariaLabel="Copy" />);
    });

    expect(container.querySelector("button")!.classList.contains("copied")).toBe(false);
  });

  it("ignores a copy that resolves after the text changed", async () => {
    let resolveCopy: (value: boolean) => void = () => undefined;
    const copy = vi.fn(() => new Promise<boolean>((resolve) => { resolveCopy = resolve; }));
    await act(async () => {
      root.render(<CopyButton text="first" ariaLabel="Copy" copy={copy} />);
    });

    act(() => container.querySelector("button")!.click());
    await act(async () => {
      root.render(<CopyButton text="second" ariaLabel="Copy" copy={copy} />);
    });
    await act(async () => {
      resolveCopy(true);
    });

    // The old attempt copied "first"; confirming it now would swear the button
    // holds "second" (and announce a copy of it).
    expect(copy).toHaveBeenCalledWith("first");
    expect(container.querySelector("button")!.classList.contains("copied")).toBe(false);
  });
});
