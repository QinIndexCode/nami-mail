/**
 * The single JSON-admissibility guard shared by every process boundary.
 *
 * Values reaching this module come from an MCP peer, a model stream, or a
 * desktop IPC frame, so none of them is trusted to be shallow. The walk
 * therefore has one hard rule: decide the depth budget *before* recursing, so
 * the validator itself can never be the thing that overflows the stack.
 */

/**
 * Deepest JSON nesting accepted anywhere in the process. Real tool schemas and
 * tool payloads are an order of magnitude shallower than this, so the bound
 * costs nothing legitimate while removing the stack-overflow vector.
 */
export const maxJsonDepth = 64;

const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Why a value failed the JSON-safety walk. Depth is reported separately from
 * an ordinary shape rejection because it is the one case that says something
 * about the peer (a document tens of thousands of levels deep) rather than
 * about the value, and it is worth a log line instead of a silent drop.
 */
export type JsonVerdict = { safe: true } | { safe: false; reason: "shape" | "depth" };

const jsonSafe: JsonVerdict = { safe: true };
const jsonUnsafeShape: JsonVerdict = { safe: false, reason: "shape" };
const jsonUnsafeDepth: JsonVerdict = { safe: false, reason: "depth" };

export function checkJsonValue(value: unknown, visited: WeakSet<object>, depth: number): JsonVerdict {
  if (value === null || typeof value === "boolean" || typeof value === "string") return jsonSafe;
  if (typeof value === "number") return Number.isFinite(value) ? jsonSafe : jsonUnsafeShape;
  if (!value || typeof value !== "object") return jsonUnsafeShape;
  // Checked before recursing, so the walk itself can never overflow the stack
  // no matter how deep the document claims to be.
  if (depth >= maxJsonDepth) return jsonUnsafeDepth;
  if (visited.has(value)) return jsonUnsafeShape;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const verdict = checkJsonValue(entry, visited, depth + 1);
      if (!verdict.safe) return verdict;
    }
    return jsonSafe;
  }
  if (!isPlainJsonObject(value)) return jsonUnsafeShape;
  for (const [key, entry] of Object.entries(value)) {
    if (unsafeObjectKeys.has(key)) return jsonUnsafeShape;
    const verdict = checkJsonValue(entry, visited, depth + 1);
    if (!verdict.safe) return verdict;
  }
  return jsonSafe;
}

/**
 * Rejects values that are not plain JSON, that carry a prototype-polluting key,
 * that form a cycle, or that nest deeper than `maxJsonDepth`.
 */
export function isSafeJsonValue(value: unknown, visited = new WeakSet<object>(), depth = 0): boolean {
  return checkJsonValue(value, visited, depth).safe;
}

/**
 * Serializes a value only when it is admissible JSON.
 *
 * Callers that re-serialize model-controlled data cannot use `JSON.stringify`
 * on its own: the engine's own walk is recursive and unbounded, so a deep but
 * otherwise valid payload would raise `RangeError` from inside the caller's
 * request-assembly path. Admissibility is decided first, which bounds the
 * depth the engine ever has to walk.
 */
export function safeStringifyJson(value: unknown): string | undefined {
  if (!isSafeJsonValue(value)) return undefined;
  return JSON.stringify(value);
}