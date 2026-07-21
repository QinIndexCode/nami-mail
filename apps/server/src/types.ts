import type { DatabaseHandle } from "./db.js";
import type { OAuthService } from "./oauth.js";
import type { AppSettings } from "./settings.js";

export type AccountRecord = {
  id: string;
  email: string;
  provider: string;
  provider_name: string;
  encrypted_password: string;
  auth_method: "password" | "oauth2";
  provider_subject: string | null;
  tenant_id: string | null;
  granted_scopes: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  imap_transport: "tls" | "starttls";
  imap_username: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_transport: "tls" | "starttls";
  smtp_username: string | null;
  username_mode: "email" | "local";
  status: string;
  last_error: string | null;
  last_error_code: string | null;
  last_synced_at: string | null;
  created_at: string;
};

export type RuntimeContext = {
  db: DatabaseHandle;
  masterKey: Buffer;
  // Tests and embedded hosts can keep custom assets alongside their own data.
  backgroundDirectory?: string;
  // Outbound files live only under this runtime-owned directory. The API
  // accepts opaque tokens and never receives a renderer-provided file path.
  outboundAttachmentDirectory?: string;
  // The owning runtime uses this to replace its pending IMAP sync delay after
  // a user changes the persisted refresh interval.
  onRefreshIntervalChanged?: (refreshIntervalSeconds: AppSettings["refreshIntervalSeconds"]) => void;
  // OAuth refresh tokens stay encrypted at rest; access tokens only live in
  // this service's in-memory cache and are refreshed on demand.
  oauthService?: OAuthService;
  // Tests and embedded hosts may provide the exact local callback origin.
  // The normal runtime derives it from the bound loopback listener.
  oauthCallbackOrigin?: string;
  // Microsoft requires a redirect URI registered as localhost. The runtime
  // sets this only after its IPv6 loopback callback bridge is listening.
  microsoftOAuthCallbackOrigin?: string;
  // Keep Google available when the machine cannot bind the Microsoft-only
  // IPv6 loopback callback bridge.
  microsoftOAuthCallbackUnavailable?: string;
};

export function publicAccount(row: AccountRecord) {
  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    providerName: row.provider_name,
    authMethod: row.auth_method,
    status: row.status,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}
