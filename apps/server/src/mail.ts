import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { decryptAccountPassword } from "./account-credentials.js";
import type { ResolvedOutboundAttachment } from "./outbound-attachments.js";
import { loginUsername, type DetectedProvider, type MailServerConfig } from "./providers.js";
import type { AccountRecord } from "./types.js";

const connectionOptions = {
  logger: false as const,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 45_000,
  tls: { rejectUnauthorized: true },
};

export type AccountAccessTokenProvider = {
  getAccessToken(account: AccountRecord): Promise<string>;
};

export const MAIL_ERROR_CODES = [
  "local_data_invalid",
  "invalid_credential",
  "imap_auth_failed",
  "smtp_auth_failed",
  "imap_disabled",
  "provider_configuration",
  "server_not_found",
  "network_unavailable",
  "connection_refused",
  "connection_failed",
  "timeout",
  "tls_certificate_failed",
  "tls_handshake_failed",
  "oauth_required",
  "reauth_required",
  "partial_sync",
  "unknown",
] as const;

export type MailErrorCode = typeof MAIL_ERROR_CODES[number];

export type SafeMailError = {
  code: MailErrorCode;
  message: string;
};

type MailAuth =
  | { kind: "password"; secret: string }
  | { kind: "oauth2"; accessToken: string };

type ConnectionProvider = Pick<DetectedProvider, "imap" | "smtp" | "usernameMode">;
type MailOperationPhase = "imap" | "smtp";

function withMailOperationPhase(error: unknown, phase: MailOperationPhase): Error {
  const wrapped = new Error(error instanceof Error ? error.message : "Mail operation failed.");
  // Keep the original error as a cause for classification without serializing
  // arbitrary library fields into user-visible messages.
  Object.assign(wrapped, { cause: error, mailPhase: phase });
  return wrapped;
}

function transportOf(server: Pick<MailServerConfig, "transport" | "secure">): "tls" | "starttls" {
  return server.transport ?? (server.secure ? "tls" : "starttls");
}

function imapClient(
  username: string,
  provider: Pick<ConnectionProvider, "imap">,
  auth: MailAuth,
): ImapFlow {
  const transport = transportOf(provider.imap);
  const client = new ImapFlow({
    host: provider.imap.host,
    port: provider.imap.port,
    secure: transport === "tls",
    // A false `secure` value otherwise allows ImapFlow to downgrade to
    // plaintext when STARTTLS is unavailable. This is deliberately mandatory.
    doSTARTTLS: transport === "starttls",
    auth: auth.kind === "oauth2"
      ? { user: username, accessToken: auth.accessToken }
      : { user: username, pass: auth.secret },
    ...connectionOptions,
  });

  // ImapFlow reports connection failures both through rejected operations and
  // through EventEmitter. A late socket error without a listener terminates the
  // entire Node.js process even after the HTTP handler has returned an error.
  client.on("error", () => undefined);
  return client;
}

export function createImapClient(
  email: string,
  password: string,
  provider: Pick<DetectedProvider, "imap" | "usernameMode" | "imapUsernameMode">,
): ImapFlow {
  return imapClient(loginUsername(email, provider as DetectedProvider, "imap"), provider, { kind: "password", secret: password });
}

function smtpTransport(
  username: string,
  provider: Pick<ConnectionProvider, "smtp">,
  auth: MailAuth,
) {
  const transport = transportOf(provider.smtp);
  return nodemailer.createTransport({
    host: provider.smtp.host,
    port: provider.smtp.port,
    secure: transport === "tls",
    // Nodemailer otherwise uses opportunistic STARTTLS on port 587. Require it
    // so an active downgrade cannot expose credentials or message contents.
    requireTLS: transport === "starttls",
    auth: auth.kind === "oauth2"
      ? { type: "OAuth2" as const, user: username, accessToken: auth.accessToken }
      : { user: username, pass: auth.secret },
    ...connectionOptions,
  });
}

