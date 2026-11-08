import { useEffect, useState } from "react";
import { request } from "./api";
import { useI18n } from "./i18n";
export type ImagePolicy = { mode: "block" | "allow"; trustedSenders: string[] };
type Permission = { allowed: boolean; trusted: boolean; granted: boolean; sender: string };
const defaults: Permission = { allowed: false, trusted: false, granted: false, sender: "" };
export const IMAGE_POLICY_CHANGED = "nami-image-policy-changed";
export function useImagePrivacy(messageId: string | undefined, demo = false) {
  const [state, setState] = useState<{ id?: string; permission: Permission }>({ permission: defaults });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!messageId) return;
      if (demo) { setState({ id: messageId, permission: defaults }); return; }
      void request<Permission>(`/api/messages/${encodeURIComponent(messageId)}/images/permission`)
        .then((permission) => { if (active) setState({ id: messageId, permission }); })
        .catch(() => { if (active) setState({ id: messageId, permission: defaults }); });
    };
    refresh();
    window.addEventListener(IMAGE_POLICY_CHANGED, refresh);
    return () => { active = false; window.removeEventListener(IMAGE_POLICY_CHANGED, refresh); };
  }, [messageId, demo]);
  const permission = state.id === messageId ? state.permission : defaults;
  const authorize = async (trustSender = false, revoke = false) => {
    if (!messageId) return;
    setBusy(true); setError("");
    try {
      const next = demo ? { ...defaults, allowed: !revoke, granted: !revoke } : await request<Permission>(`/api/messages/${encodeURIComponent(messageId)}/images/allow`,
        revoke ? { method: "DELETE" } : { method: "POST", body: JSON.stringify({ trustSender }) });
      setState({ id: messageId, permission: next });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return { ...permission, busy, error, authorize };
}
export function ImagePrivacyNotice({ privacy }: { privacy: ReturnType<typeof useImagePrivacy> }) {
  const { t } = useI18n();
  return <div className="mail-image-notice" role="status">
    <p className="mail-image-notice-text">{t(privacy.allowed ? "images.allowed" : "images.blocked")}</p>
    <div className="mail-image-notice-actions">{!privacy.allowed && <>
      <button className="secondary-button" type="button" disabled={privacy.busy} onClick={() => void privacy.authorize()}>{t("images.loadOnce")}</button>
      <button className="secondary-button" type="button" disabled={privacy.busy} onClick={() => void privacy.authorize(true)}>{t("images.trustSender")}</button>
    </>}
    {privacy.granted && !privacy.trusted && <button className="secondary-button" type="button" disabled={privacy.busy} onClick={() => void privacy.authorize(false, true)}>{t("images.revokeMessage")}</button>}
    </div>
    {privacy.error && <p className="mail-image-notice-error" role="alert">{privacy.error}</p>}
  </div>;
}
