import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownFormat =
  | "bold"
  | "italic"
  | "heading"
  | "bulletList"
  | "numberedList"
  | "quote"
  | "code"
  | "link"
  | "divider"
  | "table";

export type TextStats = {
  words: number;
  characters: number;
  readingMinutes: number;
};

/**
 * Counts characters and words (with international support for CJK ideographs and Latin words).
 */
export function calculateTextStats(text: string): TextStats {
  if (!text.trim()) {
    return { words: 0, characters: 0, readingMinutes: 1 };
  }
  // Strip URLs and markdown formatting characters for accurate word count
  const withoutUrls = text.replace(/https?:\/\/[^\s)\]]+/g, " ");
  const plain = withoutUrls.replace(/[*_~`#>|[\]()-]/g, " ").trim();
  const characters = text.replace(/\r?\n/g, "").length;

  // Match Latin/alphanumeric words or individual CJK ideographs
  const matches = plain.match(/[a-zA-Z0-9_\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]+|[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/g);
  const words = matches ? matches.length : 0;
  const readingMinutes = Math.max(1, Math.ceil(words / 220));

  return { words, characters, readingMinutes };
}

/**
 * Pure function to apply Markdown syntax around current selection or cursor position.
 */
export function applyMarkdownFormat(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: MarkdownFormat,
): { text: string; newSelectionStart: number; newSelectionEnd: number } {
  const selectedText = value.slice(selectionStart, selectionEnd);
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);

  switch (format) {
    case "bold": {
      const placeholder = selectedText || "粗体文本";
      const replacement = `**${placeholder}**`;
      return {
        text: before + replacement + after,
        newSelectionStart: selectedText ? selectionStart : selectionStart + 2,
        newSelectionEnd: selectedText ? selectionStart + replacement.length : selectionStart + 2 + placeholder.length,
      };
    }
    case "italic": {
      const placeholder = selectedText || "斜体文本";
      const replacement = `*${placeholder}*`;
      return {
        text: before + replacement + after,
        newSelectionStart: selectedText ? selectionStart : selectionStart + 1,
        newSelectionEnd: selectedText ? selectionStart + replacement.length : selectionStart + 1 + placeholder.length,
      };
    }
    case "heading": {
      // Find line start
      const lineStart = before.lastIndexOf("\n") + 1;
      const currentLineBefore = before.slice(lineStart);
      const newBefore = before.slice(0, lineStart);
      const isAlreadyHeading = /^#{1,6}\s/.test(currentLineBefore);
      const prefix = isAlreadyHeading ? "" : "### ";
      const replacement = prefix + currentLineBefore + selectedText;
      return {
        text: newBefore + replacement + after,
        newSelectionStart: newBefore.length + replacement.length,
        newSelectionEnd: newBefore.length + replacement.length,
      };
    }
    case "bulletList": {
      const placeholder = selectedText || "列表项";
      const lines = placeholder.split(/\r?\n/);
      const listContent = lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n");
      const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const replacement = `${prefix}${listContent}`;
      return {
        text: before + replacement + after,
        newSelectionStart: before.length + replacement.length,
        newSelectionEnd: before.length + replacement.length,
      };
    }
    case "numberedList": {
      const placeholder = selectedText || "列表项";
      const lines = placeholder.split(/\r?\n/);
      const listContent = lines.map((l, i) => (/^\d+\.\s/.test(l) ? l : `${i + 1}. ${l}`)).join("\n");
      const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const replacement = `${prefix}${listContent}`;
      return {
        text: before + replacement + after,
        newSelectionStart: before.length + replacement.length,
        newSelectionEnd: before.length + replacement.length,
      };
    }
    case "quote": {
      const placeholder = selectedText || "引用文本";
      const lines = placeholder.split(/\r?\n/);
      const quoteContent = lines.map((l) => (l.startsWith("> ") ? l : `> ${l}`)).join("\n");
      const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
      const replacement = `${prefix}${quoteContent}`;
      return {
        text: before + replacement + after,
        newSelectionStart: before.length + replacement.length,
        newSelectionEnd: before.length + replacement.length,
      };
    }
    case "code": {
      if (selectedText.includes("\n")) {
        // Multi-line code block
        const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
        const replacement = `${prefix}\`\`\`\n${selectedText}\n\`\`\`\n`;
        return {
          text: before + replacement + after,
          newSelectionStart: before.length + replacement.length,
          newSelectionEnd: before.length + replacement.length,
        };
      }
      const placeholder = selectedText || "code";
      const replacement = `\`${placeholder}\``;
      return {
        text: before + replacement + after,
        newSelectionStart: selectedText ? selectionStart : selectionStart + 1,
        newSelectionEnd: selectedText ? selectionStart + replacement.length : selectionStart + 1 + placeholder.length,
      };
    }
    case "link": {
      const textPart = selectedText || "链接文字";
      const replacement = `[${textPart}](https://)`;
      const urlStart = before.length + textPart.length + 3;
      return {
        text: before + replacement + after,
        newSelectionStart: urlStart,
        newSelectionEnd: urlStart + 8, // selects "https://"
      };
    }
    case "divider": {
      const prefix = before.length > 0 && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      const replacement = `${prefix}---\n\n`;
      return {
        text: before + replacement + after,
        newSelectionStart: before.length + replacement.length,
        newSelectionEnd: before.length + replacement.length,
      };
    }
    case "table": {
      const prefix = before.length > 0 && !before.endsWith("\n") ? "\n\n" : "";
      const replacement = `${prefix}| 列 1 | 列 2 |\n| --- | --- |\n| 内容 A | 内容 B |\n\n`;
      return {
        text: before + replacement + after,
        newSelectionStart: before.length + replacement.length,
        newSelectionEnd: before.length + replacement.length,
      };
    }
  }
}

