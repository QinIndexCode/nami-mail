import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/db.js";
import { encryptMessagePayload } from "../src/message-storage.js";
import { updateAppSettings } from "../src/settings.js";
import { AutoReplyEngine, type AutoReplyEngineOptions, type AutoReplyUiEvent } from "../src/agent/auto-reply.js";
import { AutoReplyWorkQueue } from "../src/agent/auto-reply-work.js";
import { trackAutoReplyDelivery } from "../src/agent/auto-reply-delivery.js";
import { SqliteMailApplicationService } from "../src/agent/sqlite-mail-application-service.js";
import { acceptPreparedSendTask } from "../src/tasks/kinds/send.js";
import { prepareSubmission, markSubmissionFailed, markSubmissionUnknownDelivery, markSubmissionConfirmed } from "../src/outbox.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { EncryptedAgentMemoryStore } from "../src/agent/memory.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function fixture(count = 1, autoSubmitted = "") {
  const db = openDatabase(":memory:");
  cleanups.push(() => db.close());
  const key = Buffer.alloc(32, 0x37);
  applyAgentStoreSchema(db);
  db.prepare(`INSERT INTO accounts(id,email,provider,provider_name,encrypted_password,imap_host,imap_port,imap_secure,smtp_host,smtp_port,smtp_secure,username_mode,status,created_at)
    VALUES ('account','me@example.test','custom','Fixture','unused','localhost',993,1,'localhost',465,1,'email','connected',?)`).run(new Date().toISOString());
  db.prepare("INSERT INTO folders(account_id,path,name,special_use) VALUES ('account','INBOX','Inbox','\\Inbox')").run();
  const ids = Array.from({ length: count }, (_, index) => `message-${index}`);
  for (const [index, id] of ids.entries()) {
    const payload = { messageId: `<${id}@example.test>`, subject: `Subject ${index}`, fromName: "Ada", fromAddress: "ada@example.test", to: [], cc: null, inReplyTo: null, references: null, snippet: "Review", textBody: "Please review.", htmlBody: "", attachments: null, headers: { autoSubmitted, listUnsubscribe: "", precedence: "", returnPath: "ada@example.test", labels: [] } };
    db.prepare(`INSERT INTO messages(id,account_id,mailbox,uid,subject,from_name,from_address,sent_at,snippet,text_body,flags_json,has_attachments,size,encrypted_payload,payload_version,created_at)
      VALUES (?,'account','INBOX',?,?,?,?,'2026-11-07T01:00:00Z','Review','','[]',0,0,?,1,?)`)
      .run(id, index + 1, payload.subject, payload.fromName, payload.fromAddress, encryptMessagePayload(key, id, "account", payload), new Date().toISOString());
  }
  updateAppSettings(db, { autoReply: { enabled: true, accountIds: ["account"], mode: "template", dailyLimitPerAccount: 500, template: { text: "Thank you", skipConfirmation: true } } });
  const events: AutoReplyUiEvent[] = [];
  const started: string[] = [];
  const mail = new SqliteMailApplicationService({ db, masterKey: key, syncMessageLimit: 2000, outboundAttachmentDirectory: ".",
    acceptPreparedSend: (input) => acceptPreparedSendTask({ db, masterKey: key, scheduler: { start: (id) => started.push(id) } }, input) });
  const options: AutoReplyEngineOptions = { db, masterKey: key, mail, audit: { append: async () => undefined } as unknown as AutoReplyEngineOptions["audit"],
    memory: new EncryptedAgentMemoryStore(db, key), confirmationStore: {} as AutoReplyEngineOptions["confirmationStore"], desktopConfirmation: { capability: {} },
    onEvent: (event) => events.push(event), evaluate: async () => { throw new Error("Template mode must not call a model."); } };
  const engine = new AutoReplyEngine(options);
  cleanups.push(() => engine.close());
  const decision = (id = ids[0]!) => (db.prepare("SELECT decision FROM auto_reply_processed WHERE message_id=?").get(id) as { decision: string } | undefined)?.decision;
  return { db, key, ids, engine, options, events, started, decision };
}

