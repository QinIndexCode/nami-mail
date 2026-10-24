import { useEffect, useRef, type RefObject } from "react";

export interface UseInitialPromptOptions {
  initialPrompt?: string;
  autoSend?: boolean;
  loading: boolean;
  ready: boolean;
  onSend: (prompt: string) => Promise<void> | void;
  setComposer: (value: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Handles seeding the composer with an initial prompt and optionally triggering
 * auto-send (e.g. from reader "AI Summary" or "AI Draft Reply").
 *
 * - When not auto-sending: focuses the composer textarea and sets cursor to end.
 * - When auto-sending: waits until the workspace (including its initial
 *   transcript restore) finishes loading and is ready, then sends once.
 */
export function useInitialPrompt({
  initialPrompt,
  autoSend = false,
  loading,
  ready,
  onSend,
  setComposer,
  composerRef,
}: UseInitialPromptOptions): void {
  const hasAutoSentRef = useRef(false);
  const hasFocusedRef = useRef(false);
  const appliedPromptRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (initialPrompt !== undefined && initialPrompt !== appliedPromptRef.current) {
      appliedPromptRef.current = initialPrompt;
      setComposer(initialPrompt);
    }
  }, [initialPrompt, setComposer]);

  useEffect(() => {
    if (!initialPrompt || autoSend || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    window.requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        const pos = el.value.length || initialPrompt.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }, [initialPrompt, autoSend, composerRef]);

  useEffect(() => {
    if (!initialPrompt || !autoSend || loading || !ready || hasAutoSentRef.current) return;
    hasAutoSentRef.current = true;
    void onSend(initialPrompt);
  }, [initialPrompt, autoSend, loading, ready, onSend]);
}
