import type { Message } from "./types";

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
      const sorted = [...group].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
      return { key: sorted[0]!.id, messages: sorted };
    })
    .sort((a, b) => {
      const newestA = a.messages[a.messages.length - 1]!.sentAt;
      const newestB = b.messages[b.messages.length - 1]!.sentAt;
      return new Date(newestB).getTime() - new Date(newestA).getTime();
    });
}
