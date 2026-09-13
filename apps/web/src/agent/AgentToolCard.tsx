import { memo, useState } from "react";
import { Check, ChevronDown, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useI18n } from "../i18n";
import type { AgentToolActivity } from "../agentTypes";
import { toolLabelKeys } from "./agent-utils";

function AgentToolCardInner({ activity }: { activity: AgentToolActivity }) {
  const { t } = useI18n();
  const icon = activity.state === "failed" ? <CircleAlert size={15} /> : activity.state === "completed" ? <Check size={15} /> : <LoaderCircle className="spin" size={15} />;
  const title = toolLabelKeys[activity.toolName] ? t(toolLabelKeys[activity.toolName]) : activity.title;
  const summary = activity.state === "failed"
    ? activity.error?.code === "INTERRUPTED"
      ? t("agent.interrupted")
      : activity.error?.code?.startsWith("CONFIRMATION_")
        ? activity.error.message
        : t("agent.tool.failed")
    : activity.state === "completed"
      ? activity.summary ?? t("agent.tool.completed")
      : activity.state === "awaiting_confirmation"
        ? t("agent.confirmation.waiting")
        : t("agent.tool.running");
  return (
    <div className={`agent-tool-card ${activity.state}`}>
      <span className="agent-tool-icon" aria-hidden="true">{icon}</span>
      <span className="agent-tool-copy"><strong>{title}</strong><small>{summary}</small></span>
      {activity.state === "awaiting_confirmation" && <span className="agent-tool-waiting">{t("agent.confirmation.waiting")}</span>}
    </div>
  );
}

const AgentToolCard = memo(AgentToolCardInner);
export default AgentToolCard;

// Tool activities stay collapsed into a quiet one-line summary — even while
// running — so a turn's tool calls never dominate the conversation. A FINAL
// failure — the newest activity failed — in the LATEST turn expands the list
// to make the error visible (earlier failures followed by successful tools do
// not pin it open); once the user starts a new turn (superseded), the old
// warning folds back into its summary automatically. The user can always fold
// the list back down; the failed count keeps the error visible on the summary
// row, and a fresh failure pops it open again. The summary row stays in place
// as an accordion header so the fold is a smooth height transition.
export const AgentToolList = memo(function AgentToolListInner({ activities, superseded = false }: { activities: AgentToolActivity[]; superseded?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  // Dismissal is keyed to the latest activity so a NEW failure (a later
  // activity becomes the latest) pops the list open again.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const latest = activities[activities.length - 1];
  const autoExpanded = latest?.state === "failed" && !superseded && dismissedKey !== latest.id;
  const open = expanded || autoExpanded;
  const failedCount = activities.filter((activity) => activity.state === "failed").length;
  const runningCount = activities.filter((activity) => activity.state === "running" || activity.state === "awaiting_confirmation").length;
  // Only a DONE failure can be dismissed; a running tool that fails later must
  // still pop the list open again.
  const collapse = () => {
    setExpanded(false);
    if (latest?.state === "failed") setDismissedKey(latest.id);
  };

  return (
    <div className={`agent-tool-list${open ? " open" : ""}`}>
      <button type="button" className="agent-tool-summary" aria-expanded={open} onClick={() => (open ? collapse() : setExpanded(true))}>
        <Wrench size={13} />
        {/* The count renders as a rolling odometer digit: only the number spins
            (like a taximeter) when a new tool call lands. The full sentence is
            kept for screen readers; the visual is the prefix + rolling digit +
            suffix so the surrounding text never moves. */}
        <span className="agent-tool-summary-label">
          <span className="visually-hidden">{t("agent.tool.summary", { count: activities.length })}</span>
          <span className="agent-tool-summary-visual" aria-hidden="true">
            <span className="agent-tool-summary-prefix">{t("agent.tool.summaryPrefix")}</span>
            <span className="agent-tool-count-window">
              <span className="agent-tool-count-strip" style={{ transform: `translateY(${-activities.length}em)` }}>
                {Array.from({ length: Math.max(10, activities.length + 1) }, (_, digit) => (
                  <span key={digit} className="agent-tool-count-digit">{digit}</span>
                ))}
              </span>
            </span>
            <span className="agent-tool-summary-suffix">{t("agent.tool.summarySuffix")}</span>
          </span>
        </span>
        <span className="agent-tool-summary-chips">{failedCount > 0 && <em className="agent-tool-summary-failed">{t("agent.tool.failedCount", { count: failedCount })}</em>}{runningCount > 0 && <em className="agent-tool-summary-running">{t("agent.tool.runningCount", { count: runningCount })}</em>}</span>
        <ChevronDown size={13} className="agent-tool-summary-chevron" />
      </button>
      <div className="agent-tool-collapse" aria-hidden={!open}>
        <div className="agent-tool-collapse-inner">
          {activities.map((activity) => <AgentToolCard key={activity.id} activity={activity} />)}
          <button type="button" className="agent-tool-toggle" onClick={collapse}>{t("agent.tool.collapse")}</button>
        </div>
      </div>
    </div>
  );
});
