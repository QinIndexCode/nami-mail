import { LoaderCircle } from "lucide-react";
import { type AgentSlashCommand, type AgentSlashSubcommand } from "@nami/agent-contracts";
import { useI18n } from "../i18n";
import { useDeferredUnmount } from "../hooks/useDeferredUnmount";
import type { MentionItem } from "./agent-utils";
import type { SlashMenuItem } from "../slashMenu";

/**
 * The composer's two listbox overlays — the slash-command menu and the /@
 * mail-mention menu. Both unmount through a short fade-out (useDeferredUnmount
 * keeps the last items mounted, inert and aria-hidden, until the transition
 * ends); reopening mid-fade cancels the pending unmount.
 *
 * The textarea's combobox attributes (aria-controls/activedescendant) stay in
 * AgentWorkspace and reference the stable element ids rendered here.
 */
type ComposerMenusProps = {
  slashMenu: SlashMenuItem[] | null;
  activeSlashIndex: number;
  completeSlash: (command: AgentSlashCommand, sub?: AgentSlashSubcommand) => void;
  startMailReference: () => void;
  mentionOpen: boolean;
  mentionItems: MentionItem[];
  mentionLoading: boolean;
  mentionLimitReached: boolean;
  activeMentionIndex: number;
  introduceMailReference: (item: MentionItem) => void;
  loadMoreMentions: () => void;
};

export function ComposerMenus({
  slashMenu,
  activeSlashIndex,
  completeSlash,
  startMailReference,
  mentionOpen,
  mentionItems,
  mentionLoading,
  mentionLimitReached,
  activeMentionIndex,
  introduceMailReference,
  loadMoreMentions,
}: ComposerMenusProps) {
  const { t } = useI18n();
  const slashMenuOpen = slashMenu !== null && slashMenu.length > 0;
  const slashMenuFade = useDeferredUnmount(slashMenuOpen, slashMenu ?? []);
  const slashMenuItems = slashMenuOpen ? slashMenu : slashMenuFade.snapshot;
  const mentionMenuFade = useDeferredUnmount(mentionOpen, mentionItems);

  return (
    <>
      {slashMenuItems && (
        <div className={`agent-slash-menu${slashMenuOpen ? "" : " closing"}`} id="agent-slash-menu" role="listbox" aria-hidden={slashMenuOpen ? undefined : true} aria-label={t("agent.commands.label")}>
          {slashMenuItems.map((item, index) => (
            <button
              type="button"
              role="option"
              id={`agent-slash-menu-item-${index}`}
              aria-selected={index === activeSlashIndex}
              key={item.kind === "mail-reference" ? "mail-reference" : item.kind === "sub" ? `${item.command.id}.${item.sub.name}` : item.command.id}
              className={`agent-slash-item${item.kind === "sub" ? " agent-slash-item-sub" : ""}${index === activeSlashIndex ? " selected" : ""}`}
              onMouseDown={(event) => { event.preventDefault(); if (item.kind === "mail-reference") startMailReference(); else if (item.kind === "sub") completeSlash(item.command, item.sub); else completeSlash(item.command); }}
            >
              {item.kind === "mail-reference" ? (
                <>
                  <span className="agent-slash-item-name">/@</span>
                  <span className="agent-slash-item-desc">{t("agent.mention.label")}</span>
                </>
              ) : (
                <>
                  <span className="agent-slash-item-name">/{item.kind === "sub" ? `${item.command.name} ${item.sub.name}` : item.command.name}</span>
                  <span className="agent-slash-item-desc">{item.kind === "sub" ? t(item.sub.descriptionKey) : t(item.command.descriptionKey)}</span>
                  {item.kind === "sub" ? (item.sub.usageKey && <span className="agent-slash-item-usage">{t(item.sub.usageKey)}</span>) : (item.command.usageKey && <span className="agent-slash-item-usage">{t(item.command.usageKey)}</span>)}
                </>
              )}
            </button>
          ))}
        </div>
      )}
      {(mentionOpen || mentionMenuFade.render) && (
        <div className={`agent-mention-menu${mentionOpen ? "" : " closing"}`} id="agent-mention-menu" role="listbox" aria-hidden={mentionOpen ? undefined : true} aria-label={t("agent.mention.label")} onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) loadMoreMentions();
        }}>
          {mentionOpen && mentionLoading && mentionItems.length === 0 ? (
            <div className="agent-mention-empty"><LoaderCircle size={13} className="spin" /><span>{t("agent.mention.loading")}</span></div>
          ) : mentionOpen && mentionItems.length === 0 ? (
            <div className="agent-mention-empty"><span>{t("agent.mention.empty")}</span></div>
          ) : (
            (mentionOpen ? mentionItems : mentionMenuFade.snapshot!).map((item, index) => (
              <button
                type="button"
                role="option"
                id={`agent-mention-menu-item-${index}`}
                aria-selected={index === activeMentionIndex}
                key={item.id}
                className={`agent-mention-item${index === activeMentionIndex ? " selected" : ""}`}
                onMouseDown={(event) => { event.preventDefault(); introduceMailReference(item); }}
              >
                <span className="agent-mention-avatar" aria-hidden="true">{(item.subject ?? "").trim() ? item.subject!.trim()[0].toUpperCase() : "?"}</span>
                <span className="agent-mention-main">
                  <span className="agent-mention-subject">{item.subject || t("agent.reference.noSubject")}</span>
                  <span className="agent-mention-meta">{item.sender}<span aria-hidden="true">{" · "}</span>{item.accountEmail}</span>
                </span>
              </button>
            ))
          )}
          {mentionOpen && mentionLimitReached && <div className="agent-mention-limit" role="status">{t("agent.mention.maxReached")}</div>}
        </div>
      )}
    </>
  );
}
