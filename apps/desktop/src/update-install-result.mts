import fs from "node:fs/promises";
import path from "node:path";

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const occurredAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

export const updateInstallFailureStages = [
  "wait",
  "verify-archive",
  "extract",
  "verify-installer",
  "install",
  "cleanup",
  "restart",
] as const;

export type UpdateInstallFailureStage = typeof updateInstallFailureStages[number];

export type UpdateInstallFailure = {
  schemaVersion: 1;
  version: string;
  stage: UpdateInstallFailureStage;
  occurredAt: string;
};

const failureStageSet = new Set<string>(updateInstallFailureStages);

export function updateInstallResultPath(cacheDirectory: string): string {
  return path.join(cacheDirectory, "install-result.json");
}

export async function removeUpdateVersionCache(cacheDirectory: string, version: string): Promise<boolean> {
  if (!path.isAbsolute(cacheDirectory) || !stableVersionPattern.test(version)) return false;
  const versionDirectory = path.join(cacheDirectory, version);
  const relative = path.relative(cacheDirectory, versionDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    await fs.rm(versionDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  } catch {
    return false;
  }
  try {
    await fs.access(versionDirectory);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function parseUpdateInstallFailure(value: unknown): UpdateInstallFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<UpdateInstallFailure>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.version !== "string"
    || !stableVersionPattern.test(candidate.version)
    || typeof candidate.stage !== "string"
    || !failureStageSet.has(candidate.stage)
    || typeof candidate.occurredAt !== "string"
    || !occurredAtPattern.test(candidate.occurredAt)
    || !Number.isFinite(Date.parse(candidate.occurredAt))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    version: candidate.version,
    stage: candidate.stage as UpdateInstallFailureStage,
    occurredAt: candidate.occurredAt,
  };
}

export class UpdateInstallResultStore {
  constructor(private readonly resultPath: string) {}

  async readFailure(): Promise<UpdateInstallFailure | undefined> {
    let contents: string;
    try {
      contents = await fs.readFile(this.resultPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
    try {
      const failure = parseUpdateInstallFailure(JSON.parse(contents));
      if (failure) return failure;
    } catch {
      // Invalid helper output cannot be trusted or retried.
    }
    await this.clearFailure();
    return undefined;
  }

  async clearFailure(): Promise<void> {
    await fs.rm(this.resultPath, { force: true }).catch(() => undefined);
  }

  async consumeFailure(): Promise<UpdateInstallFailure | undefined> {
    const failure = await this.readFailure();
    if (failure) await this.clearFailure();
    return failure;
  }
}

export function describeUpdateInstallFailure(failure: UpdateInstallFailure): string {
  const stageLabel: Record<UpdateInstallFailureStage, string> = {
    wait: "等待应用关闭时中断",
    "verify-archive": "更新包校验未通过",
    extract: "更新包解压未完成",
    "verify-installer": "安装程序验证未通过",
    install: "安装程序未能完成",
    cleanup: "更新已安装，但临时文件清理未完成",
    restart: "旧版本未能自动重新打开",
  };
  if (failure.stage === "restart") {
    return `v${failure.version} 更新未完成，且旧版本未能自动重新打开。请手动启动 Nami Mail 后重新检查更新。`;
  }
  if (failure.stage === "cleanup") {
    return `v${failure.version} 已安装，但临时更新文件未能完全清理。请在关闭其他 Nami Mail 进程后重新检查更新。`;
  }
  return `v${failure.version} 更新未完成（${stageLabel[failure.stage]}）。已恢复当前版本，请重新检查并下载更新。`;
}
