import {
  Bold,
  Code,
  Columns2,
  Eye,
  Heading,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  PenLine,
  Quote,
  Table,
} from "lucide-react";
import type { MarkdownFormat } from "./composeMarkdown";
import { useI18n } from "./i18n";

export type ComposeViewMode = "write" | "preview" | "split";

export type ComposeMarkdownToolbarProps = {
  onFormat: (format: MarkdownFormat) => void;
  markdownEnabled: boolean;
  onToggleMarkdown: (enabled: boolean) => void;
  viewMode: ComposeViewMode;
  onChangeViewMode: (mode: ComposeViewMode) => void;
  isMaximized: boolean;
  disabled?: boolean;
};

export default function ComposeMarkdownToolbar({
  onFormat,
  markdownEnabled,
  onToggleMarkdown,
  viewMode,
  onChangeViewMode,
  isMaximized,
  disabled = false,
}: ComposeMarkdownToolbarProps) {
  const { t } = useI18n();

  return (
    <div className="compose-md-toolbar" role="toolbar" aria-label={t("compose.markdown.toolbarAria")}>
      <div className="compose-md-toolbar-group">
        <button
          type="button"
          className={`compose-md-btn compose-md-toggle-pill${markdownEnabled ? " active" : ""}`}
          onClick={() => onToggleMarkdown(!markdownEnabled)}
          disabled={disabled}
          data-tooltip={markdownEnabled ? t("compose.markdown.disable") : t("compose.markdown.enable")}
          aria-pressed={markdownEnabled}
        >
          <span className="compose-md-pill-tag">M↓</span>
          <span>{t("compose.markdown.label")}</span>
        </button>

        {markdownEnabled && viewMode !== "preview" && (
          <>
            <span className="compose-md-divider" role="separator" />
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("bold")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.bold")}
              aria-label={t("compose.markdown.bold")}
            >
              <Bold size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("italic")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.italic")}
              aria-label={t("compose.markdown.italic")}
            >
              <Italic size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("heading")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.heading")}
              aria-label={t("compose.markdown.heading")}
            >
              <Heading size={14} />
            </button>
            <span className="compose-md-divider" role="separator" />
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("bulletList")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.bulletList")}
              aria-label={t("compose.markdown.bulletList")}
            >
              <List size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("numberedList")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.numberedList")}
              aria-label={t("compose.markdown.numberedList")}
            >
              <ListOrdered size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("quote")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.quote")}
              aria-label={t("compose.markdown.quote")}
            >
              <Quote size={14} />
            </button>
            <span className="compose-md-divider" role="separator" />
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("code")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.code")}
              aria-label={t("compose.markdown.code")}
            >
              <Code size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("link")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.link")}
              aria-label={t("compose.markdown.link")}
            >
              <Link2 size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("table")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.table")}
              aria-label={t("compose.markdown.table")}
            >
              <Table size={14} />
            </button>
            <button
              type="button"
              className="compose-md-btn"
              onClick={() => onFormat("divider")}
              disabled={disabled}
              data-tooltip={t("compose.markdown.divider")}
              aria-label={t("compose.markdown.divider")}
            >
              <Minus size={14} />
            </button>
          </>
        )}
      </div>

      {markdownEnabled && (
        <div className="compose-md-view-modes" role="radiogroup" aria-label={t("compose.markdown.viewModeAria")}>
          <button
            type="button"
            className={`compose-md-mode-btn${viewMode === "write" ? " active" : ""}`}
            onClick={() => onChangeViewMode("write")}
            data-tooltip={t("compose.markdown.viewWrite")}
            aria-checked={viewMode === "write"}
            role="radio"
          >
            <PenLine size={13} />
            <span>{t("compose.markdown.modeWrite")}</span>
          </button>
          {isMaximized && (
            <button
              type="button"
              className={`compose-md-mode-btn${viewMode === "split" ? " active" : ""}`}
              onClick={() => onChangeViewMode("split")}
              data-tooltip={t("compose.markdown.viewSplit")}
              aria-checked={viewMode === "split"}
              role="radio"
            >
              <Columns2 size={13} />
              <span>{t("compose.markdown.modeSplit")}</span>
            </button>
          )}
          <button
            type="button"
            className={`compose-md-mode-btn${viewMode === "preview" ? " active" : ""}`}
            onClick={() => onChangeViewMode("preview")}
            data-tooltip={t("compose.markdown.viewPreview")}
            aria-checked={viewMode === "preview"}
            role="radio"
          >
            <Eye size={13} />
            <span>{t("compose.markdown.modePreview")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
