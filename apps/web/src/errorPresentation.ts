import { ApiError } from "./api";
import type { Account } from "./types";

export type MailIssueKind =
  | "authentication"
  | "connection"
  | "dns"
  | "local-data"
  | "local-service"
  | "oauth"
  | "protocol"
  | "sync"
  | "tls"
  | "unknown";

export type MailErrorPresentation = {
  kind: MailIssueKind;
  title: string;
  message: string;
  guidance: string;
  retryable: boolean;
};

type ErrorDetails = {
  code?: string;
  message: string;
  status?: number;
};

function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message, status: error.status };
  }

  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; status?: unknown };
    return {
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      message: typeof value.message === "string" ? value.message : "",
      ...(typeof value.status === "number" ? { status: value.status } : {}),
    };
  }

  return { message: typeof error === "string" ? error : "" };
}

function presentation(
  kind: MailIssueKind,
  title: string,
  message: string,
  guidance: string,
  retryable: boolean,
): MailErrorPresentation {
  return { kind, title, message, guidance, retryable };
}

/**
 * Converts the server's stable error codes (and older saved error text) into
 * a short explanation that distinguishes network reachability, server setup,
 * credentials, and TLS verification. Technical socket details stay in logs.
 */
export function presentMailError(error: unknown): MailErrorPresentation {
  const { code: rawCode, message: rawMessage, status } = errorDetails(error);
  const code = rawCode?.trim().toLowerCase();
  const message = rawMessage.trim();
  const normalized = `${code ?? ""} ${message}`.toLowerCase();

  if (code === "oauth_not_configured") {
    return presentation(
      "oauth",
      "无法使用安全登录",
      "当前应用尚未配置该服务商的安全登录。",
      "可使用该服务商允许的应用专用密码；如需安全登录，请联系应用管理员。",
      false,
    );
  }
  if (code === "oauth_callback_unavailable") {
    return presentation(
      "oauth",
      "无法完成安全登录",
      "Nami Mail 无法启动完成安全登录所需的本地回调。",
      "请重启 Nami Mail 后重试；仍无法完成时，请联系应用管理员。",
      true,
    );
  }
  if (code === "oauth_expired") {
    return presentation("oauth", "授权已过期", "这次安全登录没有在有效期内完成。", "重新开始登录即可。", true);
  }
  if (code === "oauth_invalid_state") {
    return presentation("oauth", "登录会话已失效", "为保护账户安全，Nami Mail 已停止这次登录。", "请重新开始安全登录。", true);
  }
  if (code === "oauth_identity_invalid") {
    return presentation(
      "oauth",
      "未确认邮箱身份",
      "服务商没有返回可验证的邮箱身份，账户没有被添加。",
      "请在服务商页面确认登录的是目标邮箱后重新开始。",
      true,
    );
  }
  if (code === "oauth_connection_failed") {
    return presentation(
      "oauth",
      "授权完成，但邮箱未连接",
      "安全登录已经完成，但邮件服务器未接受收发邮件所需的连接。",
      "请确认服务商或组织管理员已启用 IMAP、SMTP 与 OAuth 权限，然后重新登录。",
      false,
    );
  }
  if (code === "oauth_failed" || code === "oauth_refresh_failed") {
    const cancelled = /(?:取消|access_denied|denied)/i.test(normalized);
    return presentation(
      "oauth",
      cancelled ? "已取消安全登录" : "安全登录未完成",
      cancelled ? "服务商没有授予 Nami Mail 访问该邮箱的权限。" : "服务商没有完成这次安全登录。",
      cancelled ? "重新开始登录并在服务商页面确认授权即可。" : "请重新开始安全登录；持续出现时确认网络可以访问服务商登录页面。",
      true,
    );
  }
  if (code === "oauth_required") {
    return presentation(
      "oauth",
      "此邮箱需要安全登录",
      "该服务商不接受网页登录密码或普通 IMAP 凭据。",
      "请使用对应服务商的 OAuth2 登录；不要在此填写网页登录密码。",
      false,
    );
  }
  if (code === "reauth_required" || /授权已(?:失效|过期)|重新登录/.test(message)) {
    return presentation(
      "oauth",
      "需要重新登录",
      "该邮箱的安全授权已失效或被撤销。",
      "要恢复连接，请移除此设备上的账户后重新使用安全登录添加；不会删除服务器上的邮件。",
      false,
    );
  }
  if (code === "partial_sync") {
    return presentation(
      "sync",
      "部分文件夹未完成同步",
      "本次同步已更新可访问的其他文件夹，未完成的文件夹可能仍显示旧邮件。",
      "检查网络或服务商状态后重新同步；已同步的邮件不会因此被删除。",
      true,
    );
  }
  if (code === "local_data_invalid") {
    return presentation(
      "local-data",
      "本地账户数据无法验证",
      "账户凭据与已保存的连接配置不匹配，Nami Mail 未连接邮件服务器。",
      "请从可信备份恢复应用数据；没有可信备份时，移除此设备上的该账户后重新添加。此操作不会删除服务器上的邮件。",
      false,
    );
  }
  if (code === "provider_configuration" || /(?:邮件服务商拒绝了当前协议或服务器配置|服务器配置不匹配|protocol not supported)/i.test(normalized)) {
    return presentation(
      "protocol",
      "邮箱服务器配置不匹配",
      "服务商返回的 IMAP/SMTP 配置无法用于当前连接。",
      "核对主机、端口、用户名与 TLS/STARTTLS 模式；修改现有账户时，移除后重新添加并使用手动配置，不会删除服务器邮件。",
      false,
    );
  }
  if (code === "tls_certificate_failed" || /(?:certificate|证书)/i.test(normalized)) {
    return presentation(
      "tls",
      "TLS 证书验证未通过",
      "邮箱服务器提供的安全证书无法通过验证，Nami Mail 已拒绝不安全连接。",
      "这通常不等同于网络断开。请核对服务器地址、系统时间与证书链，企业代理也可能替换证书；若多个服务同时无法访问，再检查网络、代理或 VPN。不要关闭证书验证。",
      false,
    );
  }
  if (code === "tls_handshake_failed" || /(?:无法完成.*(?:tls|starttls|加密协商)|加密协商失败)/i.test(normalized)) {
    return presentation(
      "tls",
      "TLS 加密协商失败",
      "已连接到服务器，但双方未能建立兼容的加密连接。",
      "这通常不等同于网络断开。请先核对端口和 TLS/STARTTLS 模式；若多个服务同时无法访问，再检查网络、代理或 VPN。修改现有账户时，移除后重新添加并使用手动配置。",
      false,
    );
  }
  if (code === "tls_failed" || /(?:tls|starttls|安全连接|加密协商)/i.test(normalized)) {
    return presentation(
      "tls",
      "TLS 安全连接未通过",
      "邮箱服务器的证书或加密协商没有通过验证，Nami Mail 已拒绝不安全连接。",
      "这通常不等同于网络断开。请核对主机、端口与 TLS/STARTTLS 模式；若多个服务同时无法访问，再检查网络、代理或 VPN。不要关闭证书验证。",
      false,
    );
  }
  if (code === "server_not_found" || /(?:getaddrinfo|enotfound|dns|无法找到.*服务器|无法解析.*服务器)/i.test(normalized)) {
    return presentation(
      "dns",
      "找不到邮箱服务器",
      "邮箱服务器地址无法解析，连接尚未到达密码验证步骤。",
      "检查 IMAP/SMTP 主机拼写和网络 DNS；企业邮箱可向管理员确认服务器地址后使用手动配置。",
      true,
    );
  }
  if (code === "network_unavailable" || /(?:当前网络无法到达|网络不可用|network unavailable|network is down)/i.test(normalized)) {
    return presentation(
      "connection",
      "本机网络不可用",
      "Nami Mail 当前无法通过本机网络访问邮箱服务器。",
      "检查网络连接、代理、VPN 与防火墙后重新同步；其他已连接账户不会因此被删除。",
      true,
    );
  }
  if (code === "connection_refused" || /(?:服务器拒绝了连接|connection refused|econnrefused)/i.test(normalized)) {
    return presentation(
      "connection",
      "邮箱服务器拒绝了连接",
      "服务器地址可达，但目标端口没有接受这次连接。",
      "检查 IMAP/SMTP 主机和端口，以及代理或防火墙规则；企业邮箱可向管理员确认端口要求。",
      true,
    );
  }
  if (code === "timeout" || /(?:timeout|timed out|超时)/i.test(normalized)) {
    return presentation(
      "connection",
      "连接邮箱服务器超时",
      "在等待邮箱服务器响应时超过了可用时间。",
      "先检查网络、代理、VPN 或防火墙；若只有这一个邮箱受影响，再核对服务器地址和端口后重试。",
      true,
    );
  }
  if (code === "imap_disabled" || /(?:imap.*(?:disabled|not enabled|禁用|开启)|未开启.*imap)/i.test(normalized)) {
    return presentation(
      "protocol",
      "IMAP 未启用",
      "该账户或组织尚未允许通过 IMAP 收取邮件。",
      "请在邮箱服务商设置中启用 IMAP，或联系组织管理员开通后重新同步。",
      true,
    );
  }
  if (code === "smtp_auth_failed" || /(?:发件服务器拒绝了登录凭据|smtp.*(?:凭据|auth|login))/i.test(normalized)) {
    return presentation(
      "authentication",
      "发件服务器未接受凭据",
      "收件连接可能正常，但 SMTP 没有接受当前用户名或授权码。",
      "核对 SMTP 用户名与应用专用密码；需要修改凭据时，移除后重新添加账户。",
      false,
    );
  }
  if (code === "imap_auth_failed" || /(?:收件服务器拒绝了登录凭据|imap.*(?:凭据|auth|login))/i.test(normalized)) {
    return presentation(
      "authentication",
      "收件服务器未接受凭据",
      "IMAP 已响应，但当前密码、授权码或登录方式未通过验证。",
      "确认已启用 IMAP 并使用客户端授权码或应用专用密码；需要更换凭据时，移除后重新添加账户。",
      false,
    );
  }
  if (code === "invalid_credential" || /(?:凭据|授权码|应用专用密码|密码).*(?:拒绝|错误|无效)|(?:authentication|credentials|login).*(?:failed|invalid|reject)/i.test(normalized)) {
    return presentation(
      "authentication",
      "邮箱未接受登录凭据",
      "服务器已响应，但当前密码、授权码或登录方式未通过验证。",
      "确认已使用客户端授权码或应用专用密码；需要更换凭据时，移除后重新添加账户。",
      false,
    );
  }
  if (code === "account_exists" || /(?:邮箱已经添加|邮箱已添加|account exists)/i.test(normalized)) {
    return presentation("unknown", "邮箱已添加", "这个邮箱已存在于 Nami Mail。", "返回主界面即可继续使用；无需再次添加。", false);
  }
  if (code === "connection_failed" || /(?:econnreset|socket hang up|连接邮箱服务器失败|连接被拒绝|与邮件服务器的连接在完成前中断|connection failed)/i.test(normalized)) {
    return presentation(
      "connection",
      "无法连接邮箱服务器",
      "连接在邮箱服务器响应前被拒绝或中断。",
      "这可能是网络、代理或防火墙限制，也可能是服务器地址或端口不正确。检查后可重新同步。",
      true,
    );
  }
  if (code === "local_service_unavailable" || /failed to fetch|networkerror|err_connection_refused|无法连接本地服务/i.test(normalized)) {
    return presentation(
      "local-service",
      "Nami Mail 本地邮件服务不可用",
      "应用界面暂时无法访问本机邮件服务，并不表示邮箱密码有误。",
      "请确认 Nami Mail 仍在运行；重试无效时重启应用，再检查本机安全软件是否拦截了它。",
      true,
    );
  }
  if (status && status >= 500) {
    return presentation(
      "local-service",
      "本地服务暂时不可用",
      "本地邮件服务暂时无法处理这次操作。",
      "请稍后重试；持续出现时重启应用后再试。",
      true,
    );
  }

  return presentation(
    "unknown",
    "操作未完成",
    "暂时无法确定失败原因。",
    "请重试；仍无法完成时，请检查网络和账户设置，或重启应用。",
    true,
  );
}

