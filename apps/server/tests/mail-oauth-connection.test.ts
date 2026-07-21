import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountRecord } from "../src/types.js";

const { ImapFlow, createTransport } = vi.hoisted(() => ({
  ImapFlow: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("imapflow", () => ({ ImapFlow }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

import { testOAuthAccountConnection } from "../src/mail.js";

const account: AccountRecord = {
  id: "oauth-account",
  email: "member@contoso.example",
  provider: "microsoft",
  provider_name: "Microsoft 365",
  encrypted_password: "managed-by-oauth",
  auth_method: "oauth2",
  provider_subject: "member-subject",
  tenant_id: "tenant-id",
  granted_scopes: "[]",
  imap_host: "outlook.office365.com",
  imap_port: 993,
  imap_secure: 1,
  imap_transport: "tls",
  imap_username: "member@contoso.example",
  smtp_host: "smtp.office365.com",
  smtp_port: 587,
  smtp_secure: 0,
  smtp_transport: "starttls",
  smtp_username: "member@contoso.example",
  username_mode: "email",
  status: "connecting",
  last_error: null,
  last_error_code: null,
  last_synced_at: null,
  created_at: "2026-07-19T00:00:00.000Z",
};

describe("OAuth account transport verification", () => {
  const imap = {
    usable: true,
    on: vi.fn(),
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [{ path: "INBOX" }, { path: "Sent" }]),
    logout: vi.fn(async () => undefined),
  };
  const smtp = {
    verify: vi.fn(async () => true),
    close: vi.fn(),
  };
  const tokenProvider = { getAccessToken: vi.fn(async () => "oauth-access-token") };

  beforeEach(() => {
    vi.clearAllMocks();
    imap.usable = true;
    imap.connect.mockResolvedValue(undefined);
    imap.list.mockResolvedValue([{ path: "INBOX" }, { path: "Sent" }]);
    imap.logout.mockResolvedValue(undefined);
    smtp.verify.mockResolvedValue(true);
    ImapFlow.mockImplementation(function MockImapFlow() { return imap; });
    createTransport.mockReturnValue(smtp);
    tokenProvider.getAccessToken.mockResolvedValue("oauth-access-token");
  });

  it("uses one OAuth access token to verify IMAP and required-STARTTLS SMTP", async () => {
    await expect(testOAuthAccountConnection(account, Buffer.alloc(32, 7), tokenProvider)).resolves.toEqual({ folders: 2, smtp: true });

    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(1);
    expect(ImapFlow).toHaveBeenCalledWith(expect.objectContaining({
      host: "outlook.office365.com",
      secure: true,
      auth: { user: "member@contoso.example", accessToken: "oauth-access-token" },
    }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { type: "OAuth2", user: "member@contoso.example", accessToken: "oauth-access-token" },
    }));
    expect(imap.connect).toHaveBeenCalledTimes(1);
    expect(imap.list).toHaveBeenCalledTimes(1);
    expect(smtp.verify).toHaveBeenCalledTimes(1);
    expect(imap.logout).toHaveBeenCalledTimes(1);
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });

  it("fails the account verification when SMTP OAuth cannot be verified", async () => {
    smtp.verify.mockRejectedValueOnce(new Error("SMTP AUTH is disabled"));

    await expect(testOAuthAccountConnection(account, Buffer.alloc(32, 7), tokenProvider)).rejects.toThrow("SMTP AUTH is disabled");
    expect(imap.logout).toHaveBeenCalledTimes(1);
    expect(smtp.close).toHaveBeenCalledTimes(1);
  });
});
