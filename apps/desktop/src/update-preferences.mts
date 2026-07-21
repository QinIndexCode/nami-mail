import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const preferenceSchemaVersion = 1;

export type StoredUpdatePreferences = {
  schemaVersion: 1;
  skippedVersion: string | null;
  snoozedVersion: string | null;
  snoozedUntil: string | null;
};

export type UpdatePromptPolicy = {
  suppression: "none" | "skipped" | "snoozed";
  remindAt: string | null;
};

function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && stableVersionPattern.test(value);
}

function validFutureTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

export function emptyUpdatePreferences(): StoredUpdatePreferences {
  return {
    schemaVersion: preferenceSchemaVersion,
    skippedVersion: null,
    snoozedVersion: null,
    snoozedUntil: null,
  };
}

export function normalizeUpdatePreferences(value: unknown): StoredUpdatePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyUpdatePreferences();
  const candidate = value as Partial<StoredUpdatePreferences>;
  if (candidate.schemaVersion !== preferenceSchemaVersion) return emptyUpdatePreferences();
  const skippedVersion = isStableVersion(candidate.skippedVersion) ? candidate.skippedVersion : null;
  const snoozedVersion = isStableVersion(candidate.snoozedVersion) ? candidate.snoozedVersion : null;
  const snoozedUntil = validFutureTimestamp(candidate.snoozedUntil);
  return {
    schemaVersion: preferenceSchemaVersion,
    skippedVersion,
    snoozedVersion: snoozedVersion && snoozedUntil ? snoozedVersion : null,
    snoozedUntil: snoozedVersion && snoozedUntil ? snoozedUntil : null,
  };
}

export function resolveUpdatePromptPolicy(
  preferences: StoredUpdatePreferences,
  targetVersion: string,
  now = Date.now(),
): UpdatePromptPolicy {
  if (preferences.skippedVersion === targetVersion) {
    return { suppression: "skipped", remindAt: null };
  }
  if (preferences.snoozedVersion === targetVersion && preferences.snoozedUntil) {
    const remindAt = Date.parse(preferences.snoozedUntil);
    if (Number.isFinite(remindAt) && remindAt > now) {
      return { suppression: "snoozed", remindAt: new Date(remindAt).toISOString() };
    }
  }
  return { suppression: "none", remindAt: null };
}

export function skipUpdateVersion(
  preferences: StoredUpdatePreferences,
  targetVersion: string,
): StoredUpdatePreferences {
  if (!isStableVersion(targetVersion)) throw new Error("Update versions must use stable x.y.z semantic versions.");
  return {
    schemaVersion: preferenceSchemaVersion,
    skippedVersion: targetVersion,
    snoozedVersion: null,
    snoozedUntil: null,
  };
}

export function snoozeUpdateVersion(
  preferences: StoredUpdatePreferences,
  targetVersion: string,
  durationMinutes: number,
  now = Date.now(),
): StoredUpdatePreferences {
  if (!isStableVersion(targetVersion)) throw new Error("Update versions must use stable x.y.z semantic versions.");
  const boundedMinutes = Math.trunc(durationMinutes);
  if (!Number.isFinite(boundedMinutes) || boundedMinutes < 5 || boundedMinutes > 43_200) {
    throw new Error("Update reminder duration must be between 5 minutes and 30 days.");
  }
  const remindAt = new Date(now + boundedMinutes * 60_000).toISOString();
  return {
    schemaVersion: preferenceSchemaVersion,
    skippedVersion: preferences.skippedVersion === targetVersion ? null : preferences.skippedVersion,
    snoozedVersion: targetVersion,
    snoozedUntil: remindAt,
  };
}

export class UpdatePreferencesStore {
  private preferences = emptyUpdatePreferences();

  constructor(private readonly filePath: string) {}

  get(): StoredUpdatePreferences {
    return { ...this.preferences };
  }

  async load(): Promise<StoredUpdatePreferences> {
    try {
      this.preferences = normalizeUpdatePreferences(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.preferences = emptyUpdatePreferences();
      else {
        // A damaged local preference must never prevent the mail client from
        // starting or from offering a newer signed release.
        this.preferences = emptyUpdatePreferences();
      }
    }
    return this.get();
  }

  async save(next: StoredUpdatePreferences): Promise<StoredUpdatePreferences> {
    this.preferences = normalizeUpdatePreferences(next);
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(this.preferences)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return this.get();
  }
}
