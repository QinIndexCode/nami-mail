import { Archive, Inbox, Mail, MailOpen, ShieldCheck, Star, Trash2 } from "lucide-react";
import { selectionMoveActions, type MessageFolderContext } from "./messageMoveActions";
import type { MoveTarget } from "./api";
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
  /** A batch request is in flight (the create round trip), so nothing may start
   * a second one over the same rows. */
  busy: boolean;
  folderContext?: MessageFolderContext;
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
 * Its actions go inert only for the length of the create round trip. That is the
 * one window where a second click — a double click is enough — would have the
 * server accept a whole second batch over the same rows, with nothing in the UI
 * having said a batch was already under way. Once the server accepts, the local
 * commit has landed and the remote push runs on in the background (contract
 * §二十六), so the bar comes back: the user's next action is a new batch, not a
 * wait for the mail server, and its progress is reported by the cloud-sync panel
 * in the rail rather than by a frozen count in here.
 *
 * Selecting rows and leaving multi-select stay available throughout — only the
 * actions that start a batch are ever held back, plus the Done button for the
 * same round trip (its pre-existing rule).
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
  busy,
  folderContext = "other",
  onSelectAll,
  onSetSeen,
  onSetFlagged,
  onMove,
  onTrash,
  onDone,
}: SelectionToolbarProps) {
  const { t } = useI18n();
  const actionsDisabled = busy || selectedCount === 0;

  return (
    <div className="list-toolbar selection-toolbar" aria-hidden={!visible}>
      <button className="selection-select-all" type="button" onClick={onSelectAll} disabled={!selectableCount}>
        {selectAllPaged ? t("mail.selection.selectAllMatching", { count: matchingCount }) : t("mail.selection.selectAll")}
      </button>
      <span className="selection-count">
        {busy
          ? t("mail.selection.busy")
          : t("mail.selection.count", { count: selectAllPaged ? matchingCount : selectedCount })}
      </span>
      <div className="selection-actions">
        <IconButton label={t("mail.action.markRead")} className="selection-action" onClick={() => onSetSeen(true)} disabled={actionsDisabled}><MailOpen size={15} /></IconButton>
        <IconButton label={t("mail.action.markUnread")} className="selection-action" onClick={() => onSetSeen(false)} disabled={actionsDisabled}><Mail size={15} /></IconButton>
        <IconButton label={t("mail.action.star")} className="selection-action" onClick={() => onSetFlagged(true)} disabled={actionsDisabled}><Star size={15} /></IconButton>
        <IconButton label={t("mail.action.unstar")} className="selection-action" onClick={() => onSetFlagged(false)} disabled={actionsDisabled}><Star size={15} fill="none" /></IconButton>
        <span className="toolbar-divider" aria-hidden="true" />
        {selectionMoveActions(folderContext).map((action) => (
          <IconButton key={action.target} label={t(action.labelKey)} className={`selection-action${action.target === "trash" ? " selection-action-danger" : ""}`} onClick={action.target === "trash" ? onTrash : () => onMove(action.target)} disabled={busy || (!selectedCount && !selectAllPaged)}>
            {action.target === "inbox" ? <Inbox size={15} /> : action.target === "archive" ? <Archive size={15} /> : action.target === "junk" ? <ShieldCheck size={15} /> : <Trash2 size={15} />}
          </IconButton>
        ))}
      </div>
      <button className="selection-done" type="button" onClick={onDone} disabled={busy}>{t("mail.selection.done")}</button>
    </div>
  );
}

export default SelectionToolbar;
