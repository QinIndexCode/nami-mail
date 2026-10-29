import { describe, expect, it } from "vitest";
import {
  applyMarkdownFormat,
  calculateTextStats,
  markdownToEmailHtml,
} from "./composeMarkdown";

describe("composeMarkdown", () => {
  describe("calculateTextStats", () => {
    it("handles empty text", () => {
      expect(calculateTextStats("")).toEqual({ words: 0, characters: 0, readingMinutes: 1 });
      expect(calculateTextStats("   \n\n  ")).toEqual({ words: 0, characters: 0, readingMinutes: 1 });
    });

    it("counts Latin words and characters correctly", () => {
      const stats = calculateTextStats("Hello world, this is a test.");
      expect(stats.words).toBe(6);
      expect(stats.characters).toBe(28);
      expect(stats.readingMinutes).toBe(1);
    });

    it("counts Chinese characters as words appropriately", () => {
      const stats = calculateTextStats("这是一封测试邮件，包含中文字数。");
      expect(stats.words).toBe(14); // 14 CJK characters
      expect(stats.characters).toBe(16); // includes punctuation
      expect(stats.readingMinutes).toBe(1);
    });

    it("ignores markdown syntax tokens and URLs in word count", () => {
      const stats = calculateTextStats("**粗体** and *斜体* with [link](https://example.com)");
      // 粗体 (2) + and (1) + 斜体 (2) + with (1) + link (1) = 7
      expect(stats.words).toBe(7);
    });
  });

  describe("applyMarkdownFormat", () => {
    it("wraps selected text with bold", () => {
      const input = "Hello world";
      const res = applyMarkdownFormat(input, 6, 11, "bold");
      expect(res.text).toBe("Hello **world**");
      expect(res.newSelectionStart).toBe(6);
      expect(res.newSelectionEnd).toBe(15);
    });

    it("inserts bold placeholder when no text is selected", () => {
      const input = "Hello ";
      const res = applyMarkdownFormat(input, 6, 6, "bold");
      expect(res.text).toBe("Hello **粗体文本**");
      expect(res.newSelectionStart).toBe(8);
      expect(res.newSelectionEnd).toBe(12);
    });

    it("wraps selected text with italic", () => {
      const input = "Hello world";
      const res = applyMarkdownFormat(input, 6, 11, "italic");
      expect(res.text).toBe("Hello *world*");
    });

    it("prepends heading prefix to line", () => {
      const input = "Title here";
      const res = applyMarkdownFormat(input, 5, 5, "heading");
      expect(res.text).toBe("### Title here");
    });

    it("creates bullet list from selection", () => {
      const input = "Item 1\nItem 2";
      const res = applyMarkdownFormat(input, 0, input.length, "bulletList");
      expect(res.text).toBe("- Item 1\n- Item 2");
    });

    it("creates numbered list from selection", () => {
      const input = "First\nSecond";
      const res = applyMarkdownFormat(input, 0, input.length, "numberedList");
      expect(res.text).toBe("1. First\n2. Second");
    });

    it("creates blockquote from selection", () => {
      const input = "Quote line 1\nQuote line 2";
      const res = applyMarkdownFormat(input, 0, input.length, "quote");
      expect(res.text).toBe("> Quote line 1\n> Quote line 2");
    });

    it("formats inline code for single line", () => {
      const input = "const a = 1;";
      const res = applyMarkdownFormat(input, 6, 7, "code");
      expect(res.text).toBe("const `a` = 1;");
    });

    it("formats code block for multiline selection", () => {
      const input = "function test() {\n  return 42;\n}";
      const res = applyMarkdownFormat(input, 0, input.length, "code");
      expect(res.text).toBe("```\nfunction test() {\n  return 42;\n}\n```\n");
    });

    it("inserts markdown link template", () => {
      const input = "Click here for details";
      const res = applyMarkdownFormat(input, 6, 10, "link");
      expect(res.text).toBe("Click [here](https://) for details");
      expect(res.text.slice(res.newSelectionStart, res.newSelectionEnd)).toBe("https://");
    });

    it("inserts horizontal divider", () => {
      const input = "Section 1";
      const res = applyMarkdownFormat(input, 9, 9, "divider");
      expect(res.text).toBe("Section 1\n\n---\n\n");
    });

    it("inserts table template", () => {
      const input = "Some text";
      const res = applyMarkdownFormat(input, 9, 9, "table");
      expect(res.text).toContain("| 列 1 | 列 2 |");
      expect(res.text).toContain("| 内容 A | 内容 B |");
    });

    it("uses localized placeholders when provided", () => {
      const englishPlaceholders = {
        bold: "bold text",
        italic: "italic text",
        listItem: "list item",
        quote: "quote text",
        code: "code",
        linkText: "link text",
        tableHeader1: "Column 1",
        tableHeader2: "Column 2",
        tableCellA: "Content A",
        tableCellB: "Content B",
      };

      const boldRes = applyMarkdownFormat("", 0, 0, "bold", englishPlaceholders);
      expect(boldRes.text).toBe("**bold text**");

      const italicRes = applyMarkdownFormat("", 0, 0, "italic", englishPlaceholders);
      expect(italicRes.text).toBe("*italic text*");

      const listRes = applyMarkdownFormat("", 0, 0, "bulletList", englishPlaceholders);
      expect(listRes.text).toBe("- list item");

      const quoteRes = applyMarkdownFormat("", 0, 0, "quote", englishPlaceholders);
      expect(quoteRes.text).toBe("> quote text");

      const linkRes = applyMarkdownFormat("", 0, 0, "link", englishPlaceholders);
      expect(linkRes.text).toBe("[link text](https://)");

      const tableRes = applyMarkdownFormat("", 0, 0, "table", englishPlaceholders);
      expect(tableRes.text).toContain("| Column 1 | Column 2 |");
      expect(tableRes.text).toContain("| Content A | Content B |");
    });
  });

  describe("markdownToEmailHtml", () => {
    it("returns empty string for empty input", () => {
      expect(markdownToEmailHtml("")).toBe("");
      expect(markdownToEmailHtml("   ")).toBe("");
    });

    it("renders headings, paragraphs, bold, italic with inline styles", () => {
      const md = "# Title\n\nThis is **bold** and *italic* text.";
      const html = markdownToEmailHtml(md);
      expect(html).toContain("<h1 style=\"font-size:20px;font-weight:600");
      expect(html).toContain("Title</h1>");
      expect(html).toContain("<p style=\"margin:0 0 12px 0");
      expect(html).toContain("<strong>bold</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain("font-family: -apple-system");
    });

    it("renders blockquote and inline code with email inline styles", () => {
      const md = "> This is a quote\n\nUse `npm test` to verify.";
      const html = markdownToEmailHtml(md);
      expect(html).toContain("<blockquote style=\"margin:12px 0;padding:6px 14px;border-left:3px solid #3b82f6");
      expect(html).toContain("<code style=\"font-family:ui-monospace");
      expect(html).toContain("npm test</code>");
    });

    it("renders markdown tables with styled table/th/td", () => {
      const md = "| A | B |\n|---|---|\n| 1 | 2 |";
      const html = markdownToEmailHtml(md);
      expect(html).toContain("<table style=\"border-collapse:collapse;width:100%");
      expect(html).toContain("<th style=\"border:1px solid #e2e8f0");
      expect(html).toContain("<td style=\"border:1px solid #e2e8f0");
    });

    it("renders links with target=_blank and color styling", () => {
      const md = "[Visit Google](https://google.com)";
      const html = markdownToEmailHtml(md);
      expect(html).toContain("<a href=\"https://google.com\"");
      expect(html).toContain("target=\"_blank\"");
      expect(html).toContain("color:#2563eb");
    });
  });
});
