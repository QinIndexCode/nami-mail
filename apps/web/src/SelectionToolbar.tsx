import { Archive, Mail, MailOpen, ShieldCheck, Star, Trash2 } from "lucide-react";
import type { BatchJobSnapshot, MoveTarget } from "./api";
import { useI18n } from "./i18n";
import { IconButton } from "./mailUi";

export type SelectionToolbarProps = {
  /** Whether the bar is exposed to assistive tech (multi-select is active). */
  visible: boolean;
  selectAllPaged: boolean;
  selectedCount: number;
  /** Rows the list currently holds — what "select all" would take. */
  selectableCount: number;
  /** Rows matching the query server-side, which a predicate selection covers. */
  matchingCount: number;
  /** The running batch job, while one owns the selection. */
  job: BatchJobSnapshot | null;
  busy: boolean;
  onSelectAll: () => void;
  onSetSeen: (seen: boolean) => void;
  onSetFlagged: (flagged: boolean) => void;
  onMove: (target: MoveTarget) => void;
  onTrash: () => void;
  onDone: () => void;
};

/**
 * The multi-select action bar.
 *
 * Its actions go inert while a batch job owns the selection. A job is driven by
 * a poll loop and the remote push behind it can take tens of seconds, so the bar
 * stays on screen and fully clickable for that whole window; a second click
 * would have the server accept a whole second job over the same rows, with
 * nothing in the UI having said a job was already running. Selecting rows and
 * leaving multi-select stay available — only the actions that start a batch are
 * held back.
 *
 * Extracted from App.tsx so the disabled wiring has a render test; App owns the
 * handlers and the state behind them.
 */
export function SelectionToolbar({
  visible,
  selectAllPaged,
  selectedCount,
  selectableCount,
  matchingCount,
  job,
  busy,
  onSelectAll,
  onSetSeen,
  onSetFlagged,
  onMove,
  onTrash,
  onDone,
}: SelectionToolbarProps) {
  const { t } = useI18n();
  // One job at a time: while it runs, every action that would enqueue another
  // batch is disabled, matching the count line that is reporting its progress.
  const actionsDisabled = job !== null || selectedCount === 0;

  return (
    <div className="list-toolbar selection-toolbar" aria-hidden={!visible}>
      <button className="selection-select-all" type="button" onClick={onSelectAll} disabled={!selectableCount}>
        {selectAllPaged ? t("mail.selection.selectAllMatching", { count: matchingCount }) : t("mail.selection.selectAll")}
      </button>
      <span className="selection-count">
        {job
          ? t("mail.selection.batchProcessing", { done: job.done, total: job.total || matchingCount })
          : busy
            ? t("mail.selection.busy")
            : t("mail.selection.count", { count: selectAllPaged ? matchingCount : selectedCount })}
      </span>
      <div className="selection-actions">
        <IconButton label={t("mail.action.markRead")} className="selection-action" onClick={() => onSetSeen(true)} disabled={actionsDisabled}><MailOpen size={15} /></IconButton>
        <IconButton label={t("mail.action.markUnread")} className="selection-action" onClick={() => onSetSeen(false)} disabled={actionsDisabled}><Mail size={15} /></IconButton>
        <IconButton label={t("mail.action.star")} className="selection-action" onClick={() => onSetFlagged(true)} disabled={actionsDisabled}><Star size={15} /></IconButton>
        <IconButton label={t("mail.action.unstar")} className="selection-action" onClick={() => onSetFlagged(false)} disabled={actionsDisabled}><Star size={15} fill="none" /></IconButton>
        <span className="toolbar-divider" aria-hidden="true" />
        <IconButton label={t("mail.action.archive")} className="selection-action" onClick={() => onMove("archive")} disabled={actionsDisabled}><Archive size={15} /></IconButton>
        <IconButton label={t("mail.action.reportSpam")} className="selection-action" onClick={() => onMove("junk")} disabled={actionsDisabled}><ShieldCheck size={15} /></IconButton>
        <IconButton
          label={t("mail.action.moveToTrash")}
          className="selection-action selection-action-danger"
          onClick={onTrash}
          // Trash opens a confirmation dialog rather than starting the batch
          // itself, so it follows the selection directly — but a running job
          // still owns the rows the dialog would act on.
          disabled={job !== null || (!selectedCount && !selectAllPaged)}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
      <button className="selection-done" type="button" onClick={onDone} disabled={busy}>{t("mail.selection.done")}</button>
    </div>
  );
}

export default SelectionToolbar;
