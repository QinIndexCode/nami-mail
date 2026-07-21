import { describe, expect, it, vi } from "vitest";

const { close, createTransport, send } = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  send: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

import { encryptAccountPassword } from "../src/account-credentials.js";
import { sendMail } from "../src/mail.js";
import type { AccountRecord } from "../src/types.js";

function outboundAccount(key: Buffer): AccountRecord {
  const account: AccountRecord = {
    id: "account-1",
    email: "sender@example.com",
    provider: "custom",
    provider_name: "Demo",
    encrypted_password: "pending",
    auth_method: "password",
    provider_subject: null,
    tenant_id: null,
    granted_scopes: null,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_secure: 1,
    imap_transport: "tls",
    imap_username: "sender@example.com",
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: 1,
    smtp_transport: "tls",
    smtp_username: "sender@example.com",
    username_mode: "email",
    status: "connected",
    last_error: null,
    last_error_code: null,
    last_synced_at: null,
    created_at: new Date().toISOString(),
  };
  account.encrypted_password = encryptAccountPassword(account, "app-password", key);
  return account;
}

describe("SMTP outbound attachments", () => {
  it("passes only resolved attachment content to Nodemailer and does not add BCC", async () => {
    const key = Buffer.alloc(32, 9);
    const account = outboundAccount(key);
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
    createTransport.mockReturnValue({ sendMail: send, close });

    await sendMail(account, key, {
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Attachment",
      text: "Body",
      attachments: [{
        filename: "notes.txt",
        contentType: "text/plain",
        content: Buffer.from("attachment body"),
      }],
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      attachments: [{
        filename: "notes.txt",
        contentType: "text/plain",
        content: Buffer.from("attachment body"),
        contentDisposition: "attachment",
      }],
    }));
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("bcc");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes RFC threading headers to Nodemailer", async () => {
    const key = Buffer.alloc(32, 9);
    const account = outboundAccount(key);
    send.mockResolvedValue({ messageId: "<sent@nami.local>" });
    createTransport.mockReturnValue({ sendMail: send, close });

    await sendMail(account, key, {
      to: ["recipient@example.com"],
      subject: "Reply",
      text: "Body",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
    }));
  });
});