/**
 * Standard inline styling components for email HTML rendering.
 * Inlines styles directly so client email sanitizers (Gmail/Outlook) keep rich formatting.
 */
export const emailMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: "20px", fontWeight: "600", margin: "16px 0 8px 0", color: "#111827", lineHeight: "1.3" }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: "17px", fontWeight: "600", margin: "14px 0 6px 0", color: "#111827", lineHeight: "1.3" }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: "15px", fontWeight: "600", margin: "12px 0 4px 0", color: "#111827", lineHeight: "1.3" }}>
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p style={{ margin: "0 0 12px 0", lineHeight: "1.6", color: "#1f2937" }}>
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: "0 0 12px 0", paddingLeft: "24px", color: "#1f2937", lineHeight: "1.6" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ margin: "0 0 12px 0", paddingLeft: "24px", color: "#1f2937", lineHeight: "1.6" }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ marginBottom: "4px" }}>
      {children}
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote style={{ margin: "12px 0", padding: "6px 14px", borderLeft: "3px solid #3b82f6", color: "#4b5563", backgroundColor: "#f8fafc", borderRadius: "0 4px 4px 0" }}>
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} style={{ color: "#2563eb", textDecoration: "underline" }} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isInline = !className && typeof children === "string" && !children.includes("\n");
    if (isInline) {
      return (
        <code style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace", fontSize: "12px", backgroundColor: "#f3f4f6", padding: "2px 5px", borderRadius: "4px", color: "#be185d" }}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} style={{ fontFamily: "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace", fontSize: "12px" }} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre style={{ margin: "12px 0", padding: "12px 14px", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", overflowX: "auto", fontFamily: "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace", fontSize: "12px", lineHeight: "1.5", color: "#1e293b" }}>
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <table style={{ borderCollapse: "collapse", width: "100%", margin: "14px 0", fontSize: "13px" }}>
      {children}
    </table>
  ),
  thead: ({ children }) => (
    <thead style={{ backgroundColor: "#f8fafc" }}>
      {children}
    </thead>
  ),
  th: ({ children }) => (
    <th style={{ border: "1px solid #e2e8f0", padding: "8px 12px", textAlign: "left", fontWeight: "600", color: "#374151" }}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ border: "1px solid #e2e8f0", padding: "8px 12px", textAlign: "left", color: "#1f2937" }}>
      {children}
    </td>
  ),
  hr: () => (
    <hr style={{ border: "none", borderTop: "1px solid #e5e7eb", margin: "20px 0" }} />
  ),
};

/**
 * Converts markdown text into an email-safe HTML string wrapped in a typography container.
 */
export function markdownToEmailHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  const innerHtml = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: emailMarkdownComponents,
      },
      markdown,
    ),
  );

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937;">\n${innerHtml}\n</div>`;
}
