import { describe, expect, it } from "vitest";
import type { DesktopUpdateSnapshot } from "./desktop";
import { resolveUpdateFooter } from "./updateFooter";

const baseSnapshot: DesktopUpdateSnapshot = {
  schemaVersion: 2,
  phase: "unavailable",
  currentVersion: "0.1.0",
  targetVersion: null,
  percent: null,
  checkedAt: null,
  suppression: "none",
  remindAt: null,
  reason: "initializing",
  args: {},
};

function snapshot(overrides: Partial<DesktopUpdateSnapshot>): DesktopUpdateSnapshot {
  return { ...baseSnapshot, ...overrides };
}

describe("resolveUpdateFooter", () => {
  it("hides the button without a snapshot", () => {
    expect(resolveUpdateFooter(null)).toBeNull();
  });

  it("hides the button for quiet phases", () => {
    for (const phase of ["unavailable", "idle", "checking", "up-to-date"] as const) {
      expect(resolveUpdateFooter(snapshot({ phase }))).toBeNull();
    }
  });

  it("hides the button when the user skipped or snoozed the release", () => {
    for (const suppression of ["skipped", "snoozed"] as const) {
      expect(resolveUpdateFooter(snapshot({ phase: "available", suppression }))).toBeNull();
      expect(resolveUpdateFooter(snapshot({ phase: "ready", suppression }))).toBeNull();
    }
  });

  it("starts a download while a release is available", () => {
    expect(resolveUpdateFooter(snapshot({ phase: "available", targetVersion: "0.1.1" }))).toEqual({ kind: "download" });
  });

  it("reports download progress with a fallback of zero", () => {
    expect(resolveUpdateFooter(snapshot({ phase: "downloading", percent: 42 }))).toEqual({ kind: "downloading", percent: 42 });
    expect(resolveUpdateFooter(snapshot({ phase: "downloading", percent: null }))).toEqual({ kind: "downloading", percent: 0 });
  });

  it("offers an in-app restart once the release is ready", () => {
    expect(resolveUpdateFooter(snapshot({ phase: "ready", targetVersion: "0.1.1" }))).toEqual({ kind: "install" });
  });

  it("offers a retry after a failed check", () => {
    expect(resolveUpdateFooter(snapshot({ phase: "error", targetVersion: "0.1.1" }))).toEqual({ kind: "retry" });
  });

  it("keeps the retry only while the error is active, not after dismissal", () => {
    expect(resolveUpdateFooter(snapshot({ phase: "error", suppression: "skipped" }))).toBeNull();
  });
});