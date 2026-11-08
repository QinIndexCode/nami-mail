import { request } from "./api";
import { apiError, requestResponse } from "./apiTransport";
import type { ComposeDraft } from "./mailUi";
export type RestorePreview = { id: string; createdAt: string; schemaVersion: number; counts: Record<string, number>; bytes: number; files: number };
export async function exportApplicationBackup(password: string): Promise<Blob> {
  const response = await requestResponse("/api/app-backups/export", { method: "POST", body: JSON.stringify({ password }), signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok) throw await apiError(response);
  return response.blob();
}
export async function previewApplicationBackup(file: File, password: string): Promise<RestorePreview> {
  const encoded = btoa(Array.from(new TextEncoder().encode(password), (byte) => String.fromCharCode(byte)).join(""));
  const response = await requestResponse("/api/app-backups/preview", { method: "POST", body: file,
    headers: { "content-type": "application/x-nami-backup", "x-nami-backup-password": encoded }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<RestorePreview>;
}
export const activateApplicationBackup = (id: string) => request(`/api/app-backups/${encodeURIComponent(id)}/activate`, { method: "POST", body: JSON.stringify({ confirm: true }) });
export const recoverSubmissionDraft = (id: string, confirmUnknown = false) => request<{ draft: ComposeDraft; missingAttachments: number }>(`/api/submissions/${encodeURIComponent(id)}/retry-draft`, { method: "POST", body: JSON.stringify({ confirmUnknown }) });
