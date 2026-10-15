// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTranscriptScroll, type UseTranscriptScrollOptions, type UseTranscriptScrollResult } from "./useTranscriptScroll";
import type { AgentMessage } from "../agentTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let lastHookResult: UseTranscriptScrollResult | null = null;

function ScrollHarness(props: UseTranscriptScrollOptions) {
  const result = useTranscriptScroll(props);
  lastHookResult = result;
  return (
    <div className="agent-transcript" ref={result.transcriptRef}>
      <div ref={result.messagesEndRef} />
    </div>
  );
}

describe("useTranscriptScroll", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    lastHookResult = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    lastHookResult = null;
  });

  const makeMessage = (id: string, role: "user" | "assistant", content = "hi"): AgentMessage => ({
    id,
    role,
    content,
    createdAt: "2026-10-13T08:00:00.000Z",
    citations: [],
    toolActivities: [],
    state: "complete",
  });

  it("pins to bottom when conversation loads", async () => {
    const userMessageElsRef = { current: new Map<string, HTMLElement>() };
    const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];

    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={messages}
          loadingConversationId={null}
          streaming={false}
          userMessages={[messages[0]!]}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    const transcriptEl = container.querySelector<HTMLDivElement>(".agent-transcript")!;
    expect(transcriptEl).not.toBeNull();
    expect(lastHookResult?.stickToBottomRef.current).toBe(true);
    expect(lastHookResult?.showScrollToBottom).toBe(false);
  });

  it("suppresses pinning while conversation skeleton is loading", async () => {
    const userMessageElsRef = { current: new Map<string, HTMLElement>() };

    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={[]}
          loadingConversationId="conv-1"
          streaming={false}
          userMessages={[]}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    // During loading of conv-1 skeleton, lastPinnedConversationId is not marked as finished
    // Now simulate conversation fetch completion:
    const messages = [makeMessage("u1", "user"), makeMessage("a1", "assistant")];
    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={messages}
          loadingConversationId={null}
          streaming={false}
          userMessages={[messages[0]!]}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    expect(lastHookResult?.stickToBottomRef.current).toBe(true);
    expect(lastHookResult?.showScrollToBottom).toBe(false);
  });

  it("disarms stickToBottom when user scrolls up (scrollTop decreases)", async () => {
    const userMessageElsRef = { current: new Map<string, HTMLElement>() };
    const messages = [makeMessage("u1", "user")];

    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={messages}
          loadingConversationId={null}
          streaming={false}
          userMessages={messages}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    const transcriptEl = container.querySelector<HTMLDivElement>(".agent-transcript")!;
    Object.defineProperty(transcriptEl, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(transcriptEl, "clientHeight", { value: 300, configurable: true });

    // Initial position at bottom
    transcriptEl.scrollTop = 700;
    act(() => {
      transcriptEl.dispatchEvent(new Event("scroll"));
    });
    expect(lastHookResult?.stickToBottomRef.current).toBe(true);

    // User scrolls up (scrollTop decreases to 200, distanceFromBottom = 1000 - 200 - 300 = 500)
    transcriptEl.scrollTop = 200;
    act(() => {
      transcriptEl.dispatchEvent(new Event("scroll"));
    });

    expect(lastHookResult?.stickToBottomRef.current).toBe(false);
    expect(lastHookResult?.showScrollToBottom).toBe(true);

    // User scrolls back down to bottom (scrollTop = 690, distanceFromBottom = 10)
    transcriptEl.scrollTop = 690;
    act(() => {
      transcriptEl.dispatchEvent(new Event("scroll"));
    });

    expect(lastHookResult?.stickToBottomRef.current).toBe(true);
    expect(lastHookResult?.showScrollToBottom).toBe(false);
  });

  it("jumpToUserMessage scrolls target element into view at the top of the container", async () => {
    const userMessage = makeMessage("u1", "user");
    const userMessageElsRef = { current: new Map<string, HTMLElement>() };
    const targetElement = document.createElement("article");
    userMessageElsRef.current.set("u1", targetElement);

    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={[userMessage]}
          loadingConversationId={null}
          streaming={false}
          userMessages={[userMessage]}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    const transcriptEl = container.querySelector<HTMLDivElement>(".agent-transcript")!;
    const scrollToMock = vi.fn();
    transcriptEl.scrollTo = scrollToMock;
    transcriptEl.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    targetElement.getBoundingClientRect = () => ({ top: 250 } as DOMRect);
    transcriptEl.scrollTop = 50;

    act(() => {
      lastHookResult?.jumpToUserMessage(0);
    });

    // targetTop = el.scrollTop + (nodeRect.top - containerRect.top) - 16
    // = 50 + (250 - 100) - 16 = 50 + 150 - 16 = 184
    expect(scrollToMock).toHaveBeenCalledWith({ top: 184, behavior: "smooth" });
    expect(lastHookResult?.stickToBottomRef.current).toBe(false);
    expect(lastHookResult?.showScrollToBottom).toBe(true);
  });

  it("scrollToBottom restores stickToBottom and triggers smooth scroll to container bottom", async () => {
    const userMessageElsRef = { current: new Map<string, HTMLElement>() };

    act(() => {
      root.render(
        <ScrollHarness
          activeConversationId="conv-1"
          activeMessages={[]}
          loadingConversationId={null}
          streaming={false}
          userMessages={[]}
          userMessageElsRef={userMessageElsRef}
        />,
      );
    });

    const transcriptEl = container.querySelector<HTMLDivElement>(".agent-transcript")!;
    const scrollToMock = vi.fn();
    transcriptEl.scrollTo = scrollToMock;
    Object.defineProperty(transcriptEl, "scrollHeight", { value: 1200, configurable: true });

    // Set to scrolled up
    if (lastHookResult) {
      lastHookResult.stickToBottomRef.current = false;
    }

    act(() => {
      lastHookResult?.scrollToBottom();
    });

    expect(lastHookResult?.stickToBottomRef.current).toBe(true);
    expect(lastHookResult?.showScrollToBottom).toBe(false);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
  });
});
