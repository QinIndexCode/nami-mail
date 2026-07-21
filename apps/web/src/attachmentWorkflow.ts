type SizedAttachment = {
  size: number;
};

type PendingAttachment = {
  file: SizedAttachment;
  phase: "uploading" | "error";
  retryable: boolean;
};

export type ComposeAttachmentSummary = {
  attachedCount: number;
  attachedBytes: number;
  uploadingCount: number;
  failedCount: number;
  reservedCount: number;
  reservedBytes: number;
};

/**
 * Failed local validation never reserves an attachment slot or byte budget.
 * Retryable transfers still do, so retrying cannot silently exceed send limits.
 */
export function summarizeComposeAttachments(
  attachments: readonly SizedAttachment[],
  pendingUploads: readonly PendingAttachment[],
): ComposeAttachmentSummary {
  const attachedCount = attachments.length;
  const attachedBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
  const uploading = pendingUploads.filter((upload) => upload.phase === "uploading");
  const retryableFailures = pendingUploads.filter((upload) => upload.phase === "error" && upload.retryable);

  return {
    attachedCount,
    attachedBytes,
    uploadingCount: uploading.length,
    failedCount: pendingUploads.filter((upload) => upload.phase === "error").length,
    reservedCount: attachedCount + uploading.length + retryableFailures.length,
    reservedBytes: attachedBytes
      + uploading.reduce((total, upload) => total + upload.file.size, 0)
      + retryableFailures.reduce((total, upload) => total + upload.file.size, 0),
  };
}
