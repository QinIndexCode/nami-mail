import fs from "node:fs/promises";
import path from "node:path";

export async function resolveLocalWindowsElectronDist(projectRoot) {
  const electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
  const electronExecutable = path.join(electronDist, "electron.exe");
  try {
    const executable = await fs.stat(electronExecutable);
    return executable.isFile() ? electronDist : undefined;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}
