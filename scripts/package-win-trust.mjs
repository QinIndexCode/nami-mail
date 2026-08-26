/**
 * Kill-safe injection of the update trust config for scripts/package-win.mjs.
 * The packaged app ships build/nami-update-trust.json via extraResources, and
 * GitHub ZIP builds swap in a real Ed25519 key before packaging. Mutating a
 * tracked file means a hard kill (CI timeout, Ctrl+C at the wrong moment)
 * would leave the injected key behind; the sidecar records the original
 * state so the next packaging run heals it before doing anything else.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const TRUST_SIDECAR_SUFFIX = ".package-win-original";

export function resolveTrustPaths(projectRoot, suffix = TRUST_SIDECAR_SUFFIX) {
  const trustConfigPath = path.join(projectRoot, "build", "nami-update-trust.json");
  return { trustConfigPath, sidecarPath: `${trustConfigPath}${suffix}` };
}

/**
 * Restores the trust config to its pre-injection state. An empty sidecar
 * means the trust file did not exist before the injection, so it is removed
 * rather than rewritten. Returns true when a stale injection was healed.
 */
export async function healTrustInjection({ trustConfigPath, sidecarPath }) {
  let original;
  try {
    original = await fs.readFile(sidecarPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (original.length === 0) {
    await fs.rm(trustConfigPath, { force: true });
  } else {
    await fs.writeFile(trustConfigPath, original, { encoding: "utf8", mode: 0o644 });
  }
  await fs.rm(sidecarPath, { force: true });
  return true;
}

/**
 * Records the pre-injection state (healing any earlier stale injection
 * first) so a killed run can be repaired by the next one.
 */
export async function beginTrustInjection({ trustConfigPath, sidecarPath, originalTrustConfig }) {
  await healTrustInjection({ trustConfigPath, sidecarPath });
  await fs.writeFile(sidecarPath, originalTrustConfig ?? "", { encoding: "utf8", mode: 0o600 });
}

/** Restores the pre-injection state and clears the sidecar. Idempotent. */
export async function restoreTrustInjection({ trustConfigPath, sidecarPath }) {
  await healTrustInjection({ trustConfigPath, sidecarPath });
}
