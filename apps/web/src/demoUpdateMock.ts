import type React from "react";
import type { DesktopUpdateSnapshot } from "./desktop";
import type { UpdateFooterAction } from "./updateFooter";
import type { Translate } from "./i18n";

declare const __NAMI_APP_VERSION__: string;

export function isDemoPromptRequested(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("prompt") === "1";
}

export function resolveDemoUpdateSnapshot(isDemo: boolean): DesktopUpdateSnapshot | null {
  if (!isDemo || typeof window === "undefined") return null;
  const urlParams = new URLSearchParams(window.location.search);
  const param = urlParams.get("update");
  const isAutomatedTest = typeof navigator !== "undefined" && Boolean(navigator.webdriver);
  if (isAutomatedTest && !param) return null;

  const activeParam = param || "ready";
  if (activeParam === "none" || activeParam === "false" || activeParam === "0") return null;

  const phase = (
    ["available", "ready", "downloading", "error"].includes(activeParam)
      ? activeParam
      : "ready"
  ) as DesktopUpdateSnapshot["phase"];

  return {
    schemaVersion: 2,
    currentVersion: typeof __NAMI_APP_VERSION__ !== "undefined" ? __NAMI_APP_VERSION__ : "0.4.3",
    targetVersion: "0.4.4",
    phase,
    reason: phase === "ready" ? "downloadReady" : phase === "available" ? "releaseAvailable" : phase === "downloading" ? "downloading" : "mailDataBusy",
    percent: phase === "downloading" ? 68 : phase === "ready" ? 100 : null,
    suppression: "none",
    remindAt: null,
    checkedAt: new Date().toISOString(),
    args: {},
  };
}

export function handleDemoUpdateFooterAction(
  action: UpdateFooterAction,
  setStatus: React.Dispatch<React.SetStateAction<DesktopUpdateSnapshot | null>>,
  showToast: (message: string, kind?: "info" | "error" | "success") => void,
  t: Translate,
): void {
  if (action.kind === "download") {
    setStatus((current) => (current ? { ...current, phase: "downloading", percent: 45, reason: "downloading" } : current));
    window.setTimeout(() => {
      setStatus((current) => (current ? { ...current, phase: "ready", percent: 100, reason: "downloadReady" } : current));
      showToast(t("settings.update.downloadReady"), "success");
    }, 1200);
  } else if (action.kind === "install") {
    showToast(t("settings.update.restartAndUpdate"), "info");
    window.setTimeout(() => {
      setStatus((current) => (current ? { ...current, phase: "error", reason: "mailDataBusy", percent: null } : current));
    }, 2000);
  } else if (action.kind === "retry") {
    setStatus((current) => (current ? { ...current, phase: "downloading", percent: 15, reason: "downloading" } : current));
    window.setTimeout(() => {
      setStatus((current) => (current ? { ...current, phase: "ready", percent: 100, reason: "downloadReady" } : current));
    }, 1200);
  }
}
