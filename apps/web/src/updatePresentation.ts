import type { DesktopUpdateSnapshot } from "./desktop";
import type { Translate } from "./i18n";

export type UpdatePromptPresentation = {
  eyebrow: string;
  title: string;
  description: string;
};

export type UpdatePresentation = {
  prompt: UpdatePromptPresentation;
  status: string;
  isError: boolean;
  isInstalledCleanupResult: boolean;
  cleanupComplete: boolean;
};

function versionLabel(version: string | null, t: Translate): string {
  return version ? `v${version}` : t("update.prompt.newVersion");
}

function updateVersion(snapshot: DesktopUpdateSnapshot): string {
  return snapshot.targetVersion ?? snapshot.currentVersion;
}

export function isInstalledCleanupResult(snapshot: DesktopUpdateSnapshot): boolean {
  return snapshot.reason === "installResult" && snapshot.args.installStage === "cleanup";
}

function installStageLabel(snapshot: DesktopUpdateSnapshot, t: Translate): string {
  const stage = snapshot.args.installStage;
  if (!stage) return t("update.installStage.unknown");
  return t(`update.installStage.${stage}`);
}

function updateStatus(snapshot: DesktopUpdateSnapshot, t: Translate): string {
  const version = updateVersion(snapshot);
  if (isInstalledCleanupResult(snapshot)) {
    return snapshot.args.cleanupComplete
      ? t("update.status.cleanupComplete")
      : t("update.status.cleanupPending");
  }

  switch (snapshot.reason) {
    case "initializing":
      return t("update.status.initializing");
    case "disabled":
      return t("update.status.disabled");
    case "unpackaged":
      return t("update.status.unpackaged");
    case "platformUnsupported":
      return t("update.status.platformUnsupported");
    case "sourceUnconfigured":
      return t("update.status.sourceUnconfigured");
    case "trustUnavailable":
      return t("update.status.trustUnavailable");
    case "scheduled":
      return t("update.status.scheduled");
    case "checking":
      return t("update.status.checking");
    case "upToDate":
      return t("update.status.upToDate", { version });
    case "releaseAvailable":
      return t("update.status.releaseAvailable", { version });
    case "downloading":
      return t("update.status.downloading", { version, percent: snapshot.percent ?? 0 });
    case "downloadReady":
      return t("update.status.downloadReady", { version });
    case "network":
      return t("update.status.network");
    case "tls":
      return t("update.status.tls");
    case "releaseUnavailable":
      return t("update.status.releaseUnavailable");
    case "rateLimited":
      return t("update.status.rateLimited");
    case "signatureInvalid":
      return t("update.status.signatureInvalid");
    case "integrityInvalid":
      return t("update.status.integrityInvalid");
    case "archiveIntegrityInvalid":
      return t("update.status.archiveIntegrityInvalid");
    case "mailDataBusy":
      return t("update.status.mailDataBusy");
    case "installerNotStarted":
      return t("update.status.installerNotStarted");
    case "installResult":
      return t("update.status.installResult", { stage: installStageLabel(snapshot, t) });
    case "unknown":
      return t("update.status.unknown");
  }
}

function promptPresentation(
  snapshot: DesktopUpdateSnapshot,
  status: string,
  installedCleanupResult: boolean,
  t: Translate,
): UpdatePromptPresentation {
  const version = versionLabel(snapshot.targetVersion, t);
  if (installedCleanupResult) {
    return {
      eyebrow: t("update.prompt.complete.eyebrow"),
      title: t("update.prompt.complete.title", { version }),
      description: t("update.prompt.complete.description"),
    };
  }
  if (snapshot.phase === "downloading") {
    return {
      eyebrow: t("update.prompt.downloading.eyebrow"),
      title: t("update.prompt.downloading.title", { version }),
      description: t("update.prompt.downloading.description"),
    };
  }
  if (snapshot.phase === "ready") {
    return {
      eyebrow: t("update.prompt.ready.eyebrow"),
      title: t("update.prompt.ready.title", { version }),
      description: t("update.prompt.ready.description"),
    };
  }
  if (snapshot.phase === "checking") {
    return {
      eyebrow: t("update.prompt.checking.eyebrow"),
      title: t("update.prompt.checking.title"),
      description: t("update.prompt.checking.description"),
    };
  }
  if (snapshot.phase === "error") {
    return {
      eyebrow: t("update.prompt.error.eyebrow"),
      title: t("update.prompt.error.title"),
      description: t("update.prompt.error.description", { version }),
    };
  }
  if (snapshot.phase === "up-to-date") {
    return {
      eyebrow: t("update.prompt.upToDate.eyebrow"),
      title: t("update.prompt.upToDate.title", { version }),
      description: status,
    };
  }
  return {
    eyebrow: t("update.prompt.available.eyebrow"),
    title: t("update.prompt.available.title", { version }),
    description: t("update.prompt.available.description"),
  };
}

/**
 * Converts the versioned desktop update contract into user-facing, localized
 * copy. The renderer never consumes updater-provided free-form text.
 */
export function presentUpdateSnapshot(snapshot: DesktopUpdateSnapshot, t: Translate): UpdatePresentation {
  const installedCleanupResult = isInstalledCleanupResult(snapshot);
  const status = updateStatus(snapshot, t);
  return {
    prompt: promptPresentation(snapshot, status, installedCleanupResult, t),
    status,
    isError: snapshot.phase === "error" && !installedCleanupResult,
    isInstalledCleanupResult: installedCleanupResult,
    cleanupComplete: installedCleanupResult && snapshot.args.cleanupComplete === true,
  };
}