function fallbackSentence(fallback: string): string {
  return fallback.trim().replace(/[。！？!?]+$/, "");
}

export function mailErrorMessage(error: unknown, fallback = "操作未完成"): string {
  const issue = presentMailError(error);
  if (issue.kind === "unknown") return `${fallbackSentence(fallback)}。${issue.guidance}`;
  return `${issue.title}：${issue.message} ${issue.guidance}`;
}

/** Keeps transient notices compact; full recovery steps belong in the form or account health panel. */
export function mailErrorToastMessage(error: unknown, fallback = "操作未完成"): string {
  const issue = presentMailError(error);
  if (issue.kind === "unknown") return `${fallbackSentence(fallback)}。请检查后重试。`;
  return `${issue.title}。${issue.retryable ? "检查后重试。" : "请按提示检查账户设置。"}`;
}

export function accountHealthIssue(account: Pick<Account, "status" | "lastError" | "lastErrorCode">): MailErrorPresentation | null {
  if (account.status === "connected" && !account.lastError) return null;
  if (account.status === "reauth_required") return presentMailError({ code: "reauth_required", message: account.lastError ?? "" });
  if (account.lastErrorCode || account.lastError) {
    return presentMailError({ code: account.lastErrorCode ?? undefined, message: account.lastError ?? "" });
  }
  if (account.status === "error") {
    return presentation(
      "connection",
      "需要重新同步",
      "该邮箱上次同步没有完成。",
      "检查网络和邮箱服务状态后重新同步。",
      true,
    );
  }
  if (account.status === "degraded") {
    return presentation(
      "sync",
      "部分文件夹未完成同步",
      "该邮箱上次同步只完成了部分文件夹。",
      "检查网络和邮箱服务状态后重新同步；已同步的邮件不会因此被删除。",
      true,
    );
  }
  return null;
}
