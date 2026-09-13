/**
 * Shared helper functions extracted from app.ts.
 *
 * These are pure functions with no mutable state — safe to import from
 * route modules without creating circular dependencies.
 */
import { z } from "zod";
import { type AccountCredentialIdentity } from "./account-credentials.js";
import { OutboundAttachmentError } from "./outbound-attachments.js";
import { mailErrorHttpStatus, safeMailError } from "./mail.js";
import { OAuthError } from "./oauth.js";
import { detectProvider, loginUsername, providerPresets, type DetectedProvider, type ProviderPreset } from "./providers.js";
import { manualAccountSchema } from "./schemas.js";

// Allow contemporary 4K/8K wallpapers without retaining their original size.
// The image is still normalized and the persisted WebP remains capped.
export const MAX_BACKGROUND_UPLOAD_BYTES = 50 * 1024 * 1024;

export function decodedUploadHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2_304) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function validationMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "请求参数无效。";
}

export function oauthProviderFor(provider: Pick<ProviderPreset, "family">): "google" | "microsoft" | undefined {
  if (provider.family === "google") return "google";
  if (provider.family === "microsoft") return "microsoft";
  return undefined;
}

export function isOAuthOnlyProvider(provider: DetectedProvider): boolean {
  return provider.authMethods.length > 0 && provider.authMethods.every((method) => method === "oauth2");
}

export function providerInfo(provider: ProviderPreset) {
  return {
    id: provider.id,
    name: provider.name,
    family: provider.family,
    priority: provider.priority,
    authMethods: provider.authMethods,
    recommendedAuthMethod: provider.recommendedAuthMethod,
    credentialLabel: provider.credentialLabel,
    credentialName: provider.credentialName,
    credentialHint: provider.credentialHint,
    helpText: provider.helpText,
    caveat: provider.caveat,
    setupSteps: provider.setupSteps,
    helpUrl: provider.helpUrl,
    helpLabel: provider.helpLabel,
    usernameMode: provider.usernameMode ?? "email",
    imapUsernameMode: provider.imapUsernameMode ?? provider.usernameMode ?? "email",
    smtpUsernameMode: provider.smtpUsernameMode ?? provider.usernameMode ?? "email",
    basicAuthLimited: Boolean(provider.basicAuthLimited),
    capabilities: provider.capabilities,
    imap: { host: provider.imap.host, port: provider.imap.port, transport: provider.imap.transport },
    smtp: { host: provider.smtp.host, port: provider.smtp.port, transport: provider.smtp.transport },
  };
}

export function providerDiscovery(provider: DetectedProvider) {
  return {
    ...providerInfo(provider),
    domain: provider.domain,
    isCustom: provider.isCustom,
    source: provider.source,
    confidence: provider.confidence,
  };
}

export function manualProvider(provider: DetectedProvider, input: z.infer<typeof manualAccountSchema>): DetectedProvider {
  // When the user tweaks endpoints for a known provider, keep its preset
  // identity (id / name / family) so the account stays recognizable; only
  // truly custom domains fall back to the "custom" label.
  const declared = input.providerId && input.providerId !== "custom"
    ? providerPresets.find((preset) => preset.id === input.providerId)
    : undefined;
  const identity = declared ?? provider;
  return {
    ...identity,
    domain: provider.domain,
    isCustom: provider.isCustom,
    source: provider.source,
    confidence: provider.confidence,
    priority: identity.priority ?? "fallback",
    domains: identity.domains?.length ? identity.domains : [provider.domain],
    imap: { ...input.imap, secure: input.imap.transport === "tls" },
    smtp: { ...input.smtp, secure: input.smtp.transport === "tls" },
    usernameMode: "email",
  };
}

export function passwordCredentialIdentity(
  id: string,
  email: string,
  provider: DetectedProvider,
  usernames: { imap: string; smtp: string },
): AccountCredentialIdentity {
  return {
    id,
    email,
    provider: provider.id,
    auth_method: "password",
    imap_host: provider.imap.host,
    imap_port: provider.imap.port,
    imap_secure: provider.imap.secure ? 1 : 0,
    imap_transport: provider.imap.transport,
    imap_username: usernames.imap,
    smtp_host: provider.smtp.host,
    smtp_port: provider.smtp.port,
    smtp_secure: provider.smtp.secure ? 1 : 0,
    smtp_transport: provider.smtp.transport,
    smtp_username: usernames.smtp,
    username_mode: provider.usernameMode ?? "email",
  };
}

export function oauthErrorBody(error: unknown): { code: string; message: string } {
  if (error instanceof OAuthError) return { code: error.code, message: error.message };
  return { code: "oauth_failed", message: "授权未完成，请重试。" };
}

export function mailFailure(error: unknown, hint?: string) {
  const details = safeMailError(error, hint);
  return {
    statusCode: mailErrorHttpStatus(details.code),
    body: { ok: false as const, ...details },
  };
}

export function mailFailureBody(failure: ReturnType<typeof mailFailure>, message: string) {
  // Local validation and cache-state errors are already represented by their
  // precise safe message. Do not turn them into a misleading transport error.
  if (failure.body.code === "unknown") return { ok: false as const, message };
  return { ...failure.body, message };
}

export function oauthRequiredBody(provider: DetectedProvider) {
  return {
    ok: false as const,
    code: "oauth_required",
    provider: provider.name,
    message: `${provider.name} 要求使用 OAuth2 登录，请选择对应的安全登录方式。`,
  };
}

export function folderRank(folder: Record<string, unknown>): number {
  const ranks: Record<string, number> = {
    "\\Inbox": 0,
    "\\Sent": 1,
    "\\Drafts": 2,
    "\\Flagged": 3,
    "\\Important": 4,
    "\\All": 5,
    "\\Archive": 6,
    "\\Junk": 7,
    "\\Spam": 7,
    "\\Trash": 8,
  };
  return ranks[String(folder.special_use ?? "")] ?? 20;
}

export function outboundAttachmentErrorStatus(error: unknown): number {
  return error instanceof OutboundAttachmentError ? error.statusCode : 422;
}

export function outboundAttachmentActionErrorMessage(error: unknown): string {
  if (error instanceof OutboundAttachmentError) return error.message;
  return "附件处理失败，请重新添加后重试。";
}

export function contentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
