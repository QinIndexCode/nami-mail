export type DesktopMailNotice = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  count: number;
  shouldAlert: boolean;
  playCustomSound: boolean;
};

type NativeNotification = {
  title: string;
  body: string;
  silent: boolean;
};

export type DesktopUpdateSnapshot = {
  phase: "unavailable" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: "none" | "skipped" | "snoozed";
  remindAt: string | null;
  message: string;
};

type DesktopBridge = {
  localApiRequestHeaders: () => Promise<Record<string, string>>;
  notify: (payload: NativeNotification) => Promise<{ shown: boolean }>;
  copyVerificationCode: (code: string) => Promise<{ copied: boolean }>;
  getUpdateStatus: () => Promise<DesktopUpdateSnapshot | undefined>;
  checkForUpdates: () => Promise<DesktopUpdateSnapshot | undefined>;
  downloadUpdate: () => Promise<DesktopUpdateSnapshot | undefined>;
  skipUpdate: () => Promise<DesktopUpdateSnapshot | undefined>;
  snoozeUpdate: (durationMinutes: number) => Promise<DesktopUpdateSnapshot | undefined>;
  installUpdate: () => Promise<{ accepted: boolean; snapshot?: DesktopUpdateSnapshot }>;
  setCustomNotificationSoundReady: (ready: boolean) => void;
  onNewMail: (listener: (payload: DesktopMailNotice) => void) => () => void;
  onOpenMessage: (listener: (id: string) => void) => () => void;
  onSettingsChanged: (listener: () => void) => () => void;
  onUpdateStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
};

declare global {
  interface Window {
    namiDesktop?: DesktopBridge;
  }
}

export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.namiDesktop;
}

function updateErrorEvidence(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  return typeof error === "string" ? error.toLowerCase() : "";
}

/**
 * IPC failures are rare because the desktop updater normally returns a status
 * snapshot. When the bridge itself fails, keep the recovery advice specific
 * without exposing an Electron or network implementation detail to the user.
 */
export function updateBridgeErrorMessage(error: unknown, fallback: string): string {
  const evidence = updateErrorEvidence(error);
  if (/signature|publisher|code.?sign|not signed|certificate.*identity|integrity|sha.?512|manifest/.test(evidence)) {
    return "更新包未通过完整性验证，Nami Mail 已停止安装。请稍后重新检查更新。";
  }
  if (/cert_|certificate|self signed|unable to verify|tls|ssl/.test(evidence)) {
    return "更新服务的安全连接未通过。请检查系统时间、代理或安全软件后重新检查。";
  }
  if (/enotfound|eai_again|enetunreach|ehostunreach|econnrefused|econnreset|etimedout|timeout|network/.test(evidence)) {
    return "暂时无法连接更新服务。请检查网络、代理或 DNS 后重新检查。";
  }
  if (/403|rate[ _-]?limit|forbidden/.test(evidence)) {
    return "更新服务暂时限制了请求，请稍后重新检查。";
  }
  if (/404|not found|no published versions|asset_missing/.test(evidence)) {
    return "暂时未找到可安装的正式更新，请稍后重新检查。";
  }
  return fallback;
}