export async function testMailboxConnection(
  email: string,
  password: string,
  provider: DetectedProvider,
): Promise<{ folders: number }> {
  const client = createImapClient(email, password, provider);
  try {
    try {
      await client.connect();
      const folders = await client.list();
      return { folders: folders.length };
    } catch (error) {
      throw withMailOperationPhase(error, "imap");
    }
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

/** Tests both inbound and outbound authentication before an account is saved. */
export async function testAccountConnection(
  email: string,
  password: string,
  provider: DetectedProvider,
  usernames: { imap?: string; smtp?: string } = {},
): Promise<{ folders: number; smtp: true }> {
  const imapUsername = usernames.imap?.trim() || loginUsername(email, provider, "imap");
  const smtpUsername = usernames.smtp?.trim() || loginUsername(email, provider, "smtp");
  const client = imapClient(imapUsername, provider, { kind: "password", secret: password });
  const transport = smtpTransport(smtpUsername, provider, { kind: "password", secret: password });
  try {
    let folders: Awaited<ReturnType<typeof client.list>>;
    try {
      await client.connect();
      folders = await client.list();
    } catch (error) {
      throw withMailOperationPhase(error, "imap");
    }
    try {
      await transport.verify();
    } catch (error) {
      throw withMailOperationPhase(error, "smtp");
    }
    return { folders: folders.length, smtp: true };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
    transport.close();
  }
}

async function accountAuth(
  account: AccountRecord,
  masterKey: Buffer,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<MailAuth> {
  if (account.auth_method === "oauth2") {
    if (!accessTokenProvider) {
      const error = new Error("OAuth account needs a token provider.");
      Object.assign(error, { code: "reauth_required" satisfies MailErrorCode });
      throw error;
    }
    return { kind: "oauth2", accessToken: await accessTokenProvider.getAccessToken(account) };
  }
  // Authenticate the account and its exact stored endpoints before creating a
  // network client, so a modified database row cannot redirect this secret.
  return { kind: "password", secret: decryptAccountPassword(account, account.encrypted_password, masterKey) };
}

function connectionProviderForAccount(account: AccountRecord): ConnectionProvider {
  return {
    imap: {
      host: account.imap_host,
      port: account.imap_port,
      secure: Boolean(account.imap_secure),
      transport: account.imap_transport ?? (account.imap_secure ? "tls" : "starttls"),
    },
    smtp: {
      host: account.smtp_host,
      port: account.smtp_port,
      secure: Boolean(account.smtp_secure),
      transport: account.smtp_transport ?? (account.smtp_secure ? "tls" : "starttls"),
    },
    usernameMode: account.username_mode,
  };
}

/**
 * Verifies both OAuth transports with one access token before an OAuth account
 * is presented as connected. A successful IMAP sync alone is not enough: many
 * Microsoft tenants independently disable SMTP AUTH or omit SMTP.Send.
 */
export async function testOAuthAccountConnection(
  account: AccountRecord,
  masterKey: Buffer,
  accessTokenProvider: AccountAccessTokenProvider,
): Promise<{ folders: number; smtp: true }> {
  const provider = connectionProviderForAccount(account);
  const auth = await accountAuth(account, masterKey, accessTokenProvider);
  if (auth.kind !== "oauth2") throw new Error("OAuth account verification requires OAuth credentials.");
  const imapUsername = account.imap_username?.trim() || loginUsername(account.email, provider as DetectedProvider, "imap");
  const smtpUsername = account.smtp_username?.trim() || loginUsername(account.email, provider as DetectedProvider, "smtp");
  const client = imapClient(imapUsername, provider, auth);
  const transport = smtpTransport(smtpUsername, provider, auth);
  try {
    let folders: Awaited<ReturnType<typeof client.list>>;
    try {
      await client.connect();
      folders = await client.list();
    } catch (error) {
      throw withMailOperationPhase(error, "imap");
    }
    try {
      await transport.verify();
    } catch (error) {
      throw withMailOperationPhase(error, "smtp");
    }
    return { folders: folders.length, smtp: true };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
    transport.close();
  }
}

export async function imapClientForAccount(
  account: AccountRecord,
  masterKey: Buffer,
  accessTokenProvider?: AccountAccessTokenProvider,
): Promise<ImapFlow> {
  const provider = connectionProviderForAccount(account);
  const username = account.imap_username?.trim() || loginUsername(account.email, provider as DetectedProvider, "imap");
  return imapClient(username, provider, await accountAuth(account, masterKey, accessTokenProvider));
}

export async function sendMail(
  account: AccountRecord,
  masterKey: Buffer,
  message: {
    to: string[];
    cc?: string[];
    /** Stable RFC Message-ID generated before the SMTP attempt starts. */
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    subject: string;
    text: string;
    html?: string;
    attachments?: readonly Pick<ResolvedOutboundAttachment, "filename" | "contentType" | "content">[];
  },
  accessTokenProvider?: AccountAccessTokenProvider,
) {
  const provider = connectionProviderForAccount(account);
  const username = account.smtp_username?.trim() || loginUsername(account.email, provider as DetectedProvider, "smtp");
  const transport = smtpTransport(username, provider, await accountAuth(account, masterKey, accessTokenProvider));
  try {
    try {
      return await transport.sendMail({
        from: account.email,
        to: message.to,
        cc: message.cc,
        ...(message.messageId ? { messageId: message.messageId } : {}),
        inReplyTo: message.inReplyTo,
        references: message.references?.length ? message.references : undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: attachment.content,
          contentDisposition: "attachment",
        })),
      });
    } catch (error) {
      throw withMailOperationPhase(error, "smtp");
    }
  } finally {
    transport.close();
  }
}

