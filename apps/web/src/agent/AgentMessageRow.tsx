/**
 * One transcript message row. Isolated with React.memo so a streaming update —
 * which only mutates the single in-flight message object — re-renders that row
 * alone instead of re-parsing every historic message's markdown.
 *
 * Extracted from AgentWorkspace.tsx — zero functional changes.
 */
import { memo, useCallback, useState } from "react";
import { ChevronDown, ChevronUp, CircleAlert, Mail } from "lucide-react";
import { presentAttachment } from "../attachmentPresentation";
import { AttachmentFileIcon } from "../mailUi";
import type { AgentMessage } from "../agentTypes";
import type { Translate } from "../i18n";
import { shortDate, truncateForPreview } from "./agent-utils";
import AgentToolCard, { AgentToolList } from "./AgentToolCard";
import { AgentMessageContent, AgentRecallButton, CopyMessageButton } from "./AgentSmallComponents";

export type AgentMessageRowProps = {
  message: AgentMessage;
  /** Whether a newer user turn follows this message (supersedes its warnings). */
  superseded: boolean;
  /** Live provider status text (e.g. "retrying") shown in the thinking line. */
  statusMessage?: string | null;
  locale: string;
  t: Translate;
  onOpenAttachment: (path?: string) => void;
  onOpenMessage: (messageId: string) => void;
  onRevoke: (messageId: string) => void;
  onRetry: () => void;
  onUserMessageRef: (messageId: string, node: HTMLElement | null) => void;
};

export const AgentMessageRow = memo(function AgentMessageRowInner({
  message,
  superseded,
  statusMessage,
  locale,
  t,
  onOpenAttachment,
  onOpenMessage,
  onRevoke,
  onRetry,
  onUserMessageRef,
}: AgentMessageRowProps) {
  const userMessageRef = useCallback((node: HTMLElement | null) => {
    onUserMessageRef(message.id, node);
  }, [message.id, onUserMessageRef]);
  const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
  // A revoked message disappears from the transcript entirely; the "已撤回信息"
  // notice lives above the composer instead of leaving a placeholder row.
  if (message.revoked) return null;
  const allAttachments = message.attachments ?? [];
  const attachmentOverflow = allAttachments.length - 5;
  const visibleAttachments = attachmentsExpanded || attachmentOverflow <= 0 ? allAttachments : allAttachments.slice(0, 5);
  return (
    <article
      className={`agent-message ${message.role} ${message.state === "streaming" ? "streaming" : ""}${message.interrupted ? " interrupted" : ""}`}
      ref={message.role === "user" ? userMessageRef : undefined}
    >
      {!message.revoked && (
        <>
          {message.quote && <div className="agent-message-quote"><span className="agent-quote-mark" aria-hidden="true">"</span><span className="agent-quote-text">{truncateForPreview(message.quote)}</span><span className="agent-quote-mark" aria-hidden="true">"</span></div>}
          {message.references && message.references.length > 0 && (
            <div className="agent-message-references">
              {message.references.map((reference) => (
                <button key={reference.id} type="button" className="agent-message-reference" onClick={() => onOpenMessage(reference.id)} title={reference.subject} data-tooltip={t("agent.reference.open")}><Mail size={12} /><span>{reference.subject || t("agent.reference.noSubject")}</span></button>
              ))}
            </div>
          )}
          {message.content ? <AgentMessageContent content={message.content} streaming={message.state === "streaming"} /> : message.state === "streaming" && <div className="agent-thinking"><span className="agent-thinking-dots" aria-hidden="true"><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /></span>{statusMessage || t("agent.message.thinking")}</div>}
          {message.attachments && message.attachments.length > 0 && <div className="agent-message-attachments">{visibleAttachments.map((attachment, index) => { const presentation = presentAttachment(attachment.name, attachment.type, t); return <button key={`${attachment.name}-${index}`} type="button" className="agent-message-attachment" onClick={() => onOpenAttachment(attachment.path)} data-tooltip={attachment.path ?? attachment.name}><AttachmentFileIcon kind={presentation.kind} /><span>{attachment.name}</span></button>; })}{attachmentOverflow > 0 && <button type="button" className="agent-message-attachment is-more" aria-expanded={attachmentsExpanded} onClick={() => setAttachmentsExpanded((value) => !value)}>{attachmentsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}<span>{attachmentsExpanded ? t("agent.message.collapseAttachments") : t("agent.message.expandAttachments", { count: attachmentOverflow })}</span></button>}</div>}
          {message.toolActivities.length > 0 && <AgentToolList activities={message.toolActivities} superseded={superseded} />}
          {message.error && <div className="agent-message-error"><CircleAlert size={15} /><span>{message.error.message}{message.error.suggestion ? ` ${message.error.suggestion}` : ""}</span>{message.error.retryable && <button type="button" onClick={onRetry}>{t("agent.message.retry")}</button>}</div>}
        </>
      )}
      <div className="agent-message-meta">{message.role === "system" && <span className="agent-message-role">{t("agent.message.system")}</span>}{message.interrupted && <span className="agent-message-interrupted">{t("agent.message.interrupted")}</span>}<time>{shortDate(message.createdAt, locale)}</time>{!message.revoked && <span className="agent-message-actions">{message.content && <CopyMessageButton content={message.content} label={t("agent.message.copy")} />}{message.role === "user" && <AgentRecallButton disabled={!message.content || message.state === "streaming"} onRevoke={() => onRevoke(message.id)} label={t("agent.message.revoke")} confirmLabel={t("agent.message.revokeConfirm")} />}</span>}</div>
    </article>
  );
});
