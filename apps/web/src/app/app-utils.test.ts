// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collapseQuotedMailHtml, splitQuotedMailText } from "./app-utils";

describe("collapseQuotedMailHtml", () => {
  it("folds a top-level blockquote into a details toggle", () => {
    const html = "<p>Reply text</p><blockquote><p>quoted history</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "显示引用的原文");
    expect(folded).toContain('<details class="mail-quote"><summary>显示引用的原文</summary>');
    expect(folded).toContain("<blockquote><p>quoted history</p></blockquote>");
    expect(folded).toContain("<p>Reply text</p>");
  });

  it("folds a gmail_quote wrapper as one block without double-wrapping its inner blockquote", () => {
    const html = '<p>Reply</p><div class="gmail_quote"><div class="gmail_attr">On … wrote:</div><blockquote><p>quoted</p></blockquote></div>';
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
    expect(folded).toContain("On … wrote:");
    expect(folded).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("folds only the outermost quote when quotes are nested", () => {
    const html = "<p>Reply</p><blockquote><p>first</p><blockquote><p>second</p></blockquote></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(1);
  });

  it("folds each sibling quote at its original position", () => {
    const html = "<blockquote><p>q1</p></blockquote><p>middle</p><blockquote><p>q2</p></blockquote>";
    const folded = collapseQuotedMailHtml(html, "Show quoted text");
    expect(folded.match(/<details class="mail-quote">/g)).toHaveLength(2);
    expect(folded.indexOf("middle")).toBeGreaterThan(folded.indexOf("q1"));
    expect(folded.indexOf("q2")).toBeGreaterThan(folded.indexOf("middle"));
  });

  it("returns the input unchanged when there is nothing to fold", () => {
    const html = "<p>Just a message.</p>";
    expect(collapseQuotedMailHtml(html, "Show quoted text")).toBe(html);
    expect(collapseQuotedMailHtml("", "Show quoted text")).toBe("");
  });
});

describe("splitQuotedMailText", () => {
  it('splits a trailing ">" quote block, including blank lines inside it', () => {
    const text = "Hello\n\nReply body.\n\n> quoted answer\n\n> more quoting\n";
    expect(splitQuotedMailText(text)).toEqual({ body: "Hello\n\nReply body.", quote: "> quoted answer\n\n> more quoting" });
  });

  it("splits at a classic separator header even without > prefixes", () => {
    const text = "收到。\n\n-----原始邮件-----\n发件人: Someone\n正文被旧客户端复制下来";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("收到。");
    expect(parts.quote).toContain("-----原始邮件-----");
    expect(parts.quote).toContain("正文被旧客户端复制下来");
  });

  it("supports the English original-message separator", () => {
    const text = "Got it.\n\n----- Original Message -----\nFrom: Someone\nforwarded body";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("Got it.");
    expect(parts.quote).toContain("forwarded body");
  });

  it("leaves interleaved replies inline and only folds the trailing quote", () => {
    const text = "answer one\n\n> old quote\n\nanswer two\n\n> newer quote";
    const parts = splitQuotedMailText(text);
    expect(parts.body).toBe("answer one\n\n> old quote\n\nanswer two");
    expect(parts.quote).toBe("> newer quote");
  });

  it("never folds when the whole message is a quote", () => {
    const text = "> all quoted";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });

  it("returns plain text unchanged when there is no quote", () => {
    const text = "Hello\n\nNothing quoted here.";
    expect(splitQuotedMailText(text)).toEqual({ body: text, quote: "" });
  });
});