const mailErrorCodeSet = new Set<string>(MAIL_ERROR_CODES);

type MailErrorEvidence = {
  codes: Set<string>;
  text: string;
  authenticationFailed: boolean;
  tlsFailed: boolean;
  phase: MailOperationPhase | undefined;
};

/**
 * Only inspect small, known error fields. Network libraries sometimes attach
 * request/config objects that can contain credentials, so those must never be
 * converted to text or persisted as part of a diagnostic.
 */
function mailErrorEvidence(error: unknown): MailErrorEvidence {
  const strings: string[] = [];
  const codes = new Set<string>();
  const seen = new Set<object>();
  let authenticationFailed = false;
  let tlsFailed = false;
  let phase: MailOperationPhase | undefined;

  const add = (value: unknown, isCode = false): void => {
    if (typeof value !== "string" || !value) return;
    const clipped = value.slice(0, 512);
    strings.push(clipped);
    if (isCode) codes.add(clipped.toUpperCase());
  };

  const inspect = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return;
    seen.add(value);
    const details = value as Record<string, unknown>;
    add(details.message);
    add(details.code, true);
    add(details.errno, true);
    add(details.syscall);
    add(details.responseStatus);
    add(details.responseText);
    add(details.serverResponseCode, true);
    add(details.command);
    add(details.stage);
    add(details.reason);
    if (details.authenticationFailed === true) authenticationFailed = true;
    // ImapFlow deliberately marks mandatory STARTTLS failures (including its
    // plaintext-injection guard) with this stable flag. Prefer that signal to
    // brittle provider wording such as "Unexpected close" or a timeout.
    if (details.tlsFailed === true) tlsFailed = true;
    if (details.mailPhase === "imap" || details.mailPhase === "smtp") phase = details.mailPhase;
    inspect(details.cause, depth + 1);
  };

  inspect(error, 0);
  return { codes, text: strings.join(" ").toLowerCase(), authenticationFailed, tlsFailed, phase };
}

function hasAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function hasCode(evidence: MailErrorEvidence, codes: readonly string[]): boolean {
  return codes.some((code) => evidence.codes.has(code));
}

function explicitMailErrorCode(error: unknown): MailErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as Record<string, unknown>).code;
  if (typeof code !== "string") return undefined;
  if (mailErrorCodeSet.has(code)) return code as MailErrorCode;
  // These names appeared in early desktop builds. Keep stored/in-flight errors
  // useful while returning the more precise taxonomy for newly observed ones.
  if (code === "tls_failed") return "tls_handshake_failed";
  return undefined;
}

