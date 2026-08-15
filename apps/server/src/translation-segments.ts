/**
 * Merging of translation segments into engine-safe blocks.
 *
 * A sanitized HTML mail can expose hundreds of visible text nodes. Translating
 * each one individually hits free engines (Google/MyMemory) with far too many
 * requests and trips their rate limits. Instead we merge *consecutive* segments
 * into larger blocks that stay under the engine's per-query character cap, join
 * them with a private-use separator, translate once, and split the result back
 * into per-segment translations.
 */

// Newlines survive the free Google/MyMemory engines and allow a translated
// block to be split back into per-segment results; control characters are
// replaced by the engines and cannot round-trip.
export const SEGMENT_SEPARATOR = "\n";
// Google's free endpoint caps each query at 500 characters; keep blocks
// comfortably under that so a merged block never gets rejected.
export const MAX_BLOCK_CHARS = 400;

export type TranslationBlock = {
  indices: number[];
  text: string;
};

/** Groups consecutive segments into blocks that fit within MAX_BLOCK_CHARS. */
export function buildTranslationBlocks(segments: readonly string[]): TranslationBlock[] {
  const blocks: TranslationBlock[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    const current = blocks.at(-1);
    if (current && current.text.length + 1 + segment.length <= MAX_BLOCK_CHARS) {
      current.text += `${SEGMENT_SEPARATOR}${segment}`;
      current.indices.push(index);
    } else {
      blocks.push({ indices: [index], text: segment });
    }
  }
  return blocks;
}

/**
 * Splits a translated block back into per-segment translations. When the engine
 * preserved the separator, each part maps 1:1 to a segment. If it collapsed the
 * separator (e.g. a block that became empty), the whole translated block is
 * distributed to every segment so the request still succeeds.
 */
export function splitTranslatedBlock(translatedBlock: string, indices: number[], target: string[]): void {
  const parts = translatedBlock.split(SEGMENT_SEPARATOR);
  for (let partIndex = 0; partIndex < indices.length; partIndex++) {
    const segmentIndex = indices[partIndex]!;
    target[segmentIndex] = partIndex < parts.length ? parts[partIndex]!.trim() : translatedBlock;
  }
}
