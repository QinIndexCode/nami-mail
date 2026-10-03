/**
 * useAgentSession: the streaming conversation state machine lifted out of
 * AgentWorkspace.tsx. Owns a run's lifecycle wherever it is independent of the
 * surrounding UI:
 *
 *  - streaming / streamStatus / ghostConversationId / backgroundRunIds flags,
 *    the per-conversation session buffer (sessionStreamsRef) and replay on
 *    re-entry, the background-run pickup/fold-in poll, the cancel/stop
 *    affordances and the interrupt-to-send path
 *  - the frame-batched reveal-pacing pipeline (pendingStreamPieces / rAF /
 *    pacing) that folds text/tool/citation deltas onto the active transcript
 *  - the run-driving entry point (runStream)
 *
 * It is deliberately "injection-driven": `active` (and its setter) live in the
 * component because event folding, replay and the poll all write the active
 * conversation's message list, and that list is the component's render state.
 * The hook receives the pieces it needs (activeIdRef for liveness checks,
 * setActive to fold rows, refreshConversations / setConversations for
 * bookkeeping, setPendingMemorySuggestions for memory suggestions) and exposes
 * back the session flags + run controls the component renders against.
 *
 * Design constraints: no new runtime dependency (plain React hooks +
 * AbortController), and the reveal-pacing layer may only change *when* a
 * character appears — never which characters, or in what order.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api, ApiError } from "../api";
import type {
  AgentBootstrap,
  AgentConversation,
  AgentMessage,
  AgentStreamEvent,
} from "../agentTypes";
import type { Translate } from "../i18n";
import {
  applyRevokedMarks,
  currentTime,
  interruptAssistantMessage,
  lastMessageIsStreaming,
  lastMessageIsUnanswered,
  messageWithEvent,
  purgeStaleErrors,
} from "./agent-utils";

/**
 * A run that may outlive the conversation currently being viewed: when the user
 * switches away mid-reply the run keeps streaming into this buffer rather than
 * rendering to a transcript nobody is looking at. Re-entry replays the buffered
 * events so the reply appears where it left off, then live events resume the
 * same row. Terminal runs are dropped once the server has persisted the turn.
 */
type SessionStream = {
  conversationId: string;
  assistantMessageId: string;
  controller: AbortController;
  /** text_delta / citation / tool / confirmation / error / completed deltas. */
  events: AgentStreamEvent[];
  /** Latest status message while the run was in the background. */
  status: string | null;
  /** Memory suggestions collected while the run was in the background. */
  suggestions: string[];
  /** True once a terminal event (completed/error) was received. */
  done: boolean;
};

/**
 * Reveal pacing, as two independent limits because one `rate * dt` budget gives
 * neither: THROUGHPUT (`rateMin`..`rateMax`, chars/sec) follows the model's
 * arrival rate, and STEP (`stepChars`..`stepCharsCeiling`, chars per paint)
 * caps a single paint, so a longer delta is sliced and its tail re-queued.
 * Exported so tests state the invariants in these terms; the measurements
 * behind every value live in useAgentSession.pacing.test.tsx.
 */
export const STREAM_REVEAL = {
  rateMin: 24, // chars/sec floor: a slow model still produces visible movement
  rateMax: 1200, // chars/sec ceiling: tracks a fast model, so the queue does not grow
  arrivalWindowMs: 300, // arrival-rate window (further clamped to the time since the last flush)
  smoothingTauMs: 160, // reveal-rate low-pass time constant; time-based, so 60 Hz == 144 Hz
  stepChars: 12, // characters one paint adds while the reveal keeps up
  stepCharsCeiling: 24, // hard ceiling for one paint: no frame can ever dump a backlog
  stepCatchupChars: 200, // backlog at which the step is fully widened to that ceiling
  catchUpSeconds: 0.35, // drain horizon for a backlog the model has stopped feeding
  hiddenStepChars: 480, // characters one hidden tick may reveal (bounded work; nobody is watching)
  dtClampMs: 250, // hard cap on the time one flush charges, so a stall can never become one big reveal
  hiddenTickMs: 250, // hidden-window drain cadence: a heartbeat, not a debounce
} as const;

/** Agent tools whose successful completion mutates primary mail state. Their
 *  completion notifies the app so the mail list refreshes in step with the
 *  conversation (e.g. the read flag set by the agent shows up immediately). */
const MAIL_STATE_MUTATING_TOOLS = new Set<string>([
  "messages.set-flag",
]);

export type UseAgentSessionParams = {
  demoMode: boolean;
  /** The active conversation (component-owned render state). */
  active: AgentConversation | null;
  /** Folds streamed rows / replays / poll results onto the active transcript. */
  setActive: Dispatch<SetStateAction<AgentConversation | null>>;
  /** Liveness ref: the id of whatever conversation is on screen. Shared with the component. */
  activeIdRef: RefObject<string | null>;
  /** The sidebar conversation list; setConversations drives title bumps. */
  setConversations: Dispatch<SetStateAction<AgentBootstrap["conversations"]>>;
  /** Performs a conversation list refresh (after poll fold-in / run completion). */
  refreshConversations: (query?: string) => Promise<void>;
  /** The conversation search term at poll time, so fold-ins refresh the right view. */
  conversationSearch: string;
  /** Setter for the component's pending memory-suggestion chips. */
  setPendingMemorySuggestions: Dispatch<SetStateAction<string[]>>;
  /** Reads a stable translator (localization keys for run/stream messages). */
  getT: () => Translate;
  /** Notified when an agent tool mutates primary mail state (flags, moves) so
   *  the surrounding app can refresh its mail list in step with the chat. */
  onMailStateChanged?: () => void;
};

