/**
 * Small, self-contained sub-components extracted from AgentWorkspace.tsx.
 * RevokeNotice, AgentRecallButton, AgentScrubberBar, CopyMessageButton,
 * AgentMessageContent — zero functional changes.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, Undo2 } from "lucide-react";
import { useI18n } from "../i18n";
import { AgentMarkdown, streamingMarkdownContent } from "../AgentMarkdown";
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
 * Renders an assistant turn's body. While it is streaming, the content is
 * parsed and rendered live by `AgentMarkdown` (a mature react-markdown-based
 * renderer) instead of showing plain text, so bold/headings/code appear as the
 * model types them. `streamingMarkdownContent` guards against an unfinished
 * code fence swallowing the tail; once the turn completes, the full content is
 * parsed with no truncation.
 */
export const AgentMessageContent = memo(function AgentMessageContentInner({ content, streaming }: { content: string; streaming: boolean }) {
  if (streaming) {
    return <AgentMarkdown content={streamingMarkdownContent(content)} />;
  }
  return <AgentMarkdown content={content} />;
});
