import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Clock3, Download, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck, SkipForward } from "lucide-react";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import { type Translate, useI18n } from "./i18n";
import ThemedSelect from "./ThemedSelect";
import { isInstalledCleanupResult, presentUpdateSnapshot } from "./updatePresentation";
import { useDialogFocus } from "./useDialogFocus";

type UpdateAction = "check" | "download" | "skip" | "snooze" | "install";

export type StartupUpdatePromptProps = {
  snapshot: DesktopUpdateSnapshot | null;
  onSnapshot: (snapshot: DesktopUpdateSnapshot) => void;
  /** Do not interrupt an account, compose, settings, or sending-status dialog. */
  defer?: boolean;
  onVisibilityChange?: (visible: boolean) => void;
};

const promptablePhases = new Set<DesktopUpdateSnapshot["phase"]>(["available", "ready", "error"]);

function isPromptableSnapshot(snapshot: DesktopUpdateSnapshot): boolean {
  return promptablePhases.has(snapshot.phase) || isInstalledCleanupResult(snapshot);
}

const snoozeOptions = [
  { minutes: 60, labelKey: "update.prompt.snooze.oneHour" },
  { minutes: 24 * 60, labelKey: "update.prompt.snooze.oneDay" },
  { minutes: 7 * 24 * 60, labelKey: "update.prompt.snooze.oneWeek" },
  { minutes: 30 * 24 * 60, labelKey: "update.prompt.snooze.thirtyDays" },
] as const;

export function startupUpdatePromptVersion(
  snapshot: DesktopUpdateSnapshot | null,
  defer = false,
  dismissedTerminalVersion: string | null = null,
): string | null {
  if (defer || snapshot?.suppression !== "none" || !snapshot.targetVersion || !isPromptableSnapshot(snapshot)) return null;
  if ((snapshot.phase === "error" || isInstalledCleanupResult(snapshot)) && snapshot.targetVersion === dismissedTerminalVersion) return null;
  return snapshot.targetVersion;
}

function versionLabel(version: string | null, t: Translate): string {
  return version ? `v${version}` : t("update.prompt.newVersion");
}

/**
 * A desktop-only, app-owned update prompt. It deliberately has no backdrop
 * dismissal, so an available release is handled through an explicit choice.
 */
