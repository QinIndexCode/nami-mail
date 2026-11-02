import type { Message } from "./types";
import { withSeenFlag } from "./app/mailStore";

export type ThreadGroup = {
  /** Representative message id (the earliest message in the conversation). */
  key: string;
  /** Messages in the conversation, ordered oldest to newest. */
  messages: Message[];
};

function trimmedId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Orders a conversation by sent time, oldest to newest (stable for ties). */
export function sortThreadByTimeline(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
}

/** Gmail-style conversation strip: the locally grouped members are merged
 *  with the server-resolved thread (which adds members stored outside the
 *  currently loaded view, e.g. the user's own replies in Sent). Local state
 *  wins on id collisions so fresh flags/seen values are never stale. */
export function mergeThreadMembers(local: readonly Message[], extras: readonly Message[]): Message[] {
  if (!extras.length) return [...local];
  const known = new Set(local.map((message) => message.id));
  return [...local, ...extras.filter((message) => !known.has(message.id))];
}

/**
 * Folds the several rows one message occupies back into the single member it
 * represents. The store keeps one row per (account, mailbox, uid), so a mail
 * filed in more than one folder — the inbox plus a user label — is stored
 * twice: two ids, one RFC Message-ID, one sent time. A conversation is a set
 * of messages rather than of rows, so the reader must not draw one card per
 * folder: the strip would show two identical timestamps side by side and only
 * one of them could hold the focus state.
 *
 * Both sources feed the same duplication. The list-side grouping unions the
 * rows into one thread, and GET /api/messages/:id/thread walks every row of
 * the account, so either alone is enough to produce the pair.
 *
 * `selectedId` is the row the reader has open and it always survives, so the
 * focused card is the copy that stays rather than a lookalike of it. Rows
 * without a Message-ID carry no identity to compare and are never folded.
 */
export function collapseDuplicateMembers(members: readonly Message[], selectedId?: string | null): Message[] {
  const keptAt = new Map<string, number>();
  const kept: Message[] = [];
  for (const member of members) {
    const identity = trimmedId(member.messageId);
    const at = identity === null ? undefined : keptAt.get(identity);
    if (at === undefined) {
      if (identity !== null) keptAt.set(identity, kept.length);
      kept.push(member);
      continue;
    }
    if (kept[at]!.id !== selectedId && member.id === selectedId) kept[at] = member;
  }
  return kept;
}

/**
 * How many messages a conversation holds, counting the folder copies of one
 * message once. Same root cause as `collapseDuplicateMembers`, read instead of
 * folded: the list badge wants the number, not the members, and it recomputes
 * it for every visible row on every scroll frame, so this walks the members
 * without building the folded array.
 *
 * Identity is the RFC Message-ID, exactly as when folding; a row without one
 * has nothing to compare and counts as its own message. An absent or empty
 * thread still means the row itself, so the answer is never 0.
 */
export function countThreadMessages(members: readonly Message[] | null | undefined): number {
  if (!members || members.length === 0) return 1;
  const identities = new Set<string>();
  for (const member of members) {
    identities.add(trimmedId(member.messageId) ?? member.id);
  }
  return identities.size;
}

export type ThreadSnapshot = {
  anchorId: string;
  members: Message[];
};

/**
 * Folds a freshly fetched server thread into the previous snapshot without
 * dropping members. The reader may currently be showing a member that only
 * the previous snapshot contained, so a refetch of the same conversation
 * unions (fresh server values win on collisions) while a fetch for a
 * different conversation replaces wholesale.
 */
export function mergeThreadSnapshot(previous: ThreadSnapshot | null, next: ThreadSnapshot): ThreadSnapshot {
  if (!previous) return next;
  const nextIds = new Set(next.members.map((message) => message.id));
  const sameConversation = previous.members.some((message) => nextIds.has(message.id));
  if (!sameConversation) return next;
  const previousById = new Map(previous.members.map((message) => [message.id, message]));
  const known = new Set(next.members.map((message) => message.id));
  return {
    anchorId: next.anchorId,
    members: [
      ...next.members.map((nextMember) => {
        const prev = previousById.get(nextMember.id);
        if (!prev) return nextMember;
        return {
          ...nextMember,
          htmlBody: nextMember.htmlBody !== undefined ? nextMember.htmlBody : prev.htmlBody,
          textBody: nextMember.htmlBody !== undefined ? nextMember.textBody : (prev.textBody ?? nextMember.textBody),
        };
      }),
      ...previous.members.filter((message) => !known.has(message.id)),
    ],
  };
}

