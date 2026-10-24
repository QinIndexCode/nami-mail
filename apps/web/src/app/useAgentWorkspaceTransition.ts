import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ReaderAiLaunchIntent } from "../readerAiActions";
import { AGENT_FADE_STAGGER_MS, MAIL_FADE_STAGGER_MS, SWITCH_FADE_MS } from "./app-utils";

// Interface-switch ("fade hand-off") phases between the mail workspace and the
// Agent workspace. Each interface fades out/in in two layers — the mail
// sidebar and workspace leave first, then the Agent's conversation rail and
// main panel enter (and vice versa on close). These phases only drive class
// names; the motion itself lives in styles.css. `idle` is the settled state in
// either direction.
export type AgentPhase = "idle" | "mail-leaving" | "agent-entering" | "agent-leaving" | "mail-entering";

const MAIL_SWITCH_TOTAL_MS = SWITCH_FADE_MS + MAIL_FADE_STAGGER_MS;
const AGENT_SWITCH_TOTAL_MS = SWITCH_FADE_MS + AGENT_FADE_STAGGER_MS;

type AgentWorkspaceTransitionOptions = {
  /** Demo presentation never switches interfaces. */
  demoPresentation: boolean;
  setAgentPhase: (phase: AgentPhase) => void;
  setAgentOpen: (open: boolean) => void;
  setAgentLaunchIntent: (intent: ReaderAiLaunchIntent | null) => void;
  /** The virtualized mail list, whose scroll offset is restored on return. */
  messageListRef: RefObject<HTMLDivElement | null>;
};

/**
 * The timer-driven interruption guard around the mail ↔ Agent hand-off.
 *
 * A click that arrives mid-transition is a no-op *before* it touches the
 * timers: clearing them first and then returning would strand the phase in
 * `mail-leaving`/`agent-entering` with no timer left to advance it. The latest
 * explicit intent still wins, so a second reader click retargets the launch
 * instead of being dropped, while a plain open/close never erases an intent
 * already pending.
 */
export function useAgentWorkspaceTransition({
  demoPresentation,
  setAgentPhase,
  setAgentOpen,
  setAgentLaunchIntent,
  messageListRef,
}: AgentWorkspaceTransitionOptions): {
  openAgentWorkspace: (intent?: ReaderAiLaunchIntent) => void;
  closeAgentWorkspace: () => void;
} {
  const agentSwitchTimersRef = useRef<number[]>([]);
  // Mirrors the rendered phase for the controllers, which must read it
  // synchronously without being recreated on every phase change.
  const agentPhaseRef = useRef<AgentPhase>("idle");
  // Scroll position across the Agent round-trip: the mail column is
  // display:none while the workspace is open, which resets the virtualized
  // list's scroller. The offset is captured before hiding and re-applied once
  // the column is laid out again.
  const agentReturnScrollTopRef = useRef<number | null>(null);

  const clearAgentSwitchTimers = useCallback(() => {
    for (const timer of agentSwitchTimersRef.current) window.clearTimeout(timer);
    agentSwitchTimersRef.current = [];
  }, []);
  useEffect(() => clearAgentSwitchTimers, [clearAgentSwitchTimers]);
  const queueAgentTimer = useCallback((run: () => void, delay: number) => {
    agentSwitchTimersRef.current.push(window.setTimeout(run, delay));
  }, []);

  const openAgentWorkspace = useCallback((intent?: ReaderAiLaunchIntent) => {
    if (demoPresentation) return;
    if (agentPhaseRef.current === "mail-leaving" || agentPhaseRef.current === "agent-entering") {
      // Mid-transition: keep whatever is pending unless this click named a
      // different mail. The timers stay untouched -- they are the only thing
      // that can move the phase forward.
      if (intent) setAgentLaunchIntent(intent);
      return;
    }
    setAgentLaunchIntent(intent ?? null);
    clearAgentSwitchTimers();
    // Only sample the offset while the mail column is visible. Re-opening
    // during `agent-leaving` (workspace still up, column display:none) would
    // otherwise overwrite the saved offset with the 0 the hidden scroller
    // reports, and the next close would land at the top of the list.
    if (agentPhaseRef.current === "idle") {
      agentReturnScrollTopRef.current = messageListRef.current?.scrollTop ?? null;
    }
    agentPhaseRef.current = "mail-leaving";
    setAgentPhase("mail-leaving");
    // Warm the lazy chunk while the mail layers fade out so the workspace is
    // ready the moment it takes over (no Suspense spinner in the hand-off).
    void import("../AgentWorkspace").catch(() => undefined);
    queueAgentTimer(() => {
      setAgentOpen(true);
      agentPhaseRef.current = "agent-entering";
      setAgentPhase("agent-entering");
    }, MAIL_SWITCH_TOTAL_MS);
    queueAgentTimer(() => {
      agentPhaseRef.current = "idle";
      setAgentPhase("idle");
    }, MAIL_SWITCH_TOTAL_MS + AGENT_SWITCH_TOTAL_MS);
  }, [clearAgentSwitchTimers, demoPresentation, messageListRef, queueAgentTimer, setAgentLaunchIntent, setAgentOpen, setAgentPhase]);

  const closeAgentWorkspace = useCallback(() => {
    if (demoPresentation) return;
    // Same rule as opening: return before touching the in-flight timers.
    if (agentPhaseRef.current === "agent-leaving" || agentPhaseRef.current === "mail-entering") return;
    setAgentLaunchIntent(null);
    clearAgentSwitchTimers();
    agentPhaseRef.current = "agent-leaving";
    setAgentPhase("agent-leaving");
    queueAgentTimer(() => {
      setAgentOpen(false);
      agentPhaseRef.current = "mail-entering";
      setAgentPhase("mail-entering");
      const savedTop = agentReturnScrollTopRef.current;
      if (savedTop == null) return;
      // The scroller was display:none while the Agent workspace was open, so
      // its offset was lost. Restore once the column is laid out again (double
      // rAF: one frame for display, one for the virtualizer's re-measure) so
      // the user lands exactly where they left. A quick re-entry into the
      // workspace (phase back to "mail-leaving") cancels the restore but keeps
      // the saved offset for the next return; the ref is cleared only once the
      // restore actually lands.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (agentPhaseRef.current === "mail-leaving") return;
          const viewport = messageListRef.current;
          if (!viewport) return;
          viewport.scrollTop = savedTop;
          if (agentReturnScrollTopRef.current === savedTop) {
            agentReturnScrollTopRef.current = null;
          }
        });
      });
    }, AGENT_SWITCH_TOTAL_MS);
    queueAgentTimer(() => {
      agentPhaseRef.current = "idle";
      setAgentPhase("idle");
    }, AGENT_SWITCH_TOTAL_MS + MAIL_SWITCH_TOTAL_MS);
  }, [clearAgentSwitchTimers, demoPresentation, messageListRef, queueAgentTimer, setAgentLaunchIntent, setAgentOpen, setAgentPhase]);

  return { openAgentWorkspace, closeAgentWorkspace };
}