export default function StartupUpdatePrompt({
  snapshot,
  onSnapshot,
  defer = false,
  onVisibilityChange,
}: StartupUpdatePromptProps) {
  const { t } = useI18n();
  const [dismissedTerminalVersion, setDismissedTerminalVersion] = useState<string | null>(null);
  const eligibleVersion = startupUpdatePromptVersion(snapshot, defer, dismissedTerminalVersion);
  const [openVersion, setOpenVersion] = useState<string | null>(() => startupUpdatePromptVersion(snapshot, defer));
  const [snoozeMinutes, setSnoozeMinutes] = useState<number>(24 * 60);
  const [busyAction, setBusyAction] = useState<UpdateAction | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [backgroundDownloadVersion, setBackgroundDownloadVersion] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const updateUnavailableMessage = t("update.prompt.unavailable");

  useEffect(() => {
    if (defer) {
      setOpenVersion(null);
      return;
    }
    if (eligibleVersion) {
      setOpenVersion(eligibleVersion);
      setRequestError(null);
      return;
    }
    if (!snapshot || !openVersion) return;
    if (snapshot.suppression !== "none" || snapshot.targetVersion !== openVersion) {
      setOpenVersion(null);
      setRequestError(null);
    }
  }, [defer, eligibleVersion, openVersion, snapshot]);

  useEffect(() => {
    if (!backgroundDownloadVersion) return;
    if (!snapshot || snapshot.targetVersion !== backgroundDownloadVersion || !["available", "downloading"].includes(snapshot.phase)) {
      setBackgroundDownloadVersion(null);
    }
  }, [backgroundDownloadVersion, snapshot]);

  const dialogOpen = Boolean(
    !defer
      && snapshot
      && openVersion
      && snapshot.targetVersion === openVersion
      && snapshot.suppression === "none"
      && isPromptableSnapshot(snapshot)
      && !(backgroundDownloadVersion === snapshot.targetVersion && snapshot.phase === "available"),
  );

  useEffect(() => {
    onVisibilityChange?.(dialogOpen);
  }, [dialogOpen, onVisibilityChange]);

  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange]);

  useDialogFocus(dialogOpen, dialogRef);

  useLayoutEffect(() => {
    if (!dialogOpen) return undefined;
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      // Let the themed select close its own listbox before treating Escape as
      // a dialog command. The update prompt itself has no implicit dismissal.
      if (target?.closest(".select-control")?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockEscape, true);
    return () => window.removeEventListener("keydown", blockEscape, true);
  }, [dialogOpen]);

  const saveSnapshot = (next: DesktopUpdateSnapshot | undefined) => {
    if (next) onSnapshot(next);
  };

  const runAction = async (action: UpdateAction, operation: () => Promise<DesktopUpdateSnapshot | undefined>) => {
    if (busyAction) return;
    setBusyAction(action);
    setRequestError(null);
    try {
      saveSnapshot(await operation());
    } catch (error) {
      if (action === "download") setBackgroundDownloadVersion(null);
      setRequestError(updateBridgeErrorMessage(error, t("update.prompt.error.action"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const download = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setRequestError(updateUnavailableMessage);
      return;
    }
    if (snapshot?.targetVersion) setBackgroundDownloadVersion(snapshot.targetVersion);
    void runAction("download", () => bridge.downloadUpdate());
  };

  const skip = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setRequestError(updateUnavailableMessage);
      return;
    }
    void runAction("skip", () => bridge.skipUpdate());
  };

  const snooze = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setRequestError(updateUnavailableMessage);
      return;
    }
    void runAction("snooze", () => bridge.snoozeUpdate(snoozeMinutes));
  };

  const checkAgain = () => {
    const bridge = desktopBridge();
    if (!bridge) {
      setRequestError(updateUnavailableMessage);
      return;
    }
    void runAction("check", () => bridge.checkForUpdates());
  };

  const dismissTerminalPrompt = () => {
    if (snapshot?.targetVersion && (snapshot.phase === "error" || isInstalledCleanupResult(snapshot))) {
      setDismissedTerminalVersion(snapshot.targetVersion);
    }
    setOpenVersion(null);
    setRequestError(null);
  };

  const install = async () => {
    const bridge = desktopBridge();
    if (!bridge || busyAction) {
      if (!bridge) setRequestError(updateUnavailableMessage);
      return;
    }
    setBusyAction("install");
    setRequestError(null);
    try {
      const result = await bridge.installUpdate();
      saveSnapshot(result.snapshot);
      if (!result.accepted && !result.snapshot) {
        setRequestError(t("update.prompt.error.notReady"));
      }
    } catch (error) {
      setRequestError(updateBridgeErrorMessage(error, t("update.prompt.error.start"), t));
    } finally {
      setBusyAction(null);
    }
  };

  const backgroundDownloadVisible = Boolean(
    !defer
      && snapshot
      && (
        snapshot.phase === "downloading"
        || (
          backgroundDownloadVersion
          && snapshot.targetVersion === backgroundDownloadVersion
          && snapshot.phase === "available"
        )
      )
      && snapshot.targetVersion
      && snapshot.suppression === "none",
  );

  if (!dialogOpen || !snapshot) {
    if (!backgroundDownloadVisible || !snapshot) return null;
    return (
      <aside className="update-background-status" role="status" aria-live="polite" aria-label={t("update.prompt.background.downloadingAria", { version: versionLabel(snapshot.targetVersion, t) })}>
        <Download size={16} aria-hidden="true" />
        <span className="update-background-copy"><strong>{snapshot.phase === "available" ? t("update.prompt.background.startingDownload", { version: versionLabel(snapshot.targetVersion, t) }) : t("update.prompt.background.downloading", { version: versionLabel(snapshot.targetVersion, t) })}</strong><small>{t("update.prompt.background.description")}</small></span>
        <strong className="update-background-percent">{snapshot.percent ?? 0}%</strong>
        <progress aria-label={t("update.prompt.background.downloadingAria", { version: versionLabel(snapshot.targetVersion, t) })} max={100} value={snapshot.percent ?? 0} />
      </aside>
    );
  }

  const presentation = presentUpdateSnapshot(snapshot, t);
  const isTransferring = snapshot.phase === "checking" || snapshot.phase === "downloading";
  const actionPending = Boolean(busyAction) || isTransferring;
  const canChooseLater = ["available", "ready"].includes(snapshot.phase);
  const installedCleanupNotice = presentation.isInstalledCleanupResult;
  const cleanupRetryRequired = installedCleanupNotice && !presentation.cleanupComplete;
  const hasUpdateError = presentation.isError || cleanupRetryRequired || Boolean(requestError);

  return (
    <div className="modal-backdrop update-prompt-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="update-prompt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="startup-update-title"
        aria-describedby="startup-update-description"
        aria-busy={actionPending}
        tabIndex={-1}
      >
        <header className="update-prompt-heading">
          <span className={`update-prompt-icon${hasUpdateError ? " error" : ""}`} aria-hidden="true">
            {hasUpdateError ? <CircleAlert size={21} /> : snapshot.phase === "ready" || installedCleanupNotice ? <ShieldCheck size={21} /> : <Download size={21} />}
          </span>
          <div>
            <span className="eyebrow">{presentation.prompt.eyebrow}</span>
            <h2 id="startup-update-title">{presentation.prompt.title}</h2>
          </div>
        </header>

        <p id="startup-update-description" className="update-prompt-description">{presentation.prompt.description}</p>

        {snapshot.phase === "downloading" && (
          <div className="update-progress" role="status" aria-live="polite">
            <div><span>{t("update.prompt.progressLabel")}</span><strong>{snapshot.percent ?? 0}%</strong></div>
            <progress aria-label={t("update.prompt.background.downloadingAria", { version: versionLabel(snapshot.targetVersion, t) })} max={100} value={snapshot.percent ?? 0} />
          </div>
        )}

        {snapshot.phase === "checking" && (
          <div className="update-prompt-pending" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} />{t("update.prompt.checkingStatus")}</div>
        )}

        {hasUpdateError && (
          <div className="form-status error update-prompt-error" role="alert"><CircleAlert size={16} />{requestError ?? presentation.status}</div>
        )}

        {(installedCleanupNotice || (snapshot.phase !== "error" && snapshot.phase !== "checking" && snapshot.phase !== "downloading")) && (
          <p className="update-prompt-status" role="status" aria-live="polite">{presentation.status}</p>
        )}

        <footer className="update-prompt-actions">
          {snapshot.phase === "ready" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={() => void install()}>
                {busyAction === "install" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                {t("update.prompt.restartAndUpdate")}
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={skip}>
                {busyAction === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}
                {t("update.prompt.skipVersion")}
              </button>
            </>
          ) : cleanupRetryRequired ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={checkAgain}>
                {busyAction === "check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {t("update.prompt.checkAgain")}
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={dismissTerminalPrompt}>{t("update.prompt.later")}</button>
            </>
          ) : installedCleanupNotice ? (
            <button className="primary-button" type="button" data-dialog-initial-focus onClick={dismissTerminalPrompt}>
              {t("update.prompt.acknowledge")}
            </button>
          ) : snapshot.phase === "error" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={checkAgain}>
                {busyAction === "check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {t("update.prompt.checkAgain")}
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={dismissTerminalPrompt}>{t("update.prompt.later")}</button>
            </>
          ) : snapshot.phase === "available" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={download}>
                {busyAction === "download" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                {t("update.prompt.updateVersion")}
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={skip}>
                {busyAction === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}
                {t("update.prompt.skipVersion")}
              </button>
            </>
          ) : (
            <span className="update-prompt-waiting" role="status"><LoaderCircle className="spin" size={15} />{t("update.prompt.keepRunning")}</span>
          )}
        </footer>

        {canChooseLater && (
          <div className="update-prompt-snooze" role="group" aria-label={t("update.prompt.snooze.groupLabel")}>
            <span className="update-prompt-snooze-label"><Clock3 size={15} aria-hidden="true" />{t("update.prompt.snooze.label")}</span>
            <ThemedSelect
              id="startup-update-snooze"
              value={snoozeMinutes}
              aria-label={t("update.prompt.snooze.selectLabel")}
              disabled={actionPending}
              onValueChange={(value) => setSnoozeMinutes(Number(value))}
            >
              {snoozeOptions.map((option) => <option key={option.minutes} value={option.minutes}>{t(option.labelKey)}</option>)}
            </ThemedSelect>
            <button className="secondary-button" type="button" disabled={actionPending} onClick={snooze}>
              {busyAction === "snooze" ? <LoaderCircle className="spin" size={15} /> : <Clock3 size={15} />}
              {t("update.prompt.snooze.remindMe")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
