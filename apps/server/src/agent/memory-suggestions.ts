/**
 * Memory suggestion protocol between the model and the UI. The system prompt
 * asks the model to end a reply with a single "MEMORY_SUGGEST: <summary>" line
 * when the user states a durable fact or preference. The server strips those
 * lines from the streamed text and the persisted transcript, then emits one
 * memory_suggestion stream event per summary; the web renders a save/dismiss
 * chip above the composer.
 */

const MEMORY_SUGGEST_LINE = /^[ \t]*MEMORY_SUGGEST:[ \t]*(.*?)[ \t]*$/gm;
const MEMORY_SUGGEST_PREFIX = /^[ \t]*MEMORY_SUGGEST:/;

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
 * Filters live text chunks while streaming so a marker line never flashes in
 * the rendered reply. Chunks split marker lines arbitrarily, so the caller
 * must thread `carry` (the unclosed line tail from the previous chunk)
 * through consecutive calls. A complete marker line is dropped; a trailing
 * line that merely starts with the marker prefix is returned as the next
 * `carry` and dropped once it closes or the stream ends.
 */
export function filterMemorySuggestionChunk(chunk: string, carry = ""): { text: string; carry: string } {
  const combined = carry + chunk;
  const lines = combined.split("\n");
  const last = lines.pop() ?? "";
  const kept = lines.filter((line) => !MEMORY_SUGGEST_LINE.test(`${line}\n`) && !MEMORY_SUGGEST_PREFIX.test(line));
  let nextCarry = "";
  if (last) {
    if (MEMORY_SUGGEST_PREFIX.test(last)) {
      nextCarry = last;
    } else {
      kept.push(last);
    }
  }
  return { text: kept.join("\n"), carry: nextCarry };
}
