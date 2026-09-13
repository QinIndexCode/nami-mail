import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Record of an update installation this machine has started but not yet
 * confirmed.
 *
 * The Windows helper deletes its failure record when the installer reports
 * success, so a successful-but-ineffective install (the installer exits 0
 * without replacing the program files, e.g. a security product holding them)
 * used to be indistinguishable from "there was never an update": the next
 * launch simply reported the old version as up to date. Writing the intent
 * before the helper starts lets the next launch tell the two apart.
 */

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const pendingInstallSchemaVersion = 1;

/**
 * How long a record is left unjudged. The helper waits up to 90 seconds for the
 * app to exit and then runs the installer, so a launch that happens inside this
 * window must not be read as "the install did nothing".
 */
export const pendingInstallObservationDelayMs = 2 * 60 * 1_000;

export type PendingUpdateInstall = {
  schemaVersion: 1;
  fromVersion: string;
  toVersion: string;
  startedAt: string;
};

export type PendingUpdateInstallOutcome =
  /** This process is already the target version: the install took effect. */
  | "landed"
  /** Recorded too recently to judge; the helper may still be installing. */
  | "pending"
  /** The installer finished without changing the running version. */
  | "not-applied"
  /** The record cannot describe this process (corrupt, downgrade, or a no-op record). */
  | "invalid";

export function pendingUpdateInstallPath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "pending-install.json");
}

function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && stableVersionPattern.test(value);
}

export function parsePendingUpdateInstall(value: unknown): PendingUpdateInstall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<PendingUpdateInstall>;
  if (
    candidate.schemaVersion !== pendingInstallSchemaVersion
    || !isStableVersion(candidate.fromVersion)
    || !isStableVersion(candidate.toVersion)
    || typeof candidate.startedAt !== "string"
    || !timestampPattern.test(candidate.startedAt)
    || !Number.isFinite(Date.parse(candidate.startedAt))
  ) {
    return undefined;
  }
  return {
    schemaVersion: pendingInstallSchemaVersion,
    fromVersion: candidate.fromVersion,
    toVersion: candidate.toVersion,
    startedAt: candidate.startedAt,
  };
}

export function resolvePendingUpdateInstall(
  record: PendingUpdateInstall,
  currentVersion: string,
  now = Date.now(),
  observationDelayMs = pendingInstallObservationDelayMs,
): PendingUpdateInstallOutcome {
  // A record that cannot name two distinct versions can never describe an
  // upgrade this process should be judged against.
  if (record.fromVersion === record.toVersion) return "invalid";
  if (currentVersion === record.toVersion) return "landed";
  // Any third version (a downgrade, or a release installed by other means)
  // makes the record meaningless rather than evidence of a failed install.
  if (currentVersion !== record.fromVersion) return "invalid";
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) return "invalid";
  const delay = Math.max(0, Math.trunc(observationDelayMs));
  return now - startedAt < delay ? "pending" : "not-applied";
}

export class PendingUpdateInstallStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<PendingUpdateInstall | undefined> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch {
      // A missing or unreadable record means "no pending install", never a
      // startup failure: the updater must stay available either way.
      return undefined;
    }
    try {
      const record = parsePendingUpdateInstall(JSON.parse(contents));
      if (record) return record;
    } catch {
      // Fall through: an unparseable record is discarded below.
    }
    await this.clear();
    return undefined;
  }

  async write(record: PendingUpdateInstall): Promise<void> {
    const parsed = parsePendingUpdateInstall(record);
    if (!parsed) throw new Error("The pending update install record is invalid.");
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
