import { createHash } from "node:crypto";

export const MAIL_CHUNKER_VERSION = "nami-mail-chunker-v1";

export type MailChunkInput = {
  messageId: string;
  sourceRevision: string;
  subject?: string;
  text: string;
  targetTokens?: number;
  maximumTokens?: number;
};

export type MailChunk = {
  chunkId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  tokenEstimate: number;
  kind: "subject" | "paragraph" | "list" | "table" | "mixed";
  chunkerVersion: typeof MAIL_CHUNKER_VERSION;
};

type SemanticBlock = {
  text: string;
  kind: MailChunk["kind"];
};

const defaultTargetTokens = 360;
const defaultMaximumTokens = 520;

function digest(value: string): string {
  return `sha256.${createHash("sha256").update(value, "utf8").digest("base64url")}`;
}

function validIdentifier(value: string, name: string): void {
  if (!value || value.length > 512) throw new Error(`${name} is invalid.`);
}

/** A deterministic estimate used for local budgeting; the embedding provider remains authoritative. */
export function estimateMailTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) return 0;
  const cjk = (normalized.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  const nonCjk = normalized.replace(/[\u3400-\u9FFF\uF900-\uFAFF]/g, "");
  const words = nonCjk.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const punctuation = (nonCjk.match(/[^\s\p{L}\p{N}_-]/gu) ?? []).length;
  return cjk + words.reduce((total, word) => total + Math.max(1, Math.ceil(word.length / 4)), 0) + Math.ceil(punctuation / 3);
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
}

function isTableLine(line: string): boolean {
  return line.includes("|") && line.split("|").filter((cell) => cell.trim()).length >= 2;
}

function blocksFromText(text: string): SemanticBlock[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.map((paragraph) => {
    const lines = paragraph.split("\n");
    const listLines = lines.filter(isListLine).length;
    const tableLines = lines.filter(isTableLine).length;
    const kind: MailChunk["kind"] = tableLines >= Math.max(2, Math.ceil(lines.length / 2))
      ? "table"
      : listLines >= Math.max(1, Math.ceil(lines.length / 2))
        ? "list"
        : "paragraph";
    return { text: paragraph, kind };
  });
}

function sentenceParts(value: string): string[] {
  const parts = value.match(/[^.!?。！？\n]+(?:[.!?。！？]+|$)|\n+/g) ?? [value];
  return parts.map((part) => part.trim()).filter(Boolean);
}

function wordParts(value: string): string[] {
  const parts = value.match(/[\u3400-\u9FFF\uF900-\uFAFF]|[^\s\u3400-\u9FFF\uF900-\uFAFF]+/g) ?? [value];
  return parts.map((part) => part.trim()).filter(Boolean);
}

function splitOversizedBlock(block: SemanticBlock, maximumTokens: number): SemanticBlock[] {
  if (estimateMailTokens(block.text) <= maximumTokens) return [block];
  const parts = block.kind === "list" || block.kind === "table"
    ? block.text.split("\n").map((line) => line.trim()).filter(Boolean)
    : sentenceParts(block.text);
  const result: SemanticBlock[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (!current.length) return;
    result.push({ text: current.join(block.kind === "paragraph" ? " " : "\n"), kind: block.kind });
    current = [];
    currentTokens = 0;
  };
  for (const part of parts) {
    const partTokens = estimateMailTokens(part);
    if (partTokens > maximumTokens) {
      flush();
      let wordBuffer: string[] = [];
      let wordTokens = 0;
      for (const word of wordParts(part)) {
        const wordTokenCount = estimateMailTokens(word);
        if (wordBuffer.length && wordTokens + wordTokenCount > maximumTokens) {
          result.push({ text: wordBuffer.join(" "), kind: block.kind });
          wordBuffer = [];
          wordTokens = 0;
        }
        wordBuffer.push(word);
        wordTokens += wordTokenCount;
      }
      if (wordBuffer.length) result.push({ text: wordBuffer.join(" "), kind: block.kind });
      continue;
    }
    if (current.length && currentTokens + partTokens > maximumTokens) flush();
    current.push(part);
    currentTokens += partTokens;
  }
  flush();
  return result;
}

function mergeKinds(kinds: Set<MailChunk["kind"]>): MailChunk["kind"] {
  if (kinds.size === 1) return [...kinds][0]!;
  return "mixed";
}

/**
 * Chunks cleaned mail by semantic blocks first, only splitting at sentences
 * or list/table rows when a block exceeds the hard token budget.
 */
export function chunkMailContent(input: MailChunkInput): MailChunk[] {
  validIdentifier(input.messageId, "Message id");
  validIdentifier(input.sourceRevision, "Source revision");
  const targetTokens = input.targetTokens ?? defaultTargetTokens;
  const maximumTokens = input.maximumTokens ?? defaultMaximumTokens;
  if (!Number.isSafeInteger(targetTokens) || !Number.isSafeInteger(maximumTokens)
    || targetTokens < 32 || maximumTokens < targetTokens || maximumTokens > 8_192) {
    throw new Error("Mail chunk token budgets are invalid.");
  }
  const subject = input.subject?.replace(/\s+/g, " ").trim() ?? "";
  const blocks = blocksFromText(input.text).flatMap((block) => splitOversizedBlock(block, maximumTokens));
  if (!blocks.length && !subject) return [];
  const prefix = subject ? `Subject: ${subject}` : "";
  const prefixTokens = estimateMailTokens(prefix);
  if (prefixTokens >= maximumTokens) throw new Error("Mail subject exceeds the chunk token budget.");
  const chunks: Array<{ content: string; kind: MailChunk["kind"] }> = [];
  let current: SemanticBlock[] = [];
  let currentTokens = prefixTokens;
  const flush = () => {
    if (!current.length) return;
    const body = current.map((block) => block.text).join("\n\n").trim();
    chunks.push({
      content: prefix ? `${prefix}\n\n${body}` : body,
      kind: mergeKinds(new Set(current.map((block) => block.kind))),
    });
    current = [];
    currentTokens = prefixTokens;
  };
  for (const block of blocks) {
    const blockTokens = estimateMailTokens(block.text);
    if (current.length && currentTokens + blockTokens > targetTokens) flush();
    if (blockTokens + prefixTokens > maximumTokens) {
      // `splitOversizedBlock` used the body ceiling. Re-split with the actual
      // subject allowance before emitting an otherwise oversize chunk.
      const parts = splitOversizedBlock(block, maximumTokens - prefixTokens);
      for (const part of parts) {
        const partTokens = estimateMailTokens(part.text);
        if (current.length && currentTokens + partTokens > targetTokens) flush();
        current.push(part);
        currentTokens += partTokens;
        if (currentTokens >= targetTokens) flush();
      }
      continue;
    }
    current.push(block);
    currentTokens += blockTokens;
  }
  flush();
  if (!chunks.length && subject) chunks.push({ content: prefix, kind: "subject" });
  return chunks.map((chunk, chunkIndex) => {
    const tokenEstimate = estimateMailTokens(chunk.content);
    const contentHash = digest(chunk.content);
    return {
      chunkId: digest(`${input.messageId}\0${input.sourceRevision}\0${chunkIndex}\0${contentHash}`),
      chunkIndex,
      content: chunk.content,
      contentHash,
      tokenEstimate,
      kind: chunk.kind,
      chunkerVersion: MAIL_CHUNKER_VERSION,
    };
  });
}
