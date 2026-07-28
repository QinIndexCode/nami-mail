import path from "node:path";

export function resolveInstallerSmokeBaseDirectory(projectRoot) {
  return path.join(path.resolve(projectRoot), ".nami-installer-smoke");
}
