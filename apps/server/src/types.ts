import type { DatabaseHandle } from "./db.js";

export type AccountRecord = {
  id: string;
  email: string;
  provider: string;
  provider_name: string;
  encrypted_password: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username_mode: "email" | "local";
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
  created_at: string;
};

export type RuntimeContext = {
  db: DatabaseHandle;
  masterKey: Buffer;
};

export function publicAccount(row: AccountRecord) {
  return {
    id: row.id,
    email: row.email,
    provider: row.provider,
    providerName: row.provider_name,
    status: row.status,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
  };
}
