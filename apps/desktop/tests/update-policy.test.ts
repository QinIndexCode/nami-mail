import assert from "node:assert/strict";
import test from "node:test";
import { jitteredDelay, prepareAndBeginUpdateInstall, updateRetryDelay } from "../src/update-policy.mts";

test("uses bounded jitter for periodic update checks", () => {
  assert.equal(jitteredDelay(10_000, () => 0, 0.2), 8_000);
  assert.equal(jitteredDelay(10_000, () => 0.5, 0.2), 10_000);
  assert.equal(jitteredDelay(10_000, () => 1, 0.2), 12_000);
});

test("backs off update retries exponentially without exceeding the maximum", () => {
  const options = { baseDelayMs: 60_000, maximumDelayMs: 15 * 60_000, random: () => 0.5 };
  assert.equal(updateRetryDelay(1, options), 60_000);
  assert.equal(updateRetryDelay(2, options), 120_000);
  assert.equal(updateRetryDelay(3, options), 240_000);
  const cappedDelay = updateRetryDelay(30, options);
  assert.ok(cappedDelay >= 12 * 60_000);
  assert.ok(cappedDelay <= 15 * 60_000);
});

test("closes the mail service before starting the installer and then quits", async () => {
  const calls: string[] = [];
  const result = await prepareAndBeginUpdateInstall(
    async () => {
      calls.push("prepare:start");
      await Promise.resolve();
      calls.push("prepare:complete");
      return true;
    },
    () => {
      calls.push("installer");
      return true;
    },
    () => calls.push("quit"),
    () => calls.push("recover"),
  );

  assert.equal(result, "started");
  assert.deepEqual(calls, ["prepare:start", "prepare:complete", "installer", "quit"]);
});

test("does not start the installer or quit when mail-service preparation fails", async () => {
  const calls: string[] = [];
  const result = await prepareAndBeginUpdateInstall(
    async () => {
      calls.push("prepare");
      return false;
    },
    () => {
      calls.push("installer");
      return true;
    },
    () => calls.push("quit"),
    () => calls.push("recover"),
  );

  assert.equal(result, "not-prepared");
  assert.deepEqual(calls, ["prepare"]);
});

test("recovers the prepared app when the installer cannot start", async () => {
  const calls: string[] = [];
  const result = await prepareAndBeginUpdateInstall(
    async () => {
      calls.push("prepare");
      return true;
    },
    () => {
      calls.push("installer");
      return false;
    },
    () => calls.push("quit"),
    () => calls.push("recover"),
  );

  assert.equal(result, "installer-not-started");
  assert.deepEqual(calls, ["prepare", "installer", "recover"]);
});

test("recovers and preserves an installer launch exception", async () => {
  const calls: string[] = [];
  const failure = new Error("installer launch failed");

  await assert.rejects(
    prepareAndBeginUpdateInstall(
      async () => {
        calls.push("prepare");
        return true;
      },
      () => {
        calls.push("installer");
        throw failure;
      },
      () => calls.push("quit"),
      () => calls.push("recover"),
    ),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["prepare", "installer", "recover"]);
});
