import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown, sanitizeAgentMarkdownUrl, streamingMarkdownContent } from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  it("renders the GFM structures used in agent answers", () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdown content={`# Summary

- [x] Reconciled
- [ ] Follow up

~~Old~~ and **new**.

| Account | Status |
| --- | --- |
| Inbox | Ready |

\`inline\`

\`\`\`ts
const state = "ready";
\`\`\`

[Documentation](https://example.test/docs)`} />,
    );

    expect(markup).toContain("<h1>Summary</h1>");
    expect(markup).toContain('class="contains-task-list"');
    expect(markup).toContain('type="checkbox" disabled="" checked=""');
    expect(markup).toContain("<del>Old</del>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain('class="language-ts"');
    expect(markup).toContain('href="https://example.test/docs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it("keeps raw HTML escaped and prevents unsafe destinations from becoming links", () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdown content={`<script>alert("xss")</script>

[Unsafe](javascript:alert(1))

![Remote preview](https://cdn.example.test/preview.png)`} />,
    );

    expect(markup).toContain("&lt;script&gt;alert");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="https://cdn.example.test/preview.png"');
    expect(markup).toContain(">Remote preview</a>");
  });

  it("allows only explicit external link and image protocols", () => {
    expect(sanitizeAgentMarkdownUrl("https://example.test/path", "href")).toBe("https://example.test/path");
    expect(sanitizeAgentMarkdownUrl("mailto:team@example.test", "href")).toBe("mailto:team@example.test");
    expect(sanitizeAgentMarkdownUrl("https://example.test/preview.png", "src")).toBe("https://example.test/preview.png");
    expect(sanitizeAgentMarkdownUrl("javascript:alert(1)", "href")).toBeUndefined();
    expect(sanitizeAgentMarkdownUrl("data:text/html,unsafe", "src")).toBeUndefined();
    expect(sanitizeAgentMarkdownUrl("/local-route", "href")).toBeUndefined();
  });
});

describe("AgentMarkdown streaming", () => {
  it("renders a fully-streamed table once streaming completes", () => {
    // A finished table (the state after streaming ends) must render as <table>.
    const full = "# Title\n\n| Account | Status |\n| --- | --- |\n| Inbox | Ready |\n";
    const markup = renderToStaticMarkup(<AgentMarkdown content={full} />);
    expect(markup).toContain("<table>");
    expect(markup).toContain("<h1>Title</h1>");
  });

  it("renders completed markdown live while an unfinished code fence stays visible as text", () => {
    // Simulates the production chain: AgentMessageContent feeds the
    // streaming-safe truncated content into AgentMarkdown. A finished bold
    // line, a closed js fence, then an open python fence with typed lines.
    const content = "**Done** and _live_.\n```js\nconst x = 1;\n```\nmid text\n```py\nprint(1)\n";
    const markup = renderToStaticMarkup(<AgentMarkdown content={streamingMarkdownContent(content)} />);
    expect(markup).toContain("<strong>Done</strong>");
    expect(markup).toContain("<em>live</em>");
    expect(markup).toContain("language-js");
    expect(markup).toContain("mid text");
    // The unfinished python block is visible as plain text, not swallowed.
    expect(markup).toContain("print(1)");
    expect(markup).not.toContain("language-py");
  });
});

describe("streamingMarkdownContent", () => {
  it("passes through content without code fences untouched", () => {
    expect(streamingMarkdownContent("**bold** and `inline`")).toBe("**bold** and `inline`");
  });

  it("passes through closed fences untouched", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    expect(streamingMarkdownContent(input)).toBe(input);
  });

  it("truncates at the last closed fence and neutralises an open fence tail", () => {
    const input = "before\n```js\nconst x = 1;\n```\nmid\n```py\nprint(1)\n";
    const result = streamingMarkdownContent(input);
    // Everything up to the closed fence is preserved verbatim.
    expect(result).toContain("const x = 1;");
    expect(result).toContain("mid");
    // The unfinished python tail is visible but its fence is neutralised so it
    // cannot open a new block that swallows later content.
    expect(result).toContain("print(1)");
    expect(result).not.toContain("```py");
  });

  it("keeps an open fence at the very start visible as text", () => {
    const input = "```\nconst x = 1;\n";
    const result = streamingMarkdownContent(input);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```\nconst");
  });

  it("leaves inline code fences alone (not block fences)", () => {
    const input = "text `code` more";
    expect(streamingMarkdownContent(input)).toBe(input);
  });
});
