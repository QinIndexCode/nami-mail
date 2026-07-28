import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown, sanitizeAgentMarkdownUrl } from "./AgentMarkdown";

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
