export const defaultUpdateCheckIntervalMs = 6 * 60 * 60 * 1_000;
export const defaultUpdateRetryBaseDelayMs = 60 * 1_000;
export const defaultUpdateRetryMaxDelayMs = 60 * 60 * 1_000;

export function jitteredDelay(
  delayMs: number,
  random: () => number = Math.random,
  ratio = 0.2,
  maximumMs = Number.MAX_SAFE_INTEGER,
): number {
  const boundedDelay = Math.max(1_000, Math.min(maximumMs, Math.round(delayMs)));
  const boundedRatio = Math.max(0, Math.min(0.5, ratio));
  const minimum = Math.max(1_000, Math.round(boundedDelay * (1 - boundedRatio)));
  const maximum = Math.max(minimum, Math.min(maximumMs, Math.round(boundedDelay * (1 + boundedRatio))));
  const sample = Math.max(0, Math.min(1, random()));
  return Math.round(minimum + ((maximum - minimum) * sample));
}

export function updateRetryDelay(
  consecutiveFailures: number,
  options: {
    baseDelayMs?: number;
    maximumDelayMs?: number;
    random?: () => number;
  } = {},
): number {
  const baseDelayMs = Math.max(1_000, options.baseDelayMs ?? defaultUpdateRetryBaseDelayMs);
  const maximumDelayMs = Math.max(baseDelayMs, options.maximumDelayMs ?? defaultUpdateRetryMaxDelayMs);
  const exponent = Math.max(0, Math.min(30, Math.trunc(consecutiveFailures) - 1));
  const exponentialDelay = Math.min(maximumDelayMs, baseDelayMs * (2 ** exponent));
  return jitteredDelay(exponentialDelay, options.random, 0.2, maximumDelayMs);
}

export type PreparedUpdateInstallResult = "not-prepared" | "installer-not-started" | "started";

export async function prepareAndBeginUpdateInstall(
  prepareForInstall: () => Promise<boolean>,
  startInstaller: () => boolean | Promise<boolean>,
  quitApplication: () => void,
  recoverPreparedApplication: () => void,
): Promise<PreparedUpdateInstallResult> {
  const prepared = await prepareForInstall();
  if (!prepared) return "not-prepared";

  let installerStarted: boolean;
  try {
    installerStarted = await startInstaller();
  } catch (error) {
    recoverPreparedApplication();
    throw error;
  }

  if (!installerStarted) {
    recoverPreparedApplication();
    return "installer-not-started";
  }

  quitApplication();
  return "started";
}
