import { useEffect, useState } from "react";
import { request } from "./api";
import { useI18n } from "./i18n";
type Item = { id: string; subject: string; eligible: boolean; reason: string };
type Details = { id: string; kind: string; status: string; total: number; items: Item[]; nextOffset: number | null };
export function TaskRecoveryPanel({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const [details, setDetails] = useState<Details | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void request<Details>(`/api/tasks/${encodeURIComponent(id)}/recovery`).then((value) => { if (active) setDetails(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [id]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="cloud-sync-section" aria-label={t("recovery.title")}>
    <button className="secondary-button" type="button" onClick={onBack}>{t("recovery.back")}</button>
    <p className="settings-note">{t("recovery.description")}</p>
    {details && <>
      <p>{t("recovery.count", { count: details.total })}</p>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => setSelected(new Set(details.items.filter((item) => item.eligible).slice(0, 1000).map((item) => item.id)))}>{t("recovery.select")}</button>
      <ul className="task-recovery-items">{details.items.map((item) => <li key={item.id}>
        <label><input type="checkbox" disabled={busy || !item.eligible} checked={selected.has(item.id)} onChange={(event) => setSelected((current) => {
          const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next;
        })} />{item.subject || t("mail.message.noSubject")}</label>
        <p className="settings-note">{t(`recovery.reason.${item.reason}`)}</p>
      </li>)}</ul>
      {details.nextOffset !== null && <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(async () => {
        const page = await request<Details>(`/api/tasks/${encodeURIComponent(id)}/recovery?offset=${details.nextOffset}`);
        setDetails({ ...page, items: [...details.items, ...page.items] });
      })}>{t("recovery.more")}</button>}
      <div className="settings-inline-actions">
        <button className="secondary-button" type="button" disabled={busy || !selected.size || selected.size > 1000} onClick={() => void run(async () => {
          const result = await request<{ retried: number; skipped: number }>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST", body: JSON.stringify({ messageIds: [...selected] }) });
          setNotice(t("recovery.accepted", result)); setSelected(new Set());
          setDetails(await request<Details>(`/api/tasks/${encodeURIComponent(id)}/recovery`)); onChanged();
        })}>{t("recovery.retry")}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(async () => {
          await request(`/api/tasks/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: JSON.stringify({ acknowledge: true }) }); onChanged(); onBack();
        })}>{t("recovery.dismiss")}</button>
      </div>
    </>}
    {busy && <p role="status">{t("data.working")}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
