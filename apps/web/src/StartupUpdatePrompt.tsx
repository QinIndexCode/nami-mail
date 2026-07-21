import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Clock3, Download, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck, SkipForward } from "lucide-react";
import { desktopBridge, type DesktopUpdateSnapshot, updateBridgeErrorMessage } from "./desktop";
import ThemedSelect from "./ThemedSelect";
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
const updateUnavailableMessage = "自动更新暂时不可用。请退出后重新打开 Nami Mail，再试一次。";

const snoozeOptions = [
  { minutes: 60, label: "1 小时后提醒" },
  { minutes: 24 * 60, label: "明天提醒" },
  { minutes: 7 * 24 * 60, label: "一周后提醒" },
  { minutes: 30 * 24 * 60, label: "30 天后提醒" },
] as const;

export function startupUpdatePromptVersion(
  snapshot: DesktopUpdateSnapshot | null,
  defer = false,
  dismissedErrorVersion: string | null = null,
): string | null {
  if (defer || snapshot?.suppression !== "none" || !snapshot.targetVersion || !promptablePhases.has(snapshot.phase)) return null;
  if (snapshot.phase === "error" && snapshot.targetVersion === dismissedErrorVersion) return null;
  return snapshot.targetVersion;
}

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "新版本";
}

function isInstalledCleanupNotice(snapshot: DesktopUpdateSnapshot): boolean {
  const version = snapshot.targetVersion;
  if (!version || !snapshot.message.includes(`v${version} 已安装`)) return false;
  return /(?:临时更新文件|更新缓存).*(?:清理|清除)/.test(snapshot.message);
}

function installedCleanupStatusCopy(snapshot: DesktopUpdateSnapshot): string {
  if (/(?:未能|无法|失败|未完全|待清理)/.test(snapshot.message)) {
    return "临时更新文件尚未全部清理，不影响当前使用。Nami Mail 会在下次启动时继续处理。";
  }
  return "临时更新文件已处理完成，当前使用不受影响。";
}

