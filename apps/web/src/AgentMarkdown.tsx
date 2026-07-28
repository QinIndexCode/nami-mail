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
 * Renders LLM output without enabling raw HTML. React Markdown keeps raw HTML
 * as escaped text, while GFM covers tables, task lists, strikethrough, and
 * autolink literals. Remote images remain opt-in links to avoid background
 * requests from model-provided content.
 */
export function AgentMarkdown({ content }: { content: string }) {
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
}
