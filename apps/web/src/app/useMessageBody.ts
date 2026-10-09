import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Message, MessageDetail } from "../types";
import type { ThreadSnapshot } from "../threads";

type MessagesSetter = (update: (items: Message[]) => Message[]) => void;
type ThreadExtrasSetter = (update: (current: ThreadSnapshot | null) => ThreadSnapshot | null) => void;

export type MessageBodyPhase = "idle" | "loading" | "loaded" | "error";

/**
 * Replaces the body-less list row with the full detail, in BOTH reader
 * sources. Flags ride on the local row: the detail response was built when
 * the request left, and a seen/star toggle the user made while it was in
 * flight is newer than anything the response carries — the same
 * local-pending-wins rule the flags patcher applies. (R10: the previous
 * whole-row replace let an older detail flip seen/flagged back.)
 */
export function mergeMessageDetail(
  detail: MessageDetail,
  setMessages: MessagesSetter,
  setThreadExtras: ThreadExtrasSetter,
): void {
  const withLocalFlags = (row: Message): Message => ({
    ...detail,
    seen: row.seen,
    flagged: row.flagged,
    // The flags ARRAY rides with the booleans: the existing local-pending
    // rule (mailListState's flag-override merge) keeps seen/flagged/flags
    // as one consistent triple, so a detail response can never half-apply
    // a toggle (flagged=true with a \Flagged-less array, or the reverse).
    flags: row.flags,
    snoozedUntil: row.snoozedUntil ?? detail.snoozedUntil,
  });
  setMessages((items) => items.map((item) => (item.id === detail.id ? withLocalFlags(item) : item)));
  setThreadExtras((current) => (current
    ? { ...current, members: current.members.map((member) => (member.id === detail.id ? withLocalFlags(member) : member)) }
    : current));
}

const ensureInFlight = new Map<string, Promise<Message | null>>();

/**
 * The action seam for reply / reply-all / forward (R10): resolves the FULL
 * message for a pinned message id before compose content is built from it —
 * a list row only carries the 4000-character preview, so quoting `selected`
 * directly could truncate the user's reply. The response is merged back
 * through {@link mergeMessageDetail} so the reader's row stays one source of
 * truth, keyed by the detail's own id so a response can never land in
 * another message's row.
 *
 * Returns the full message, or null when the detail could not be loaded —
 * the caller keeps the current mail open and surfaces a notice. A row that
 * already carries a body resolves without a request; concurrent calls for
 * the same id share one request.
 */
export function ensureFullMessage(
  isDemo: boolean,
  source: Message,
  merge: (detail: MessageDetail) => void,
): Promise<Message | null> {
  if (isDemo || source.htmlBody !== undefined) return Promise.resolve(source);
  const existing = ensureInFlight.get(source.id);
  if (existing) return existing;
  const pending = api.message(source.id)
    .then((detail) => {
      merge(detail);
      return detail;
    })
    .catch(() => null)
    .finally(() => {
      ensureInFlight.delete(source.id);
    });
  ensureInFlight.set(source.id, pending);
  return pending;
}

/**
 * Loads the body of the message the reader has open.
 *
 * A list row carries no body: `GET /api/messages` answers with a bounded text
 * preview and no HTML part, because a page that serialized every stored body
 * is what turns a few oversized messages into a frozen inbox refresh. Anything
 * that reads a body — the reader, quoting a reply, translating, editing a
 * draft — therefore needs the per-message endpoint, and the open message is the
 * only one it ever needs.
 *
 * The loaded message is merged back into the list state (and into the thread
 * snapshot, which the reader also resolves from) so every existing consumer
 * keeps reading one row: a background refresh that swaps the row for a
 * body-less one re-triggers this effect, and a message whose real body is
 * empty never loops, because a detail response always carries both body keys.
 *
 * The phase (R10) lets the reader show a loading state, an explicit failure
 * with a retry, and treats an empty-body success as loaded — a failed load
 * no longer silently leaves the reader on a preview forever.
 */
export function useMessageBody(
  isDemo: boolean,
  openMessage: Message | null,
  setMessages: MessagesSetter,
  setThreadExtras: ThreadExtrasSetter,
): { phase: MessageBodyPhase; reload: () => void } {
  const [phase, setPhase] = useState<MessageBodyPhase>("idle");
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  // The setters live behind a ref: callers pass inline closures (the test
  // harness does; App passes stable useState setters, but the hook must not
  // depend on that), and a setter identity in the deps would re-run this
  // effect on every render — each run setPhaseing again — a render loop in
  // the error state. Only the real inputs (mode, open row, retry attempt)
  // may re-trigger the load.
  const settersRef = useRef({ setMessages, setThreadExtras });
  settersRef.current = { setMessages, setThreadExtras };

  useEffect(() => {
    if (isDemo || !openMessage) {
      setPhase("idle");
      return;
    }
    if (openMessage.htmlBody !== undefined) {
      setPhase("loaded");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    void api.message(openMessage.id).then((detail) => {
      if (cancelled) return;
      mergeMessageDetail(detail, (update) => settersRef.current.setMessages(update), (update) => settersRef.current.setThreadExtras(update));
      setPhase("loaded");
    }).catch(() => {
      if (!cancelled) setPhase("error");
    });
    return () => { cancelled = true; };
  }, [isDemo, openMessage, attempt]);

  return { phase, reload };
}
