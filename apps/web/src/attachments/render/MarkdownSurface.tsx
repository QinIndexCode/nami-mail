import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SurfaceProps } from "../document";

/**
 * Markdown surface (plan §4.4).
 *
 * The text is rendered by `react-markdown`, which never injects raw HTML: no
 * `rehype-raw` is configured and `skipHtml` drops raw blocks, so `<script>` in
 * an attachment comes out as nothing rather than as markup. Two element types
 * are replaced rather than trusted:
 *
 * - `a`: only `http`/`https` keep a href, and clicking one is intercepted and
 *   handed to `openExternal` instead of letting the webview navigate away from
 *   the app. `mailto:` keeps its href untouched because the app already owns
 *   that channel (the document-level handler opens the composer); everything
 *   else degrades to text.
 * - `img`: remote images are never loaded. The `src` is ignored outright, so a
 *   Markdown file cannot make the preview issue a network request or leak a
 *   read receipt.
 */

type Props = SurfaceProps & {
  /** Test seam and desktop bridge; the web build opens a new tab. */
  openExternal?: (url: string) => void;
};

type LinkTarget = { href: string; intercept: boolean };

function classifyLink(href: string | undefined): LinkTarget | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://preview.invalid/");
    if (url.protocol === "mailto:") return { href: url.toString(), intercept: false };
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // A relative or fragment href resolves against the placeholder origin; it
    // would point at the app itself, so it is not an external link at all.
    if (url.origin === "https://preview.invalid") return null;
    return { href: url.toString(), intercept: true };
  } catch {
    return null;
  }
}

function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function MarkdownSurface({ document, openExternal = openInBrowser }: Props) {
  const surface = document.surface;
  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        const target = classifyLink(href);
        if (!target) return <span className="attachment-preview-md-blocked">{children}</span>;
        if (!target.intercept) return <a href={target.href}>{children}</a>;
        return (
          <a
            href={target.href}
            rel="noreferrer noopener"
            target="_blank"
            onClick={(event) => {
              event.preventDefault();
              openExternal(target.href);
            }}
          >
            {children}
          </a>
        );
      },
      img({ alt }) {
        return (
          <span className="attachment-preview-md-image" role="img" aria-label={alt ?? ""}>
            {alt ?? ""}
          </span>
        );
      },
    }),
    [openExternal],
  );

  if (surface.surface !== "markdown") return null;
  return (
    <div className="attachment-preview-markdown">
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url, key) => (key === "src" ? "" : url)}
      >
        {surface.text}
      </ReactMarkdown>
    </div>
  );
}
