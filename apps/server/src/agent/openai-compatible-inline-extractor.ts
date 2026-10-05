import type { ToolCall } from "@nami/agent-contracts";
import { asRecord } from "./provider-common.js";

/**
 * Detects and extracts tool calls that some models (e.g. Xiaomi MiMo) emit as
 * inline text rather than through the OpenAI tool_calls field. Supports two
 * common inline formats:
 *
 *   1. XML-style:  <tool_call><function=NAME><parameter=JSON></parameter></function></tool_call>
 *   2. JSON-style: {"action":"NAME","action_input":{...}}
 *
 * The extractor buffers incoming text deltas so that tags split across stream
 * chunks are handled correctly. Non-tool-call text is passed through unchanged.
 */
export class InlineToolCallExtractor {
  private buffer = "";
  // Complete tool-call blocks removed from the text buffer while draining.
  // extractToolCalls() parses these instead of re-scanning the text buffer,
  // which no longer contains the blocks after drain() has emitted them.
  private extractedBlocks: string[] = [];
  private static readonly OPEN_TAG = "<tool_call>";
  private static readonly CLOSE_TAG = "</tool_call>";
  // Keep enough tail to cover split tags and JSON prefixes.
  private static readonly SAFE_TAIL = 24;

  /** Returns text that is safe to emit now and keeps potential tag fragments buffered. */
  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Flushes the remaining buffer at stream end. */
  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = "";
    while (this.buffer) {
      const openIdx = this.buffer.indexOf(InlineToolCallExtractor.OPEN_TAG);
      const jsonIdx = this.detectJsonAction(this.buffer);

      if (openIdx === -1 && jsonIdx === -1) {
        // No tool-call marker found. Emit everything except a safe tail that
        // might be the start of a split tag, unless this is the final flush.
        if (final || this.buffer.length <= InlineToolCallExtractor.SAFE_TAIL) {
          output += this.buffer;
          this.buffer = "";
        } else {
          const cut = this.buffer.length - InlineToolCallExtractor.SAFE_TAIL;
          output += this.buffer.slice(0, cut);
          this.buffer = this.buffer.slice(cut);
        }
        break;
      }

      // Pick whichever marker appears first.
      const useXml = openIdx !== -1 && (jsonIdx === -1 || openIdx < jsonIdx);
      const markerIdx = useXml ? openIdx : jsonIdx;

      // Emit any text before the marker.
      if (markerIdx > 0) {
        output += this.buffer.slice(0, markerIdx);
        this.buffer = this.buffer.slice(markerIdx);
      }

      if (useXml) {
        const closeIdx = this.buffer.indexOf(InlineToolCallExtractor.CLOSE_TAG);
        if (closeIdx === -1) {
          // Closing tag not yet received. Wait for more chunks unless final.
          if (final) {
            // Stream ended without closing tag; emit as plain text.
            output += this.buffer;
            this.buffer = "";
          }
          break;
        }
        // Extract the full block (including close tag). It is removed from
        // the text stream and saved for extractToolCalls() to parse.
        const end = closeIdx + InlineToolCallExtractor.CLOSE_TAG.length;
        this.extractedBlocks.push(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
      } else {
        // JSON-style: try to parse a complete JSON object starting at jsonIdx.
        const result = this.tryExtractJson(this.buffer);
        if (!result) {
          if (final) {
            output += this.buffer;
            this.buffer = "";
          }
          break;
        }
        output += result.before;
        // The JSON tool-call payload is saved for extractToolCalls() to parse.
        this.extractedBlocks.push(result.jsonText);
        this.buffer = result.rest;
      }
    }
    return output;
  }

  private detectJsonAction(text: string): number {
    // Look for {"action": or {"action ": patterns near the start of a potential JSON object.
    const match = text.search(/\{"action"\s*:/);
    return match === -1 ? -1 : match;
  }

  private tryExtractJson(text: string): { before: string; jsonText: string; rest: string } | null {
    const start = text.search(/\{"action"\s*:/);
    if (start === -1) return null;
    // Scan forward to find the matching closing brace.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return {
            before: text.slice(0, start),
            jsonText: text.slice(start, i + 1),
            rest: text.slice(i + 1),
          };
        }
      }
    }
    return null; // incomplete JSON
  }

  /** Extracts tool calls from the inline-format blocks saved by drain(). */
  extractToolCalls(): ToolCall[] {
    const calls: ToolCall[] = [];
    // Each block is one complete inline tool call in one of two formats.
    for (const block of this.extractedBlocks) {
      if (block.startsWith(InlineToolCallExtractor.OPEN_TAG)) {
        // XML-style: <tool_call><function=NAME><parameter=JSON</parameter></function></tool_call>
        // The parameter value stops at the first '<' so the trailing
        // </parameter> close tag is never consumed by the value capture.
        const match = /<tool_call>\s*<function=([^\s>]+)>\s*<parameter=([^<]*)<\/parameter>\s*<\/function>\s*<\/tool_call>/.exec(block);
        if (!match) continue;
        const toolName = match[1] ?? "";
        if (!toolName) continue;
        const rawArgs = match[2] ?? "";
        let input: unknown = {};
        try { input = rawArgs ? JSON.parse(rawArgs) : {}; } catch { /* keep empty */ }
        calls.push({
          id: `inline-${Date.now()}-${calls.length}`,
          toolName,
          input,
          requestedAt: new Date().toISOString(),
        });
      } else if (block.startsWith("{\"action\"")) {
        // JSON-style: {"action":"NAME","action_input":{...}}
        let payload: unknown;
        try {
          payload = JSON.parse(block);
        } catch {
          continue;
        }
        const record = asRecord(payload);
        const toolName = typeof record?.action === "string" ? record.action : "";
        if (!record || !toolName) continue;
        let input: unknown = record.action_input ?? {};
        // Some models serialize action_input as a JSON string.
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch { /* keep the string */ }
        }
        calls.push({
          id: `inline-${Date.now()}-${calls.length}`,
          toolName,
          input,
          requestedAt: new Date().toISOString(),
        });
      }
    }
    this.extractedBlocks = [];
    return calls;
  }
}