export type UseAgentSessionResult = {
  streaming: boolean;
  streamStatus: string | null;
  ghostConversationId: string | null;
  /** Conversations with a live run streaming in the background; drives sidebar spinners. */
  backgroundRunIds: ReadonlySet<string>;
  /** Recomputes backgroundRunIds after the session map changed. */
  syncBackgroundRuns: () => void;
  /** True when a conversation hosts a live (undone, un-aborted) session buffer. */
  hasLiveRun: (conversationId: string) => boolean;
  /** Returns the session buffer held for a conversation, if any. */
  getSession: (conversationId: string) => SessionStream | undefined;
  /** Clears any pending frame-batched deltas (conversation switch / new run). */
  clearPendingFlush: () => void;
  /** Paints every queued delta onto the CURRENT transcript in one pass (the switch drain). */
  drainPendingFlush: () => void;
  /** Consumes (and clears) a cached background-run failure for a conversation. */
  takeBackgroundError: (conversationId: string) => { code: string; message: string; retryable?: boolean } | undefined;
  /** Drops the streaming / status affordances when leaving a live conversation (run keeps streaming). */
  clearLiveRunIndicators: () => void;
  /** Restores the streaming / status affordances for a still-running conversation on re-entry. */
  restoreLiveRunIndicators: (conversationId: string) => void;
  /** Detaches and returns a conversation's session buffer, aborting it. */
  terminateSession: (conversationId: string) => SessionStream | undefined;
  /** Replays a background session's buffered events when re-entering its conversation. */
  replayBackgroundSession: (session: SessionStream, conversationView: AgentConversation) => void;
  /** Stops the on-screen conversation's live run. */
  stopStreaming: () => void;
  /** Stops a pickup run (no local controller) after the panel reopened. */
  stopGhostRun: () => void;
  /** Interrupt-to-send: cancels the active run and folds it to "interrupted". */
  prepareInterruptToSend: () => void;
  /** Runs a new assistant turn against a conversation and streams its events. */
  runStream: (args: {
    conversation: AgentConversation;
    assistantMessage: Pick<AgentMessage, "id">;
    streamPayload: Parameters<typeof api.streamAgentMessage>[1];
  }) => Promise<void>;
};

/**
 * Folds a server transcript snapshot into what is already on screen. A poll or
 * a conversation fetch can return a snapshot taken before the text that has
 * since streamed in, and adopting it wholesale rewinds the reply — the visible
 * symptom of "the answer went backwards". While a run is live for the
 * conversation keep whichever copy of a row is further along; once it ends the
 * server is authoritative again, so nothing is held back indefinitely.
 */
export function keepAheadTranscript(
  current: AgentConversation,
  server: AgentConversation,
  live: boolean,
): AgentConversation {
  if (!live) return server;
  const byId = new Map(current.messages.map((message) => [message.id, message]));
  let changed = false;
  const messages = server.messages.map((incoming) => {
    const mine = byId.get(incoming.id);
    if (mine && (mine.content?.length ?? 0) > (incoming.content?.length ?? 0)) {
      changed = true;
      return mine;
    }
    return incoming;
  });
  return changed ? { ...server, messages } : server;
}

