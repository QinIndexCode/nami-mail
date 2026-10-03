import { useCallback, useEffect, useRef, useState } from "react";

export type TypewriterOptions = {
  /** Target text to type out. */
  text: string;
  /** Base milliseconds per character (default: 18ms). */
  speedMs?: number;
  /** Maximum total animation duration in milliseconds (default: 1800ms). */
  maxDurationMs?: number;
  /** Whether typewriter animation should run (default: true). */
  enabled?: boolean;
  /** Optional callback fired when typing animation completes. */
  onComplete?: () => void;
};

export type TypewriterResult = {
  /** The portion of text revealed so far. */
  displayedText: string;
  /** Whether typing is currently in progress. */
  isTyping: boolean;
  /** Skip animation and reveal full text immediately. */
  complete: () => void;
  /** Reset displayed text. */
  reset: () => void;
};

/**
 * High-performance typewriter hook for progressive text generation display.
 * Adapts cadence to text length so long outputs complete within maxDurationMs.
 * Respects prefers-reduced-motion by revealing complete text instantly.
 */
export function useTypewriter({
  text,
  speedMs = 18,
  maxDurationMs = 1800,
  enabled = true,
  onComplete,
}: TypewriterOptions): TypewriterResult {
  const [displayedText, setDisplayedText] = useState(() => (enabled ? "" : text));
  const [isTyping, setIsTyping] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const complete = useCallback(() => {
    setDisplayedText(text);
    setIsTyping(false);
    onCompleteRef.current?.();
  }, [text]);

  const reset = useCallback(() => {
    setDisplayedText("");
    setIsTyping(false);
  }, []);

  useEffect(() => {
    if (!text) {
      setDisplayedText("");
      setIsTyping(false);
      return;
    }

    if (!enabled) {
      setDisplayedText(text);
      setIsTyping(false);
      return;
    }

    // Check system preference for reduced motion
    const prefersReducedMotion = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      setDisplayedText(text);
      setIsTyping(false);
      onCompleteRef.current?.();
      return;
    }

    // Calculate dynamic step interval and chunk size
    const totalChars = text.length;
    const effectiveIntervalMs = Math.max(10, Math.min(speedMs, Math.floor(maxDurationMs / Math.max(1, totalChars))));
    const charsPerStep = Math.max(1, Math.ceil(totalChars / (maxDurationMs / effectiveIntervalMs)));

    let currentIndex = 0;
    setDisplayedText("");
    setIsTyping(true);

    const timer = setInterval(() => {
      currentIndex = Math.min(totalChars, currentIndex + charsPerStep);
      setDisplayedText(text.slice(0, currentIndex));

      if (currentIndex >= totalChars) {
        clearInterval(timer);
        setIsTyping(false);
        onCompleteRef.current?.();
      }
    }, effectiveIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [text, speedMs, maxDurationMs, enabled]);

  return {
    displayedText,
    isTyping,
    complete,
    reset,
  };
}
