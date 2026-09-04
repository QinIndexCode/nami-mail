/**
 * useAgentSession: the streaming conversation state machine lifted out of
 * AgentWorkspace.tsx. Owns everything about a run's lifecycle that is
 * independent of the surrounding UI:
 *
 *  - streaming / streamStatus / ghostConversationId / backgroundRunIds flags
 *  - the per-conversation session buffer (sessionStreamsRef) and replay on
 *    re-entry (replayBackgroundSession)
 *  - the frame-batched reveal-pacing pipeline (pendingStreamPieces / rAF /
 *    pacing) that folds text/tool/citation deltas onto the active transcript
 *  - the background-run pickup/fold-in poll
 *  - cancel/stop affordances (stopStreaming / stopGhostRun) and the
 *    interrupt-to-send path (prepareInterruptToSend)
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
 * Design constraints:
 *  - Behaviour is identical to the pre-extraction code; this is a structural
 *    lift, no semantics change.
 *  - No new runtime dependency; plain React hooks + AbortController.
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
 * A run that may outlive the conversation currently being viewed. When the user
 * switches away mid-reply, the run keeps streaming into this buffer instead of
 * touching the UI (rendering to a transcript nobody is looking at). Re-entering
 * the conversation replays the buffered events so the reply appears exactly
 * where it left off — the server's `inFlight` snapshot plus the missing tail —
 * then live events resume the same row. Terminal runs are removed once the
 * server has persisted the final turn, so re-entry just renders the persisted
 * transcript.
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

/** Reveal pacing tuning (chars/sec). Kept as module constants like the source. */
const STREAM_PACING_WINDOW_MS = 800;   // arrival rate is measured over this window
const STREAM_PACING_SMOOTHING = 0.22;  // how quickly the reveal speed hunts arrival
const STREAM_PACING_MIN_RATE = 24;     // chars/sec floor: slow output still flows
const STREAM_PACING_MAX_RATE = 280;    // chars/sec ceiling: a burst stays readable

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
   * A turn that outlived the panel is being picked up: the fold-in poll is
   * watching this conversation because its newest message is a user message
   * (or a server streaming snapshot) with no local session attached. While set,
   * the composer shows a stop affordance backed by cancelAgentRun — the usual
   * in-session interrupt cannot reach a run without a local controller.
   */
  const [ghostConversationId, setGhostConversationId] = useState<string | null>(null);
  const [backgroundRunIds, setBackgroundRunIds] = useState<ReadonlySet<string>>(() => new Set());

  // ---------------------------------------------------------------------------
  // Run bookkeeping refs
  // ---------------------------------------------------------------------------
  const abortRef = useRef<AbortController | null>(null);
  // Conversations with a live run streaming in the background (not the one on
  // screen); drives the sidebar spinner so a run the user left keeps being
  // visible elsewhere.
  // Failures of background runs (the user left the conversation while it ran).
  // The server persists most failure turns itself, but requests rejected before
  // any record is written (scope/slash validation, transport failure, an
  // exhausted CONFLICT retry) leave the conversation with neither a row nor an
  // error — re-entry would silently show a bare user message. Keyed by
  // conversation, consumed (and cleared) once re-surfaced in the view.
  const backgroundErrorRef = useRef(new Map<string, { code: string; message: string; retryable?: boolean }>());
  // A pickup the user explicitly abandoned (stop) is recorded so the poll can
  // never re-arm for the same last message: the server run was cancelled and
  // can never complete. Recording the message id keeps a fresh turn (a new
  // last message) on an independent poll.
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
  }>({ lastTick: performance.now(), value: STREAM_PACING_MIN_RATE, arrivals: [] });

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
  // Arm the next frame-batched flush pass. While the window is visible it runs
  // on requestAnimationFrame so it batches with paints; while the window is
  // hidden rAF may stop firing entirely on some platforms, which would let a
  // long background stream pile an unbounded backlog that all flushes at once
  // on restore. Falling back to a bounded setTimeout keeps the hidden backlog
  // draining at a fixed pace, so restoring never hits a giant flush. The active
  // id lives in whichever ref matches the path taken; every cancellation point
  // clears both so a stale id can never fire into the wrong context.
  const armStreamFlush = useCallback(() => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    if (streamHiddenTimerRef.current !== null) {
      window.clearTimeout(streamHiddenTimerRef.current);
      streamHiddenTimerRef.current = null;
    }
    if (document.hidden) {
      streamHiddenTimerRef.current = window.setTimeout(flushPendingStreamPiecesRef.current, 250);
    } else {
      streamRafRef.current = requestAnimationFrame(flushPendingStreamPiecesRef.current);
    }
  }, []);

  const flushPendingStreamPieces = useCallback(() => {
    streamRafRef.current = null;
    streamHiddenTimerRef.current = null;
    const queue = pendingStreamPiecesRef.current;
    if (queue.length === 0) return;
    pendingStreamPiecesRef.current = [];
    // A terminal event ends the run: absolutely nothing else is coming, so the
    // stream is flushed completely this frame (ignoring the pacing). This is
    // what lets the assistant row reach its final state immediately. Without it
    // a pacing tail keeps trickling in after completion, the message stays
    // "streaming", the pickup poll re-arms and races the rAF flush with a server
    // snapshot — the transcript flash / sidebar blink we guard against.
    const hasTerminal = queue.some((piece) => piece.event.type === "completed" || piece.event.type === "error");
    // Measure the model's arrival rate over a sliding window and let the reveal
    // speed follow it (smoothing keeps a speed change gradual rather than a jump).
    const pacing = streamPacingRef.current;
    const now = performance.now();
    const dt = Math.min(now - pacing.lastTick, 250);
    pacing.lastTick = now;
    const cutoff = now - STREAM_PACING_WINDOW_MS;
    while (pacing.arrivals.length > 0 && pacing.arrivals[0].t < cutoff) pacing.arrivals.shift();
    let windowChars = 0;
    for (const arrival of pacing.arrivals) windowChars += arrival.c;
    const arrivalRate = windowChars / (STREAM_PACING_WINDOW_MS / 1000);
    const targetRate = Math.min(STREAM_PACING_MAX_RATE, Math.max(arrivalRate, STREAM_PACING_MIN_RATE));
    pacing.value += (targetRate - pacing.value) * STREAM_PACING_SMOOTHING;
    // Consume text_delta only within this frame's reveal budget unless the run
    // has ended; anything beyond it stays queued and drains on later frames.
    let consumed = 0;
    let charBudget = hasTerminal ? Number.POSITIVE_INFINITY : Math.max((pacing.value * dt) / 1000, 1);
    while (consumed < queue.length) {
      const piece = queue[consumed]!;
      if (piece.event.type === "text_delta") {
        const length = piece.event.delta.length;
        // The front piece must always render, even when it alone exceeds the
        // budget: fast models can emit a whole word/sentence in a single delta,
        // and blocking it would starve the stream (a permanent freeze). We only
        // stop once the budget is genuinely spent and at least one piece has
        // already been consumed, which keeps the smooth paced read for steady
        // small-token output while never deadlocking on an oversized token.
        if (length > charBudget && consumed > 0) break;
        charBudget -= length;
      }
      consumed += 1;
    }
    const pieces = queue.slice(0, consumed);
    const leftovers = queue.slice(consumed);
    const byId = new Map<string, AgentStreamEvent[]>();
    for (const piece of pieces) {
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
    // Drain the remaining backlog on the next frame at the same bounded pace.
    if (leftovers.length > 0) armStreamFlush();
  }, [armStreamFlush, setActive]);
  flushPendingStreamPiecesRef.current = flushPendingStreamPieces;

  // Live runs keyed by conversation, so a run the user navigated away from can
  // keep streaming into a buffer (no UI cost) and be replayed on re-entry. When
  // the run is foreground, deltas flow through the frame batching path above.
  const enqueueStreamPiece = useCallback((conversationId: string, messageId: string, event: AgentStreamEvent, flushNow = false) => {
    const session = sessionStreamsRef.current.get(conversationId);
    if (!session || session.assistantMessageId !== messageId) return;
    // A completed write-tool event means primary mail state just changed
    // server-side (e.g. the agent marked a message read). Notify the app so
    // the mail list refreshes in step with the conversation instead of
    // lagging until the next poll. Fires on the live arrival only; replays
    // re-render the buffered row but do not re-notify.
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
        if (streamRafRef.current !== null) {
          cancelAnimationFrame(streamRafRef.current);
          streamRafRef.current = null;
        }
        if (streamHiddenTimerRef.current !== null) {
          window.clearTimeout(streamHiddenTimerRef.current);
          streamHiddenTimerRef.current = null;
        }
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
  }, [activeIdRef, armStreamFlush, flushPendingStreamPieces, setActive, setConversations, setPendingMemorySuggestions]);

  // Close the panel is a "leave", not a "cancel". Drop every local stream (the
  // fetch rejection aborts the SSE, which on the server only stops event
  // delivery — the run keeps draining and persists the completed turn, per the
  // /messages route contract). We must NOT call cancelAgentRun here: that aborts
  // the server run and its finally skips persisting the assistant row, so
  // reopening shows just the orphaned user message with no reply and no tool
  // calls. The completed reply is instead picked up on reopen by the poll.
  useEffect(() => {
    const streamsRef = sessionStreamsRef;
    return () => {
      for (const session of streamsRef.current.values()) {
        session.controller.abort();
      }
      if (streamRafRef.current !== null) cancelAnimationFrame(streamRafRef.current);
      if (streamHiddenTimerRef.current !== null) {
        window.clearTimeout(streamHiddenTimerRef.current);
        streamHiddenTimerRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Background pickup / fold-in poll
  // ---------------------------------------------------------------------------
  const pollLastMessageId = active?.messages[active.messages.length - 1]?.id;
  useEffect(() => {
    // Poll while the newest turn is unfinished: the last message is either the
    // user's (server still answering) or a streaming assistant snapshot from a
    // run that outlived the panel. Once a complete assistant reply arrives,
    // fold it in and stop.
    if (demoMode || streaming || !active || (!lastMessageIsUnanswered(active) && !lastMessageIsStreaming(active))) return;
    const targetId = active.id;
    const pendingLastId = active.messages[active.messages.length - 1].id;
    // A pickup the user stopped (see stopGhostRun) is abandoned for good: the
    // run was cancelled server-side and will never complete, so without this
    // the poll would burn its whole 8-minute budget on a dead turn.
    if (abandonedPickupRef.current?.conversationId === targetId
      && abandonedPickupRef.current.lastMessageId === pendingLastId) return;
    let stopped = false;
    let attempts = 0;
    // The message count of the last snapshot: a growing transcript is a live
    // signal that the server run is still progressing.
    let lastSeenCount = active.messages.length;
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
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? next
            : current);
          setGhostConversationId((current) => (current === targetId ? null : current));
          void refreshConversations(conversationSearch);
          return;
        }
        if (freshLast && freshLast.role === "assistant" && freshLast.state === "streaming") {
          // The in-flight reply gained content since the last read; refresh the
          // live snapshot while continuing to poll for its completion.
          const next = applyRevokedMarks(purgeStaleErrors(fresh));
          setActive((current) => current && current.id === targetId
            && current.messages[current.messages.length - 1]?.id === pendingLastId
            ? next
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
  }, [active?.id, pollLastMessageId, conversationSearch, demoMode, refreshConversations, streaming, setActive]);

  // ---------------------------------------------------------------------------
  // Replay a background session on re-entry
  // ---------------------------------------------------------------------------
  const replayBackgroundSession = useCallback((session: SessionStream, conversationView: AgentConversation) => {
    const messages = conversationView.messages;
    // Only a streaming assistant row *after the last user message* can
    // belong to the current run: an interrupted previous run's inFlight row
    // sits before that user message and must never be adopted or replaced,
    // or the new run's deltas would graft onto the old partial reply.
    const lastUserIndex = messages.reduce((acc, message, i) => (message.role === "user" ? i : acc), -1);
    const liveIndex = messages.findIndex((message, i) => i > lastUserIndex && message.role === "assistant" && message.state === "streaming");
    // A reply the server already sealed (its snapshot row is terminal) must
    // not get a second row: the server may still hold the SSE open (e.g. the
    // title bump after `completed`), so by the time the user returns the
    // client session can outlive the server's inFlight row. When no live
    // streaming row exists, the server's terminal row is authoritative and
    // any client-side rebuild risks grafting a stale streaming copy on top.
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
    // run; a sealed reply (server terminal row kept) is not, and must not arm
    // the streaming affordance readers can't act on (spinner, stop, blocks).
    // A sealed run's last status is stale by definition — only restore status
    // for a run still in flight (memory suggestions are durable and stay).
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
      void api.cancelAgentRun(session.conversationId).catch(() => undefined);
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
    if (active?.id === conversationId) {
      const last = active.messages[active.messages.length - 1];
      if (last) abandonedPickupRef.current = { conversationId, lastMessageId: last.id };
    }
    setGhostConversationId((current) => (current === conversationId ? null : current));
  }, [ghostConversationId, active?.id]);

  // Interrupt-to-send: if the current conversation hosts a live run, sending a
  // new message folds the running reply into an "interrupted" state and cancels
  // that run (via its own controller, not the shared abortRef) before the new
  // one starts. Only the on-screen conversation is affected — a run streaming
  // in the background for another conversation keeps going.
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

  // Pending frame-batched deltas belong to the outgoing transcript; drop them
  // so they can never land on a different conversation (switch / new run).
  const clearPendingFlush = useCallback(() => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    if (streamHiddenTimerRef.current !== null) {
      window.clearTimeout(streamHiddenTimerRef.current);
      streamHiddenTimerRef.current = null;
    }
    pendingStreamPiecesRef.current = [];
  }, []);

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
    // The run is now live from this moment: raise the streaming affordance so
    // the composer disables and the stop affordance appears. (The pre-extraction
    // code did this in sendMessage before starting the pipeline; it belongs to
    // the run lifecycle, so it lives here in the hook.)
    setStreaming(true);
    setStreamStatus(null);
    // A run may already be bound to this conversation slot — the interrupt path
    // above covers the visible case, but a concurrent send (double-send through
    // the creation lock) or one whose teardown is still unwinding can arrive
    // here with a live session still in place. The slot rebind silences the old
    // run, so fold its assistant row now; otherwise its earlier transcript row
    // never gets a terminal event and lingers as a spinning placeholder with no
    // self-healing path.
    const prior = sessionStreamsRef.current.get(conversation.id);
    if (prior && !prior.done) {
      prior.controller.abort();
      // Aborting the socket only stops delivery — the server's run unwinds to
      // completion and keeps claiming the conversation's active-run slot
      // (tokens keep burning, and the new stream below would eat CONFLICTs).
      // Cancel the server-side run like every other supersede path does.
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
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    if (streamHiddenTimerRef.current !== null) {
      window.clearTimeout(streamHiddenTimerRef.current);
      streamHiddenTimerRef.current = null;
    }
    pendingStreamPiecesRef.current = [];
    const pacing = streamPacingRef.current;
    pacing.arrivals = [];
    pacing.value = STREAM_PACING_MIN_RATE;
    pacing.lastTick = performance.now();
    // A new run supersedes any previously cached background failure for this
    // conversation; its outcome (successful or a fresh error) replaces it.
    backgroundErrorRef.current.delete(conversation.id);
    // A still-unwinding previous run on the server can briefly reject the new
    // stream with CONFLICT. We retry a few times (swallowing the conflict and
    // its trailing events) until the old run finishes tearing down.
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
        // The retry pause belongs to the run that is waiting; only surface the
        // busy notice on the screen if that run is the one being viewed.
        if (activeIdRef.current === conversation.id) setStreamStatus(t("agent.error.streamBusy"));
        // Give the superseded run time to release the conversation on the server.
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        // An abort may have raced with the retry delay; do not restart a stream
        // that is no longer wanted.
        if (controller.signal.aborted) return;
      }
      // A successful turn clears stale failure rows — both the one the retry
      // targeted and any others left behind — so the transcript stops showing
      // outdated errors once the conversation moves on. A run that itself
      // failed keeps its error row for the user to retry. Only touch the
      // transcript when it is the one on screen; a run that finished in the
      // background cleans up its own view on re-entry via the server snapshot.
      if (!turnFailed && activeIdRef.current === conversation.id) {
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
      // Only the latest run may clear shared run state; a superseded run's
      // teardown must not drop the streaming flag of the run that replaced it.
      // A background-completed run clears nothing: the streaming flag belongs
      // to whatever conversation is on screen.
      if (isCurrentRun()) {
        if (abortRef.current === controller) abortRef.current = null;
        if (activeIdRef.current === conversation.id) {
          setStreaming(false);
          setStreamStatus(null);
        }
      }
      // Remove this run's session once it ends. Re-entry afterwards simply
      // renders the server-persisted transcript, so the client buffer is no
      // longer needed. Guarded by controller identity so an interrupt-to-send
      // that replaced this session cannot be wiped by the old run's teardown.
      const ended = sessionStreamsRef.current.get(conversation.id);
      if (ended && ended.controller === controller) sessionStreamsRef.current.delete(conversation.id);
      syncBackgroundRuns();
    }
    function isCurrentRun() {
      const bound = sessionStreamsRef.current.get(conversation.id);
      return bound !== undefined && bound.controller === controller;
    }
  }, [activeIdRef, conversationSearch, enqueueStreamPiece, getT, refreshConversations, setActive, syncBackgroundRuns]);

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