export function useAgentSession({
  demoMode,
  active,
  setActive,
  activeIdRef,
  setConversations,
  refreshConversations,
  conversationSearch,
  setPendingMemorySuggestions,
  getT,
  onMailStateChanged,
}: UseAgentSessionParams): UseAgentSessionResult {
  // ---------------------------------------------------------------------------
  // Session flags
  // ---------------------------------------------------------------------------
  const [streaming, setStreaming] = useState(false);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);
  /**
   * A turn that outlived the panel is being picked up: the fold-in poll watches
   * this conversation because its newest message is a user message (or a server
   * streaming snapshot) with no local session attached. While set, the composer
   * shows a stop affordance backed by cancelAgentRun — the usual in-session
   * interrupt cannot reach a run without a local controller.
   */
  const [ghostConversationId, setGhostConversationId] = useState<string | null>(null);
  const [backgroundRunIds, setBackgroundRunIds] = useState<ReadonlySet<string>>(() => new Set());

  // ---------------------------------------------------------------------------
  // Run bookkeeping refs
  // ---------------------------------------------------------------------------
  const abortRef = useRef<AbortController | null>(null);
  // Failures of background runs (the user left the conversation while it ran).
  // The server persists most failure turns itself, but requests rejected before
  // any record is written leave the conversation with neither a row nor an
  // error — re-entry would silently show a bare user message. Consumed once
  // re-surfaced in the view.
  const backgroundErrorRef = useRef(new Map<string, { code: string; message: string; retryable?: boolean }>());
  // A pickup the user explicitly abandoned (stop) is recorded so the poll can
  // never re-arm for the same last message: that run was cancelled server-side
  // and can never complete. Recording the message id keeps a fresh turn on an
  // independent poll.
  const abandonedPickupRef = useRef<{ conversationId: string; lastMessageId: string } | null>(null);
  // Live runs keyed by conversation: while the user browses a different
  // conversation, a run keeps streaming into its buffer (no UI cost) and is
  // replayed on re-entry.
  const sessionStreamsRef = useRef(new Map<string, SessionStream>());
  // Latest mail-state callback, mirrored into a ref so detecting a mutating
  // tool below never changes enqueueStreamPiece's identity (it is a dep of
  // runStream and other memoised hooks).
  const onMailStateChangedRef = useRef(onMailStateChanged);
  onMailStateChangedRef.current = onMailStateChanged;

  // ---------------------------------------------------------------------------
  // Frame-batched reveal pacing pipeline
  // ---------------------------------------------------------------------------
  const pendingStreamPiecesRef = useRef<{ id: string; event: AgentStreamEvent }[]>([]);
  const streamRafRef = useRef<number | null>(null);
  // While the window is hidden the flush falls back to setTimeout (rAF may stop
  // firing on some hidden-window configurations). The pending id lives here so
  // every cancellation point can also clear it even though the rAF ref is null.
  const streamHiddenTimerRef = useRef<number | null>(null);
  // Lets armStreamFlush (defined before flushPendingStreamPieces) reach the
  // latest flush callback without a use-before-declaration cycle.
  const flushPendingStreamPiecesRef = useRef<() => void>(() => undefined);
  const streamPacingRef = useRef<{
    lastTick: number;
    value: number; // current reveal rate, chars/sec
    arrivals: { t: number; c: number }[]; // text deltas pushed by the foreground run
  }>({ lastTick: performance.now(), value: STREAM_REVEAL.rateMin, arrivals: [] });

  // ---------------------------------------------------------------------------
  // Background run spinner sync
  // ---------------------------------------------------------------------------
  const syncBackgroundRuns = useCallback(() => {
    const ids = new Set<string>();
    sessionStreamsRef.current.forEach((session, id) => {
      // A run that turned terminal (done/aborted) is no longer "working": it
      // either finished or was stopped, so its spinner goes out immediately
      // even though the slot is only cleaned up once the SSE finally closes.
      if (activeIdRef.current !== id && !session.done && !session.controller.signal.aborted) ids.add(id);
    });
    setBackgroundRunIds((current) => {
      if (current.size === ids.size && [...current].every((id) => ids.has(id))) return current;
      return ids;
    });
  }, [activeIdRef]);

  // ---------------------------------------------------------------------------
  // rAF flush + reveal pacing
  // ---------------------------------------------------------------------------
  // Arm the next frame-batched flush pass: requestAnimationFrame while visible
  // (rAF may stop firing entirely while hidden), a fixed setTimeout otherwise.
  // That timer is a HEARTBEAT, not a debounce — armed only when none is pending,
  // and re-armed by the flush while a backlog remains, so a delta arriving
  // mid-window rides the pending tick instead of starving it (the old
  // clear-then-re-arm never fired at all, and the whole hidden backlog landed on
  // the first visible frame). The active id lives in whichever ref matches the
  // path taken; every cancellation point clears both.
  const armStreamFlush = useCallback(() => {
    if (document.hidden) {
      if (streamHiddenTimerRef.current === null) {
        streamHiddenTimerRef.current = window.setTimeout(flushPendingStreamPiecesRef.current, STREAM_REVEAL.hiddenTickMs);
      }
      return;
    }
    if (streamHiddenTimerRef.current !== null) {
      window.clearTimeout(streamHiddenTimerRef.current);
      streamHiddenTimerRef.current = null;
    }
    if (streamRafRef.current === null) {
      streamRafRef.current = requestAnimationFrame(flushPendingStreamPiecesRef.current);
    }
  }, []);

  // Cancels the armed flush (rAF + hidden heartbeat): the teardown every
  // cancellation point (clear / drain / flush-now / restart / unmount) shares.
  const cancelStreamFlush = useCallback(() => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    if (streamHiddenTimerRef.current !== null) {
      window.clearTimeout(streamHiddenTimerRef.current);
      streamHiddenTimerRef.current = null;
    }
  }, []);

  // Folds the pending queue onto the active transcript. `drainAll` (a switch)
  // paints every queued piece in one pass; pacing slices text and re-queues.
  const applyStreamPieces = useCallback((drainAll: boolean) => {
    streamRafRef.current = null;
    streamHiddenTimerRef.current = null;
    const queue = pendingStreamPiecesRef.current;
    if (queue.length === 0) return;
    pendingStreamPiecesRef.current = [];
    const pacing = streamPacingRef.current;
    const now = performance.now();
    let budget = Number.POSITIVE_INFINITY;
    if (drainAll) pacing.arrivals = []; // ∞ budget: a switch paints the whole queue at once
    else {
      const dt = Math.min(Math.max(now - pacing.lastTick, 0), STREAM_REVEAL.dtClampMs);
      // The arrival window is clamped to the time since the last flush: a longer
      // one counts characters this flush is not charged for (no under-drain).
      const windowMs = Math.min(STREAM_REVEAL.arrivalWindowMs, Math.max(dt, 1));
      const cutoff = now - windowMs;
      while (pacing.arrivals.length > 0 && pacing.arrivals[0]!.t < cutoff) pacing.arrivals.shift();
      let backlog = 0;
      for (const piece of queue) if (piece.event.type === "text_delta") backlog += piece.event.delta.length;
      let windowChars = 0;
      for (const arrival of pacing.arrivals) windowChars += arrival.c;
      // A backlog the model stopped feeding (tool call, thinking pause, terminal
      // tail) implies a drain rate of its own; the arrival rate is the larger.
      const targetRate = Math.min(STREAM_REVEAL.rateMax, Math.max(
        windowChars / (windowMs / 1000), backlog / STREAM_REVEAL.catchUpSeconds, STREAM_REVEAL.rateMin,
      ));
      pacing.value += (targetRate - pacing.value) * (1 - Math.exp(-dt / STREAM_REVEAL.smoothingTauMs));
      // This paint's budget: the tracked rate allows in `dt`, clamped to the
      // per-paint step (bounded work while hidden).
      const stepMax = document.hidden ? STREAM_REVEAL.hiddenStepChars : Math.round(
        STREAM_REVEAL.stepChars
        + (STREAM_REVEAL.stepCharsCeiling - STREAM_REVEAL.stepChars) * Math.min(1, backlog / STREAM_REVEAL.stepCatchupChars),
      );
      // Whole characters, rounded not floored (slicing truncates; flooring
      // dropped one character nearly every frame). At least one, always.
      budget = Math.max(1, Math.round(Math.min((pacing.value * dt) / 1000, stepMax)));
    }
    pacing.lastTick = now;
    // Split the queue into what this paint reveals and what goes back into the
    // pending queue, order preserved in both halves (content is a pure append).
    const applied: { id: string; event: AgentStreamEvent }[] = [];
    const leftovers: { id: string; event: AgentStreamEvent }[] = [];
    for (let index = 0; index < queue.length; index += 1) {
      const piece = queue[index]!;
      const event = piece.event;
      if (event.type === "text_delta" && !drainAll) {
        const take = Math.min(event.delta.length, budget);
        if (take <= 0) {
          leftovers.push(piece);
          continue;
        }
        budget -= take;
        if (take === event.delta.length) applied.push(piece);
        else {
          applied.push({ id: piece.id, event: { type: "text_delta", delta: event.delta.slice(0, take) } });
          leftovers.push({ id: piece.id, event: { type: "text_delta", delta: event.delta.slice(take) } });
        }
        continue;
      }
      // Never budget-gated; under a drain every remaining piece applies in full.
      applied.push(piece);
      if ((event.type !== "completed" && event.type !== "error") || drainAll) continue;
      // A terminal event lands in this very frame even with characters queued
      // behind it — the row reaches its final state at once, so the transcript
      // does not sit in "streaming", the pickup poll does not re-arm against it
      // and the sidebar does not blink. (A drain has no tail: ∞ budget applied.)
      for (let rest = index + 1; rest < queue.length; rest += 1) leftovers.push(queue[rest]!);
      break;
    }
    const byId = new Map<string, AgentStreamEvent[]>();
    for (const piece of applied) {
      const events = byId.get(piece.id);
      if (events) events.push(piece.event);
      else byId.set(piece.id, [piece.event]);
    }
    setActive((current) => {
      if (!current) return current;
      let messages = current.messages;
      byId.forEach((events, messageId) => {
        let row = messages.find((message) => message.id === messageId);
        if (!row) return;
        for (const event of events) row = messageWithEvent(row, event);
        messages = messages.map((message) => (message.id === messageId ? row : message));
      });
      return messages === current.messages ? current : { ...current, messages };
    });
    // Whatever this paint did not take goes back into the pending queue (the
    // queue was detached above). Safe to assign directly — nothing can enqueue
    // in between.
    if (leftovers.length > 0) {
      pendingStreamPiecesRef.current = leftovers;
      armStreamFlush();
    }
  }, [armStreamFlush, setActive]);
  // Zero-arg shell on purpose: rAF invokes its callback with a truthy
  // timestamp, so a boolean first parameter would read every frame as a drain.
  const flushPendingStreamPieces = useCallback(() => {
    applyStreamPieces(false);
  }, [applyStreamPieces]);
  flushPendingStreamPiecesRef.current = flushPendingStreamPieces;

  // Live runs keyed by conversation, so a run the user navigated away from can
  // keep streaming into a buffer (no UI cost) and be replayed on re-entry. When
  // the run is foreground, deltas flow through the frame batching path above.
  const enqueueStreamPiece = useCallback((conversationId: string, messageId: string, event: AgentStreamEvent, flushNow = false) => {
    const session = sessionStreamsRef.current.get(conversationId);
    if (!session || session.assistantMessageId !== messageId) return;
    // A completed write-tool event means primary mail state just changed
    // server-side (e.g. the agent marked a message read). Notify the app so the
    // mail list refreshes in step instead of lagging until the next poll. Live
    // arrivals only; replays re-render the row but do not re-notify.
    if (event.type === "tool" && event.activity.state === "completed" && MAIL_STATE_MUTATING_TOOLS.has(event.activity.toolName)) {
      onMailStateChangedRef.current?.();
    }
    // Foreground run: surface status/suggestions/title in the live UI and push
    // message deltas through the frame-batched render path.
    if (session.conversationId === activeIdRef.current) {
      if (event.type === "status") {
        if (event.message) {
          // Mirror into the session so a later switch away and back restores
          // the last status instead of losing it.
          session.status = event.message;
          setStreamStatus(event.message);
        }
        return;
      }
      if (event.type === "memory_suggestion") {
        if (!session.suggestions.includes(event.summary)) session.suggestions.push(event.summary);
        setPendingMemorySuggestions((items) => (items.includes(event.summary) ? items : [...items, event.summary]));
        return;
      }
      if (event.type === "title") {
        setActive((current) => current && current.id === conversationId ? { ...current, title: event.title } : current);
        setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, title: event.title } : item));
        return;
      }
      if (event.type === "completed" || event.type === "error") {
        session.done = true;
        setStreamStatus(null);
      }
      // Keep the session buffer as the full event sequence for this run (even
      // while foregrounded) so a later re-entry can rebuild the row
      // identically. status/memory_suggestion/title never reach here.
      session.events.push(event);
      // Feed the adaptive reveal pacing with the text that arrived this frame so
      // the reveal speed can match the model's output rate.
      if (event.type === "text_delta") streamPacingRef.current.arrivals.push({ t: performance.now(), c: event.delta.length });
      pendingStreamPiecesRef.current.push({ id: messageId, event });
      if (flushNow) {
        cancelStreamFlush();
        flushPendingStreamPieces();
        return;
      }
      armStreamFlush();
      return;
    }
    // Background run: accumulate without rendering. Status/suggestions are kept
    // for re-entry; a terminal event marks the session complete; the remaining
    // deltas are replayed onto the message when the user returns.
    if (event.type === "status") {
      if (event.message) session.status = event.message;
      return;
    }
    if (event.type === "memory_suggestion") {
      if (!session.suggestions.includes(event.summary)) session.suggestions.push(event.summary);
      return;
    }
    if (event.type === "title") {
      // A background run still earns its sidebar title; only the active-header
      // title is deferred to re-entry (the conversation view carries it).
      setConversations((items) => items.map((item) => (item.id === conversationId ? { ...item, title: event.title } : item)));
      return;
    }
    if (event.type === "completed" || event.type === "error") session.done = true;
    // Keep a record of background failures: the server persists only successful
    // turns, so re-entry would otherwise show a bare user message with no error.
    if (event.type === "error") backgroundErrorRef.current.set(conversationId, event.error);
    session.events.push(event);
  }, [activeIdRef, armStreamFlush, cancelStreamFlush, flushPendingStreamPieces, setActive, setConversations, setPendingMemorySuggestions]);

  // Close the panel is a "leave", not a "cancel": drop every local stream (the
  // fetch rejection aborts the SSE, which on the server only stops event
  // delivery). We must NOT call cancelAgentRun here — it aborts the server run
  // and its finally skips persisting the assistant row, so reopening would show
  // the orphaned user message with no reply. The reply is picked up by the poll.
  useEffect(() => {
    const streamsRef = sessionStreamsRef;
    return () => {
      for (const session of streamsRef.current.values()) {
        session.controller.abort();
      }
      cancelStreamFlush();
    };
  }, [cancelStreamFlush]);

  // ---------------------------------------------------------------------------
  // Background pickup / fold-in poll
  // ---------------------------------------------------------------------------
  const pollLastMessageId = active?.messages[active.messages.length - 1]?.id;
  const activeId = active?.id ?? null;
  const pollLastMessageCount = active?.messages.length ?? 0;
  // The pickup gate collapses `active` into scalars so the poll effect below
  // never references the object itself: listing `active` would tear down and
  // restart the poll on every streamed fold-in (each tick folds a snapshot
  // into the transcript, which changes the object identity mid-run).
  const pollNeedsPickup = Boolean(active && (lastMessageIsUnanswered(active) || lastMessageIsStreaming(active)));
  useEffect(() => {
    // Poll while the newest turn is unfinished: the last message is either the
    // user's (server still answering) or a streaming assistant snapshot from a
    // run that outlived the panel. Once a complete assistant reply arrives,
    // fold it in and stop.
    if (demoMode || streaming || !activeId || !pollNeedsPickup) return;
    const targetId = activeId;
    const pendingLastId = pollLastMessageId;
    if (!pendingLastId) return;
    // A pickup the user stopped (see stopGhostRun) is abandoned for good: the
    // run was cancelled server-side and will never complete, so without this
    // the poll would burn its whole 8-minute budget on a dead turn.
    if (abandonedPickupRef.current?.conversationId === targetId
      && abandonedPickupRef.current.lastMessageId === pendingLastId) return;
    let stopped = false;
    let attempts = 0;
    // The message count of the last snapshot: a growing transcript is a live
    // signal that the server run is still progressing.
    let lastSeenCount = pollLastMessageCount;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // While polling, the conversation is being picked up without a local
    // session; surface the pickup affordances (thinking row / stop).
    setGhostConversationId(targetId);
    const tick = async () => {
      if (stopped) return;
      // The user may have stopped the pickup while a tick was scheduled or
      // in flight; abandon it (the cancelled run can never complete).
      if (abandonedPickupRef.current?.conversationId === targetId
        && abandonedPickupRef.current.lastMessageId === pendingLastId) return;
      attempts += 1;
      try {
        const fresh = await api.agentConversation(targetId);
        if (stopped) return;
        const freshLast = fresh.messages[fresh.messages.length - 1];
        // A terminal state folds in and ends the poll: the turn either
        // completed, or the server ended it with a persisted error row (which
        // no longer has anything to wait for).
        if (freshLast && freshLast.role === "assistant" && (freshLast.state === "complete" || freshLast.state === "error")) {
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          const pending = sessionStreamsRef.current.get(targetId);
          const live = Boolean(pending && !pending.done);
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? keepAheadTranscript(current, next, live)
            : current);
          setGhostConversationId((current) => (current === targetId ? null : current));
          void refreshConversations(conversationSearch);
          return;
        }
        if (freshLast && freshLast.role === "assistant" && freshLast.state === "streaming") {
          // The in-flight reply gained content since the last read; refresh the
          // live snapshot while continuing to poll for its completion.
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          const pending = sessionStreamsRef.current.get(targetId);
          const live = Boolean(pending && !pending.done);
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? keepAheadTranscript(current, next, live)
            : current);
        }
        // Renew the poll budget while the turn is visibly still alive on the
        // server (a streaming row, or the transcript growing). A long
        // multi-tool turn or one waiting on a desktop confirmation can exceed
        // the initial budget; it must still be folded in on completion. Only a
        // completely silent transcript burns the budget down.
        if (freshLast && freshLast.state === "streaming") {
          attempts = 0;
        } else if (fresh.messages.length > lastSeenCount) {
          attempts = 0;
          lastSeenCount = fresh.messages.length;
        }
      } catch {
        // Transient failure — keep polling until the attempt budget runs out.
      }
      if (attempts < 240) {
        timer = setTimeout(() => void tick(), 2_000);
      } else {
        // The budget ran out while the server stayed silent: the pickup is
        // dead, so drop its affordances instead of leaving a ghost row, and
        // record the abandonment so re-entering the conversation cannot arm
        // the poll for the same dead turn again.
        setGhostConversationId((current) => (current === targetId ? null : current));
        abandonedPickupRef.current = { conversationId: targetId, lastMessageId: pendingLastId };
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      setGhostConversationId((current) => (current === targetId ? null : current));
    };
  }, [activeId, pollNeedsPickup, pollLastMessageId, pollLastMessageCount, conversationSearch, demoMode, refreshConversations, streaming, setActive]);

  // ---------------------------------------------------------------------------
  // Replay a background session on re-entry
  // ---------------------------------------------------------------------------
  const replayBackgroundSession = useCallback((session: SessionStream, conversationView: AgentConversation) => {
    const messages = conversationView.messages;
    // Only a streaming assistant row *after the last user message* can belong to
    // the current run: an interrupted run's inFlight row sits before that user
    // message and must never be adopted, or the new deltas graft onto it.
    const lastUserIndex = messages.reduce((acc, message, i) => (message.role === "user" ? i : acc), -1);
    const liveIndex = messages.findIndex((message, i) => i > lastUserIndex && message.role === "assistant" && message.state === "streaming");
    // A reply the server already sealed (its snapshot row is terminal) must not
    // get a second row: the server may still hold the SSE open, so the client
    // session can outlive the server's inFlight row. With no live streaming row
    // the server's terminal row is authoritative, and a rebuild risks grafting a
    // stale streaming copy on top.
    const sealedAfterLastUser = messages.some((message, i) => i > lastUserIndex && message.role === "assistant");
    let next = messages;
    if (session.events.length === 0) {
      // No deltas have arrived yet. Adopt the server's inFlight streaming row
      // if present (its id becomes the live row id); otherwise — unless the
      // server already sealed the reply — seed an empty live row so the first
      // deltas have a target instead of being dropped.
      if (liveIndex !== -1) {
        session.assistantMessageId = messages[liveIndex].id;
      } else if (!sealedAfterLastUser) {
        next = [
          ...messages,
          {
            id: session.assistantMessageId,
            role: "assistant",
            content: "",
            createdAt: currentTime(),
            state: "streaming",
            citations: [],
            toolActivities: [],
          },
        ];
      }
    } else {
      // The client buffer holds the full event sequence and is authoritative.
      // Rebuild the assistant row from scratch and replace any server inFlight
      // row (different id) in place so no duplicate reply appears.
      const base: AgentMessage = {
        id: session.assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: currentTime(),
        state: "streaming",
        citations: [],
        toolActivities: [],
      };
      let rebuilt = base;
      for (const event of session.events) rebuilt = messageWithEvent(rebuilt, event);
      next = liveIndex !== -1
        ? messages.map((message, i) => (i === liveIndex ? rebuilt : message))
        : sealedAfterLastUser
          ? messages
          : [...messages, rebuilt];
    }
    setActive({ ...conversationView, messages: next });
    // Only a replay that ended up with an actual streaming target is a live
    // run; a sealed reply must not arm affordances readers can't act on (spinner,
    // stop, blocks), and its last status is stale by definition — memory
    // suggestions are durable and stay.
    const hasLiveTarget = next.some((message, i) => i > lastUserIndex && message.role === "assistant" && message.state === "streaming");
    if (!session.done && hasLiveTarget) {
      setStreaming(true);
      if (session.status) setStreamStatus(session.status);
    }
    if (session.suggestions.length > 0) {
      setPendingMemorySuggestions((items) => {
        const merged = [...items];
        for (const suggestion of session.suggestions) if (!merged.includes(suggestion)) merged.push(suggestion);
        return merged;
      });
    }
  }, [setActive, setPendingMemorySuggestions]);

  // ---------------------------------------------------------------------------
  // stopStreaming / stopGhostRun
  // ---------------------------------------------------------------------------
  const stopStreaming = useCallback(() => {
    const conversationId = active?.id;
    if (!conversationId) return;
    const session = sessionStreamsRef.current.get(conversationId);
    // The on-screen conversation may be mid-run (user pressed stop) or have no
    // run at all. Cancel through the session's own controller so a background
    // run from another conversation can never be stopped by mistake.
    if (session) {
      session.controller.abort();
      // The run is over from the user's point of view: the server row is now
      // authoritative, so a late snapshot must win over the buffered text.
      session.done = true;
      void api.cancelAgentRun(session.conversationId).catch(() => undefined);
      // Drop the affordances now rather than waiting for the aborted fetch to
      // unwind: the button the user just pressed must not stay armed for the
      // round-trip, and the run's teardown becomes a no-op once it is unbound.
      setStreaming(false);
      setStreamStatus(null);
    }
  }, [active?.id]);

  const stopGhostRun = useCallback(() => {
    const conversationId = ghostConversationId;
    if (!conversationId) return;
    void api.cancelAgentRun(conversationId).catch(() => undefined);
    // Abandon the pickup for this last message: the cancelled run never
    // persists a completed turn, so the transcript stays at the last user
    // message (same as an interrupted turn after a stop), and the poll must
    // not keep waiting on a turn that can never complete.
    if (active?.id === conversationId && pollLastMessageId) {
      abandonedPickupRef.current = { conversationId, lastMessageId: pollLastMessageId };
    }
    setGhostConversationId((current) => (current === conversationId ? null : current));
  }, [ghostConversationId, active?.id, pollLastMessageId]);

  // Interrupt-to-send: sending a new message folds a live reply to
  // "interrupted" and cancels that run (via its own controller, not the shared
  // abortRef) first. Only the on-screen conversation is affected.
  const prepareInterruptToSend = useCallback(() => {
    const activeSession = sessionStreamsRef.current.get(active?.id ?? "");
    if (activeSession && !activeSession.done) {
      const interruptLabel = getT()("agent.interrupted");
      activeSession.controller.abort();
      void api.cancelAgentRun(activeSession.conversationId).catch(() => undefined);
      setActive((current) => current ? {
        ...current,
        messages: current.messages.map((message) =>
          message.role === "assistant" && message.state === "streaming" ? interruptAssistantMessage(message, interruptLabel) : message,
        ),
      } : current);
      activeSession.done = true;
      // The superseded run must not hold the shared streaming flag: its own
      // teardown will see it is no longer the bound run and skip clearing it,
      // so clear here (the new run re-sets it once it starts).
      setStreaming(false);
      setStreamStatus(null);
    }
    // A run being picked up after the panel reopened has no local session to
    // interrupt. Sending a new message must still cancel it server-side,
    // otherwise the new stream races the old run and lands in the CONFLICT
    // retry window (the 5×400ms busy pause).
    if (!activeSession && ghostConversationId === active?.id) {
      void api.cancelAgentRun(ghostConversationId).catch(() => undefined);
      setGhostConversationId(null);
    }
  }, [active?.id, ghostConversationId, getT, setActive]);

  // ---------------------------------------------------------------------------
  // Session navigation primitives (component-side session-buffer access)
  // ---------------------------------------------------------------------------
  // True when a conversation hosts a live (undone, un-aborted) session buffer.
  const hasLiveRun = useCallback((conversationId: string) => {
    const session = sessionStreamsRef.current.get(conversationId);
    return !!session && !session.done && !session.controller.signal.aborted;
  }, []);

  const getSession = useCallback((conversationId: string) => {
    return sessionStreamsRef.current.get(conversationId);
  }, []);

  // Drops pending frame-batched deltas (switch / new run). CONFLICT retries keep
  // this drop: a rejected attempt's deltas belong to a run that never happened.
  const clearPendingFlush = useCallback(() => {
    cancelStreamFlush();
    pendingStreamPiecesRef.current = [];
  }, [cancelStreamFlush]);

  // A switch drains instead of dropping: the queued tail paints onto the
  // outgoing transcript in one pass before the view swaps, and the drain resets
  // the pacing window so the next paced flush cannot inherit a stale dt.
  const drainPendingFlush = useCallback(() => {
    cancelStreamFlush();
    applyStreamPieces(true);
  }, [applyStreamPieces, cancelStreamFlush]);

  // Consumes (and clears) a cached background-run failure for a conversation.
  const takeBackgroundError = useCallback((conversationId: string) => {
    const stored = backgroundErrorRef.current.get(conversationId);
    if (stored) backgroundErrorRef.current.delete(conversationId);
    return stored;
  }, []);

  // Drops the streaming / status affordances when leaving a live conversation
  // (the run keeps streaming in the background; re-entry replays and restores).
  const clearLiveRunIndicators = useCallback(() => {
    if (active?.id && sessionStreamsRef.current.has(active.id)) {
      setStreaming(false);
      setStreamStatus(null);
    }
  }, [active?.id]);

  // Restores the streaming / status affordances for a still-running
  // conversation on re-entry (used when an action abandoned a cleared UI).
  const restoreLiveRunIndicators = useCallback((conversationId: string) => {
    const session = sessionStreamsRef.current.get(conversationId);
    if (session && !session.done) {
      setStreaming(true);
      if (session.status) setStreamStatus(session.status);
    }
  }, []);

  // Detaches and returns a conversation's session buffer, aborting it and
  // cancelling the server run. A cached failure is cleared unconditionally so
  // it cannot outlive a deleted conversation even with no session bound.
  const terminateSession = useCallback((conversationId: string) => {
    const session = sessionStreamsRef.current.get(conversationId);
    if (session) {
      session.controller.abort();
      void api.cancelAgentRun(conversationId).catch(() => undefined);
      // Delete only the session this call captured: if a newer run rebound the
      // slot (a re-send while a delete was in flight), wiping it would strand
      // that run and freeze its streaming flag.
      if (sessionStreamsRef.current.get(conversationId)?.controller === session.controller) {
        sessionStreamsRef.current.delete(conversationId);
      }
    }
    backgroundErrorRef.current.delete(conversationId);
    return session;
  }, []);

  // ---------------------------------------------------------------------------
  // runStream: the run-driving entry point
  // ---------------------------------------------------------------------------
  const runStream = useCallback(async ({
    conversation,
    assistantMessage,
    streamPayload,
  }: {
    conversation: AgentConversation;
    assistantMessage: Pick<AgentMessage, "id">;
    streamPayload: Parameters<typeof api.streamAgentMessage>[1];
  }) => {
    const t = getT();
    const streamSession: SessionStream = {
      conversationId: conversation.id,
      assistantMessageId: assistantMessage.id,
      controller: new AbortController(),
      events: [],
      status: null,
      suggestions: [],
      done: false,
    };
    const controller = streamSession.controller;
    // The run is live from this moment: raise the streaming affordance so the
    // composer disables and the stop affordance appears. (Pre-extraction this
    // sat in sendMessage; it belongs to the run lifecycle.)
    setStreaming(true);
    setStreamStatus(null);
    // A run may already be bound to this slot — the interrupt path above covers
    // the visible case, but a concurrent send or one whose teardown is still
    // unwinding can arrive here with a live session in place. The rebind
    // silences the old run, so fold its assistant row now; otherwise that row
    // never gets a terminal event and lingers as a spinning placeholder.
    const prior = sessionStreamsRef.current.get(conversation.id);
    if (prior && !prior.done) {
      prior.controller.abort();
      // Aborting the socket only stops delivery — the server's run unwinds to
      // completion and keeps claiming the conversation's active-run slot, so
      // cancel it server-side like every other supersede path does.
      void api.cancelAgentRun(prior.conversationId).catch(() => undefined);
      setActive((current) => current && current.id === conversation.id
        ? {
          ...current,
          messages: current.messages.map((message) =>
            message.id === prior.assistantMessageId && message.state === "streaming"
              ? interruptAssistantMessage(message, t("agent.interrupted"))
              : message,
          ),
        }
        : current);
    }
    sessionStreamsRef.current.set(conversation.id, streamSession);
    syncBackgroundRuns();
    // A new run must not inherit frame-batched deltas of an interrupted one,
    // and restarts the reveal pacing from its floor (no stale rate samples).
    cancelStreamFlush();
    pendingStreamPiecesRef.current = [];
    const pacing = streamPacingRef.current;
    pacing.arrivals = [];
    pacing.value = STREAM_REVEAL.rateMin;
    pacing.lastTick = performance.now();
    // A new run supersedes any previously cached background failure for this
    // conversation; its outcome (successful or a fresh error) replaces it.
    backgroundErrorRef.current.delete(conversation.id);
    // A still-unwinding previous run can briefly reject the new stream with
    // CONFLICT; retry a few times (swallowing it and its trailing events).
    let conflictRetries = 0;
    const MAX_CONFLICT_RETRIES = 5;
    // Set when this run ends in an error terminal. The failure row must stay
    // visible for retry, so the success cleanup below must not fold it away.
    let turnFailed = false;
    try {
      for (;;) {
        let conflictRetry = false;
        await api.streamAgentMessage(conversation.id, streamPayload, (event) => {
          // A cancelled run may still emit buffered events as it unwinds. They
          // belong to a superseded run and must not touch the current one.
          if (!isCurrentRun()) return;
          if (event.type === "error" && event.error.code === "CONFLICT" && !controller.signal.aborted && conflictRetries < MAX_CONFLICT_RETRIES) {
            conflictRetry = true;
            return;
          }
          // Once this attempt hit a conflict, drop the rest of its events
          // (including the trailing completed/error) so the assistant message
          // is not wrongly marked; the retry below restarts cleanly.
          if (conflictRetry) return;
          if (event.type === "error") turnFailed = true;
          if (event.type === "completed" && event.reason === "error") turnFailed = true;
          enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, event, event.type === "completed" || event.type === "error");
        }, controller.signal);
        if (!conflictRetry) break;
        if (controller.signal.aborted) return;
        conflictRetries += 1;
        // The rejected attempt may already have buffered deltas; they belong to
        // a run that never happened and would graft onto the retry's reply.
        clearPendingFlush();
        // Only surface the busy notice if the waiting run is the one on screen.
        if (activeIdRef.current === conversation.id) setStreamStatus(t("agent.error.streamBusy"));
        // Give the superseded run time to release the conversation on the server.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        // An abort may have raced with the retry delay; do not restart a stream
        // that is no longer wanted.
        if (controller.signal.aborted) return;
      }
      // A successful turn clears stale failure rows — the one the retry
      // targeted and any others left behind — so the transcript stops showing
      // outdated errors. A run that itself failed keeps its row for the retry.
      // Only touch the transcript when it is the one on screen; a run that
      // finished in the background cleans up its own view on re-entry. Run
      // identity matters as much as conversation identity: a superseded run
      // must not clear rows belonging to the run that replaced it.
      if (!turnFailed && activeIdRef.current === conversation.id && isCurrentRun()) {
        setActive((current) => current ? {
          ...current,
          messages: current.messages
            .filter((item) => !(item.error && item.content === ""))
            .map((item) => (item.error ? { ...item, error: undefined } : item)),
        } : current);
      }
      await refreshConversations(conversationSearch);
    } catch (error) {
      if (!isCurrentRun()) return;
      if (controller.signal.aborted) {
        enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, { type: "completed", reason: "cancelled" }, true);
      } else {
        const code = error instanceof ApiError ? error.code ?? "agent_request_failed" : "agent_request_failed";
        const message = code === "agent_stream_unavailable"
          ? t("agent.error.streamUnavailable")
          : code === "agent_stream_invalid"
            ? t("agent.error.streamInvalid")
            : error instanceof Error ? error.message : t("agent.error.stream");
        enqueueStreamPiece(conversation.id, streamSession.assistantMessageId, { type: "error", error: { code, message, retryable: true } }, true);
      }
    } finally {
      // Only the latest run may clear shared run state, and a background-
      // completed run clears nothing: the flag belongs to whatever is on screen.
      if (isCurrentRun()) {
        if (abortRef.current === controller) abortRef.current = null;
        if (activeIdRef.current === conversation.id) {
          setStreaming(false);
          setStreamStatus(null);
        }
      }
      // Remove this run's session once it ends: re-entry renders the persisted
      // transcript, so the client buffer is no longer needed. Guarded by
      // controller identity so an interrupt-to-send cannot be wiped by the old
      // run's teardown.
      const ended = sessionStreamsRef.current.get(conversation.id);
      if (ended && ended.controller === controller) sessionStreamsRef.current.delete(conversation.id);
      syncBackgroundRuns();
    }
    function isCurrentRun() {
      const bound = sessionStreamsRef.current.get(conversation.id);
      return bound !== undefined && bound.controller === controller;
    }
  }, [activeIdRef, cancelStreamFlush, clearPendingFlush, conversationSearch, enqueueStreamPiece, getT, refreshConversations, setActive, syncBackgroundRuns]);

  // The session buffers and run controls exposed to the component.
  return useMemo(() => ({
    streaming,
    streamStatus,
    ghostConversationId,
    backgroundRunIds,
    syncBackgroundRuns,
    hasLiveRun,
    getSession,
    clearPendingFlush,
    drainPendingFlush,
    takeBackgroundError,
    clearLiveRunIndicators,
    restoreLiveRunIndicators,
    terminateSession,
    replayBackgroundSession,
    stopStreaming,
    stopGhostRun,
    prepareInterruptToSend,
    runStream,
  }), [
    streaming,
    streamStatus,
    ghostConversationId,
    backgroundRunIds,
    syncBackgroundRuns,
    hasLiveRun,
    getSession,
    clearPendingFlush,
    drainPendingFlush,
    takeBackgroundError,
    clearLiveRunIndicators,
    restoreLiveRunIndicators,
    terminateSession,
    replayBackgroundSession,
    stopStreaming,
    stopGhostRun,
    prepareInterruptToSend,
    runStream,
  ]);
}