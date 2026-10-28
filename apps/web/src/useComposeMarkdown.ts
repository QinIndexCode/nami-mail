import { useRef, useState, type KeyboardEvent } from "react";
import { applyMarkdownFormat, type MarkdownFormat } from "./composeMarkdown";
import type { ComposeViewMode } from "./ComposeMarkdownToolbar";

export type UseComposeMarkdownOptions = {
  setText: (text: string) => void;
  initialViewMode?: ComposeViewMode;
};

export function useComposeMarkdown({
  setText,
  initialViewMode,
}: UseComposeMarkdownOptions) {
  const [markdownEnabled, setMarkdownEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("nami:compose-markdown-enabled") !== "false";
    } catch {
      return true;
    }
  });
  const [viewMode, setViewMode] = useState<ComposeViewMode>(initialViewMode ?? "write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleToggleMarkdown = (enabled: boolean) => {
    setMarkdownEnabled(enabled);
    if (!enabled && viewMode !== "write") setViewMode("write");
    try {
      localStorage.setItem("nami:compose-markdown-enabled", String(enabled));
    } catch {
      // ignore
    }
  };

  const handleFormat = (format: MarkdownFormat) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { selectionStart, selectionEnd, value } = textarea;
    const result = applyMarkdownFormat(value, selectionStart, selectionEnd, format);
    setText(result.text);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(result.newSelectionStart, result.newSelectionEnd);
      }
    });
  };

  const handleBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      handleFormat("bold");
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      handleFormat("italic");
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      handleFormat("link");
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      const form = textareaRef.current?.closest("form");
      if (form) form.requestSubmit();
    }
  };

  return {
    markdownEnabled,
    viewMode,
    setViewMode,
    textareaRef,
    handleToggleMarkdown,
    handleFormat,
    handleBodyKeyDown,
  };
}
