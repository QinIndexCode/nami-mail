import net, { type Socket } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutboundAttachment, linkOutboundAttachmentsToSubmission, resolveOutboundAttachments } from "../src/outbound-attachments.js";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { encryptAccountPassword } from "../src/account-credentials.js";
import { setProviderFactory, resetProviderFactory, defaultProviderFactory } from "../src/provider/index.js";
import { sendMail } from "../src/mail.js";
import { prepareSubmission, submissionForId, submissionRequestForId, markSubmissionConfirmed, SubmissionConflictError } from "../src/outbox.js";
import { createSendRunner } from "../src/tasks/kinds/send.js";
import { recordTask, taskRow, taskItems } from "../src/tasks/store.js";
import { sendSchema } from "../src/schemas.js";
import type { AccountRecord } from "../src/types.js";

afterEach(resetProviderFactory);

async function smtpFixture() {
  const bodies: string[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 localhost fixture\r\n");
    let input = "";
    let data = false;
    socket.on("data", (chunk) => {
      input += chunk;
      for (;;) {
        const end = input.indexOf(data ? "\r\n.\r\n" : "\r\n");
        if (end < 0) break;
        if (data) {
          bodies.push(input.slice(0, end));
          input = input.slice(end + 5);
          data = false;
          socket.write("250 queued\r\n");
          continue;
        }
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        if (/^(EHLO|HELO)/i.test(line)) socket.write("250 localhost\r\n");
        else if (/^RCPT TO:.*reject@example\.test/i.test(line)) socket.write("550 recipient unavailable\r\n");
        else if (line === "DATA") { data = true; socket.write("354 send data\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setProviderFactory({ ...defaultProviderFactory, createSmtpTransport: () => nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true }) });
  return { bodies, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

function fixture() {
  const db = openDatabase(":memory:");
  const key = Buffer.alloc(32, 0x42);
  db.prepare(`INSERT INTO accounts (id,email,provider,provider_name,encrypted_password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username_mode,status,created_at)
    VALUES ('account','sender@example.test','custom','Fixture','pending','localhost',993,1,'localhost',465,1,'email','connected',?)`).run(new Date().toISOString());
  const account = db.prepare("SELECT * FROM accounts WHERE id = 'account'").get() as AccountRecord;
  account.encrypted_password = encryptAccountPassword(account, "synthetic", key);
  db.prepare("UPDATE accounts SET encrypted_password = ?").run(account.encrypted_password);
  return { db, key, account };
}

describe("recipient privacy and SMTP results", () => {
  it("delivers BCC in the SMTP envelope without publishing a Bcc or Cc header", async () => {
    const smtp = await smtpFixture();
    const { db, key, account } = fixture();
    try {
      const result = await sendMail(account, key, { to: ["visible@example.test"], bcc: ["hidden@example.test"], subject: "BCC", text: "Synthetic" });
      expect(result.accepted).toEqual(["visible@example.test", "hidden@example.test"]);
      expect(smtp.bodies[0]).not.toMatch(/^(Bcc|Cc):/im);
      expect(smtp.bodies[0]).not.toContain("hidden@example.test");
    } finally { db.close(); await smtp.close(); }
  });

  it("persists partial rejection in encrypted details and retains it after Sent confirmation", async () => {
    const smtp = await smtpFixture();
    const { db, key } = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-partial-attachment-"));
    try {
      const attachment = createOutboundAttachment(db, directory, key, { accountId: "account", filename: "retry.txt", contentType: "text/plain", content: Buffer.from("Retain for rejected recipient") });
      const { submission } = prepareSubmission(db, key, { accountId: "account", accountEmail: "sender@example.test", request: { to: ["visible@example.test"], bcc: ["reject@example.test"], subject: "Partial", text: "Synthetic", attachmentTokens: [attachment.token] } });
      linkOutboundAttachmentsToSubmission(db, "account", submission.id, [attachment.token]);
      const id = recordTask(db, key, { id: submission.id, accountId: "account", kind: "send", total: 1, submissionId: submission.id });
      await createSendRunner({ db, masterKey: key, outboundAttachmentDirectory: directory, scheduleSentVerification() {} })({ task: taskRow(db, id)!, payload: undefined, items: taskItems(db, id), signal: new AbortController().signal, report() {} });
      expect(resolveOutboundAttachments(db, directory, key, "account", [attachment.token])[0]?.content.toString()).toBe("Retain for rejected recipient");
      const result = submissionForId(db, key, id)!;
      expect(result.deliveryStatus).toBe("submitted");
      expect(result.recipientDelivery).toMatchObject({ accepted: ["visible@example.test"], rejected: [{ address: "reject@example.test" }] });
      expect(result.recipientDelivery?.rejected[0]?.responseCode).toBe(550);
      expect(result.bccRecipients).toEqual(["reject@example.test"]);
      expect(markSubmissionConfirmed(db, key, id).recipientDelivery).toEqual(result.recipientDelivery);
      const stored = db.prepare("SELECT request_json,encrypted_details FROM outbound_submissions WHERE id = ?").get(id);
      expect(JSON.stringify(stored)).not.toContain("reject@example.test");
      expect(smtp.bodies[0]).not.toContain("reject@example.test");
    } finally { db.close(); await smtp.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves BCC through encrypted replay and includes it in the idempotency comparison", () => {
    const { db, key } = fixture();
    try {
      const input = { accountId: "account", accountEmail: "sender@example.test", idempotencyKey: "bcc-key", request: { to: [], bcc: ["hidden@example.test"], subject: "BCC", text: "Synthetic", attachmentTokens: [] } };
      expect(sendSchema.safeParse({ accountId: "account", to: [], bcc: input.request.bcc }).success).toBe(true);
      const { submission } = prepareSubmission(db, key, input);
      expect(submissionRequestForId(db, key, submission.id)?.bcc).toEqual(input.request.bcc);
      expect(prepareSubmission(db, key, input).created).toBe(false);
      expect(() => prepareSubmission(db, key, { ...input, request: { ...input.request, bcc: ["other@example.test"] } })).toThrow(SubmissionConflictError);
    } finally { db.close(); }
  });
});
