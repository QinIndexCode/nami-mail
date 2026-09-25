import { useEffect, useRef, useState } from "react";
import { CheckCheck, CircleAlert, ShieldAlert } from "lucide-react";
import { useI18n } from "../i18n";
import type { AgentConfirmation } from "../agentTypes";
import { formatCountdown, shortDate } from "./agent-utils";

export function AgentConfirmationCard({
  confirmation,
  desktopConfirmationAvailable,
  resolutionError,
  onDecision,
  expiresAt,
  onExpire,
  forceLeaving = false,
  onStartLeaving,
}: {
  confirmation: AgentConfirmation;
  desktopConfirmationAvailable: boolean;
  resolutionError?: string;
  /** Local decision handler (demo mode) — real builds resolve through the desktop bridge. */
  onDecision?: (decision: "approve" | "reject") => void;
  /** Deadline (epoch ms) driving the local ticking countdown. */
  expiresAt?: number;
  /** Called once when the deadline passes while the card is mounted. */
  onExpire?: () => void;
  /** Real builds resolve through the desktop bridge, so the workspace collapses
   *  the wrapping slot (grid 1fr→0fr) and removes the card after the collapse —
   *  without this signal the card would vanish with no exit transition at all. */
  forceLeaving?: boolean;
  /** Triggered the moment a decision is clicked to initiate the wrapping slot collapse without waiting. */
  onStartLeaving?: () => void;
}) {
  const { locale, t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  useEffect(() => {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!expiredRef.current && current >= expiresAt) {
        expiredRef.current = true;
        onExpire?.();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, onExpire]);
  const decisionEnabled = Boolean(onDecision);
  const resolve = (decision: "approve" | "reject") => {
    if (leaving) return;
    setLeaving(true);
    onStartLeaving?.();
    // Let the collapse animation finish before the card unmounts.
    window.setTimeout(() => onDecision?.(decision), 340);
  };
  const remainingMs = expiresAt !== undefined && Number.isFinite(expiresAt) ? expiresAt - now : 0;
  return (
    <section
      className={`agent-confirmation-card${leaving || forceLeaving ? " leaving" : ""}`}
      aria-label={confirmation.title}
      data-nami-agent-confirmation-card
      data-nami-agent-confirmation-id={confirmation.id}
    >
      <div className="agent-confirmation-heading"><ShieldAlert size={17} /><span><strong>{confirmation.title}</strong><small>{confirmation.summary}</small></span><small className="agent-confirmation-expiry">{remainingMs > 0
        ? t("agent.confirmation.expiresIn", { time: formatCountdown(remainingMs) })
        : t("agent.confirmation.expires", { time: shortDate(confirmation.expiresAt, locale) })}</small></div>
      <dl>
        {confirmation.fields.map((field) => <div key={`${field.label}:${field.value}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      </dl>
      <div className="agent-confirmation-actions">
        <button className="secondary-button" type="button" disabled={!desktopConfirmationAvailable && !decisionEnabled} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="reject" onClick={decisionEnabled ? () => resolve("reject") : undefined}>{t("agent.confirmation.reject")}</button>
        <button className="primary-button" type="button" disabled={!desktopConfirmationAvailable && !decisionEnabled} data-nami-agent-confirmation-id={confirmation.id} data-nami-agent-confirmation-decision="approve" onClick={decisionEnabled ? () => resolve("approve") : undefined}><CheckCheck size={15} />{t("agent.confirmation.approve")}</button>
      </div>
      {resolutionError && <div className="agent-message-error" role="alert"><CircleAlert size={15} /><span>{resolutionError}</span></div>}
    </section>
  );
}
