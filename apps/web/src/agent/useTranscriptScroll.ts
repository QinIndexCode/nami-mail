import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AgentMessage } from "../agentTypes";

export type UseTranscriptScrollOptions = {
  activeConversationId: string | undefined;
  activeMessages: AgentMessage[] | undefined;
  loadingConversationId: string | null;
  streaming: boolean;
  userMessages: AgentMessage[];
  userMessageElsRef: RefObject<Map<string, HTMLElement>>;
  userMarkerPositions?: number[];
};

export type UseTranscriptScrollResult = {
  transcriptRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
  showScrollToBottom: boolean;
  scrollToBottom: () => void;
  pinToBottom: () => void;
  jumpToUserMessage: (index: number) => void;
};

/**
 * Manages transcript scroll anchoring, bottom-pinning across streaming and
 * conversation switches, and smooth jumps to user messages from the scrubber.
 */
export function useTranscriptScroll({
  activeConversationId,
  activeMessages,
  loadingConversationId,
  streaming,
  userMessages,
  userMessageElsRef,
  userMarkerPositions,
}: UseTranscriptScrollOptions): UseTranscriptScrollResult {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastPinnedConversationIdRef = useRef<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const pinToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    const el = transcriptRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      lastScrollTopRef.current = el.scrollHeight;
    }
  }, []);

  const jumpToUserMessage = useCallback((index: number) => {
    const el = transcriptRef.current;
    const message = userMessages[index];
    if (!el || !message) return;

    stickToBottomRef.current = false;
    setShowScrollToBottom(true);

    const node = userMessageElsRef.current?.get(message.id)
      ?? el.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);

    if (node) {
      const containerRect = el.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const targetTop = el.scrollTop + (nodeRect.top - containerRect.top) - 16;
      el.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "smooth",
      });
      return;
    }

    const fallbackPosition = userMarkerPositions?.[index];
    if (fallbackPosition !== undefined) {
      el.scrollTo({ top: Math.max(0, fallbackPosition - 16), behavior: "smooth" });
    }
  }, [userMarkerPositions, userMessageElsRef, userMessages]);

  // Synchronous layout auto-scroll during token streaming.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, [activeMessages, streaming]);

  // Pin transcript to bottom when switching to or loading an existing conversation.
  useLayoutEffect(() => {
    if (!activeConversationId) {
      lastPinnedConversationIdRef.current = null;
      return;
    }
    // Don't pin the temporary shell/skeleton while data is fetching; wait until messages load.
    if (loadingConversationId === activeConversationId) {
      return;
    }
    if (lastPinnedConversationIdRef.current !== activeConversationId) {
      lastPinnedConversationIdRef.current = activeConversationId;
      pinToBottom();
    }
  }, [activeConversationId, loadingConversationId, pinToBottom]);

  // Handle scroll events and user disarm of stick-to-bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollToBottom(distanceFromBottom > 120);

      if (distanceFromBottom < 40) {
        stickToBottomRef.current = true;
      } else if (el.scrollTop < lastScrollTopRef.current) {
        // Disarm only when user scrolled up (scrollTop decreased).
        stickToBottomRef.current = false;
      }
      lastScrollTopRef.current = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow progressive expansions (markdown parsing, content-visibility unfold, images) while sticking to bottom.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    let prevScrollHeight = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && el.scrollHeight > prevScrollHeight) {
        prevScrollHeight = el.scrollHeight;
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    });

    observer.observe(el);
    for (let i = 0; i < el.children.length; i++) {
      observer.observe(el.children[i]);
    }

    return () => observer.disconnect();
  }, [activeConversationId, activeMessages]);

  return {
    transcriptRef,
    messagesEndRef,
    stickToBottomRef,
    showScrollToBottom,
    scrollToBottom,
    pinToBottom,
    jumpToUserMessage,
  };
}
