import type { DesktopUpdateSnapshot } from "./desktop";

export type UpdateFooterAction =
  | { kind: "download" }
  | { kind: "downloading"; percent: number }
  | { kind: "install" }
  | { kind: "retry" };

/**
 * The sidebar footer shows a compact update entry point alongside the startup
 * prompt: a ready release can be installed (restarting the app), a failed
 * check can be retried, and an in-flight download reports its progress. The
 * "available" phase is NOT listed here — it is surfaced by the expandable
 * circular update badge instead. Skip/snooze suppression hides everything —
 * the user has already chosen how to handle this release.
 */
export function resolveUpdateFooter(snapshot: DesktopUpdateSnapshot | null): UpdateFooterAction | null {
  if (!snapshot || snapshot.suppression !== "none") return null;
  switch (snapshot.phase) {
    case "available":
      return null;
    case "downloading":
      return { kind: "downloading", percent: snapshot.percent ?? 0 };
    case "ready":
      return { kind: "install" };
    case "error":
      return { kind: "retry" };
    default:
      return null;
  }
}