export function mailErrorCode(error: unknown): MailErrorCode {
  const explicit = explicitMailErrorCode(error);
  if (explicit) return explicit;

  const evidence = mailErrorEvidence(error);
  const { text } = evidence;

  if (hasCode(evidence, [
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ]) || hasAny(text, [
    "certificate has expired",
    "certificate is not yet valid",
    "self signed certificate",
    "unable to verify the first certificate",
    "unable to verify leaf signature",
    "unable to get local issuer certificate",
    "unable to get issuer certificate",
    "hostname/ip does not match certificate",
    "certificate verify failed",
  ])) {
    return "tls_certificate_failed";
  }

  if (evidence.tlsFailed || hasCode(evidence, ["EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_TLS_INVALID_PROTOCOL_VERSION"]) || hasAny(text, [
    "starttls",
    "tls handshake",
    "handshake failure",
    "wrong version number",
    "ssl routines",
    "unknown protocol",
    "unsupported protocol",
  ])) {
    return "tls_handshake_failed";
  }

  if (hasCode(evidence, ["ENOTFOUND"]) || hasAny(text, ["getaddrinfo enotfound", "enotfound", "name or service not known"])) {
    return "server_not_found";
  }

  // EAI_AGAIN is a temporary resolver failure, not proof that the configured
  // hostname is wrong. Treat it as a network condition so users do not edit a
  // valid provider preset while offline or behind a captive proxy.
  if (hasCode(evidence, ["EAI_AGAIN"]) || hasAny(text, ["getaddrinfo eai_again", "temporary failure in name resolution", "dns lookup timed out"])) {
    return "network_unavailable";
  }

  if (hasCode(evidence, ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNTIMEOUT"]) || hasAny(text, ["timeout", "timed out", "timedout", "socket timeout"])) {
    return "timeout";
  }

  if (hasCode(evidence, ["ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ENONET", "EADDRNOTAVAIL"]) || hasAny(text, [
    "network is unreachable",
    "no route to host",
    "network is down",
    "network unavailable",
  ])) {
    return "network_unavailable";
  }

  if (hasCode(evidence, ["ECONNREFUSED"]) || hasAny(text, ["connection refused", "econnrefused"])) return "connection_refused";

  if ((evidence.phase === "imap" || evidence.authenticationFailed || text.includes("imap") || text.includes("authenticationfailed")) && hasAny(text, ["disabled", "not enabled", "not available"])) {
    return "imap_disabled";
  }

  if (hasAny(text, [
    "smtp auth is disabled",
    "smtp authentication is disabled",
    "smtpclientauthentication is disabled",
    "smtp client authentication is disabled",
    "basic authentication is disabled",
    "authentication mechanism is not supported",
    "unsupported authentication mechanism",
    "command not supported",
    "command unrecognized",
    "protocol not supported",
    "not implemented",
  ])) {
    return "provider_configuration";
  }

  if (evidence.phase === "smtp" && hasAny(text, ["auth", "credential", "login", "535", "534"])) return "smtp_auth_failed";

  if (hasCode(evidence, ["EAUTH"]) || (text.includes("smtp") && hasAny(text, ["auth", "credential", "login", "535", "534"]))) {
    return "smtp_auth_failed";
  }

  if (evidence.phase === "imap" && hasAny(text, ["auth", "credential", "login", "535", "534"])) return "imap_auth_failed";

  if (evidence.authenticationFailed || text.includes("authenticationfailed") || (text.includes("imap") && hasAny(text, ["auth", "credential", "login"]))) {
    return "imap_auth_failed";
  }

  if (hasAny(text, ["invalid credentials", "authentication failed", "login failed", "invalid login", "invalid password", "credentials rejected"])) {
    return "invalid_credential";
  }

  if (hasCode(evidence, ["ECONNRESET", "ECONNABORTED", "EPIPE", "ERR_SOCKET_CLOSED"]) || hasAny(text, [
    "socket hang up",
    "connection reset",
    "connection aborted",
    "connection closed",
    "connection failed",
    "unable to connect",
  ])) {
    return "connection_failed";
  }

  return "unknown";
}

function safeCredentialHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const normalized = hint.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 320) : undefined;
}

