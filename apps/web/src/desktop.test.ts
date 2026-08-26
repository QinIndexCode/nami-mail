import { describe, expect, it } from "vitest";
import {
  desktopBridge,
  normalizeDesktopAgentConfirmationResult,
  normalizeDesktopUpdateInstallResult,
  normalizeDesktopUpdateSnapshot,
  type DesktopBridge,
  type DesktopUpdateSnapshot,
  updateBridgeErrorMessage,
} from "./desktop";
import { translate } from "./i18n";

const zh = (key: string) => translate("zh-CN", key);

const structuredSnapshot = {
  schemaVersion: 2,
  phase: "available",
  currentVersion: "0.1.0",
  targetVersion: "0.1.1",
  percent: null,
  checkedAt: "2026-07-23T08:00:00.000Z",
  suppression: "none",
  remindAt: null,
  reason: "releaseAvailable",
  args: {},
} as const;

describe("desktop update snapshot contract", () => {
  it("normalizes the supported v2 schema without accepting extension fields", () => {
    expect(normalizeDesktopUpdateSnapshot(structuredSnapshot)).toEqual(structuredSnapshot);
    expect(normalizeDesktopUpdateSnapshot({ ...structuredSnapshot, reason: "installResult", args: { installStage: "cleanup", cleanupComplete: false } }))
      .toEqual({ ...structuredSnapshot, reason: "installResult", args: { installStage: "cleanup", cleanupComplete: false } });
    expect(normalizeDesktopUpdateSnapshot({ ...structuredSnapshot, phase: "unavailable", reason: "trustDisabledByBuild" }))
      .toEqual({ ...structuredSnapshot, phase: "unavailable", reason: "trustDisabledByBuild" });

    for (const malformed of [
      { ...structuredSnapshot, schemaVersion: 1 },
      { ...structuredSnapshot, phase: "queued" },
      { ...structuredSnapshot, reason: "unrecognized" },
      { ...structuredSnapshot, args: { installStage: "unknown-stage" } },
      { ...structuredSnapshot, args: { installStage: "cleanup", cleanupComplete: "yes" } },
      { ...structuredSnapshot, message: "legacy update text" },
    ]) {
      expect(normalizeDesktopUpdateSnapshot(malformed)).toBeUndefined();
    }
  });

  it("turns malformed install replies into a no-op", () => {
    expect(normalizeDesktopUpdateInstallResult({ accepted: true, snapshot: structuredSnapshot }))
      .toEqual({ accepted: true, snapshot: structuredSnapshot });
    expect(normalizeDesktopUpdateInstallResult({ accepted: true })).toEqual({ accepted: false });
    expect(normalizeDesktopUpdateInstallResult({ accepted: false, snapshot: { ...structuredSnapshot, reason: "futureReason" } }))
      .toEqual({ accepted: false });
  });

  it("does not expose malformed update results or events through the bridge", async () => {
    let updateListener: ((snapshot: DesktopUpdateSnapshot) => void) | undefined;
    const malformedSnapshot = { ...structuredSnapshot, reason: "futureReason" } as unknown as DesktopUpdateSnapshot;
    const rawBridge: DesktopBridge = {
      notify: async () => ({ shown: false }),
      copyVerificationCode: async () => ({ copied: false }),
      getUpdateStatus: async () => malformedSnapshot,
      checkForUpdates: async () => malformedSnapshot,
      downloadUpdate: async () => malformedSnapshot,
      skipUpdate: async () => malformedSnapshot,
      snoozeUpdate: async () => malformedSnapshot,
      installUpdate: async () => ({ accepted: false }),
      setCustomNotificationSoundReady: () => undefined,
      onNewMail: () => () => undefined,
      onOpenMessage: () => () => undefined,
      onSettingsChanged: () => () => undefined,
      onUpdateStatus: (listener) => {
        updateListener = listener;
        return () => undefined;
      },
    };
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { namiDesktop: rawBridge } });

    try {
      const guardedBridge = desktopBridge();
      expect(guardedBridge).toBeDefined();
      expect(await guardedBridge?.getUpdateStatus()).toBeUndefined();
      await expect(guardedBridge!.checkForUpdates()).rejects.toThrow("Invalid desktop updater response.");
      await expect(guardedBridge!.downloadUpdate()).rejects.toThrow("Invalid desktop updater response.");
      await expect(guardedBridge!.skipUpdate()).rejects.toThrow("Invalid desktop updater response.");
      await expect(guardedBridge!.snoozeUpdate(60)).rejects.toThrow("Invalid desktop updater response.");
      let received = 0;
      guardedBridge?.onUpdateStatus(() => { received += 1; });
      updateListener?.(malformedSnapshot);
      expect(received).toBe(0);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("desktop Agent confirmation bridge", () => {
  const confirmationId = "confirmation-7a338d89-7197-472f-95ee-d6db4c974b59";

  it("accepts only a complete desktop confirmation result", () => {
    expect(normalizeDesktopAgentConfirmationResult({ confirmationId, decision: "approve", ok: true }))
      .toEqual({ confirmationId, decision: "approve", ok: true });
    expect(normalizeDesktopAgentConfirmationResult({ confirmationId, decision: "reject", ok: false }))
      .toEqual({ confirmationId, decision: "reject", ok: false });

    for (const malformed of [
      undefined,
      null,
      { ok: false },
      { confirmationId, decision: "approved", ok: true },
      { confirmationId: "confirmation/invalid", decision: "approve", ok: true },
      { confirmationId, decision: "approve", ok: true, extra: true },
      { accepted: true },
    ]) {
      expect(normalizeDesktopAgentConfirmationResult(malformed)).toBeUndefined();
    }
  });

  it("exposes a results-only subscription and filters malformed preload payloads", () => {
    let resultListener: ((value: unknown) => void) | undefined;
    const rawBridge: DesktopBridge = {
      notify: async () => ({ shown: false }),
      copyVerificationCode: async () => ({ copied: false }),
      onAgentConfirmationResult: (listener) => {
        resultListener = listener as (value: unknown) => void;
        return () => {
          resultListener = undefined;
        };
      },
      getUpdateStatus: async () => undefined,
      checkForUpdates: async () => structuredSnapshot,
      downloadUpdate: async () => structuredSnapshot,
      skipUpdate: async () => structuredSnapshot,
      snoozeUpdate: async () => structuredSnapshot,
      installUpdate: async () => ({ accepted: false }),
      setCustomNotificationSoundReady: () => undefined,
      onNewMail: () => () => undefined,
      onOpenMessage: () => () => undefined,
      onSettingsChanged: () => () => undefined,
      onUpdateStatus: () => () => undefined,
    };
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { namiDesktop: rawBridge } });

    try {
      const bridge = desktopBridge();
      expect((bridge as Record<string, unknown> | undefined)?.resolveAgentConfirmation).toBeUndefined();
      const received: unknown[] = [];
      const unsubscribe = bridge?.onAgentConfirmationResult?.((result) => received.push(result));
      resultListener?.({ confirmationId, decision: "approve", ok: true });
      resultListener?.({ confirmationId, decision: "approved", ok: true });
      expect(received).toEqual([{ confirmationId, decision: "approve", ok: true }]);
      unsubscribe?.();
      expect(resultListener).toBeUndefined();
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("desktop tray command bridge", () => {
  it("passes the tray's compose and inbox subscriptions straight through", () => {
    const rawSubscriptions: Record<string, ((mailtoUrl?: string) => void) | undefined> = {};
    const rawBridge: DesktopBridge = {
      notify: async () => ({ shown: false }),
      copyVerificationCode: async () => ({ copied: false }),
      getUpdateStatus: async () => undefined,
      checkForUpdates: async () => structuredSnapshot,
      downloadUpdate: async () => structuredSnapshot,
      skipUpdate: async () => structuredSnapshot,
      snoozeUpdate: async () => structuredSnapshot,
      installUpdate: async () => ({ accepted: false }),
      setCustomNotificationSoundReady: () => undefined,
      onNewMail: () => () => undefined,
      onOpenMessage: () => () => undefined,
      onSettingsChanged: () => () => undefined,
      onUpdateStatus: () => () => undefined,
      onComposeNew: (listener) => {
        rawSubscriptions.compose = listener;
        return () => {
          rawSubscriptions.compose = undefined;
        };
      },
      onOpenInbox: (listener) => {
        rawSubscriptions.inbox = listener;
        return () => {
          rawSubscriptions.inbox = undefined;
        };
      },
    };
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { namiDesktop: rawBridge } });

    try {
      const bridge = desktopBridge();
      const commanded: string[] = [];
      bridge?.onComposeNew?.((mailtoUrl) => commanded.push(`compose:${mailtoUrl ?? ""}`));
      bridge?.onOpenInbox?.(() => commanded.push("inbox"));
      rawSubscriptions.compose?.();
      rawSubscriptions.compose?.("mailto:user@example.com?subject=Hi");
      rawSubscriptions.inbox?.();
      expect(commanded).toEqual(["compose:", "compose:mailto:user@example.com?subject=Hi", "inbox"]);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("desktop update bridge errors", () => {
  it("keeps TLS, network, and integrity recovery paths distinct", () => {
    expect(updateBridgeErrorMessage(new Error("CERT_HAS_EXPIRED"), "fallback")).toBe(zh("update.error.tls"));
    expect(updateBridgeErrorMessage(new Error("getaddrinfo ENOTFOUND github.com"), "fallback")).toBe(zh("update.error.network"));
    expect(updateBridgeErrorMessage(new Error("manifest signature invalid"), "fallback")).toBe(zh("update.error.integrity"));
  });

  it("uses the caller fallback for an unclassified bridge failure", () => {
    expect(updateBridgeErrorMessage(new Error("renderer destroyed"), "请重新检查更新。"))
      .toBe("请重新检查更新。");
  });

  it("explains an invalid desktop updater response without treating it as a completed action", () => {
    expect(updateBridgeErrorMessage(new Error("Invalid desktop updater response."), "fallback"))
      .toBe(zh("update.error.invalidResponse"));
  });
});
