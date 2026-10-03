/**
 * Memory suggestion protocol between the model and the UI. The system prompt
 * asks the model to end a reply with a single "MEMORY_SUGGEST: <summary>" line
 * when the user states a durable fact or preference. The server strips those
 * lines from the streamed text and the persisted transcript, then emits one
 * memory_suggestion stream event per summary; the web renders a save/dismiss
 * chip above the composer.
 */

const MEMORY_SUGGEST_KEYWORD = "MEMORY_SUGGEST:";
const MEMORY_SUGGEST_LINE = /^[ \t]*MEMORY_SUGGEST:[ \t]*(.*?)[ \t]*$/gm;
const MEMORY_SUGGEST_PREFIX = /^[ \t]*MEMORY_SUGGEST:/;

/**
 * Stateless twins of the patterns above, for `.test()`. `MEMORY_SUGGEST_LINE`
 * must keep `g` for `replace`/`matchAll`, and a global regex carries
 * `lastIndex` between `.test()` calls, so reusing it made marker detection flip
 * on and off mid-stream and let marker lines leak into the rendered reply.
 * `\r?` is tolerated so a CRLF marker line disappears from the stream too.
 */
const MEMORY_SUGGEST_LINE_TEST = /^[ \t]*MEMORY_SUGGEST:[ \t]*(.*?)[ \t]*\r?$/;

/** Strips every MEMORY_SUGGEST line from a full reply text. */
export function stripMemorySuggestions(text: string): string {
  return text.replace(MEMORY_SUGGEST_LINE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extracts suggestion summaries, capped at one per turn. Only a marker that
 * ends the reply counts: the model is instructed to append it as the final
 * line, so a mid-reply marker is most likely an echo of user input rather
 * than a real proposal.
 */
export function extractMemorySuggestions(text: string): string[] {
  const summaries: string[] = [];
  for (const match of text.matchAll(MEMORY_SUGGEST_LINE)) {
    const rest = text.slice((match.index ?? 0) + match[0].length).trim();
    if (rest) continue;
    const summary = match[1]!.trim();
    if (summary) summaries.push(summary.slice(0, 500));
  }
  return summaries.slice(0, 1);
}

/**
 * True when `line` is already a marker line, or is still short enough that the
 * rest of the stream could complete it. Those tails have to stay in `carry`
 * rather than be emitted, otherwise the marker flashes in the UI.
 */
function mayBecomeMarkerLine(line: string): boolean {
  const rest = line.replace(/^[ \t]+/, "");
  if (rest === "") return true;
  return MEMORY_SUGGEST_KEYWORD.startsWith(rest) || rest.startsWith(MEMORY_SUGGEST_KEYWORD);
}

/**
 * Filters live text chunks while streaming so a marker line never flashes in
 * the rendered reply. Chunks split marker lines arbitrarily, so the caller
 * must thread `carry` (the unclosed marker line from the previous chunk)
 * through consecutive calls.
 *
 * Every character outside a marker line is emitted exactly as the model wrote
 * it, newlines included, so the concatenation of the yielded chunks matches
 * what `stripMemorySuggestions` persists for the same raw reply (up to the
 * trailing whitespace only the persisted path can trim). The previous version
 * split on `\n`, threw the separator away and rebuilt the block with
 * `join("\n")`, which deleted every line-ending newline: a chunk that ended on
 * `\n` lost it and a `\n\n` paragraph break collapsed to nothing, so the
 * streamed reply read shorter than the stored one and paragraphs ran together.
 */
export function filterMemorySuggestionChunk(chunk: string, carry = ""): { text: string; carry: string } {
  const combined = carry + chunk;
  let text = "";
  let lineStart = 0;
  // A removed marker line must take exactly one newline with it, or a blank
  // hole appears mid-reply. The newline in front of the line is spent here
  // when it is still pending; when the marker line only arrives in a later
  // chunk that newline is long gone, so its own trailing newline goes instead.
  let separatorSpent = false;
  for (;;) {
    const lineEnd = combined.indexOf("\n", lineStart);
    if (lineEnd < 0) break;
    const line = combined.slice(lineStart, lineEnd);
    const nextStart = lineEnd + 1;
    if (MEMORY_SUGGEST_LINE_TEST.test(line)) {
      if (separatorSpent) text += "\n";
      separatorSpent = false;
      lineStart = nextStart;
      continue;
    }
    text += line;
    // Only a line that already carries the full `MEMORY_SUGGEST:` prefix is
    // certain to be a marker line; withholding the newline for a shorter
    // prefix fragment would fuse two real lines once the marker fails to
    // materialise.
    const nextBreak = combined.indexOf("\n", nextStart);
    const nextLine = nextBreak < 0 ? combined.slice(nextStart) : combined.slice(nextStart, nextBreak);
    separatorSpent = MEMORY_SUGGEST_PREFIX.test(nextLine);
    if (!separatorSpent) text += "\n";
    lineStart = nextStart;
  }
  const tail = combined.slice(lineStart);
  if (tail === "") return { text, carry: "" };
  if (mayBecomeMarkerLine(tail)) return { text, carry: tail };
  return { text: text + tail, carry: "" };
}
