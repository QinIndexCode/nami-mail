import assert from "node:assert/strict";
import test from "node:test";
import { checkJsonValue, isSafeJsonValue, maxJsonDepth, safeStringifyJson } from "../src/index.js";

// Deep payloads are built by string repetition and parsed, never by
// JSON.stringify of a deep object: the engine's own serializer is the very
// recursive walk this guard exists to bound, so constructing the fixture that
// way would crash the test runner instead of exercising the guard.
function nested(levels: number): unknown {
  return JSON.parse(`${'{"nested":'.repeat(levels)}"leaf"${"}".repeat(levels)}`);
}

test("accepts nesting up to the depth budget and rejects one level past it", () => {
  assert.equal(isSafeJsonValue(nested(maxJsonDepth)), true);
  assert.equal(isSafeJsonValue(nested(maxJsonDepth + 1)), false);
});

test("rejects an absurdly deep document without overflowing the stack", () => {
  assert.doesNotThrow(() => isSafeJsonValue(nested(50_000)));
  assert.equal(isSafeJsonValue(nested(50_000)), false);
});

test("still rejects cycles, prototype-pollution keys, and non-finite numbers", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(isSafeJsonValue(cycle), false);
  assert.equal(isSafeJsonValue(JSON.parse('{"__proto__":{"polluted":true}}')), false);
  assert.equal(isSafeJsonValue(JSON.parse('{"nested":{"constructor":{}}}')), false);
  assert.equal(isSafeJsonValue(Number.POSITIVE_INFINITY), false);
  assert.equal(isSafeJsonValue(undefined), false);
  assert.equal(isSafeJsonValue(new Date()), false);
});

test("accepts ordinary tool arguments", () => {
  assert.equal(isSafeJsonValue({ city: "Tokyo", nested: { list: [1, "two", null, true] } }), true);
});

test("separates a depth rejection from an ordinary shape rejection", () => {
  const deep = checkJsonValue(nested(maxJsonDepth + 1), new WeakSet(), 0);
  assert.deepEqual(deep, { safe: false, reason: "depth" });
  const wide = checkJsonValue({ missing: Number.NaN }, new WeakSet(), 0);
  assert.deepEqual(wide, { safe: false, reason: "shape" });
});

test("safeStringifyJson refuses an inadmissible value instead of raising", () => {
  assert.doesNotThrow(() => safeStringifyJson(nested(50_000)));
  assert.equal(safeStringifyJson(nested(50_000)), undefined);
  assert.equal(safeStringifyJson(undefined), undefined);
});

test("safeStringifyJson round-trips an admissible value unchanged", () => {
  const value = { query: "invoice", limit: 5, tags: ["a", "b"], nested: { deep: null } };
  const encoded = safeStringifyJson(value);
  assert.ok(encoded !== undefined);
  assert.deepEqual(JSON.parse(encoded), value);
});