function friendlyMailErrorForCode(code: MailErrorCode, hint?: string): string {
  const credentialHint = safeCredentialHint(hint);
  switch (code) {
    case "local_data_invalid":
      return "本地账户数据与已保存的连接配置不匹配，Nami Mail 未连接邮件服务器。请从可信备份恢复应用数据，或移除此设备上的账户后重新添加；不会删除服务器上的邮件。";
    case "invalid_credential":
      return `邮箱服务器拒绝了登录凭据。${credentialHint ? ` ${credentialHint}` : "请确认使用的是客户端授权码、应用专用密码，或正确的 OAuth 登录方式。"}`;
    case "imap_auth_failed":
      return `收件服务器拒绝了登录凭据。${credentialHint ? ` ${credentialHint}` : "请确认已开启 IMAP，并使用客户端授权码、应用专用密码或正确的 OAuth 登录方式。"}`;
    case "smtp_auth_failed":
      return `发件服务器拒绝了登录凭据。${credentialHint ? ` ${credentialHint}` : "请检查 SMTP 用户名和客户端授权码、应用专用密码或 OAuth 权限。"}`;
    case "imap_disabled":
      return "该账户的 IMAP 服务未开启或已被组织管理员禁用。请在服务商设置中开启 IMAP，或联系管理员。";
    case "provider_configuration":
      return "邮件服务商拒绝了当前协议或服务器配置。请核对 IMAP/SMTP 地址、端口与 TLS/STARTTLS 设置，并确认管理员没有禁用相应协议。";
    case "server_not_found":
      return "无法解析邮件服务器地址。请检查网络和 DNS；若使用手动配置，请核对服务器地址拼写。";
    case "network_unavailable":
      return "当前网络无法到达邮件服务器。请检查网络连接、VPN/代理和防火墙设置后重试。";
    case "connection_refused":
      return "邮件服务器拒绝了连接。请核对服务器地址、端口和 TLS/STARTTLS 选项；企业邮箱还请确认网络或管理员策略未拦截该端口。";
    case "connection_failed":
      return "与邮件服务器的连接在完成前中断。请检查网络、VPN/代理和防火墙设置后重试。";
    case "timeout":
      return "连接邮件服务器超时。网络可能不稳定，或服务器端口被防火墙拦截；请检查网络、VPN/代理后重试。";
    case "tls_certificate_failed":
      return "TLS 证书验证失败，Nami Mail 已拒绝不受信任的连接。请检查系统时间、网络代理和服务器证书，不要关闭证书验证。";
    case "tls_handshake_failed":
      return "无法完成 TLS/STARTTLS 加密协商。请核对服务器端口和 TLS/STARTTLS 设置，或联系服务商/管理员。";
    case "oauth_required":
      return "该邮箱需要 OAuth 授权，请重新使用服务商登录。";
    case "reauth_required":
      return "授权已经失效，请重新登录该邮箱。";
    case "partial_sync":
      return "部分文件夹未完成同步，其他已完成的文件夹仍可使用。请重新同步以恢复完整邮箱视图。";
    case "unknown":
      return "邮件服务发生了未识别错误。请稍后重试；若持续出现，请检查服务商状态和网络设置。";
  }
}

export function friendlyMailError(error: unknown, hint?: string): string {
  return friendlyMailErrorForCode(mailErrorCode(error), hint);
}

export function safeMailError(error: unknown, hint?: string): SafeMailError {
  const code = mailErrorCode(error);
  return { code, message: friendlyMailErrorForCode(code, hint) };
}

/** HTTP status only conveys retryability; clients should branch on the safe code. */
export function mailErrorHttpStatus(code: MailErrorCode): 422 | 503 | 504 {
  switch (code) {
    case "timeout":
      return 504;
    case "server_not_found":
    case "network_unavailable":
    case "connection_refused":
    case "connection_failed":
      return 503;
    default:
      return 422;
  }
}
