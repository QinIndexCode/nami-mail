import { randomUUID } from "node:crypto";
import * as oauth from "oauth4webapi";
import {
  ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
  AccountCredentialIntegrityError,
  decryptOAuthRefreshToken,
  encryptAccountPassword,
  encryptOAuthRefreshToken,
  type AccountCredentialIdentity,
} from "./account-credentials.js";
import { config } from "./config.js";
import type { DatabaseHandle } from "./db.js";
import {
  friendlyMailError,
  mailErrorCode,
  testOAuthAccountConnection,
  type AccountAccessTokenProvider,
  type MailErrorCode,
} from "./mail.js";
import { detectProvider, loginUsername, resolveProvider, type DetectedProvider } from "./providers.js";
import type { AccountRecord } from "./types.js";

export type OAuthProviderId = "google" | "microsoft";
export type OAuthAttemptState = "pending" | "success" | "error" | "expired";

type OAuthProviderConfig = {
  id: OAuthProviderId;
  name: string;
  clientId?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuer: string;
  jwksUri: string;
  scopes: string[];
  authorizationParameters?: Record<string, string>;
};

type OAuthAttempt = {
  id: string;
  provider: OAuthProviderId;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
  consumed: boolean;
  status: OAuthAttemptState;
  errorCode?: string;
  message?: string;
  accountId?: string;
};

export type OAuthAttemptSnapshot = {
  status: OAuthAttemptState;
  accountId?: string;
  code?: string;
  message?: string;
};

export type OAuthErrorCode =
  | "oauth_not_configured"
  | "oauth_callback_unavailable"
  | "oauth_invalid_state"
  | "oauth_expired"
  | "oauth_failed"
  | "oauth_connection_failed"
  | "oauth_identity_invalid"
  | "oauth_refresh_failed"
  | "account_exists"
  | MailErrorCode;

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function isOAuthProvider(value: string): value is OAuthProviderId {
  return value === "google" || value === "microsoft";
}

function simpleEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function providerConfig(id: OAuthProviderId): OAuthProviderConfig {
  if (id === "google") {
    return {
      id,
      name: "Google",
      clientId: config.googleOAuthClientId,
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      scopes: ["openid", "email", "profile", "https://mail.google.com/"],
      authorizationParameters: { access_type: "offline", prompt: "consent" },
    };
  }
  const tenant = encodeURIComponent(config.microsoftOAuthTenant);
  return {
    id,
    name: "Microsoft",
    clientId: config.microsoftOAuthClientId,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
    authorizationEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "https://outlook.office.com/SMTP.Send",
    ],
    authorizationParameters: { prompt: "select_account", response_mode: "query" },
  };
}

function serverMetadata(provider: OAuthProviderConfig, issuer = provider.issuer): oauth.AuthorizationServer {
  return {
    issuer,
    authorization_endpoint: provider.authorizationEndpoint,
    token_endpoint: provider.tokenEndpoint,
    jwks_uri: provider.jwksUri,
  };
}

function clientMetadata(provider: OAuthProviderConfig): oauth.Client {
  if (!provider.clientId) throw new OAuthError("oauth_not_configured", `${provider.name} 登录尚未配置客户端 ID。`);
  return { client_id: provider.clientId, id_token_signed_response_alg: "RS256" };
}

function decodeUnverifiedIssuer(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    return undefined;
  }
}

