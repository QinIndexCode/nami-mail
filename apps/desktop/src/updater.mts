import path from "node:path";
import {
  discoverGitHubZipUpdate,
  downloadGitHubZipUpdate,
  hasVerifiedCachedUpdate,
  loadGitHubUpdateSource,
  removeCachedGitHubZipUpdate,
  type GitHubZipUpdate,
} from "./github-zip-update.mjs";
import {
  resolveUpdatePromptPolicy,
  skipUpdateVersion,
  snoozeUpdateVersion,
  UpdatePreferencesStore,
} from "./update-preferences.mjs";
import {
  defaultUpdateCheckIntervalMs,
  defaultUpdateRetryBaseDelayMs,
  defaultUpdateRetryMaxDelayMs,
  jitteredDelay,
  prepareAndBeginUpdateInstall,
  updateRetryDelay,
} from "./update-policy.mjs";
import {
  removeUpdateVersionCache,
  UpdateInstallResultStore,
  updateInstallResultPath,
  type UpdateInstallFailure,
} from "./update-install-result.mjs";
import { classifyUpdateError, createUpdateSnapshot, type DesktopUpdateSnapshot } from "./update-status.mjs";
import { loadEd25519UpdateTrust, verifyEd25519UpdateManifest, type Ed25519UpdateTrust } from "./update-trust.mjs";
import {
  launchZipUpdateInstaller,
  readTrustedWindowsSigner,
  type TrustedWindowsSigner,
  type ZipUpdateInstallerTrust,
  type ZipUpdateInstallerPlan,
} from "./zip-update-installer.mjs";

type DesktopUpdaterOptions = {
  currentVersion: string;
  isPackaged: boolean;
  updateConfigPath: string;
  updateTrustPath: string;
  userDataPath: string;
  executablePath: string;
  disabled: boolean;
  platform?: NodeJS.Platform;
  automaticCheckDelayMs?: number;
  periodicCheckIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  random?: () => number;
  now?: () => number;
  fetchImpl?: typeof globalThis.fetch;
  readTrustedSigner?: (executablePath: string) => Promise<TrustedWindowsSigner | undefined>;
  launchInstaller?: (plan: ZipUpdateInstallerPlan) => Promise<boolean>;
  removeCachedVersion?: typeof removeUpdateVersionCache;
  broadcast: (snapshot: DesktopUpdateSnapshot) => void;
  prepareForInstall: () => Promise<boolean>;
  recoverAfterInstallFailure: () => void;
  quitForInstall: () => void;
};

const defaultAutomaticCheckDelayMs = 3_000;
const updateCacheDirectoryName = "updates";
const updatePreferencesFileName = "update-preferences.json";

