import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { copyTextToClipboard } from "./settings/settings-utils";

/**
 * How long a successful copy shows the checkmark before the icon returns to
 * the copy glyph. One constant so every copy control in the app behaves alike.
 */
export const COPY_FEEDBACK_MS = 1_500;

export type CopyButtonProps = {
  /** The text placed on the clipboard. */
  text: string;
  /** Accessible name. Defaults are never rendered as a native title. */
  ariaLabel: string;
  /** Accessible name while the checkmark is showing (when it should change). */
  copiedAriaLabel?: string;
  /** Clipboard writer. Defaults to `copyTextToClipboard`; return `false` on failure. */
  copy?: (text: string) => Promise<boolean>;
  /** Visible label rendered next to the icon. */
  label?: ReactNode;
  /** Label shown while the checkmark is showing. Falls back to `label`. */
  copiedLabel?: ReactNode;
  labelPosition?: "start" | "end";
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Hover tooltip; omit for none. */
  tooltip?: string;
  disabled?: boolean;
  /** Announced through a live region after a successful copy. */
  announcement?: string;
  role?: string;
  onCopied?: () => void;
  onFailed?: () => void;
};

/**
 * A copy control with the app-wide feedback: the icon cross-fades to a
 * checkmark, holds, then cross-fades back, so a second copy is still possible.
 * Both glyphs stay mounted and are toggled by `.copied` in CSS; mounting one at
 * a time would replace it instantly and leave the return to the copy glyph with
 * no transition. The copied state is local to the button and resets when `text`
 * changes.
 */
export default function CopyButton({
  text,
  ariaLabel,
  copiedAriaLabel,
  copy,
  label,
  copiedLabel,
  labelPosition = "end",
  size = 14,
  className,
  style,
  tooltip,
  disabled = false,
  announcement,
  role,
  onCopied,
  onFailed,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  /**
   * Which copy attempt owns the feedback. A resolution from an older attempt --
   * or one whose `text` prop has since changed -- must not flip the checkmark,
   * or the icon confirms text that is no longer on the button (and may not be on
   * the clipboard either).
   */
  const attemptRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    attemptRef.current += 1;
    setCopied(false);
  }, [text]);

  const handleClick = () => {
    const requested = text;
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    void (async () => {
      const succeeded = await (copy ? copy(requested) : copyTextToClipboard(requested));
      if (attempt !== attemptRef.current) return;
      if (!succeeded) {
        window.clearTimeout(timerRef.current);
        setCopied(false);
        onFailed?.();
        return;
      }
      setCopied(true);
      onCopied?.();
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    })();
  };

  const shownLabel = copied && copiedLabel !== undefined ? copiedLabel : label;

  return (
    <>
      <button
        type="button"
        role={role}
        className={`copy-button${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
        style={style}
        onClick={handleClick}
        aria-label={copied && copiedAriaLabel ? copiedAriaLabel : ariaLabel}
        data-tooltip={tooltip}
        disabled={disabled}
      >
        {labelPosition === "start" && shownLabel !== undefined && <span>{shownLabel}</span>}
        <span className="copy-button-icon" aria-hidden="true">
          <Copy size={size} />
          <Check size={size} />
        </span>
        {labelPosition === "end" && shownLabel !== undefined && <span>{shownLabel}</span>}
      </button>
      {announcement && (
        <span className="visually-hidden" role="status" aria-live="polite">{copied ? announcement : ""}</span>
      )}
    </>
  );
}
