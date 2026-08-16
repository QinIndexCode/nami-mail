import { type ReactNode, type RefObject } from "react";
import { Archive, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, Folder, Inbox, Send, Trash2 } from "lucide-react";
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

export function AttachmentFileIcon({ kind }: { kind: AttachmentKind }) {
  const icon = kind === "archive"
    ? <FileArchive size={19} />
    : kind === "image"
      ? <FileImage size={19} />
      : kind === "spreadsheet"
        ? <FileSpreadsheet size={19} />
        : kind === "code"
          ? <FileCode2 size={19} />
          : kind === "media"
            ? <FileAudio size={19} />
            : <FileText size={19} />;
  return <span className={`attachment-file-icon kind-${kind}`} aria-hidden="true">{icon}</span>;
}

export function FolderNavigationIcon({ specialUse }: { specialUse: string | null }) {
  const icon = specialUse === "\\Inbox"
    ? <Inbox size={15} />
    : specialUse === "\\Archive" || specialUse === "\\All"
      ? <Archive size={15} />
      : specialUse === "\\Sent"
        ? <Send size={15} />
        : specialUse === "\\Drafts"
          ? <FileText size={15} />
          : specialUse === "\\Trash"
            ? <Trash2 size={15} />
            : <Folder size={15} />;
  return <span aria-hidden="true">{icon}</span>;
}
