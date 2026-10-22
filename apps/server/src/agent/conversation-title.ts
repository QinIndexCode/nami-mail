/**
 * Conversation titles have one owner.
 *
 * A title is either derived locally from what the user already told us (the
 * message, a slash command, its arguments, or the referenced mail subjects),
 * or taken from the model's own answer. The model is asked to prefix its final
 * answer with one `TITLE:` line; the probe below strips that line from the
 * stream before it reaches the transcript or the UI.
 *
 * A conversation whose first message is only a greeting stays untitled: the
 * model can answer `TITLE: NONE`, and the next turn with an actual topic asks
 * again. That is why the instruction is not tied to the first turn.
 *
 * Keeping both the derivation and the model-output protocol here means the
 * title cannot accidentally become a chat reply: a missing or malformed marker
 * simply leaves the derived title in place, and there is no second provider
 * call that could generate one from unrelated context.
 */

/** Hard cap for a title as stored and as accepted from a manual rename. */
export const maximumConversationTitleLength = 120;

/** A model-written title is a label, not a sentence. Anything longer is a
 *  format violation and falls back to the derived title. */
export const maximumGeneratedTitleLength = 48;

/** A marker line longer than this is not a title; stop buffering it so a
 *  malformed reply cannot delay the visible answer indefinitely. */
const maximumTitleLineLength = 200;

/** The model writes this label when the conversation has no nameable topic
 *  yet. It is a protocol value, never a title. */
const noTitleMarker = "none";

/**
 * Added to the system prompt of any turn that runs while the conversation has
 * no title yet. It deliberately does not describe the assistant persona: the
 * observed failure was a model naming the conversation after its own greeting
 * or capability list. The line asks only for a label, says explicitly that the
 * label is not a reply, and gives the model a way out when the user has not
 * named a task or subject yet.
 */
export const conversationTitleInstruction = [
  "This conversation does not have a title yet.",
  "Begin your final answer with exactly one line of the form:",
  "TITLE: <a concise sidebar label for what the user wants, at most 24 characters, in the same language as the user's message>",
  "Name the user's task or subject as a noun phrase. Do not repeat or quote the user's wording, do not greet, and do not mention the assistant or what it can do.",
  "If the user has only greeted you, thanked you, or made small talk with no task or subject, write exactly: TITLE: NONE",
  "Then leave one blank line and write the normal answer.",
  "Output the title line only once; never explain or repeat it.",
].join(" ");

export type ConversationTitleReference = {
  subject?: string;
};

export type ConversationTitleInput = {
  content: string;
  command?: { name: string; args: string } | null;
  references?: readonly ConversationTitleReference[];
};

/**
 * Deterministic fallback title, written before the model produces anything and
 * kept when the model does not emit a usable `TITLE:` line.
 *
 * Priority:
 * 1. A command argument describes the task better than the referenced mail
 *    (`/draft quarterly report` must not be titled with the old message).
 * 2. Otherwise the referenced mail subject(s) are the most specific label.
 * 3. A command without arguments falls back to its own name.
 * 4. A plain message uses its text, unless it is only a greeting or
 *    acknowledgement. Those name no topic, so the title stays empty and the
 *    client shows its localized placeholder until a later turn has something
 *    to name.
 */
export function deriveConversationTitle(input: ConversationTitleInput): string {
  const args = input.command?.args.trim() ?? "";
  if (args) return truncateTitle(`${input.command!.name} ${args}`);

  const subjects = [...new Set((input.references ?? [])
    .map((reference) => reference.subject?.replace(/\s+/g, " ").trim() ?? "")
    .filter((subject): subject is string => subject.length > 0))]
    .slice(0, 3);
  if (subjects.length > 0) return truncateTitle(subjects.join(" · "));

  if (input.command) return truncateTitle(input.command.name);
  return isSmallTalkOnly(input.content) ? "" : truncateTitle(input.content);
}

/**
 * Whole-message small talk. The text is normalized by dropping whitespace,
 * punctuation, and symbols, so "下午好！" and "Hi there!" reduce to greeting
 * tokens; a message only counts when *every* remaining token is small talk, so
 * "你好，帮我查一下邮件" still names a task. Messages that normalize to nothing
 * (emoji or punctuation only) carry no topic either.
 */
const smallTalkTokens = [
  "你好", "您好", "你们好", "大家好", "哈喽", "嗨", "早上好", "上午好", "中午好",
  "下午好", "晚上好", "晚安", "早", "在吗", "在不在", "好久不见", "很高兴认识你",
  "辛苦了", "吃了吗", "吃了么", "最近怎么样", "好的", "好吧", "行", "嗯嗯", "嗯",
  "谢谢", "谢谢你", "感谢", "多谢", "呀", "啊", "哈", "啦", "呢",
  "greetings", "goodmorning", "goodafternoon", "goodevening", "goodnight", "goodday",
  "hellothere", "hithere", "heythere", "howareyou", "howisitgoing", "whatsup",
  "hiya", "hello", "howdy", "sup", "hey", "hi", "yo",
  "thankyou", "appreciateit", "thanks", "thx",
  "gotit", "okay", "ok", "sure", "cool", "nice", "morning", "evening",
].sort((left, right) => right.length - left.length);

