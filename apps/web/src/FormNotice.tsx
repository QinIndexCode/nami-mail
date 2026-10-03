import { Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";

export type Notice = { kind: "success" | "error"; message: string } | null;

export type FormNoticeProps = {
  notice: Notice;
  onDismiss?: () => void;
  /**
   * Auto-dismiss delay in ms.
   * Defaults to 4000ms for "success" notices when onDismiss is provided.
   * Defaults to 0 (disabled) for "error" notices.
   * Pass 0 to disable auto-dismiss.
   */
  autoDismissMs?: number;
};

const EXIT_DURATION_MS = 200;

function useCloseLabel(): string {
  try {
    return useI18n().t("common.close");
  } catch {
    return "Close";
  }
}

/**
 * Inline form-status strip used by every management/settings surface.
 *
 * The component must keep rendering exactly one `<div>`: `styles.css` styles
 * this strip through descendant/direct-child selectors
 * (`.settings-body>.form-status`, `.management-dialog-body .form-status`), so
 * an extra wrapper element would silently drop the sticky panel styling.
 */
export function FormNotice({
  notice,
  onDismiss,
  autoDismissMs,
}: FormNoticeProps): ReactNode {
  const closeLabel = useCloseLabel();
  const [closing, setClosing] = useState(false);
  const onDismissRef = useRef(onDismiss);
  const noticeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Reset closing state when notice changes
  useEffect(() => {
    setClosing(false);
  }, [notice]);

  // Measure content height and bind to --status-height CSS property for smooth height accordion animation
  useEffect(() => {
    const el = noticeRef.current;
    if (!el) return undefined;
    const updateHeight = () => {
      const h = el.scrollHeight;
      if (h > 0) {
        el.style.setProperty("--status-height", `${h + 2}px`);
      }
    };
    updateHeight();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(el);
      return () => observer.disconnect();
    }
    return undefined;
  }, [notice]);

  const requestDismiss = useCallback(() => {
    if (closing || !onDismissRef.current) return;
    setClosing(true);
  }, [closing]);

  // Once closing is triggered, wait for the exit animation to complete before calling onDismiss
  useEffect(() => {
    if (!closing) return undefined;
    const timer = window.setTimeout(() => {
      onDismissRef.current?.();
    }, EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // Auto-dismiss countdown
  useEffect(() => {
    if (!notice || !onDismiss || closing) return undefined;
    const delay = autoDismissMs !== undefined ? autoDismissMs : notice.kind === "success" ? 4000 : 0;
    if (delay <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setClosing(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss, autoDismissMs, closing]);

  if (!notice) return null;
  return (
    <div
      ref={noticeRef}
      key={`${notice.kind}:${notice.message}`}
      className={`form-status ${notice.kind}${closing ? " closing" : ""}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.kind === "success" ? <Check size={17} /> : <X size={17} />}
      <span className="form-status-message">{notice.message}</span>
      {onDismiss ? (
        <button
          type="button"
          className="form-status-dismiss"
          aria-label={closeLabel}
          onClick={requestDismiss}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
