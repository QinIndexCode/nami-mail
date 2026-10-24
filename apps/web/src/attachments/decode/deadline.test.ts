import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./deadline";
import { PreviewCanceled, PreviewFailure } from "../failure";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("resolves the work and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("done"), 1_000, () => undefined)).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates the work's own failure and clears its timer", async () => {
    vi.useFakeTimers();
    const failure = new PreviewFailure("corrupt");
    await expect(withTimeout(Promise.reject(failure), 1_000, () => undefined)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("calls onTimeout exactly once before rejecting", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const pending = withTimeout(new Promise<string>(() => undefined), 1_000, onTimeout);
    const assertion = expect(pending).rejects.toBeInstanceOf(PreviewFailure);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the timeout code even when the cleanup itself throws", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => undefined), 500, () => {
      throw new Error("cleanup blew up");
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("treats an already-aborted signal as cancellation without arming onTimeout", async () => {
    const onTimeout = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTimeout(new Promise<string>(() => undefined), 1_000, onTimeout, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(PreviewCanceled);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("cancels mid-flight without calling onTimeout and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const controller = new AbortController();
    const pending = withTimeout(new Promise<string>(() => undefined), 1_000, onTimeout, { signal: controller.signal });
    const assertion = expect(pending).rejects.toBeInstanceOf(PreviewCanceled);
    controller.abort();
    await assertion;
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve after the deadline won the race", async () => {
    vi.useFakeTimers();
    const holder: { settle: (() => void) | null } = { settle: null };
    const work = new Promise<string>((resolve) => {
      holder.settle = () => resolve("late");
    });
    const pending = withTimeout(work, 100, () => undefined);
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    holder.settle?.();
    await assertion;
    await expect(work).resolves.toBe("late");
  });
});
