import { contextBridge, ipcRenderer } from "electron";

type NativeNotification = {
  title: string;
  body: string;
  silent: boolean;
};

type NewMailPayload = {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  count: number;
  shouldAlert: boolean;
  playCustomSound: boolean;
};

const updatePhases = [
  "unavailable",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "error",
] as const;

const updateSuppressions = ["none", "skipped", "snoozed"] as const;

const updateReasons = [
  "initializing",
  "disabled",
  "unpackaged",
  "platformUnsupported",
  "sourceUnconfigured",
  "trustUnavailable",
  "scheduled",
  "checking",
  "upToDate",
  "releaseAvailable",
  "downloading",
  "downloadReady",
  "network",
  "tls",
  "releaseUnavailable",
  "rateLimited",
  "signatureInvalid",
  "integrityInvalid",
  "archiveIntegrityInvalid",
  "mailDataBusy",
  "installerNotStarted",
  "installResult",
  "unknown",
] as const;

const updateInstallStages = [
  "wait",
  "verify-archive",
  "extract",
  "verify-installer",
  "install",
  "cleanup",
  "restart",
] as const;

const updateSnapshotKeys = new Set([
  "schemaVersion",
  "phase",
  "currentVersion",
  "targetVersion",
  "percent",
  "checkedAt",
  "suppression",
  "remindAt",
  "reason",
  "args",
]);
const updateSnapshotArgumentKeys = new Set(["installStage", "cleanupComplete"]);
const updateInstallResultKeys = new Set(["accepted", "snapshot"]);

export type DesktopUpdatePhase = typeof updatePhases[number];
export type DesktopUpdateSuppression = typeof updateSuppressions[number];
export type DesktopUpdateReason = typeof updateReasons[number];
export type DesktopUpdateInstallStage = typeof updateInstallStages[number];

export type DesktopUpdateSnapshotArgs = {
  installStage?: DesktopUpdateInstallStage;
  cleanupComplete?: boolean;
};

export type DesktopUpdateSnapshot = {
  schemaVersion: 2;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: DesktopUpdateSuppression;
  remindAt: string | null;
  reason: DesktopUpdateReason;
  args: DesktopUpdateSnapshotArgs;
};

type DesktopUpdateInstallResult = {
  accepted: boolean;
  snapshot?: DesktopUpdateSnapshot;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key)) && Object.getOwnPropertySymbols(value).length === 0;
}

function hasAllKeys(value: Record<string, unknown>, requiredKeys: ReadonlySet<string>): boolean {
  return [...requiredKeys].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}

function isAllowedValue<T extends string>(value: unknown, allowedValues: readonly T[]): value is T {
  return typeof value === "string" && (allowedValues as readonly string[]).includes(value);
}

function normalizeUpdateSnapshotArgs(value: unknown): DesktopUpdateSnapshotArgs | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, updateSnapshotArgumentKeys)) return undefined;
  const installStage = value.installStage;
  const cleanupComplete = value.cleanupComplete;
  if (installStage !== undefined && !isAllowedValue(installStage, updateInstallStages)) return undefined;
  if (cleanupComplete !== undefined && typeof cleanupComplete !== "boolean") return undefined;
  return {
    ...(installStage ? { installStage } : {}),
    ...(cleanupComplete === undefined ? {} : { cleanupComplete }),
  };
}

