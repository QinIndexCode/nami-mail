import { Quote } from "lucide-react";
import type { RefObject } from "react";
import CopyButton from "../CopyButton";
import { useI18n } from "../i18n";

export type TranscriptContextMenuState = { x: number; y: number; text: string };

/** How long the copy checkmark stays visible before the menu dismisses itself. */
const COPY_FEEDBACK_HOLD_MS = 600;

/**
 * Context menu for text selected in the transcript. The copy item shows the
 * shared checkmark for a moment before the menu closes, so the click reads as
 * "copied" instead of as a menu that vanished.
 */
export default function AgentTranscriptContextMenu({
  menu,
  menuRef,
  onDismiss,
  onFollowUp,
}: {
  menu: TranscriptContextMenuState;
  menuRef: RefObject<HTMLDivElement | null>;
  onDismiss: (menu: TranscriptContextMenuState) => void;
  onFollowUp: (text: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="agent-context-menu"
      ref={menuRef}
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <CopyButton
        role="menuitem"
        text={menu.text}
        ariaLabel={t("agent.message.copy")}
        label={t("agent.message.copy")}
        labelPosition="end"
        size={14}
        onCopied={() => {
          window.setTimeout(() => onDismiss(menu), COPY_FEEDBACK_HOLD_MS);
        }}
      />
      <button type="button" role="menuitem" onClick={() => onFollowUp(menu.text)}>
        <Quote size={14} />
        <span>{t("agent.message.followUp")}</span>
      </button>
    </div>
  );
}
