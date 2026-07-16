export type Folder = {
  path: string;
  name: string;
  specialUse: string | null;
  total: number;
  unseen: number;
};

export type Account = {
  id: string;
  email: string;
  provider: string;
  providerName: string;
  status: string;
  lastError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  folders: Folder[];
};

export type MailAddress = { name: string; address: string };

export type Message = {
  id: string;
  accountId: string;
  accountEmail: string;
  providerName: string;
  mailbox: string;
  uid: number;
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  sentAt: string;
  snippet: string;
  textBody: string;
  htmlBody: string;
  flags: string[];
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  size: number;
};

export type ProviderInfo = {
  id: string;
  name: string;
  domains: string[];
  credentialHint: string;
  credentialName: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  basicAuthLimited: boolean;
};

export type Stats = { accounts: number; messages: number; unread: number };