/**
 * Applies a local read/unread change to the thread snapshot and the strip's
 * retained membership map. A member outside the loaded list lives only in
 * those two places, so neither the store's optimistic write nor its later
 * rollback reaches it; without this the open message would keep showing its
 * old unread dot until the thread was fetched again.
 *
 * The strip map is a ref, so replacing it is not a render. `changed` reports
 * whether the target was found so the caller can request the render that makes
 * the new value visible.
 */
export function applySeenToThread(
  extras: ThreadSnapshot | null,
  strip: ReadonlyMap<string, Message>,
  messageId: string,
  seen: boolean,
): { extras: ThreadSnapshot | null; strip: Map<string, Message>; changed: boolean } {
  let changed = false;
  const update = (member: Message): Message => {
    if (member.id !== messageId) return member;
    changed = true;
    return withSeenFlag(member, seen);
  };
  const extrasHasTarget = extras?.members.some((member) => member.id === messageId) ?? false;
  const nextExtras = extrasHasTarget && extras
    ? { ...extras, members: extras.members.map(update) }
    : extras;
  const nextStrip = new Map([...strip].map(([id, member]) => [id, update(member)] as const));
  return { extras: nextExtras, strip: nextStrip, changed };
}

/** Whether the thread strip should render collapsed: only long conversations,
 *  and only while the open message sits at an endpoint of the timeline, so
 *  collapsing never hides the message being read. */
export function shouldCollapseThread(messages: readonly Message[] | null, selectedId: string, pref: boolean): boolean {
  if (!messages || messages.length <= 4 || !pref) return false;
  const first = messages[0]!.id;
  const last = messages[messages.length - 1]!.id;
  return selectedId === first || selectedId === last;
}

/**
 * Groups messages into conversations. Messages connected by RFC reference
 * chains (messageId / inReplyTo / references) are unioned first, which also
 * lets a reply in one account join its original in another. Messages that
 * carry no threading headers at all fall back to a normalized-subject match
 * within the same account, mirroring how common mail clients surface threads.
 */
export function groupMessagesByThread(messages: readonly Message[]): ThreadGroup[] {
  const count = messages.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const byMessageId = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const id = trimmedId(messages[index]!.messageId);
    if (id && !byMessageId.has(id)) byMessageId.set(id, index);
  }

  for (let index = 0; index < count; index += 1) {
    const message = messages[index]!;
    const seen = new Set<string>();
    for (const candidate of [...(message.references ?? []), message.inReplyTo, message.messageId]) {
      const id = trimmedId(candidate);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const match = byMessageId.get(id);
      if (match !== undefined && match !== index) union(index, match);
    }
  }

  const subjectGroup = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const message = messages[index]!;
    const hasThreadingHeaders = Boolean(
      trimmedId(message.messageId)
      || trimmedId(message.inReplyTo)
      || (message.references?.length ?? 0) > 0,
    );
    if (hasThreadingHeaders) continue;
    const subject = normalizedSubject(message.subject);
    if (!subject) continue;
    const key = `${message.accountId}\u001f${subject}`;
    const match = subjectGroup.get(key);
    if (match !== undefined) union(match, index);
    else subjectGroup.set(key, index);
  }

  const groupsByRoot = new Map<number, Message[]>();
  for (let index = 0; index < count; index += 1) {
    const root = find(index);
    const group = groupsByRoot.get(root);
    if (group) group.push(messages[index]!);
    else groupsByRoot.set(root, [messages[index]!]);
  }

  return [...groupsByRoot.values()]
    .map((group) => {
      const sorted = sortThreadByTimeline(group);
      return { key: sorted[0]!.id, messages: sorted };
    })
    .sort((a, b) => {
      const newestA = a.messages[a.messages.length - 1]!.sentAt;
      const newestB = b.messages[b.messages.length - 1]!.sentAt;
      return new Date(newestB).getTime() - new Date(newestA).getTime();
    });
}
