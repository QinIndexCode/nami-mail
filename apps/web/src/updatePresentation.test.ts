import { describe, expect, it } from "vitest";
import type { DesktopUpdateSnapshot } from "./desktop";
import { translate } from "./i18n";
import { presentUpdateSnapshot } from "./updatePresentation";

const baseSnapshot: DesktopUpdateSnapshot = {
  schemaVersion: 2,
  phase: "error",
  currentVersion: "0.1.0",
  targetVersion: "0.1.1",
  percent: null,
  checkedAt: "2026-07-23T08:00:00.000Z",
  suppression: "none",
  remindAt: null,
  reason: "unknown",
  args: {},
};

const statusKeyByReason: Record<DesktopUpdateSnapshot["reason"], string> = {
  initializing: "update.status.initializing",
  disabled: "update.status.disabled",
  unpackaged: "update.status.unpackaged",
  platformUnsupported: "update.status.platformUnsupported",
  sourceUnconfigured: "update.status.sourceUnconfigured",
  trustUnavailable: "update.status.trustUnavailable",
  scheduled: "update.status.scheduled",
  checking: "update.status.checking",
  upToDate: "update.status.upToDate",
  releaseAvailable: "update.status.releaseAvailable",
  downloading: "update.status.downloading",
  downloadReady: "update.status.downloadReady",
  network: "update.status.network",
  tls: "update.status.tls",
  releaseUnavailable: "update.status.releaseUnavailable",
  rateLimited: "update.status.rateLimited",
  signatureInvalid: "update.status.signatureInvalid",
  integrityInvalid: "update.status.integrityInvalid",
  archiveIntegrityInvalid: "update.status.archiveIntegrityInvalid",
  mailDataBusy: "update.status.mailDataBusy",
  installerNotStarted: "update.status.installerNotStarted",
  installResult: "update.status.installResult",
  unknown: "update.status.unknown",
};

function expectedValues(reason: DesktopUpdateSnapshot["reason"]): Record<string, string | number> | undefined {
  if (reason === "upToDate" || reason === "releaseAvailable" || reason === "downloadReady") return { version: "0.1.1" };
  if (reason === "downloading") return { version: "0.1.1", percent: 0 };
  if (reason === "installResult") return { stage: translate("zh-CN", "update.installStage.install") };
  return undefined;
}

describe("update snapshot presentation", () => {
  it("maps every updater reason through the JSON locale catalog instead of desktop-provided prose", () => {
    for (const reason of Object.keys(statusKeyByReason) as DesktopUpdateSnapshot["reason"][]) {
      const snapshot: DesktopUpdateSnapshot = {
        ...baseSnapshot,
        reason,
        args: reason === "installResult" ? { installStage: "install" } : {},
      };
      const presentation = presentUpdateSnapshot(snapshot, (key, values) => translate("zh-CN", key, values));

      expect(presentation.status).toBe(translate("zh-CN", statusKeyByReason[reason], expectedValues(reason)));
    }
  });

  it("keeps network, TLS, signature, integrity, archive, data-safety, and installer failures distinct in both locales", () => {
    const reasons: DesktopUpdateSnapshot["reason"][] = [
      "network",
      "tls",
      "signatureInvalid",
      "integrityInvalid",
      "archiveIntegrityInvalid",
      "mailDataBusy",
      "installerNotStarted",
    ];

    for (const locale of ["zh-CN", "en-US"]) {
      const statuses = reasons.map((reason) => presentUpdateSnapshot(
        { ...baseSnapshot, reason },
        (key, values) => translate(locale, key, values),
      ).status);
      expect(new Set(statuses).size).toBe(reasons.length);
      expect(statuses.every((status) => status.trim().length > 0)).toBe(true);
    }
  });

  it("reports cleanup outcomes as installed results rather than ordinary update failures", () => {
    const pending = presentUpdateSnapshot({
      ...baseSnapshot,
      reason: "installResult",
      args: { installStage: "cleanup", cleanupComplete: false },
    }, (key, values) => translate("en-US", key, values));
    const complete = presentUpdateSnapshot({
      ...baseSnapshot,
      phase: "up-to-date",
      reason: "installResult",
      args: { installStage: "cleanup", cleanupComplete: true },
    }, (key, values) => translate("en-US", key, values));

    expect(pending.isInstalledCleanupResult).toBe(true);
    expect(pending.isError).toBe(false);
    expect(pending.cleanupComplete).toBe(false);
    expect(pending.status).toBe(translate("en-US", "update.status.cleanupPending"));
    expect(pending.prompt.title).toBe(translate("en-US", "update.prompt.complete.title", { version: "v0.1.1" }));
    expect(complete.isInstalledCleanupResult).toBe(true);
    expect(complete.isError).toBe(false);
    expect(complete.cleanupComplete).toBe(true);
    expect(complete.status).toBe(translate("en-US", "update.status.cleanupComplete"));
  });
});