function isSmallTalkOnly(content: string): boolean {
  const normalized = content.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  if (!normalized) return true;
  let rest = normalized;
  while (rest.length > 0) {
    const token = smallTalkTokens.find((candidate) => rest.startsWith(candidate));
    if (!token) return false;
    rest = rest.slice(token.length);
  }
  return true;
}

function truncateTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  return title.length <= maximumConversationTitleLength
    ? title
    : `${title.slice(0, maximumConversationTitleLength - 3).trimEnd()}...`;
}

export type ConversationTitleProbe = {
  buffer: string;
  done: boolean;
};

export type ConversationTitleProbeResult = {
  /** Text that should reach the transcript and the client. */
  text: string;
  /** Present only when the marker carried a usable title. */
  title?: string;
};

export function createConversationTitleProbe(): ConversationTitleProbe {
  return { buffer: "", done: false };
}

/**
 * Feeds one streamed text chunk through the marker probe.
 *
 * The first line of each provider round is buffered only while it could still
 * become `TITLE: ...`; ordinary text is released on the first chunk that
 * diverges from the marker. A marker line is always consumed, even when its
 * title is empty or too long, so protocol text never leaks into the answer;
 * in that case `title` is absent and the derived title remains in effect.
 */
export function feedConversationTitleProbe(
  probe: ConversationTitleProbe,
  delta: string,
): ConversationTitleProbeResult {
  if (probe.done) return { text: delta };
  probe.buffer += delta;

  const newline = probe.buffer.indexOf("\n");
  if (newline < 0) {
    if (probe.buffer.length > maximumTitleLineLength) {
      probe.done = true;
      return { text: takeBuffer(probe) };
    }
    // Hold only text that can still become a marker. "The review..." is
    // released as soon as "Th" disproves the prefix, so ordinary answers do
    // not wait for a line break.
    return couldBeTitleLine(probe.buffer) ? { text: "" } : release(probe);
  }

  return consumeFirstLine(probe, newline);
}

/**
 * Flushes a round that ended while the probe was still holding text. A marker
 * without a trailing newline (the model's final chunk, or a provider that
 * omits the completion event) is still recognized here.
 */
export function finishConversationTitleProbe(probe: ConversationTitleProbe): ConversationTitleProbeResult {
  if (probe.done) return { text: "" };
  const newline = probe.buffer.indexOf("\n");
  if (newline >= 0) return consumeFirstLine(probe, newline);

  probe.done = true;
  const buffered = takeBuffer(probe);
  const line = parseTitleLine(buffered);
  // Without a newline there is no way to separate the marker from an answer
  // that followed on the same line. Strip it only when the line is
  // unambiguously protocol (a valid title or the explicit no-title marker);
  // otherwise preserve every character the model produced.
  if (!line.title && !line.suppressed) return { text: buffered };
  return { text: "", ...(line.title ? { title: line.title } : {}) };
}

function consumeFirstLine(probe: ConversationTitleProbe, newline: number): ConversationTitleProbeResult {
  probe.done = true;
  const firstLine = probe.buffer.slice(0, newline);
  const rest = probe.buffer.slice(newline + 1).replace(/^\r?\n/, "");
  probe.buffer = "";
  const line = parseTitleLine(firstLine);
  if (line.matched) return line.title ? { text: rest, title: line.title } : { text: rest };
  return { text: `${firstLine}\n${rest}` };
}

function release(probe: ConversationTitleProbe): ConversationTitleProbeResult {
  probe.done = true;
  return { text: takeBuffer(probe) };
}

function takeBuffer(probe: ConversationTitleProbe): string {
  const buffered = probe.buffer;
  probe.buffer = "";
  return buffered;
}

function couldBeTitleLine(buffer: string): boolean {
  const candidate = buffer
    .replace(/^\s+/, "")
    .replace(/^\*\*\s*/, "")
    .toUpperCase();
  if (candidate.length === 0) return true;
  return "TITLE:".startsWith(candidate) || candidate.startsWith("TITLE:");
}

function parseTitleLine(line: string): { matched: boolean; title?: string; suppressed?: boolean } {
  const match = line.match(/^\s*(?:\*\*)?\s*title\s*:\s*(.*?)\s*(?:\*\*)?\s*$/i);
  if (!match) return { matched: false };
  const title = normalizeGeneratedTitle(match[1] ?? "");
  if (title?.toLowerCase() === noTitleMarker) return { matched: true, suppressed: true };
  return { matched: true, ...(title ? { title } : {}) };
}

function normalizeGeneratedTitle(value: string): string | undefined {
  const normalized = value
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’「」`]+|["'“”‘’「」`]+$/g, "")
    .trim();
  // The model may ignore the NONE instruction and echo the greeting instead;
  // a label that is only small talk is no more useful than no label.
  if (!normalized || normalized.length > maximumGeneratedTitleLength || isSmallTalkOnly(normalized)) return undefined;
  return normalized;
}
