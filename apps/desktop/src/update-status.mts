export type DesktopUpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type DesktopUpdateSuppression = "none" | "skipped" | "snoozed";

export type DesktopUpdateReason =
  | "initializing"
  | "disabled"
  | "unpackaged"
  | "platformUnsupported"
  | "sourceUnconfigured"
  | "trustUnavailable"
  | "scheduled"
  | "checking"
  | "upToDate"
  | "releaseAvailable"
  | "downloading"
  | "downloadReady"
  | "network"
  | "tls"
  | "releaseUnavailable"
  | "rateLimited"
  | "signatureInvalid"
  | "integrityInvalid"
  | "archiveIntegrityInvalid"
  | "mailDataBusy"
  | "installerNotStarted"
  | "installResult"
  | "unknown";

export type DesktopUpdateInstallStage =
  | "wait"
  | "verify-archive"
  | "extract"
  | "verify-installer"
  | "install"
  | "cleanup"
  | "restart";

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

function updateErrorEvidence(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    return `${code} ${error.name} ${error.message}`.toLowerCase();
  }
  return typeof error === "string" ? error.toLowerCase() : "";
}

export type DesktopUpdateErrorReason = Extract<
  DesktopUpdateReason,
  "network" | "tls" | "signatureInvalid" | "integrityInvalid" | "releaseUnavailable" | "rateLimited" | "unknown"
>;

export function classifyUpdateError(error: unknown): DesktopUpdateErrorReason {
  const evidence = updateErrorEvidence(error);
  if (/signature|publisher|code.?sign|not signed|authenticode|certificate.*identity/.test(evidence)) {
    return "signatureInvalid";
  }
  if (/cert_|certificate|self signed|unable to verify|tls|ssl/.test(evidence)) {
    return "tls";
  }
  if (/integrity|sha.?512|manifest[_ ]invalid|checksum|hash.?mismatch/.test(evidence)) {
    return "integrityInvalid";
  }
  if (/403|rate[ _-]?limit|forbidden/.test(evidence)) {
    return "rateLimited";
  }
  if (/404|not found|no published versions|latest\.ya?ml|asset_missing/.test(evidence)) {
    return "releaseUnavailable";
  }
  if (/enotfound|eai_again|enetunreach|ehostunreach|econnrefused|econnreset|etimedout|timeout|network/.test(evidence)) {
    return "network";
  }
  return "unknown";
}

export function createUpdateSnapshot(
  currentVersion: string,
  phase: DesktopUpdatePhase,
  reason: DesktopUpdateReason,
  patch: Partial<Omit<DesktopUpdateSnapshot, "schemaVersion" | "currentVersion" | "phase" | "reason">> = {},
): DesktopUpdateSnapshot {
  return {
    schemaVersion: 2,
    phase,
    currentVersion,
    targetVersion: null,
    percent: null,
    checkedAt: null,
    suppression: "none",
    remindAt: null,
    reason,
    args: {},
    ...patch,
  };
}
