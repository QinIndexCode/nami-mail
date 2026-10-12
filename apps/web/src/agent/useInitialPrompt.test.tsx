// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useInitialPrompt, type UseInitialPromptOptions } from "./useInitialPrompt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: UseInitialPromptOptions) {
  useInitialPrompt(props);
  return null;
}

describe("useInitialPrompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("seeds composer and focuses at end without sending when autoSend is false", async () => {
    const setComposer = vi.fn();
    const onSend = vi.fn();
    const textarea = document.createElement("textarea");
    const setSelectionRange = vi.spyOn(textarea, "setSelectionRange");
    const composerRef = { current: textarea };

    act(() => {
      root.render(
        <Harness
          initialPrompt="/draft "
          autoSend={false}
          loading={false}
          ready={true}
          onSend={onSend}
          setComposer={setComposer}
          composerRef={composerRef}
        />,
      );
    });

    expect(setComposer).toHaveBeenCalledWith("/draft ");
    expect(onSend).not.toHaveBeenCalled();

    // rAF callback for focus & cursor positioning
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(setSelectionRange).toHaveBeenCalledWith(7, 7);
  });

  it("triggers onSend once when ready and autoSend is true", () => {
    const setComposer = vi.fn();
    const onSend = vi.fn();
    const composerRef = { current: null };

    // Initially loading
    act(() => {
      root.render(
        <Harness
          initialPrompt="/summary"
          autoSend={true}
          loading={true}
          ready={false}
          onSend={onSend}
          setComposer={setComposer}
          composerRef={composerRef}
        />,
      );
    });

    expect(onSend).not.toHaveBeenCalled();

    // Becomes ready
    act(() => {
      root.render(
        <Harness
          initialPrompt="/summary"
          autoSend={true}
          loading={false}
          ready={true}
          onSend={onSend}
          setComposer={setComposer}
          composerRef={composerRef}
        />,
      );
    });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("/summary");

    // Subsequent re-renders do not trigger onSend again
    act(() => {
      root.render(
        <Harness
          initialPrompt="/summary"
          autoSend={true}
          loading={false}
          ready={true}
          onSend={onSend}
          setComposer={setComposer}
          composerRef={composerRef}
        />,
      );
    });

    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
