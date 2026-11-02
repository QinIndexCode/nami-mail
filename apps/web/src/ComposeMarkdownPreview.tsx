import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "./i18n";

export type ComposeMarkdownPreviewProps = {
  content: string;
  className?: string;
};

const previewComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!href) {
          e.preventDefault();
          return;
        }
        if (href.startsWith("http:") || href.startsWith("https:") || href.startsWith("mailto:")) {
          // allow opening external
          window.open(href, "_blank", "noopener,noreferrer");
          e.preventDefault();
        }
      }}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="compose-preview-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
};

export default function ComposeMarkdownPreview({ content, className = "" }: ComposeMarkdownPreviewProps) {
  const { t } = useI18n();

  return (
    <div
      className={`compose-markdown-preview${className ? ` ${className}` : ""}`}
      tabIndex={0}
      role="region"
      aria-label={t("compose.markdown.previewAria")}
    >
      {content.trim() ? (
        <div className="compose-markdown-preview-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={previewComponents}>
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="compose-markdown-preview-empty" role="status">
          <p>{t("compose.markdown.previewEmpty")}</p>
        </div>
      )}
    </div>
  );
}
