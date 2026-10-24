import { CloudUpload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { DeliveryTask } from "./batchJobTypes";
import { cloudSyncAccountLabel, cloudSyncKindLabel, cloudSyncTaskDetail } from "./cloudSyncPresentation";
import { usePopupExitTransition } from "./hooks/usePopupExitTransition";
import type { CloudSyncTasks } from "./app/useCloudSyncTasks";
import type { Translate } from "./i18n";
import { IconButton } from "./mailUi";

/**
 * How often an open panel re-reads the server.
 *
 * The push frames are the fast path, but they are not guaranteed: this renderer
 * can run with the stream down (or fall back to polling), and then an open
 * panel would show whatever the last read happened to say. While the panel is
 * open — and only then — a slow read keeps the progress counters and the row
 * set honest, at a cost a closed panel never pays.
 */
const PANEL_REFRESH_MS = 5000;

/**
 * The right rail's cloud-sync button, with its status panel hanging to its left.
 *
 * A panel rather than a dialog: the question it answers ("is anything still
 * being written to the mail server?") is one the user asks *about the mail
 * behind it*, so it must not take the screen, and it is anchored flush to the
 * button that opened it instead of centred, which is what makes the two read as
 * one control. It is a `role="dialog"` all the same — a keyboard user needs a
 * name for the surface they just tabbed into and needs Escape to leave it — but
 * an explicitly non-modal one: no scrim, no focus trap, and the list behind it
 * stays usable.
 *
 * It is the only place a batch's *remote* half is visible. Under the
 * commit-first rule (contract §二十六) the toolbar releases as soon as the
 * acceptance commits and reports nothing about the push that follows, so a
 * large selection would otherwise look finished while the mail server was still
 * being written to.
 */
export function CloudSyncRailItem({ tasks, t, locale }: { tasks: CloudSyncTasks; t: Translate; locale: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const { mounted, closing, beginClose } = usePopupExitTransition(open, () => setOpen(false));
  const attentionCount = tasks.attention.length;
  const total = tasks.syncing.length + attentionCount;

  // Dismiss on a click anywhere else. `pointerdown`, not `click`: the panel has
  // to be gone before the control under the cursor acts, or the same press would
  // both close the panel and operate the mail behind it. The click has already
  // chosen where focus belongs, so the close must not pull it back to the
  // trigger — hence the flag the closing effect reads.
  const restoreFocusRef = useRef(true);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
      restoreFocusRef.current = false;
      beginClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open, beginClose]);

  // Escape closes the panel and only the panel. Claimed on window capture for
  // the reason the date picker claims it there too: whatever else is listening
  // (a host dialog stopping propagation on the bubble) must not be the one that
  // reacts to this press.
  useEffect(() => {
    if (!open) return undefined;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || closing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      beginClose();
    };
    window.addEventListener("keydown", claimEscape, true);
    return () => window.removeEventListener("keydown", claimEscape, true);
  }, [open, closing, beginClose]);

  // Opening asks the server once: the panel can be opened minutes after mount,
  // and a session whose push stream is down has had no frame to keep this list
  // current. The slow poll keeps it current while it stays open, and skips a
  // hidden window the same way the mail poll does — nobody is reading it.
  const { refresh } = tasks;
  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, PANEL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  // Opening moves focus into the panel, so a keyboard user reaches the retry
  // button by tabbing on from the trigger.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Closing hands focus back to the trigger only when it was inside. This is
  // tied to `closing` rather than to the close itself because the exit
  // transition still has the panel mounted: once it is removed React has
  // already detached the ref, and "was focus inside" could no longer be asked.
  useEffect(() => {
    if (!closing) return;
    if (restoreFocusRef.current && panelRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    restoreFocusRef.current = true;
  }, [closing]);

  const renderRows = () => (
    <>
      {tasks.syncing.length > 0 && (
        <section className="cloud-sync-section">
          <p className="eyebrow" id={`${panelId}-syncing`}>{t("cloudSync.syncingSection")}</p>
          <ul aria-labelledby={`${panelId}-syncing`}>
            {tasks.syncing.map((task) => <CloudSyncRow key={task.id} task={task} t={t} locale={locale} />)}
          </ul>
        </section>
      )}
      {tasks.attention.length > 0 && (
        <section className="cloud-sync-section">
          <p className="eyebrow" id={`${panelId}-attention`}>{t("cloudSync.attentionSection")}</p>
          <ul aria-labelledby={`${panelId}-attention`}>
            {tasks.attention.map((task) => <CloudSyncRow key={task.id} task={task} t={t} locale={locale} />)}
          </ul>
        </section>
      )}
    </>
  );

  return (
    <div className="rail-item" ref={rootRef}>
      <IconButton
        label={t("cloudSync.open")}
        className={attentionCount > 0 ? "attention" : ""}
        expanded={open}
        buttonRef={triggerRef}
        onClick={() => { if (open) beginClose(); else setOpen(true); }}
      >
        <CloudUpload size={18} />
        {total > 0 && <span className="rail-badge" aria-hidden="true">{total}</span>}
      </IconButton>
      {mounted && (
        <div
          className={`cloud-sync-panel${closing ? " closing" : ""}`}
          role="dialog"
          aria-label={t("cloudSync.title")}
          tabIndex={-1}
          ref={panelRef}
        >
          <div className="cloud-sync-head">
            <span className="cloud-sync-title">{t("cloudSync.title")}</span>
            <button type="button" className="cloud-sync-close" aria-label={t("cloudSync.close")} data-tooltip={t("cloudSync.close")} onClick={beginClose}>
              <X size={13} />
            </button>
          </div>
          {tasks.failed && (
            <div className="cloud-sync-note cloud-sync-note-error">
              <span>{t("cloudSync.loadFailed")}</span>
              <button type="button" className="cloud-sync-retry" onClick={tasks.refresh}>{t("cloudSync.retry")}</button>
            </div>
          )}
          {total > 0
            ? renderRows()
            : !tasks.failed && <p className="cloud-sync-note">{tasks.loading ? t("cloudSync.loading") : t("cloudSync.allClear")}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One task. The two lines are the action and what the numbers justify saying
 * about it; a failed row adds the server's own message, which is the only
 * diagnosis of the cause anywhere in this panel.
 */
function CloudSyncRow({ task, t, locale }: { task: DeliveryTask; t: Translate; locale: string }) {
  const account = cloudSyncAccountLabel(task);
  const terminal = task.completedAt !== null;
  return (
    <li className={`cloud-sync-row${terminal ? " problem" : ""}`}>
      <span className="cloud-sync-row-head">
        <span className="cloud-sync-kind">{cloudSyncKindLabel(task.kind, t)}</span>
        <span className="cloud-sync-account" data-tooltip={account}>{account}</span>
      </span>
      <span className="cloud-sync-detail">{cloudSyncTaskDetail(task, t, locale)}</span>
      {task.error?.message && <span className="cloud-sync-message">{task.error.message}</span>}
    </li>
  );
}