function phaseCopy(snapshot: DesktopUpdateSnapshot): { eyebrow: string; title: string; description: string } {
  const version = versionLabel(snapshot.targetVersion);
  if (snapshot.phase === "downloading") {
    return {
      eyebrow: "正在下载更新",
      title: `正在下载 ${version}`,
      description: "更新会在后台下载。完成后，你可以自行选择何时重启并安装，不会打断当前工作。",
    };
  }
  if (snapshot.phase === "ready") {
    return {
      eyebrow: "更新已就绪",
      title: `${version} 已准备好安装`,
      description: "更新包已通过完整性检查。请先保存正在编辑的内容；选择“重启并更新”后，Nami Mail 会退出并继续安装。",
    };
  }
  if (snapshot.phase === "checking") {
    return {
      eyebrow: "正在检查更新",
      title: "正在检查可用更新",
      description: "正在查询是否有可用更新，请稍候。",
    };
  }
  if (snapshot.phase === "error") {
    if (isInstalledCleanupNotice(snapshot)) {
      return {
        eyebrow: "更新已完成",
        title: `${version} 已安装`,
        description: "更新已安装完成，Nami Mail 可以正常使用。",
      };
    }
    return {
      eyebrow: "更新需要处理",
      title: "上次更新未完成",
      description: `${version} 尚未完成安装。Nami Mail 已恢复正常运行；你可以重新检查，也可以稍后在设置中处理。`,
    };
  }
  return {
    eyebrow: "发现可用更新",
    title: `${version} 可更新`,
    description: "选择“更新此版本”后，Nami Mail 会在后台下载并核验更新包。准备完成后，再由你决定何时重启安装，当前工作不会被打断。",
  };
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
  const [dismissedErrorVersion, setDismissedErrorVersion] = useState<string | null>(null);
  const eligibleVersion = startupUpdatePromptVersion(snapshot, defer, dismissedErrorVersion);
  const [openVersion, setOpenVersion] = useState<string | null>(() => startupUpdatePromptVersion(snapshot, defer));
  const [snoozeMinutes, setSnoozeMinutes] = useState<number>(24 * 60);
  const [busyAction, setBusyAction] = useState<UpdateAction | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [backgroundDownloadVersion, setBackgroundDownloadVersion] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

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
      && promptablePhases.has(snapshot.phase)
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
      setRequestError(updateBridgeErrorMessage(error, "更新操作未完成。请重新检查后再试。"));
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

  const dismissError = () => {
    if (snapshot?.phase === "error" && snapshot.targetVersion) setDismissedErrorVersion(snapshot.targetVersion);
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
        setRequestError("更新尚未准备好安装。请重新检查后再试。");
      }
    } catch (error) {
      setRequestError(updateBridgeErrorMessage(error, "无法开始安装更新。Nami Mail 会继续运行，请重新检查后再试。"));
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
      <aside className="update-background-status" role="status" aria-live="polite" aria-label={`正在下载 ${versionLabel(snapshot.targetVersion)}`}>
        <Download size={16} aria-hidden="true" />
        <span className="update-background-copy"><strong>{snapshot.phase === "available" ? `正在启动 ${versionLabel(snapshot.targetVersion)} 的下载` : `正在下载 ${versionLabel(snapshot.targetVersion)}`}</strong><small>可继续处理邮件，完成后会再次提醒</small></span>
        <strong className="update-background-percent">{snapshot.percent ?? 0}%</strong>
        <progress aria-label={`正在下载 ${versionLabel(snapshot.targetVersion)}`} max={100} value={snapshot.percent ?? 0} />
      </aside>
    );
  }

  const copy = phaseCopy(snapshot);
  const isTransferring = snapshot.phase === "checking" || snapshot.phase === "downloading";
  const actionPending = Boolean(busyAction) || isTransferring;
  const canChooseLater = ["available", "ready"].includes(snapshot.phase);
  const installedCleanupNotice = snapshot.phase === "error" && isInstalledCleanupNotice(snapshot);
  const hasUpdateError = (snapshot.phase === "error" && !installedCleanupNotice) || Boolean(requestError);

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
            <span className="eyebrow">{copy.eyebrow}</span>
            <h2 id="startup-update-title">{copy.title}</h2>
          </div>
        </header>

        <p id="startup-update-description" className="update-prompt-description">{copy.description}</p>

        {snapshot.phase === "downloading" && (
          <div className="update-progress" role="status" aria-live="polite">
            <div><span>下载进度</span><strong>{snapshot.percent ?? 0}%</strong></div>
            <progress aria-label={`正在下载 ${versionLabel(snapshot.targetVersion)}`} max={100} value={snapshot.percent ?? 0} />
          </div>
        )}

        {snapshot.phase === "checking" && (
          <div className="update-prompt-pending" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} />正在检查可用更新…</div>
        )}

        {hasUpdateError && (
          <div className="form-status error update-prompt-error" role="alert"><CircleAlert size={16} />{requestError ?? snapshot.message}</div>
        )}

        {(installedCleanupNotice || (snapshot.phase !== "error" && snapshot.phase !== "checking" && snapshot.phase !== "downloading")) && (
          <p className="update-prompt-status" role="status" aria-live="polite">{installedCleanupNotice ? installedCleanupStatusCopy(snapshot) : snapshot.message}</p>
        )}

        <footer className="update-prompt-actions">
          {snapshot.phase === "ready" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={() => void install()}>
                {busyAction === "install" ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}
                重启并更新
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={skip}>
                {busyAction === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}
                跳过此版本
              </button>
            </>
          ) : installedCleanupNotice ? (
            <button className="primary-button" type="button" data-dialog-initial-focus onClick={dismissError}>
              知道了
            </button>
          ) : snapshot.phase === "error" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={checkAgain}>
                {busyAction === "check" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                重新检查
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={dismissError}>稍后处理</button>
            </>
          ) : snapshot.phase === "available" ? (
            <>
              <button className="primary-button" type="button" data-dialog-initial-focus disabled={actionPending} onClick={download}>
                {busyAction === "download" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                更新此版本
              </button>
              <button className="secondary-button" type="button" disabled={actionPending} onClick={skip}>
                {busyAction === "skip" ? <LoaderCircle className="spin" size={15} /> : <SkipForward size={15} />}
                跳过此版本
              </button>
            </>
          ) : (
            <span className="update-prompt-waiting" role="status"><LoaderCircle className="spin" size={15} />请保持 Nami Mail 运行</span>
          )}
        </footer>

        {canChooseLater && (
          <div className="update-prompt-snooze" role="group" aria-label="稍后提醒设置">
            <span className="update-prompt-snooze-label"><Clock3 size={15} aria-hidden="true" />稍后提醒</span>
            <ThemedSelect
              id="startup-update-snooze"
              value={snoozeMinutes}
              aria-label="选择提醒时间"
              disabled={actionPending}
              onValueChange={(value) => setSnoozeMinutes(Number(value))}
            >
              {snoozeOptions.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
            </ThemedSelect>
            <button className="secondary-button" type="button" disabled={actionPending} onClick={snooze}>
              {busyAction === "snooze" ? <LoaderCircle className="spin" size={15} /> : <Clock3 size={15} />}
              提醒我
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