export function normalizeDesktopUpdateSnapshot(value: unknown): DesktopUpdateSnapshot | undefined {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, updateSnapshotKeys) || !hasAllKeys(value, updateSnapshotKeys)) return undefined;
  if (value.schemaVersion !== 2
    || !isAllowedValue(value.phase, updatePhases)
    || !isNonBlankString(value.currentVersion)
    || !isNullableNonBlankString(value.targetVersion)
    || (value.percent !== null && (typeof value.percent !== "number" || !Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100))
    || !isNullableNonBlankString(value.checkedAt)
    || !isAllowedValue(value.suppression, updateSuppressions)
    || !isNullableNonBlankString(value.remindAt)
    || !isAllowedValue(value.reason, updateReasons)) {
    return undefined;
  }
  const args = normalizeUpdateSnapshotArgs(value.args);
  if (!args) return undefined;
  return {
    schemaVersion: 2,
    phase: value.phase,
    currentVersion: value.currentVersion,
    targetVersion: value.targetVersion,
    percent: value.percent,
    checkedAt: value.checkedAt,
    suppression: value.suppression,
    remindAt: value.remindAt,
    reason: value.reason,
    args,
  };
}

export function normalizeDesktopUpdateInstallResult(value: unknown): DesktopUpdateInstallResult {
  if (!isPlainRecord(value)
    || !hasOnlyKeys(value, updateInstallResultKeys)
    || !Object.prototype.hasOwnProperty.call(value, "accepted")
    || typeof value.accepted !== "boolean") {
    return { accepted: false };
  }
  if (!Object.prototype.hasOwnProperty.call(value, "snapshot")) return { accepted: false };
  const snapshot = normalizeDesktopUpdateSnapshot(value.snapshot);
  return snapshot ? { accepted: value.accepted, snapshot } : { accepted: false };
}

function invokeUpdateSnapshot(channel: string, ...args: unknown[]): Promise<DesktopUpdateSnapshot | undefined> {
  return ipcRenderer.invoke(channel, ...args).then(normalizeDesktopUpdateSnapshot);
}

const rendererEvents = globalThis as unknown as {
  addEventListener?: (type: "online", listener: () => void) => void;
};
if (contextBridge && ipcRenderer) {
  rendererEvents.addEventListener?.("online", () => {
    ipcRenderer.send("nami:update-network-online");
  });

  contextBridge.exposeInMainWorld("namiDesktop", {
    localApiRequestHeaders: () => ipcRenderer.invoke("nami:local-api-request-headers"),
    notify: (payload: NativeNotification) => ipcRenderer.invoke("nami:notify", payload),
    copyVerificationCode: (code: string) => ipcRenderer.invoke("nami:copy-verification-code", code),
    getUpdateStatus: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-get-status"),
    checkForUpdates: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-check"),
    downloadUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-download"),
    skipUpdate: (): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-skip"),
    snoozeUpdate: (durationMinutes: number): Promise<DesktopUpdateSnapshot | undefined> => invokeUpdateSnapshot("nami:update-snooze", durationMinutes),
    installUpdate: (): Promise<DesktopUpdateInstallResult> => ipcRenderer.invoke("nami:update-install").then(normalizeDesktopUpdateInstallResult),
    setCustomNotificationSoundReady: (ready: boolean) => ipcRenderer.send("nami:custom-notification-sound-ready", ready),
    onNewMail: (listener: (payload: NewMailPayload) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: NewMailPayload) => listener(payload);
      ipcRenderer.on("nami:new-mail", wrapped);
      return () => ipcRenderer.removeListener("nami:new-mail", wrapped);
    },
    onOpenMessage: (listener: (id: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
      ipcRenderer.on("nami:open-message", wrapped);
      return () => ipcRenderer.removeListener("nami:open-message", wrapped);
    },
    onSettingsChanged: (listener: () => void) => {
      const wrapped = () => listener();
      ipcRenderer.on("nami:settings-changed", wrapped);
      return () => ipcRenderer.removeListener("nami:settings-changed", wrapped);
    },
    onUpdateStatus: (listener: (snapshot: DesktopUpdateSnapshot) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
        const normalizedSnapshot = normalizeDesktopUpdateSnapshot(snapshot);
        if (normalizedSnapshot) listener(normalizedSnapshot);
      };
      ipcRenderer.on("nami:update-status", wrapped);
      return () => ipcRenderer.removeListener("nami:update-status", wrapped);
    },
  });
}
