import { ApiError } from "./api";
import { translate, type Translate } from "./i18n";
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

const defaultTranslate: Translate = (key, values) => translate("zh-CN", key, values);

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

function localizedPresentation(
  kind: MailIssueKind,
  copyKey: string,
  retryable: boolean,
  t: Translate,
): MailErrorPresentation {
  return presentation(
    kind,
    t(`error.${copyKey}.title`),
    t(`error.${copyKey}.message`),
    t(`error.${copyKey}.guidance`),
    retryable,
  );
}

/**
 * Converts stable server error codes and legacy saved text into focused,
 * localized recovery guidance without exposing transport implementation details.
 */
export function presentMailError(error: unknown, t: Translate = defaultTranslate): MailErrorPresentation {
  const { code: rawCode, message: rawMessage, status } = errorDetails(error);
  const code = rawCode?.trim().toLowerCase();
  const message = rawMessage.trim();
  const normalized = `${code ?? ""} ${message}`.toLowerCase();

  if (code === "oauth_not_configured") return localizedPresentation("oauth", "oauthNotConfigured", false, t);
  if (code === "oauth_callback_unavailable") return localizedPresentation("oauth", "oauthCallbackUnavailable", true, t);
  if (code === "oauth_expired") return localizedPresentation("oauth", "oauthExpired", true, t);
  if (code === "oauth_invalid_state") return localizedPresentation("oauth", "oauthInvalidState", true, t);
  if (code === "oauth_identity_invalid") return localizedPresentation("oauth", "oauthIdentityInvalid", true, t);
  if (code === "oauth_connection_failed") return localizedPresentation("oauth", "oauthConnectionFailed", false, t);
  if (code === "oauth_failed" || code === "oauth_refresh_failed") {
    return localizedPresentation("oauth", /(?:取消|access_denied|denied)/i.test(normalized) ? "oauthCancelled" : "oauthFailed", true, t);
  }
  if (code === "oauth_required") return localizedPresentation("oauth", "oauthRequired", false, t);
  if (code === "reauth_required" || /授权已(?:失效|过期)|重新登录/.test(message)) {
    return localizedPresentation("oauth", "reauthRequired", false, t);
  }
  if (code === "partial_sync") return localizedPresentation("sync", "partialSync", true, t);
  if (code === "local_data_invalid") return localizedPresentation("local-data", "localDataInvalid", false, t);
  if (code === "provider_configuration" || /(?:邮件服务商拒绝了当前协议或服务器配置|服务器配置不匹配|protocol not supported)/i.test(normalized)) {
    return localizedPresentation("protocol", "providerConfiguration", false, t);
  }
  if (code === "tls_certificate_failed" || /(?:certificate|证书)/i.test(normalized)) {
    return localizedPresentation("tls", "tlsCertificateFailed", false, t);
  }
  if (code === "tls_handshake_failed" || /(?:无法完成.*(?:tls|starttls|加密协商)|加密协商失败)/i.test(normalized)) {
    return localizedPresentation("tls", "tlsHandshakeFailed", false, t);
  }
  if (code === "tls_failed" || /(?:tls|starttls|安全连接|加密协商)/i.test(normalized)) {
    return localizedPresentation("tls", "tlsFailed", false, t);
  }
  if (code === "server_not_found" || /(?:getaddrinfo|enotfound|dns|无法找到.*服务器|无法解析.*服务器)/i.test(normalized)) {
    return localizedPresentation("dns", "serverNotFound", true, t);
  }
  if (code === "network_unavailable" || /(?:当前网络无法到达|网络不可用|network unavailable|network is down)/i.test(normalized)) {
    return localizedPresentation("connection", "networkUnavailable", true, t);
  }
  if (code === "connection_refused" || /(?:服务器拒绝了连接|connection refused|econnrefused)/i.test(normalized)) {
    return localizedPresentation("connection", "connectionRefused", true, t);
  }
  if (code === "timeout" || /(?:timeout|timed out|超时)/i.test(normalized)) {
    return localizedPresentation("connection", "timeout", true, t);
  }
  if (code === "imap_disabled" || /(?:imap.*(?:disabled|not enabled|禁用|开启)|未开启.*imap)/i.test(normalized)) {
    return localizedPresentation("protocol", "imapDisabled", true, t);
  }
  if (code === "smtp_auth_failed" || /(?:发件服务器拒绝了登录凭据|smtp.*(?:凭据|auth|login))/i.test(normalized)) {
    return localizedPresentation("authentication", "smtpAuthFailed", false, t);
  }
  if (code === "imap_auth_failed" || /(?:收件服务器拒绝了登录凭据|imap.*(?:凭据|auth|login))/i.test(normalized)) {
    return localizedPresentation("authentication", "imapAuthFailed", false, t);
  }
  if (code === "invalid_credential" || /(?:凭据|授权码|应用专用密码|密码).*(?:拒绝|错误|无效)|(?:authentication|credentials|login).*(?:failed|invalid|reject)/i.test(normalized)) {
    return localizedPresentation("authentication", "invalidCredential", false, t);
  }
  if (code === "account_exists" || /(?:邮箱已经添加|邮箱已添加|account exists)/i.test(normalized)) {
    return localizedPresentation("unknown", "accountExists", false, t);
  }
  if (code === "connection_failed" || /(?:econnreset|socket hang up|连接邮箱服务器失败|连接被拒绝|与邮件服务器的连接在完成前中断|connection failed)/i.test(normalized)) {
    return localizedPresentation("connection", "connectionFailed", true, t);
  }
  if (code === "local_service_unavailable" || /failed to fetch|networkerror|err_connection_refused|无法连接本地服务/i.test(normalized)) {
    return localizedPresentation("local-service", "localServiceUnavailable", true, t);
  }
  if (status && status >= 500) return localizedPresentation("local-service", "localServiceError", true, t);

  return localizedPresentation("unknown", "unknown", true, t);
}

function fallbackSentence(fallback: string): string {
  return fallback.trim().replace(/[。！？!?]+$/, "");
}

export function mailErrorMessage(error: unknown, fallback?: string, t: Translate = defaultTranslate): string {
  const issue = presentMailError(error, t);
  if (issue.kind === "unknown") {
    return t("error.fullUnknown", { fallback: fallbackSentence(fallback ?? t("error.operationIncomplete")), guidance: issue.guidance });
  }
  return t("error.fullKnown", { title: issue.title, message: issue.message, guidance: issue.guidance });
}

/** Keeps transient notices compact; full recovery steps belong in the form or account health panel. */
export function mailErrorToastMessage(error: unknown, fallback?: string, t: Translate = defaultTranslate): string {
  const issue = presentMailError(error, t);
  if (issue.kind === "unknown") {
    return t("error.toastUnknown", { fallback: fallbackSentence(fallback ?? t("error.operationIncomplete")) });
  }
  return t(issue.retryable ? "error.toastRetryable" : "error.toastCheckSettings", { title: issue.title });
}

export function accountHealthIssue(
  account: Pick<Account, "status" | "lastError" | "lastErrorCode">,
  t: Translate = defaultTranslate,
): MailErrorPresentation | null {
  if (account.status === "connected" && !account.lastError) return null;
  if (account.status === "reauth_required") return presentMailError({ code: "reauth_required", message: account.lastError ?? "" }, t);
  if (account.lastErrorCode || account.lastError) {
    return presentMailError({ code: account.lastErrorCode ?? undefined, message: account.lastError ?? "" }, t);
  }
  if (account.status === "error") return localizedPresentation("connection", "accountError", true, t);
  if (account.status === "degraded") return localizedPresentation("sync", "accountDegraded", true, t);
  return null;
}