export class DesktopUpdater {
  private snapshot: DesktopUpdateSnapshot;
  private started = false;
  private enabled = false;
  private disposed = false;
  private checkPromise: Promise<DesktopUpdateSnapshot> | undefined;
  private downloadPromise: Promise<DesktopUpdateSnapshot> | undefined;
  private automaticCheckTimer: NodeJS.Timeout | undefined;
  private consecutiveCheckFailures = 0;
  private readonly preferences: UpdatePreferencesStore;
  private readonly installResults: UpdateInstallResultStore;
  private readonly cacheDirectory: string;
  private update: GitHubZipUpdate | undefined;
  private updateTrust: { kind: "authenticode"; signer: TrustedWindowsSigner } | { kind: "ed25519"; trust: Ed25519UpdateTrust } | undefined;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.snapshot = createUpdateSnapshot(
      options.currentVersion,
      "unavailable",
      "initializing",
    );
    this.cacheDirectory = path.join(options.userDataPath, updateCacheDirectoryName);
    this.preferences = new UpdatePreferencesStore(path.join(options.userDataPath, updatePreferencesFileName));
    this.installResults = new UpdateInstallResultStore(updateInstallResultPath(this.cacheDirectory));
  }

  getSnapshot(): DesktopUpdateSnapshot {
    return { ...this.snapshot, args: { ...this.snapshot.args } };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private publish(snapshot: DesktopUpdateSnapshot): DesktopUpdateSnapshot {
    this.snapshot = snapshot;
    this.options.broadcast(this.getSnapshot());
    return this.getSnapshot();
  }

  private transition(
    phase: DesktopUpdateSnapshot["phase"],
    reason: DesktopUpdateSnapshot["reason"],
    patch: Partial<Omit<DesktopUpdateSnapshot, "schemaVersion" | "currentVersion" | "phase" | "reason">> = {},
  ): DesktopUpdateSnapshot {
    return this.publish(createUpdateSnapshot(this.options.currentVersion, phase, reason, {
      targetVersion: this.snapshot.targetVersion,
      checkedAt: this.snapshot.checkedAt,
      suppression: this.snapshot.suppression,
      remindAt: this.snapshot.remindAt,
      ...patch,
    }));
  }

  private clearCachedVersion(version: string): Promise<boolean> {
    return (this.options.removeCachedVersion ?? removeUpdateVersionCache)(this.cacheDirectory, version);
  }

  private async publishInstallResult(installFailure: UpdateInstallFailure): Promise<DesktopUpdateSnapshot> {
    const cacheCleared = await this.clearCachedVersion(installFailure.version);
    if (cacheCleared) await this.installResults.clearFailure();
    if (installFailure.stage === "cleanup" && cacheCleared) {
      return this.transition("up-to-date", "installResult", {
        targetVersion: this.options.currentVersion,
        checkedAt: installFailure.occurredAt,
        percent: null,
        suppression: "none",
        remindAt: null,
        args: { installStage: "cleanup", cleanupComplete: true },
      });
    }
    return this.transition("error", "installResult", {
      targetVersion: installFailure.version,
      checkedAt: installFailure.occurredAt,
      percent: null,
      suppression: "none",
      remindAt: null,
      args: installFailure.stage === "cleanup"
        ? { installStage: "cleanup", cleanupComplete: false }
        : { installStage: installFailure.stage },
    });
  }

  private clearScheduledCheck(): void {
    if (this.automaticCheckTimer) clearTimeout(this.automaticCheckTimer);
    this.automaticCheckTimer = undefined;
  }

  private scheduleCheck(delayMs: number): void {
    if (!this.enabled || this.disposed || this.snapshot.phase === "downloading" || (this.snapshot.phase === "ready" && this.snapshot.suppression === "none")) return;
    this.clearScheduledCheck();
    this.automaticCheckTimer = setTimeout(() => {
      this.automaticCheckTimer = undefined;
      void this.checkForUpdates();
    }, Math.max(1_000, delayMs));
    this.automaticCheckTimer.unref();
  }

  private schedulePeriodicCheck(): void {
    this.consecutiveCheckFailures = 0;
    const intervalMs = Math.max(60_000, this.options.periodicCheckIntervalMs ?? defaultUpdateCheckIntervalMs);
    const reminderDelay = this.snapshot.suppression === "snoozed" && this.snapshot.remindAt
      ? Math.max(1_000, Date.parse(this.snapshot.remindAt) - this.now())
      : intervalMs;
    this.scheduleCheck(Math.min(jitteredDelay(intervalMs, this.options.random, 0.1), reminderDelay));
  }

  private scheduleRetry(): void {
    if (this.automaticCheckTimer || !this.enabled || this.disposed) return;
    this.consecutiveCheckFailures += 1;
    this.scheduleCheck(updateRetryDelay(this.consecutiveCheckFailures, {
      baseDelayMs: this.options.retryBaseDelayMs ?? defaultUpdateRetryBaseDelayMs,
      maximumDelayMs: this.options.retryMaxDelayMs ?? defaultUpdateRetryMaxDelayMs,
      random: this.options.random,
    }));
  }

  async start(): Promise<DesktopUpdateSnapshot> {
    if (this.started) return this.getSnapshot();
    this.started = true;

    if (this.options.disabled) {
      return this.transition("unavailable", "disabled", { percent: null });
    }
    if (!this.options.isPackaged) {
      return this.transition("unavailable", "unpackaged", { percent: null });
    }
    if ((this.options.platform ?? process.platform) !== "win32") {
      return this.transition("unavailable", "platformUnsupported", { percent: null });
    }
    try {
      const source = await loadGitHubUpdateSource(this.options.updateConfigPath);
      if (!source) {
        return this.transition("unavailable", "sourceUnconfigured", { percent: null });
      }
      const trustedSigner = await (this.options.readTrustedSigner ?? readTrustedWindowsSigner)(this.options.executablePath);
      if (trustedSigner) {
        this.updateTrust = { kind: "authenticode", signer: trustedSigner };
      } else {
        const ed25519Trust = await loadEd25519UpdateTrust(this.options.updateTrustPath);
        if (!ed25519Trust) {
          return this.transition(
            "unavailable",
            "trustUnavailable",
            { percent: null },
          );
        }
        this.updateTrust = { kind: "ed25519", trust: ed25519Trust };
      }
      await this.preferences.load();
      this.enabled = true;
      const installFailure = await this.installResults.readFailure();
      if (installFailure) {
        // A failed helper may leave its randomly named PowerShell file, the
        // extracted installer, or the ZIP behind. Clear only the validated
        // version directory and keep the recovery record when Windows still
        // has a file locked, so a later startup can retry safely.
        await this.publishInstallResult(installFailure);
      } else {
        this.transition("idle", "scheduled", { percent: null });
      }
      this.scheduleCheck(Math.max(1_000, this.options.automaticCheckDelayMs ?? defaultAutomaticCheckDelayMs));
      return this.getSnapshot();
    } catch (error) {
      return this.transition("unavailable", classifyUpdateError(error), { percent: null });
    }
  }

  private publishAvailableUpdate(update: GitHubZipUpdate, cached: boolean): DesktopUpdateSnapshot {
    const policy = resolveUpdatePromptPolicy(this.preferences.get(), update.version, this.now());
    if (cached) {
      return this.transition("ready", "downloadReady", {
        targetVersion: update.version,
        checkedAt: new Date(this.now()).toISOString(),
        percent: 100,
        suppression: policy.suppression,
        remindAt: policy.remindAt,
      });
    }
    return this.transition("available", "releaseAvailable", {
      targetVersion: update.version,
      checkedAt: new Date(this.now()).toISOString(),
      percent: null,
      suppression: policy.suppression,
      remindAt: policy.remindAt,
    });
  }

  async checkForUpdates(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled) return this.getSnapshot();
    if (this.snapshot.phase === "downloading" || (this.snapshot.phase === "ready" && this.snapshot.suppression === "none")) return this.getSnapshot();
    if (this.checkPromise) return this.checkPromise;
    this.clearScheduledCheck();

    this.checkPromise = (async () => {
      try {
        const installFailure = await this.installResults.readFailure();
        if (installFailure?.stage === "cleanup") {
          const cleanupResult = await this.publishInstallResult(installFailure);
          this.schedulePeriodicCheck();
          return cleanupResult;
        }
        this.transition("checking", "checking", {
          percent: null,
          suppression: "none",
          remindAt: null,
        });
        const source = await loadGitHubUpdateSource(this.options.updateConfigPath);
        if (!source) {
          this.transition("error", "sourceUnconfigured", { percent: null, suppression: "none", remindAt: null });
          this.scheduleRetry();
          return this.getSnapshot();
        }
        const updateTrust = this.updateTrust;
        if (!updateTrust) {
          this.transition("error", "trustUnavailable", { percent: null, suppression: "none", remindAt: null });
          this.scheduleRetry();
          return this.getSnapshot();
        }
        const update = await discoverGitHubZipUpdate({
          source,
          currentVersion: this.options.currentVersion,
          fetchImpl: this.options.fetchImpl,
          verifyManifestSignature: updateTrust.kind === "ed25519"
            ? (input) => verifyEd25519UpdateManifest(updateTrust.trust, input)
            : undefined,
        });
        if (!update) {
          this.update = undefined;
          this.transition("up-to-date", "upToDate", {
            targetVersion: this.options.currentVersion,
            checkedAt: new Date(this.now()).toISOString(),
            percent: null,
            suppression: "none",
            remindAt: null,
          });
        } else {
          this.update = update;
          const policy = resolveUpdatePromptPolicy(this.preferences.get(), update.version, this.now());
          const cached = policy.suppression !== "skipped" && await hasVerifiedCachedUpdate(this.cacheDirectory, update);
          if (policy.suppression === "skipped") await removeCachedGitHubZipUpdate(this.cacheDirectory, update);
          this.publishAvailableUpdate(update, cached);
        }
        this.schedulePeriodicCheck();
      } catch (error) {
        this.transition("error", classifyUpdateError(error), { percent: null, suppression: "none", remindAt: null });
        this.scheduleRetry();
      } finally {
        this.checkPromise = undefined;
      }
      return this.getSnapshot();
    })();
    return this.checkPromise;
  }

  async downloadAvailableUpdate(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled || !this.update || this.snapshot.phase !== "available" || this.snapshot.suppression !== "none") return this.getSnapshot();
    if (this.downloadPromise) return this.downloadPromise;
    this.clearScheduledCheck();
    const update = this.update;
    this.downloadPromise = (async () => {
      try {
        this.transition("downloading", "downloading", {
          targetVersion: update.version,
          percent: 0,
          suppression: "none",
          remindAt: null,
        });
        await downloadGitHubZipUpdate({
          cacheDirectory: this.cacheDirectory,
          update,
          fetchImpl: this.options.fetchImpl,
          onProgress: (progress) => {
            this.transition("downloading", "downloading", {
              targetVersion: update.version,
              percent: progress.percent,
            });
          },
        });
        this.publishAvailableUpdate(update, true);
      } catch (error) {
        this.transition("error", classifyUpdateError(error), { targetVersion: update.version, percent: null });
        this.scheduleRetry();
      } finally {
        this.downloadPromise = undefined;
      }
      return this.getSnapshot();
    })();
    return this.downloadPromise;
  }

  async skipAvailableUpdate(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled || !this.update || !["available", "ready"].includes(this.snapshot.phase)) return this.getSnapshot();
    const update = this.update;
    await this.preferences.save(skipUpdateVersion(this.preferences.get(), update.version));
    await removeCachedGitHubZipUpdate(this.cacheDirectory, update);
    this.publishAvailableUpdate(update, false);
    this.schedulePeriodicCheck();
    return this.getSnapshot();
  }

  async snoozeAvailableUpdate(durationMinutes: number): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled || !this.update || !["available", "ready"].includes(this.snapshot.phase)) return this.getSnapshot();
    try {
      await this.preferences.save(snoozeUpdateVersion(this.preferences.get(), this.update.version, durationMinutes, this.now()));
      const cached = await hasVerifiedCachedUpdate(this.cacheDirectory, this.update);
      this.publishAvailableUpdate(this.update, cached);
      this.schedulePeriodicCheck();
    } catch (error) {
      this.transition("error", classifyUpdateError(error), { percent: null });
    }
    return this.getSnapshot();
  }

  checkAfterExternalTrigger(): Promise<DesktopUpdateSnapshot> {
    if (!this.enabled || this.snapshot.phase === "downloading" || (this.snapshot.phase === "ready" && this.snapshot.suppression === "none")) {
      return Promise.resolve(this.getSnapshot());
    }
    this.clearScheduledCheck();
    return this.checkForUpdates();
  }

  async installDownloadedUpdate(): Promise<{ accepted: boolean; snapshot: DesktopUpdateSnapshot }> {
    if (!this.enabled || !this.update || !this.updateTrust || this.snapshot.phase !== "ready" || this.snapshot.suppression !== "none") {
      return { accepted: false, snapshot: this.getSnapshot() };
    }
    const update = this.update;
    const updateTrust = this.updateTrust;
    if (!updateTrust) return { accepted: false, snapshot: this.getSnapshot() };
    const archivePath = path.join(this.cacheDirectory, update.version, update.archiveName);
    if (!await hasVerifiedCachedUpdate(this.cacheDirectory, update)) {
      const snapshot = this.transition("error", "archiveIntegrityInvalid", { percent: null });
      return { accepted: false, snapshot };
    }
    try {
      const result = await prepareAndBeginUpdateInstall(
        this.options.prepareForInstall,
        () => (this.options.launchInstaller ?? launchZipUpdateInstaller)({
          cacheDirectory: this.cacheDirectory,
          archivePath,
          archiveSize: update.archiveSize,
          archiveSha512: update.archiveSha512,
          targetVersion: update.version,
          installerName: update.installerName,
          currentExecutablePath: this.options.executablePath,
          trust: updateTrust.kind === "authenticode"
            ? { kind: "authenticode", signer: updateTrust.signer }
            : { kind: "ed25519" } as ZipUpdateInstallerTrust,
          parentProcessId: process.pid,
        }),
        this.options.quitForInstall,
        this.options.recoverAfterInstallFailure,
      );
      if (result === "not-prepared") {
        const snapshot = this.transition(
          "error",
          "mailDataBusy",
          { percent: null },
        );
        return { accepted: false, snapshot };
      }
      if (result === "installer-not-started") {
        const snapshot = this.transition("error", "installerNotStarted", { percent: null });
        return { accepted: false, snapshot };
      }
      return { accepted: true, snapshot: this.getSnapshot() };
    } catch (error) {
      const snapshot = this.transition("error", classifyUpdateError(error), { percent: null });
      return { accepted: false, snapshot };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.clearScheduledCheck();
  }
}
