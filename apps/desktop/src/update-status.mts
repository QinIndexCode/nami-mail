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

export type DesktopUpdateSnapshot = {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  targetVersion: string | null;
  percent: number | null;
  checkedAt: string | null;
  suppression: DesktopUpdateSuppression;
  remindAt: string | null;
  message: string;
};

function updateErrorEvidence(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    return `${code} ${error.name} ${error.message}`.toLowerCase();
  }
  return typeof error === "string" ? error.toLowerCase() : "";
}

export function describeUpdateError(error: unknown): string {
  const evidence = updateErrorEvidence(error);
  if (/signature|publisher|code.?sign|not signed|certificate.*identity/.test(evidence)) {
    return "更新包签名验证失败，Nami Mail 已拒绝安装。请等待发布方修复。";
  }
  if (/cert_|certificate|self signed|unable to verify|tls|ssl/.test(evidence)) {
    return "更新服务的证书验证失败。请检查系统时间、代理或安全软件后重试。";
  }
  if (/enotfound|eai_again|enetunreach|ehostunreach|econnrefused|econnreset|etimedout|timeout|network/.test(evidence)) {
    return "无法连接更新服务。请检查网络、代理或 DNS 后重试。";
  }
  if (/404|not found|no published versions|latest\.ya?ml|asset_missing/.test(evidence)) {
    return "更新渠道暂不可用，尚未找到可安装的正式版本。";
  }
  if (/403|rate[ _-]?limit|forbidden/.test(evidence)) {
    return "更新服务暂时限制了请求，请稍后再试。";
  }
  if (/integrity|sha.?512|manifest_invalid|signature|authenticode/.test(evidence)) {
    return "更新包完整性校验失败，Nami Mail 已拒绝安装。请等待发布方修复。";
  }
  return "无法完成更新检查，请稍后重试。";
}

export function createUpdateSnapshot(
  currentVersion: string,
  phase: DesktopUpdatePhase,
  message: string,
  patch: Partial<Omit<DesktopUpdateSnapshot, "currentVersion" | "phase" | "message">> = {},
): DesktopUpdateSnapshot {
  return {
    phase,
    currentVersion,
    targetVersion: null,
    percent: null,
    checkedAt: null,
    suppression: "none",
    remindAt: null,
    message,
    ...patch,
  };
}
