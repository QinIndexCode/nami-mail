import { translate, type Translate } from "./i18n";

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

export type DesktopUpdateInstallResult = {
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

function requireDesktopUpdateSnapshot(value: unknown): DesktopUpdateSnapshot {
  const snapshot = normalizeDesktopUpdateSnapshot(value);
  if (!snapshot) throw new Error("Invalid desktop updater response.");
  return snapshot;
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

export type DesktopBridge = {
  localApiRequestHeaders: () => Promise<Record<string, string>>;
  notify: (payload: NativeNotification) => Promise<{ shown: boolean }>;
  copyVerificationCode: (code: string) => Promise<{ copied: boolean }>;
  getUpdateStatus: () => Promise<DesktopUpdateSnapshot | undefined>;
  checkForUpdates: () => Promise<DesktopUpdateSnapshot | undefined>;
  downloadUpdate: () => Promise<DesktopUpdateSnapshot | undefined>;
  skipUpdate: () => Promise<DesktopUpdateSnapshot | undefined>;
  snoozeUpdate: (durationMinutes: number) => Promise<DesktopUpdateSnapshot | undefined>;
  installUpdate: () => Promise<DesktopUpdateInstallResult>;
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
  if (typeof window === "undefined" || !window.namiDesktop) return undefined;
  const bridge = window.namiDesktop;
  return {
    ...bridge,
    getUpdateStatus: () => bridge.getUpdateStatus().then(normalizeDesktopUpdateSnapshot),
    checkForUpdates: () => bridge.checkForUpdates().then(requireDesktopUpdateSnapshot),
    downloadUpdate: () => bridge.downloadUpdate().then(requireDesktopUpdateSnapshot),
    skipUpdate: () => bridge.skipUpdate().then(requireDesktopUpdateSnapshot),
    snoozeUpdate: (durationMinutes) => bridge.snoozeUpdate(durationMinutes).then(requireDesktopUpdateSnapshot),
    installUpdate: () => bridge.installUpdate().then(normalizeDesktopUpdateInstallResult),
    onUpdateStatus: (listener) => bridge.onUpdateStatus((snapshot) => {
      const normalizedSnapshot = normalizeDesktopUpdateSnapshot(snapshot);
      if (normalizedSnapshot) listener(normalizedSnapshot);
    }),
  };
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
const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);

export function updateBridgeErrorMessage(error: unknown, fallback: string, t: Translate = defaultTranslate): string {
  const evidence = updateErrorEvidence(error);
  if (/invalid desktop updater response|malformed update snapshot/.test(evidence)) {
    return t("update.error.invalidResponse");
  }
  if (/signature|publisher|code.?sign|not signed|certificate.*identity|integrity|sha.?512|manifest/.test(evidence)) {
    return t("update.error.integrity");
  }
  if (/cert_|certificate|self signed|unable to verify|tls|ssl/.test(evidence)) {
    return t("update.error.tls");
  }
  if (/enotfound|eai_again|enetunreach|ehostunreach|econnrefused|econnreset|etimedout|timeout|network/.test(evidence)) {
    return t("update.error.network");
  }
  if (/403|rate[ _-]?limit|forbidden/.test(evidence)) {
    return t("update.error.rateLimited");
  }
  if (/404|not found|no published versions|asset_missing/.test(evidence)) {
    return t("update.error.notFound");
  }
  return fallback;
}