describe("durable auto-reply processing and delivery", () => {
  it("keeps accepted work pending when an error occurs after the task commit", async () => {
    const world = fixture();
    const submit = world.options.mail.submitPreparedMail.bind(world.options.mail);
    vi.spyOn(world.options.mail, "submitPreparedMail").mockImplementation(async (context, id) => {
      await submit(context, id);
      throw new Error("Synthetic post-commit failure");
    });
    await world.engine.notifyInboxMessages("account", world.ids);
    expect(world.started).toHaveLength(1);
    expect(world.decision()).toBe("pending");
    expect(world.events).toEqual([]);
  });

  it("does not report success for a queued reply, and reconciles a later delivery failure", async () => {
    const world = fixture();
    await world.engine.notifyInboxMessages("account", world.ids);
    expect(world.decision()).toBe("pending");
    expect(world.events).toEqual([]);
    expect(world.started).toHaveLength(1);
    markSubmissionFailed(world.db, world.key, world.started[0]!, "smtp_auth_failed", "Synthetic rejection");
    world.engine.reconcileDeliveries();
    expect(world.decision()).toBe("failed");
    expect(world.events).toEqual([]);
  });

  it("reserves the daily budget while delivery is pending", async () => {
    const world = fixture(2);
    updateAppSettings(world.db, { autoReply: { dailyLimitPerAccount: 1 } });
    await world.engine.notifyInboxMessages("account", world.ids);
    expect(world.started).toHaveLength(1);
    expect(world.decision(world.ids[0])).toBe("pending");
    expect(world.decision(world.ids[1])).toBe("ignored");
  });

  it("preserves unknown delivery across restart and emits success once only after confirmation", async () => {
    const world = fixture();
    await world.engine.notifyInboxMessages("account", world.ids);
    const submission = world.started[0]!;
    markSubmissionUnknownDelivery(world.db, world.key, submission, "connection_failed", "Synthetic interruption");
    world.engine.close();
    const restored = new AutoReplyEngine(world.options);
    cleanups.push(() => restored.close());
    restored.start();
    expect(world.decision()).toBe("pending");
    expect(world.started).toHaveLength(1);
    expect(world.events).toEqual([]);
    markSubmissionConfirmed(world.db, world.key, submission);
    restored.reconcileDeliveries();
    restored.reconcileDeliveries();
    expect(world.decision()).toBe("sent");
    expect(world.events.map((event) => event.kind)).toEqual(["sent"]);
  });

  it("processes every item in a 45-message burst and does not repeat a notification", async () => {
    const world = fixture(45, "auto-generated");
    await world.engine.notifyInboxMessages("account", world.ids);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_processed").get()).toEqual({ n: 45 });
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_queue").get()).toEqual({ n: 0 });
    await world.engine.notifyInboxMessages("account", world.ids);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_processed").get()).toEqual({ n: 45 });
  });

  it("resumes a persisted inbox backlog after a worker stops", async () => {
    const world = fixture(45, "auto-generated");
    const previous = new AutoReplyWorkQueue(world.db, () => true, async () => { throw new Error("Must stop before processing."); }, () => new Date().toISOString());
    const run = previous.enqueue("account", world.ids);
    previous.close();
    await run;
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_queue").get()).toEqual({ n: 45 });
    world.engine.start();
    await world.engine.notifyInboxMessages("account", []);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_processed").get()).toEqual({ n: 45 });
  });

  it("recovers a crash between persisting an approved reply and accepting its dispatch task", async () => {
    const world = fixture();
    const { submission } = prepareSubmission(world.db, world.key, { accountId: "account", accountEmail: "me@example.test", request: { to: ["ada@example.test"], subject: "Reply", text: "Synthetic", attachmentTokens: [] } });
    trackAutoReplyDelivery(world.db, { messageId: world.ids[0]!, accountId: "account", threadKey: "thread", submissionId: submission.id, requestId: "request", confirmationId: "approval" }, new Date().toISOString());
    world.engine.start();
    await vi.waitFor(() => expect(world.started).toEqual([submission.id]));
    expect(world.decision()).toBe("pending");
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE submission_id=?").get(submission.id)).toEqual({ n: 1 });
  });
});
