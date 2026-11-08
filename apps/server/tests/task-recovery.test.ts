import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.js";
import { seedRecoveryFixture } from "./helpers/recovery-fixture.js";
import { acceptFlagsTask } from "../src/tasks/kinds/flags.js";
import { acceptMoveTask } from "../src/tasks/kinds/move.js";
import { settleTask, taskRow, openTaskPayload, recordTask, deliveryTaskList } from "../src/tasks/store.js";
import { retryTaskItems, taskRecoveryDetails } from "../src/tasks/recovery.js";
import { registerTaskRecoveryRoutes } from "../src/routes/task-recovery.js";
import { createOutboundAttachment } from "../src/outbound-attachments.js";
import { markSubmissionFailed, markSubmissionSubmitted, markSubmissionUnknownDelivery, prepareSubmission } from "../src/outbox.js";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  const db = openDatabase(":memory:"); cleanups.push(() => { db.close(); });
  const key = Buffer.alloc(32, 17); seedRecoveryFixture(db, key);
  const scheduler = { start: vi.fn() }; return { db, key, scheduler, deps: { db, masterKey: key, scheduler } };
}
describe("user task recovery", () => {
  it("reasserts an unchanged local flag through the existing acceptance and prevents duplicate recovery", () => {
    const f = fixture(); const [original] = acceptFlagsTask(f.deps, { messageIds: ["message"], patch: { seen: true } }).handles;
    settleTask(f.db, original!.id, "failed", null);
    expect(taskRecoveryDetails(f.db, f.key, original!.id)?.items[0]?.eligible).toBe(true);
    const result = retryTaskItems(f.deps, original!.id, ["message"]);
    expect(result.retried).toBe(1);
    const child = taskRow(f.db, result.taskIds[0]!)!;
    expect(child.parent_id).toBe(original!.id);
    expect(openTaskPayload<{ entries: Array<{ add: string[] }> }>(f.key, child)?.entries[0]?.add).toEqual(["\\Seen"]);
    expect(retryTaskItems(f.deps, original!.id, ["message"]).retried).toBe(0);
  });
  it("refuses superseded actions and changed UID generations", () => {
    const f = fixture(); const [original] = acceptFlagsTask(f.deps, { messageIds: ["message"], patch: { seen: true } }).handles;
    settleTask(f.db, original!.id, "failed", null);
    f.db.prepare("UPDATE folders SET uid_validity='999' WHERE path='INBOX'").run();
    expect(taskRecoveryDetails(f.db, f.key, original!.id)?.items[0]?.reason).toBe("syncRequired");
    f.db.prepare("UPDATE folders SET uid_validity='123' WHERE path='INBOX'").run();
    acceptFlagsTask(f.deps, { messageIds: ["message"], patch: { seen: false } });
    expect(taskRecoveryDetails(f.db, f.key, original!.id)?.items[0]?.reason).toBe("superseded");
    expect(retryTaskItems(f.deps, original!.id, ["message"]).taskIds).toEqual([]);
  });
  it("never retries a move already delivered or an unknown send and persists dismissal", async () => {
    const f = fixture(); const original = acceptMoveTask(f.deps, { messageIds: ["message"], destination: { target: "archive" } }).handles[0]!;
    settleTask(f.db, original.id, "failed", null);
    f.db.prepare("UPDATE messages SET mailbox='Archive',pending_move_destination=NULL,pending_move_state=NULL").run();
    expect(taskRecoveryDetails(f.db, f.key, original.id)?.items[0]?.reason).toBe("delivered");
    const send = recordTask(f.db, f.key, { accountId: "account", kind: "send" }); settleTask(f.db, send, "unknown_delivery", null);
    const app = Fastify(); registerTaskRecoveryRoutes(app, { db: f.db, masterKey: f.key }, f.scheduler); cleanups.push(() => app.close());
    expect((await app.inject({ method: "POST", url: `/api/tasks/${send}/retry`, payload: { messageIds: ["message"] } })).json()).toMatchObject({ retried: 0 });
    expect(deliveryTaskList(f.db).attention.map((row) => row.id)).toContain(send);
    await app.inject({ method: "POST", url: `/api/tasks/${send}/dismiss`, payload: { acknowledge: true } });
    expect(deliveryTaskList(f.db).attention.map((row) => row.id)).not.toContain(send);
  });
  it("recovers private body, threading and only rejected BCC, cloning available attachments and reporting missing ones", async () => {
    const f = fixture(); const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-retry-"));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = createOutboundAttachment(f.db, directory, f.key, { accountId: "account", filename: "notes.txt", contentType: "text/plain", content: Buffer.from("notes") });
    const submission = prepareSubmission(f.db, f.key, { accountId: "account", accountEmail: "me@example.test", request: {
      to: ["accepted@example.test"], bcc: ["rejected@example.test"], subject: "Private retry", text: "Original complete body", inReplyTo: "<root@example.test>", attachmentTokens: [file.token, "out_00000000-0000-0000-0000-000000000000"] } }).submission;
    markSubmissionSubmitted(f.db, f.key, submission.id, "<sent@example.test>", { accepted: ["accepted@example.test"], rejected: [{ address: "rejected@example.test", responseCode: 550 }] });
    const app = Fastify(); registerTaskRecoveryRoutes(app, { db: f.db, masterKey: f.key, outboundAttachmentDirectory: directory }, f.scheduler); cleanups.push(() => app.close());
    const response = await app.inject({ method: "POST", url: `/api/submissions/${submission.id}/retry-draft`, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ missingAttachments: 1, draft: { to: "", bcc: "rejected@example.test", text: "Original complete body", inReplyTo: "<root@example.test>", recoveryMissingAttachments: 1 } });
    expect(response.json().draft.attachments[0].token).not.toBe(file.token);
    expect(f.scheduler.start).not.toHaveBeenCalled();
  });
  it("requires explicit acknowledgment for unknown delivery and refuses retries of successful sends", async () => {
    const f = fixture(); const submission = prepareSubmission(f.db, f.key, { accountId: "account", accountEmail: "me@example.test", request: { to: ["ada@example.test"], subject: "Review", text: "", html: "<p>Original <strong>HTML</strong> body.</p>", attachmentTokens: [] } }).submission;
    const app = Fastify(); registerTaskRecoveryRoutes(app, { db: f.db, masterKey: f.key }, f.scheduler); cleanups.push(() => app.close());
    const url = `/api/submissions/${submission.id}/retry-draft`;
    markSubmissionUnknownDelivery(f.db, f.key, submission.id, "connection_reset", "unknown");
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(409);
    const recovered = await app.inject({ method: "POST", url, payload: { confirmUnknown: true } });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().draft.text).toContain("Original HTML body.");
    markSubmissionFailed(f.db, f.key, submission.id, "fixture", "fixture");
    markSubmissionSubmitted(f.db, f.key, submission.id, "<sent@example.test>");
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(409);
  });
});
