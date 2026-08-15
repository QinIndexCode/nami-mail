import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const linkProtocols = new Set(["http:", "https:", "mailto:"]);
const imageProtocols = new Set(["http:", "https:"]);

/**
 * Keep model-provided destinations within an explicit protocol allowlist.
 * Relative URLs are intentionally rejected so an answer cannot navigate the
 * local application to an unexpected route.
 */
export function sanitizeAgentMarkdownUrl(value: string, key: string): string | undefined {
  const transformed = defaultUrlTransform(value.trim());
  if (!transformed) return undefined;

  try {
    const url = new URL(transformed);
    const allowedProtocols = key === "href" ? linkProtocols : key === "src" ? imageProtocols : undefined;
    if (!allowedProtocols?.has(url.protocol.toLowerCase()) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export const transformAgentMarkdownUrl: UrlTransform = (value, key) => sanitizeAgentMarkdownUrl(value, key);

const markdownComponents: Components = {
  a: ({ node: _node, href, children, className, ...props }) => {
    if (!href) return <span className="agent-markdown-blocked-link">{children}</span>;
    const opensExternal = href.startsWith("http:") || href.startsWith("https:");
    return (
      <a
        {...props}
        className={["agent-markdown-link", className].filter(Boolean).join(" ")}
        href={href}
        target={opensExternal ? "_blank" : undefined}
        rel={opensExternal ? "noreferrer noopener" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, alt, title }) => {
    if (!src) return <span className="agent-markdown-image-blocked">{alt}</span>;
    return (
      <a
        className="agent-markdown-image-link"
        href={src}
        target="_blank"
        rel="noreferrer noopener"
        title={title || alt || undefined}
      >
        {alt || src}
      </a>
    );
  },
};

/**
 * Streaming-safe markdown: while tokens are still arriving, a code fence that
 * has not been closed yet would make react-markdown treat everything after it
 * as code. We render only up to the last *closed* fence, appending whatever
 * follows as plain text (fence neutralised), so an unfinished ``` block never
 * swallows the tail. Completed tables/lists/headings render live, giving the
 * streaming look without broken intermediates.
 */
export function streamingMarkdownContent(content: string): string {
  if (!content.includes("```")) return content;
  // Track the LAST unclosed block fence. Walking the content, a ``` that sits
  // on its own line toggles an open/close pair; anything after a still-open
  // fence is code and must be rendered as plain text (fence neutralised).
  let openFence = -1;
  let index = 0;
  while (index < content.length) {
    const fence = content.indexOf("```", index);
    if (fence === -1) break;
    // Inline code (``` inside a line) does not toggle block state; only a
    // fence at the start of a line (or the very start of the content) does.
    const lineStart = content.lastIndexOf("\n", fence - 1) + 1;
    const isBlockFence = fence === 0 || /^\s*$/.test(content.slice(lineStart, fence));
    if (isBlockFence) {
      if (openFence === -1) {
        openFence = fence;
      } else {
        openFence = -1; // closed the pair; next block fence re-opens
      }
    }
    index = fence + 3;
  }
  // No fence is left open: the markdown is complete, render it verbatim.
  if (openFence === -1) return content;
  // A fence is still open. Everything before it is safe markdown (the plain
  // text between closed blocks stays intact); the unfinished code from the
  // open fence onward is appended as plain text so what the model has typed
  // stays visible. The opening ``` and any nested ``` are neutralised with
  // zero-width spaces so react-markdown cannot open a fresh block that
  // swallows later content.
  const head = content.slice(0, openFence);
  const tail = content.slice(openFence);
  const neutralised = tail.replaceAll("```", "`\u200b`\u200b`");
  if (head.endsWith("\n") || neutralised.startsWith("\n")) return `${head}${neutralised}`;
  return `${head}\n${neutralised}`;
}

/**
 * The actual parser renderer, memoized so a parent re-render with the same
 * content (e.g. tool activity updates in the same row) does not re-parse.
 */
const AgentMarkdownRenderer = memo(function AgentMarkdownRendererInner({ content }: { content: string }) {
  return (
    <div className="agent-message-content">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml={false}
        urlTransform={transformAgentMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/**
 * Renders LLM output without enabling raw HTML. React Markdown keeps raw HTML
 * as escaped text, while GFM covers tables, task lists, strikethrough, and
 * autolink literals. Remote images remain opt-in links to avoid background
 * requests from model-provided content.
 *
 * The content is parsed directly on every render. Streaming is kept cheap by
 * the row-level memo in AgentWorkspace (only the in-flight message re-renders),
 * and `streamingMarkdownContent` already guards unfinished code fences. Unlike a
 * deferred value — whose low-priority re-render can be starved so a completed
 * table never appears until the conversation is reopened — the finished turn
 * renders the full content immediately.
 */
export function AgentMarkdown({ content }: { content: string }) {
  return <AgentMarkdownRenderer content={content} />;
}