function trustedMicrosoftIssuer(issuer: string | undefined, configuredTenant: string): string | undefined {
  if (!issuer) return undefined;
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com") return undefined;
    if (!/^\/[a-zA-Z0-9.-]+\/v2\.0$/.test(url.pathname)) return undefined;
    const tokenTenant = url.pathname.split("/")[1]?.toLowerCase();
    const configured = configuredTenant.trim().toLowerCase();
    const allowsAnyTenant = ["common", "organizations", "consumers"].includes(configured);
    // `common`, `organizations`, and `consumers` intentionally issue an ID
    // token for a concrete tenant. A tenant-pinned configuration must not
    // silently broaden that issuer allowlist.
    if (!tokenTenant || (!allowsAnyTenant && tokenTenant !== configured)) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function flowErrorCode(error: unknown): string {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = details.cause && typeof details.cause === "object" ? details.cause as Record<string, unknown> : {};
  const body = cause.body && typeof cause.body === "object" ? cause.body as Record<string, unknown> : {};
  const value = body.error ?? cause.error ?? details.error ?? details.code;
  return typeof value === "string" ? value : "oauth_failed";
}

function flowErrorMessage(error: unknown): string {
  // OAuth providers can put opaque request identifiers, tenant details, or
  // echoed values in error_description. Keep those details out of the local
  // API and present only a stable recovery action.
  switch (flowErrorCode(error)) {
    case "invalid_grant":
      return "授权已经失效或被撤销，请重新登录该邮箱。";
    case "access_denied":
      return "你取消了授权，邮箱没有被添加。";
    case "login_required":
    case "interaction_required":
    case "consent_required":
      return "服务商要求重新登录并确认授权，请重新开始安全登录。";
    case "temporarily_unavailable":
    case "server_error":
      return "安全登录服务暂时不可用，请稍后重试。";
    case "unauthorized_client":
    case "invalid_client":
      return "此安装的安全登录配置未被服务商接受，请联系部署者。";
    case "invalid_scope":
      return "此安装请求的邮箱权限未被服务商接受，请联系部署者。";
    default:
      return "服务商未完成授权。请关闭浏览器页面后重试。";
  }
}

function redactedMessage(error: unknown): string {
  return flowErrorMessage(error);
}

/**
 * OAuth token requests use HTTPS rather than IMAP/SMTP, but Node reports the
 * same transport failures. Preserve the established safe codes so a DNS/TLS
 * issue is not presented as an account authorization failure.
 */
function oauthTransportError(error: unknown): OAuthError | undefined {
  const code = mailErrorCode(error);
  switch (code) {
    case "server_not_found":
      return new OAuthError(code, "无法解析安全登录服务地址。请检查网络和 DNS 后重试。");
    case "network_unavailable":
      return new OAuthError(code, "当前网络无法访问安全登录服务。请检查网络、VPN、代理和防火墙设置后重试。");
    case "connection_refused":
      return new OAuthError(code, "安全登录服务拒绝了连接。请检查网络或代理设置后重试。");
    case "connection_failed":
      return new OAuthError(code, "与安全登录服务的连接在完成前中断。请检查网络、VPN、代理和防火墙设置后重试。");
    case "timeout":
      return new OAuthError(code, "连接安全登录服务超时。请检查网络、VPN、代理和防火墙设置后重试。");
    case "tls_certificate_failed":
      return new OAuthError(code, "安全登录服务的 TLS 证书验证失败。请检查系统时间、网络代理和证书链，不要关闭证书验证。");
    case "tls_handshake_failed":
      return new OAuthError(code, "无法与安全登录服务完成 TLS 加密协商。请检查网络代理设置后重试。");
    default:
      return undefined;
  }
}

function accountProviderForOAuth(provider: OAuthProviderId, detected: DetectedProvider): DetectedProvider {
  if (provider === "google") {
    if (detected.family === "google") return detected;
    const gmail = detectProvider("nami-workspace@gmail.com");
    return { ...gmail, name: "Google Workspace", domain: detected.domain, isCustom: true, source: "mx", confidence: "medium" };
  }
  if (detected.family === "microsoft") return detected;
  const microsoft = detectProvider("nami-workspace@outlook.com");
  return { ...microsoft, name: "Microsoft 365", domain: detected.domain, isCustom: true, source: "mx", confidence: "medium" };
}

export class OAuthService implements AccountAccessTokenProvider {
  private readonly attempts = new Map<string, OAuthAttempt>();
  private readonly attemptsByState = new Map<string, string>();
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
  ) {}

  isConfigured(provider: OAuthProviderId): boolean {
    return Boolean(providerConfig(provider).clientId);
  }

  private cleanupAttempts(now = Date.now()): void {
    for (const [id, attempt] of this.attempts) {
      if (attempt.status === "pending" && attempt.expiresAt <= now) {
        attempt.status = "expired";
        attempt.message = "授权已超时，请重新开始。";
        this.attemptsByState.delete(attempt.state);
      }
      if (attempt.expiresAt + 15 * 60_000 <= now) {
        this.attempts.delete(id);
        this.attemptsByState.delete(attempt.state);
      }
    }
  }

  async start(providerId: OAuthProviderId, loopbackOrigin: string): Promise<{ attemptId: string; authorizationUrl: string; expiresAt: string }> {
    const provider = providerConfig(providerId);
    const client = clientMetadata(provider);
    const callbackOrigin = new URL(loopbackOrigin);
    if (callbackOrigin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(callbackOrigin.hostname)) {
      throw new OAuthError("oauth_failed", "OAuth 回调必须使用本机回环地址。");
    }
    this.cleanupAttempts();
    const id = randomUUID();
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
    const redirectUri = new URL(`/api/oauth/${providerId}/callback`, callbackOrigin).toString();
    const authorizationUrl = new URL(provider.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", client.client_id);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", provider.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    for (const [key, value] of Object.entries(provider.authorizationParameters ?? {})) authorizationUrl.searchParams.set(key, value);

    const attempt: OAuthAttempt = {
      id,
      provider: providerId,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      expiresAt: Date.now() + config.oauthFlowTtlSeconds * 1_000,
      consumed: false,
      status: "pending",
    };
    this.attempts.set(id, attempt);
    this.attemptsByState.set(state, id);
    return { attemptId: id, authorizationUrl: authorizationUrl.toString(), expiresAt: new Date(attempt.expiresAt).toISOString() };
  }

  getAttempt(id: string): OAuthAttemptSnapshot {
    this.cleanupAttempts();
    const attempt = this.attempts.get(id);
    if (!attempt) return { status: "expired", code: "oauth_expired", message: "授权已过期，请重新开始。" };
    return {
      status: attempt.status,
      ...(attempt.accountId ? { accountId: attempt.accountId } : {}),
      ...(attempt.errorCode ? { code: attempt.errorCode } : {}),
      ...(attempt.message ? { message: attempt.message } : {}),
    };
  }

  private callbackAttempt(provider: OAuthProviderId, url: URL): OAuthAttempt {
    const state = url.searchParams.get("state");
    if (!state) throw new OAuthError("oauth_invalid_state", "授权响应缺少 state，已拒绝处理。");
    const id = this.attemptsByState.get(state);
    const attempt = id ? this.attempts.get(id) : undefined;
    if (!attempt || attempt.provider !== provider || attempt.state !== state) {
      throw new OAuthError("oauth_invalid_state", "授权状态无效或已被使用。请重新开始。");
    }
    if (attempt.expiresAt <= Date.now()) {
      attempt.status = "expired";
      attempt.message = "授权已超时，请重新开始。";
      this.attemptsByState.delete(state);
      throw new OAuthError("oauth_expired", attempt.message);
    }
    if (attempt.consumed) throw new OAuthError("oauth_invalid_state", "该授权响应已经使用过。请重新开始。");
    attempt.consumed = true;
    this.attemptsByState.delete(state);
    return attempt;
  }

  private async callbackTokens(provider: OAuthProviderConfig, attempt: OAuthAttempt, callbackUrl: URL) {
    const client = clientMetadata(provider);
    let as = serverMetadata(provider);
    const validated = oauth.validateAuthResponse(as, client, callbackUrl.searchParams, attempt.state);
    const exchange = await oauth.authorizationCodeGrantRequest(as, client, oauth.None(), validated, attempt.redirectUri, attempt.codeVerifier);
    if (provider.id === "microsoft") {
      // The tenant-independent endpoint signs a token with a tenant-specific
      // issuer. It is only used after constraining it to Microsoft's hostname;
      // oauth4webapi then validates issuer, audience, nonce and signature.
      const preview = await exchange.clone().json().catch(() => undefined) as { id_token?: unknown } | undefined;
      const issuer = trustedMicrosoftIssuer(decodeUnverifiedIssuer(preview?.id_token), config.microsoftOAuthTenant);
      if (!issuer) throw new OAuthError("oauth_identity_invalid", "Microsoft 未返回可验证的身份令牌。" );
      as = serverMetadata(provider, issuer);
    }
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, exchange, {
      expectedNonce: attempt.nonce,
      requireIdToken: true,
    });
    await oauth.validateApplicationLevelSignature(as, exchange);
    return { as, client, tokens };
  }

  private identityFromTokens(provider: OAuthProviderId, tokens: oauth.TokenEndpointResponse): { email: string; subject: string; tenantId?: string; scopes: string[] } {
    const claims = oauth.getValidatedIdTokenClaims(tokens);
    const email = simpleEmail(claims?.email) ?? simpleEmail(claims?.preferred_username);
    if (!claims || !email || typeof claims.sub !== "string" || !claims.sub) {
      throw new OAuthError("oauth_identity_invalid", "服务商没有返回可验证的邮箱身份。" );
    }
    if (provider === "google" && claims.email_verified === false) {
      throw new OAuthError("oauth_identity_invalid", "Google 尚未验证该邮箱地址。" );
    }
    const tenantId = provider === "microsoft" && typeof claims.tid === "string" ? claims.tid : undefined;
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : providerConfig(provider).scopes;
    return { email, subject: claims.sub, ...(tenantId ? { tenantId } : {}), scopes };
  }

  private async persistAccount(
    providerId: OAuthProviderId,
    identity: { email: string; subject: string; tenantId?: string; scopes: string[] },
    refreshToken: string,
  ): Promise<AccountRecord> {
    let detected: DetectedProvider;
    try {
      detected = await resolveProvider(identity.email);
    } catch {
      detected = detectProvider(identity.email);
    }
    const provider = accountProviderForOAuth(providerId, detected);
    const now = new Date().toISOString();
    const persist = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE").get(identity.email) as AccountRecord | undefined;
      if (existing && existing.auth_method !== "oauth2") {
        throw new OAuthError("account_exists", "该邮箱已用密码方式添加。请先在设置中移除旧账户后再使用 OAuth 登录。" );
      }
      const id = existing?.id ?? randomUUID();
      const accountEmail = existing?.email ?? identity.email;
      const imapUsername = loginUsername(identity.email, provider, "imap");
      const smtpUsername = loginUsername(identity.email, provider, "smtp");
      const credentialIdentity: AccountCredentialIdentity = {
        id,
        email: accountEmail,
        provider: provider.id,
        auth_method: "oauth2",
        imap_host: provider.imap.host,
        imap_port: provider.imap.port,
        imap_secure: provider.imap.secure ? 1 : 0,
        imap_transport: provider.imap.transport,
        imap_username: imapUsername,
        smtp_host: provider.smtp.host,
        smtp_port: provider.smtp.port,
        smtp_secure: provider.smtp.secure ? 1 : 0,
        smtp_transport: provider.smtp.transport,
        smtp_username: smtpUsername,
        username_mode: provider.usernameMode ?? "email",
      };
      const encryptedPassword = encryptAccountPassword(credentialIdentity, "oauth-managed", this.masterKey);
      const encryptedRefreshToken = encryptOAuthRefreshToken(credentialIdentity, refreshToken, this.masterKey);
      if (existing) {
        this.db.prepare(`
        UPDATE accounts SET provider = ?, provider_name = ?, encrypted_password = ?, credential_crypto_version = ?,
          auth_method = 'oauth2', provider_subject = ?, tenant_id = ?, granted_scopes = ?,
          imap_host = ?, imap_port = ?, imap_secure = ?, imap_transport = ?, imap_username = ?,
          smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_transport = ?, smtp_username = ?,
          username_mode = ?, status = 'connecting', last_error = NULL, last_error_code = NULL
        WHERE id = ?
      `).run(
        provider.id, provider.name, encryptedPassword, ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        identity.subject, identity.tenantId ?? null, JSON.stringify(identity.scopes),
        provider.imap.host, provider.imap.port, provider.imap.secure ? 1 : 0, provider.imap.transport, imapUsername,
        provider.smtp.host, provider.smtp.port, provider.smtp.secure ? 1 : 0, provider.smtp.transport, smtpUsername,
        provider.usernameMode ?? "email", id,
      );
      } else {
        this.db.prepare(`
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          provider_subject, tenant_id, granted_scopes,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'oauth2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connecting', ?)
      `).run(
        id, accountEmail, provider.id, provider.name, encryptedPassword, ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
        identity.subject, identity.tenantId ?? null, JSON.stringify(identity.scopes),
        provider.imap.host, provider.imap.port, provider.imap.secure ? 1 : 0, provider.imap.transport, imapUsername,
        provider.smtp.host, provider.smtp.port, provider.smtp.secure ? 1 : 0, provider.smtp.transport, smtpUsername,
        provider.usernameMode ?? "email", now,
      );
      }
      this.db.prepare(`
      INSERT INTO account_credentials (account_id, credential_kind, encrypted_secret, crypto_version, updated_at)
      VALUES (?, 'oauth-refresh-token', ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        encrypted_secret = excluded.encrypted_secret,
        crypto_version = excluded.crypto_version,
        updated_at = excluded.updated_at
      `).run(id, encryptedRefreshToken, ACCOUNT_CREDENTIAL_CRYPTO_VERSION, now);
      return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord;
    });
    return persist();
  }

  async finish(provider: OAuthProviderId, callbackUrl: URL): Promise<OAuthAttemptSnapshot> {
    let attempt: OAuthAttempt | undefined;
    try {
      attempt = this.callbackAttempt(provider, callbackUrl);
      const configured = providerConfig(provider);
      const { tokens } = await this.callbackTokens(configured, attempt, callbackUrl);
      const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
      if (!refreshToken) throw new OAuthError("oauth_failed", "服务商没有提供离线刷新授权，请重新授权并允许长期访问。" );
      const identity = this.identityFromTokens(provider, tokens);
      const account = await this.persistAccount(provider, identity, refreshToken);
      const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
      this.tokenCache.set(account.id, { token: tokens.access_token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000 });
      try {
        await testOAuthAccountConnection(account, this.masterKey, this);
      } catch (error) {
        const message = friendlyMailError(error);
        const code = mailErrorCode(error);
        this.tokenCache.delete(account.id);
        this.db.prepare("UPDATE accounts SET status = 'error', last_error = ?, last_error_code = ? WHERE id = ?")
          .run(message, code, account.id);
        // The authorization itself succeeded. Preserve the classified mail
        // transport code so the renderer can distinguish a TLS, network,
        // protocol, or credential follow-up instead of showing one generic
        // OAuth failure.
        throw new OAuthError(code, `授权已完成，但邮箱连接验证失败：${message}`);
      }
      attempt.status = "success";
      attempt.accountId = account.id;
      attempt.message = "授权完成，正在连接邮箱。";
      return this.getAttempt(attempt.id);
    } catch (error) {
      const failure = error instanceof OAuthError
        ? error
        : oauthTransportError(error) ?? new OAuthError("oauth_failed", redactedMessage(error));
      if (attempt) {
        attempt.status = "error";
        attempt.errorCode = failure.code;
        attempt.message = failure.message;
      }
      throw failure;
    }
  }

  private providerForAccount(account: AccountRecord): OAuthProviderId {
    if (account.provider === "gmail") return "google";
    if (account.provider === "microsoft") return "microsoft";
    throw new OAuthError("reauth_required", "该 OAuth 账户缺少可用的服务商配置，请重新登录。" );
  }

  private reauthRequired(account: AccountRecord, message: string): OAuthError {
    this.tokenCache.delete(account.id);
    this.db.prepare("UPDATE accounts SET status = 'reauth_required', last_error = ?, last_error_code = ? WHERE id = ?")
      .run(message, "reauth_required", account.id);
    return new OAuthError("reauth_required", message);
  }

  private storedRefreshToken(account: AccountRecord): string {
    const credential = this.db.prepare(`
      SELECT encrypted_secret, crypto_version
      FROM account_credentials
      WHERE account_id = ? AND credential_kind = 'oauth-refresh-token'
    `).get(account.id) as { encrypted_secret: string; crypto_version: number } | undefined;
    if (!credential) throw this.reauthRequired(account, "找不到该邮箱的刷新授权，请重新登录。");
    if (credential.crypto_version !== ACCOUNT_CREDENTIAL_CRYPTO_VERSION) {
      throw this.reauthRequired(account, "本地授权数据版本无法验证，请重新登录该邮箱。");
    }
    try {
      return decryptOAuthRefreshToken(account, credential.encrypted_secret, this.masterKey);
    } catch (error) {
      if (error instanceof AccountCredentialIntegrityError) {
        throw this.reauthRequired(account, "本地授权数据与邮箱连接配置不匹配，请重新登录该邮箱。");
      }
      throw error;
    }
  }

  async getAccessToken(account: AccountRecord): Promise<string> {
    // Validate the persisted, endpoint-bound refresh token even when an access
    // token is cached. Otherwise a database endpoint rewrite could reuse the
    // in-memory token without ever authenticating the modified account row.
    const refreshToken = this.storedRefreshToken(account);
    const cached = this.tokenCache.get(account.id);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const active = this.refreshes.get(account.id);
    if (active) return active;
    const refresh = this.refreshAccessToken(account, refreshToken).finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, refresh);
    return refresh;
  }

  private async refreshAccessToken(account: AccountRecord, refreshToken: string): Promise<string> {
    try {
      const provider = providerConfig(this.providerForAccount(account));
      const client = clientMetadata(provider);
      const response = await oauth.refreshTokenGrantRequest(serverMetadata(provider), client, oauth.None(), refreshToken);
      const tokens = await oauth.processRefreshTokenResponse(serverMetadata(provider), client, response);
      const now = Date.now();
      const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
      this.tokenCache.set(account.id, { token: tokens.access_token, expiresAt: now + Math.max(60, expiresIn) * 1_000 });
      if (typeof tokens.refresh_token === "string" && tokens.refresh_token) {
        this.db.prepare("UPDATE account_credentials SET encrypted_secret = ?, crypto_version = ?, updated_at = ? WHERE account_id = ?")
          .run(
            encryptOAuthRefreshToken(account, tokens.refresh_token, this.masterKey),
            ACCOUNT_CREDENTIAL_CRYPTO_VERSION,
            new Date(now).toISOString(),
            account.id,
          );
      }
      return tokens.access_token;
    } catch (error) {
      const code = flowErrorCode(error);
      if (error instanceof OAuthError || code === "invalid_grant") {
        this.tokenCache.delete(account.id);
        this.db.prepare("UPDATE accounts SET status = 'reauth_required', last_error = ?, last_error_code = ? WHERE id = ?")
          .run("授权已失效，请重新登录。", "reauth_required", account.id);
        throw error instanceof OAuthError ? error : new OAuthError("reauth_required", "授权已经失效，请重新登录该邮箱。" );
      }
      const transportError = oauthTransportError(error);
      if (transportError) throw transportError;
      throw new OAuthError("oauth_refresh_failed", "无法刷新授权，请稍后重试。" );
    }
  }
}

export function isSupportedOAuthProvider(value: string): value is OAuthProviderId {
  return isOAuthProvider(value);
}
