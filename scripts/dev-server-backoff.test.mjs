import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESTART_DELAY_MS,
  MIN_RESTART_DELAY_MS,
  STABLE_UPTIME_MS,
  nextRestartDelayMs,
} from "./dev-server-backoff.mjs";

test("the first failure restarts after the minimum delay", () => {
  assert.equal(nextRestartDelayMs(0, 100), MIN_RESTART_DELAY_MS);
});

test("consecutive failures double the delay", () => {
  let delay = nextRestartDelayMs(0, 100);
  assert.equal(delay, MIN_RESTART_DELAY_MS);
  delay = nextRestartDelayMs(delay, 100);
  assert.equal(delay, MIN_RESTART_DELAY_MS * 2);
  delay = nextRestartDelayMs(delay, 100);
  assert.equal(delay, MIN_RESTART_DELAY_MS * 4);
});

test("the delay is capped at the maximum", () => {
  let delay = 0;
  for (let failure = 0; failure < 6; failure += 1) {
    delay = nextRestartDelayMs(delay, 100);
  }
  assert.equal(delay, MAX_RESTART_DELAY_MS);
  assert.equal(nextRestartDelayMs(MAX_RESTART_DELAY_MS, 100), MAX_RESTART_DELAY_MS);
});

test("a stable run resets the delay to the minimum", () => {
  const afterCrashLoop = nextRestartDelayMs(MAX_RESTART_DELAY_MS, 100);
  assert.equal(afterCrashLoop, MAX_RESTART_DELAY_MS);
  const afterStableRun = nextRestartDelayMs(afterCrashLoop, STABLE_UPTIME_MS);
  assert.equal(afterStableRun, MIN_RESTART_DELAY_MS);
});

test("the stable-run boundary is inclusive", () => {
  assert.equal(nextRestartDelayMs(MAX_RESTART_DELAY_MS, STABLE_UPTIME_MS), MIN_RESTART_DELAY_MS);
  assert.equal(nextRestartDelayMs(MAX_RESTART_DELAY_MS, STABLE_UPTIME_MS - 1), MAX_RESTART_DELAY_MS);
});
