import { useState } from "react";
import { api } from "../api";
import { downloadAllAttachmentsZip, triggerBlobDownload } from "../attachmentZip";
import { triggerCalendarIcsExport, triggerContactVcfExport } from "../contactExport";
import { mailErrorMessage, mailErrorToastMessage } from "../errorPresentation";
import type { useToastQueue } from "../notifications/useToastQueue";
import type { Translate } from "../i18n";
import type { AttachmentDownloadState } from "./app-utils";
import type { PendingArchiveMove } from "../mailListState";
import type { Message, MessageAttachment } from "../types";

type ShowToast = ReturnType<typeof useToastQueue>["showToast"];

export interface AttachmentExportsOptions {
  selected: Message | null;
  selectedMovePending: boolean;
  selectedMoveLocationUnverified: boolean;
  isDemo: boolean;
  t: Translate;
  showToast: ShowToast;
  visibleAttachments: MessageAttachment[];
  pendingArchiveMovesRef: { current: PendingArchiveMove[] };
  openAttachmentPreviewRoute: (message: Message, attachment: MessageAttachment) => void;
}

export interface AttachmentExports {
  attachmentDownloads: Record<string, AttachmentDownloadState>;
  zipAllPhase: "idle" | "zipping";
  calendarImportPayload: { open: boolean; content: string; filename: string } | null;
  setCalendarImportPayload: (payload: { open: boolean; content: string; filename: string } | null) => void;
  downloadAttachment: (message: Message, attachment: MessageAttachment) => Promise<void>;
  zipAllAttachments: () => Promise<void>;
  exportSelectedEml: () => Promise<void>;
  printSelectedMessage: () => void;
  exportContactVcf: () => void;
  exportCalendarIcs: () => void;
  openCalendarImport: (content: string, filename: string) => void;
  handleIcsAttachmentImport: (message: Message, attachment: MessageAttachment) => Promise<void>;
  openAttachmentPreview: (message: Message, attachment: MessageAttachment) => void;
}

export function useAttachmentExports(options: AttachmentExportsOptions): AttachmentExports {
  const {
    selected,
    selectedMovePending,
    selectedMoveLocationUnverified,
    isDemo,
    t,
    showToast,
    visibleAttachments,
    pendingArchiveMovesRef,
    openAttachmentPreviewRoute,
  } = options;

  const [attachmentDownloads, setAttachmentDownloads] = useState<Record<string, AttachmentDownloadState>>({});
  const [zipAllPhase, setZipAllPhase] = useState<"idle" | "zipping">("idle");
  const [calendarImportPayload, setCalendarImportPayload] = useState<{ open: boolean; content: string; filename: string } | null>(null);

  const downloadAttachment = async (message: Message, attachment: MessageAttachment) => {
    if (pendingArchiveMovesRef.current.some((move) => move.id === message.id) || message.movePending) return showToast(t("mail.action.moveRefreshing"), "info");
    if (message.moveLocationUnverified) return showToast(t("mail.action.locationUnverified"), "info");
    if (isDemo) return showToast(t("mail.attachment.demoUnavailable"), "info");
    const downloadKey = `${message.id}:${attachment.partId}`;
    if (attachmentDownloads[downloadKey]?.phase === "downloading") return;
    setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "downloading" } }));
    try {
      const blob = await api.downloadAttachment(message.id, attachment.partId);
      triggerBlobDownload(blob, attachment.filename);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "ready" } }));
      window.setTimeout(() => {
        setAttachmentDownloads((current) => {
          if (current[downloadKey]?.phase !== "ready") return current;
          const next = { ...current };
          delete next[downloadKey];
          return next;
        });
      }, 3_600);
      showToast(t("mail.attachment.downloadStarted", { filename: attachment.filename }));
    } catch (error) {
      const detail = mailErrorMessage(error, t("mail.error.downloadAttachment"), t);
      setAttachmentDownloads((current) => ({ ...current, [downloadKey]: { phase: "error", detail } }));
      showToast(mailErrorToastMessage(error, t("mail.error.downloadAttachment"), t), "error");
    }
  };

  const zipAllAttachments = async () => {
    if (!selected) return;
    if (selectedMovePending || selected.movePending) return showToast(t("mail.action.moveRefreshing"), "info");
    if (selectedMoveLocationUnverified) return showToast(t("mail.action.locationUnverified"), "info");
    if (isDemo) return showToast(t("mail.attachment.demoUnavailable"), "info");
    if (zipAllPhase === "zipping") return;
    setZipAllPhase("zipping");
    try {
      await downloadAllAttachmentsZip(selected.id, selected.subject, visibleAttachments, (id, pId) => api.downloadAttachment(id, pId));
      showToast(t("mail.attachment.zipStarted", { count: visibleAttachments.length }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.zipAttachments"), t), "error");
    } finally {
      setZipAllPhase("idle");
    }
  };

  const exportSelectedEml = async () => {
    if (!selected) return;
    if (selectedMovePending || selected.movePending) return showToast(t("mail.action.moveRefreshing"), "info");
    if (selectedMoveLocationUnverified) return showToast(t("mail.action.locationUnverified"), "info");
    if (isDemo) return showToast(t("mail.action.exportDemoUnavailable"), "info");
    try {
      const { blob, filename } = await api.downloadMessageEml(selected.id);
      triggerBlobDownload(blob, filename);
      showToast(t("mail.action.exportStarted", { filename }));
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("mail.error.exportEml"), t), "error");
    }
  };

  const printSelectedMessage = () => {
    if (!selected) return;
    if (isDemo) return showToast(t("mail.action.printDemoUnavailable"), "info");
    window.print();
  };

  const exportContactVcf = () => {
    if (!selected) return;
    const filename = triggerContactVcfExport(selected.from);
    showToast(t("mail.action.exportStarted", { filename }));
  };

  const exportCalendarIcs = () => {
    if (!selected) return;
    const filename = triggerCalendarIcsExport(selected);
    showToast(t("mail.action.exportStarted", { filename }));
  };

  const openCalendarImport = (content: string, filename: string) => {
    setCalendarImportPayload({ open: true, content, filename });
  };

  const handleIcsAttachmentImport = async (message: Message, attachment: MessageAttachment) => {
    try {
      const blob = await api.downloadAttachment(message.id, attachment.partId);
      const text = await blob.text();
      openCalendarImport(text, attachment.filename);
    } catch (error) {
      showToast(mailErrorToastMessage(error, t("calendar.loadError"), t), "error");
    }
  };

  const openAttachmentPreview = (message: Message, attachment: MessageAttachment) => {
    if (pendingArchiveMovesRef.current.some((move) => move.id === message.id) || message.movePending) {
      showToast(t("mail.action.moveRefreshing"), "info");
      return;
    }
    if (message.moveLocationUnverified) {
      showToast(t("mail.action.locationUnverified"), "info");
      return;
    }
    if (isDemo) {
      showToast(t("mail.attachment.previewDemoUnavailable"), "info");
      return;
    }
    openAttachmentPreviewRoute(message, attachment);
  };

  return {
    attachmentDownloads,
    zipAllPhase,
    calendarImportPayload,
    setCalendarImportPayload,
    downloadAttachment,
    zipAllAttachments,
    exportSelectedEml,
    printSelectedMessage,
    exportContactVcf,
    exportCalendarIcs,
    openCalendarImport,
    handleIcsAttachmentImport,
    openAttachmentPreview,
  };
}
