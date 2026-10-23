import { type ReactNode, type RefObject } from "react";
import { Archive, FilePenLine, Flag, Folder, Inbox, Layers, SendHorizontal, ShieldAlert, Star, Trash2 } from "lucide-react";
import { FileIcon, defaultStyles, type FileIconProps } from "react-file-icon";
import { mediaKind } from "./attachments/catalog";
import type { AttachmentKind } from "./attachmentPresentation";
import type { OutboundAttachment } from "./types";

export type ToastKind = "success" | "error" | "info" | "warning";

export type ComposeDraft = {
  accountId?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  inReplyTo?: string;
  references?: string[];
  sourceDraftId?: string;
  attachments?: OutboundAttachment[];
};

export type PendingAttachmentUpload = {
  id: string;
  file: File;
  phase: "uploading" | "error";
  retryable: boolean;
  error?: string;
};

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Formats a Date as the local value of a `datetime-local` input. */
export function datetimeLocalFromDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Converts a `datetime-local` value to an ISO timestamp the local service can compare reliably. */
export function isoFromDatetimeLocal(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function IconButton({ label, children, onClick, className = "", disabled = false, expanded, buttonRef }: { label: string; children: ReactNode; onClick?: () => void; className?: string; disabled?: boolean; expanded?: boolean; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={buttonRef} className={`icon-button ${className}`} type="button" aria-label={label} aria-expanded={expanded} data-tooltip={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Fallbacks for extensions the icon set does not know, so a `.tsx` or an
 * extensionless file still gets a meaningful page icon instead of a blank one. */
const fallbackFileStyles: Record<AttachmentKind, FileIconProps> = {
  archive: { type: "compressed", labelColor: "#B7791F" },
  code: { type: "code", labelColor: "#2563EB" },
  document: { type: "document", labelColor: "#2C5898" },
  image: { type: "image", labelColor: "#7C3AED" },
  media: { type: "audio", labelColor: "#DB2777" },
  other: { type: "binary", labelColor: "#64748B" },
  pdf: { type: "acrobat", labelColor: "#D93831" },
  spreadsheet: { type: "spreadsheet", labelColor: "#1A754C" },
  text: { type: "document", labelColor: "#475569" },
};

export function AttachmentFileIcon({ kind, filename }: { kind: AttachmentKind; filename: string }) {
  const extension = filename.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
  // Which badge fits is decided by the shared catalog, not by a private list
  // here: a second copy is how a video extension ends up rendering as audio.
  const fallback = kind === "media" && mediaKind(filename) === "video"
    ? { ...fallbackFileStyles.media, type: "video" as const }
    : fallbackFileStyles[kind];
  const style = defaultStyles[extension] ?? fallback;
  return (
    <span className={`attachment-file-icon kind-${kind}`} aria-hidden="true">
      <FileIcon extension={extension ? extension.slice(0, 4) : undefined} labelUppercase {...style} />
    </span>
  );
}

export function FolderNavigationIcon({ specialUse, name }: { specialUse: string | null; name?: string }) {
  // Gmail marks [Gmail]/重要 without any special-use attribute; fall back on
  // the folder name so important folders keep their own icon.
  const looksImportant = name !== undefined && (name.includes("重要") || name.toLowerCase().includes("important"));
  const icon = specialUse === "\\Inbox"
    ? <Inbox size={15} />
    : specialUse === "\\Archive"
      ? <Archive size={15} />
      : specialUse === "\\All"
        ? <Layers size={15} />
        : specialUse === "\\Sent"
          ? <SendHorizontal size={15} />
          : specialUse === "\\Drafts"
            ? <FilePenLine size={15} />
            : specialUse === "\\Trash"
              ? <Trash2 size={15} />
              : specialUse === "\\Junk" || specialUse === "\\Spam"
                ? <ShieldAlert size={15} />
                : specialUse === "\\Flagged"
                  ? <Star size={15} />
                  : specialUse === "\\Important" || looksImportant
                    ? <Flag size={15} />
                    : <Folder size={15} />;
  // Flex-centering the inline svg kills the baseline/line-height drift that
  // made the icon sit visibly higher than the label text.
  return <span className="folder-nav-icon" aria-hidden="true">{icon}</span>;
}
