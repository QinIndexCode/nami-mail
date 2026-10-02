/**
 * Small, self-contained sub-components extracted from AgentWorkspace.tsx.
 * RevokeNotice, AgentRecallButton, AgentScrubberBar, CopyMessageButton —
 * zero functional changes. AgentMessageContent renders a streaming reply as a
 * memoised settled prefix, a memoised committed line prefix, and a plain-text
 * tail.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, Undo2 } from "lucide-react";
import { useI18n } from "../i18n";
import { AgentMarkdown, AgentMarkdownSettled, splitStreamingMarkdown } from "../AgentMarkdown";
import { copyToClipboard } from "./agent-utils";

// Owns its own 1 s tick so the countdown does not re-render the workspace.
export function RevokeNotice({ until, onExpire }: { until: number; onExpire: () => void }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!expiredRef.current && current >= until) {
        expiredRef.current = true;
        onExpire();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until, onExpire]);
  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div className="agent-revoke-notice" role="status">
      <span>{t("agent.message.revokeNotice")}</span>
      <em aria-hidden="true">{remaining}s</em>
    </div>
  );
}

export function AgentRecallButton({
  onRevoke,
  label,
  confirmLabel,
  disabled,
}: {
  onRevoke: () => void;
  label: string;
  confirmLabel: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(armTimerRef.current), []);
  const handleClick = () => {
    if (armed) {
      window.clearTimeout(armTimerRef.current);
      setArmed(false);
      onRevoke();
      return;
    }
    setArmed(true);
    armTimerRef.current = window.setTimeout(() => setArmed(false), 3200);
  };
  return (
    <button
      type="button"
      className={`agent-corner-button recall${armed ? " armed" : ""}`}
      disabled={disabled}
      onClick={disabled ? undefined : handleClick}
      aria-label={label}
      data-tooltip={armed ? confirmLabel : label}
    >
      {armed ? <span className="agent-recall-arm">{confirmLabel}</span> : <Undo2 size={12} />}
    </button>
  );
}

export const AgentScrubberBar = memo(function AgentScrubberBarInner({
  hovered,
  top,
  width,
  blur,
}: {
  hovered: boolean;
  top: number;
  width: number;
  blur: number;
}) {
  return (
    <span
      className={`agent-scrubber-bar${hovered ? " hovered" : ""}`}
      style={{
        top: `${top}px`,
        width: `${width}px`,
        filter: blur > 0 ? `blur(${blur}px)` : undefined,
      }}
    />
  );
});

/** Copy button with a transient checkmark: copies, shows a check, then returns
 *  to the copy icon so repeated copies stay possible. The row keeps rendering
 *  only this tiny control, isolated from the memoised message row. */
export function CopyMessageButton({ content, label }: { content: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const handleCopy = () => {
    void copyToClipboard(content);
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button
      type="button"
      className={`agent-corner-button copy${copied ? " copied" : ""}`}
      onClick={handleCopy}
      aria-label={label}
      data-tooltip={label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/**
 * Renders an assistant turn's body. A finished turn is parsed in full. While it
 * is streaming the reply is cut in three: the settled prefix of closed blocks,
 * the committed prefix of the block being typed whose lines are already safe to
 * parse, and the unterminated last line, which stays plain text so a half-open
 * `**` or `](` cannot flash. The two markdown layers share the same memoised
 * body and only move when a block or a line completes, so a paragraph costs one
 * parse rather than one per frame, and inline formatting shows up as it is typed
 * instead of a paragraph later. All three sit in one `.agent-message-content`
 * container, which keeps the existing `p:last-child` rule doing the right thing:
 * the gap between two paragraphs moves with the split point instead of appearing
 * all at once at the end.
 */
export const AgentMessageContent = memo(function AgentMessageContentInner({ content, streaming }: { content: string; streaming: boolean }) {
  if (!streaming) return <AgentMarkdown content={content} />;
  const { settled, committed, live } = splitStreamingMarkdown(content);
  return (
    <div className="agent-message-content">
      {settled.trim() ? <AgentMarkdownSettled key="settled" content={settled} /> : null}
      {committed.trim() ? <AgentMarkdownSettled key="committed" content={committed} /> : null}
      {live ? <div key="live" className="agent-message-content-streaming">{live}</div> : null}
    </div>
  );
});
