import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { PortableBackupService } from "../src/portable-backup.js";
import { openBackupDatabase, resolveBackupStorage } from "../src/portable-backup-storage.js";
import { encodeBackup, type BackupFrame } from "../src/portable-backup-format.js";
import { seedRecoveryFixture } from "./helpers/recovery-fixture.js";
import { createContact, listContacts } from "../src/contacts.js";
import { createCalendarEvent, listCalendarEvents } from "../src/calendar.js";
import { getAppSettings, updateAppSettings } from "../src/settings.js";
import { createOutboundAttachment, resolveOutboundAttachments } from "../src/outbound-attachments.js";
import { prepareSubmission, submissionForId } from "../src/outbox.js";
import { recordTask, taskRow } from "../src/tasks/store.js";
import { messagePayloadForRow, type MessageStorageRow } from "../src/message-storage.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const password = "synthetic-password-123";
async function collect(source: AsyncIterable<Buffer>) { const chunks = []; for await (const chunk of source) chunks.push(chunk); return Buffer.concat(chunks); }
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-portable-"));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceKey = Buffer.alloc(32, 21); const targetKey = Buffer.alloc(32, 22);
  const originalDatabasePath = path.join(directory, "original.db");
  const sourcePath = path.join(directory, "source.db");
  const db = openDatabase(sourcePath, { encryptionKey: sourceKey }); cleanups.push(() => db.close());
  seedRecoveryFixture(db, sourceKey);
  const settings = { db, masterKey: sourceKey, hostKey: sourceKey, originalDatabasePath: sourcePath,
    backgroundDirectory: path.join(directory, "backgrounds"), outboundDirectory: path.join(directory, "outbound") };
  const source = new PortableBackupService(settings);
  const target = new PortableBackupService({ ...settings, hostKey: targetKey, originalDatabasePath });
  return { db, directory, source, target, sourceKey, targetKey, originalDatabasePath, settings };
}
describe("portable application backup", () => {
  it("restores across host keys, retains private local data and attachments, and pauses pending external effects", async () => {
    const f = fixture();
    createContact(f.db, f.sourceKey, { name: "Ada", email: "ada@example.test" });
    createCalendarEvent(f.db, f.sourceKey, { title: "Private meeting", startAt: "2026-11-07T01:00:00Z", endAt: "2026-11-07T02:00:00Z" });
    updateAppSettings(f.db, { autoReply: { enabled: true } });
    const attachment = createOutboundAttachment(f.db, f.settings.outboundDirectory, f.sourceKey, { accountId: "account", filename: "notes.txt", contentType: "text/plain", content: Buffer.from("attachment secret") });
    const submission = prepareSubmission(f.db, f.sourceKey, { accountId: "account", accountEmail: "me@example.test", request: { to: ["ada@example.test"], subject: "Pending", text: "Private draft", attachmentTokens: [attachment.token] } }).submission;
    const task = recordTask(f.db, f.sourceKey, { accountId: "account", kind: "send", submissionId: submission.id });
    fs.writeFileSync(f.originalDatabasePath, "existing data must remain");
    const archive = await collect(f.source.export(password));
    expect(archive.includes(Buffer.from("Private subject"))).toBe(false);
    expect(archive.includes(f.sourceKey)).toBe(false);
    const preview = await f.target.preview(Readable.from([archive]), password);
    expect(preview.counts).toMatchObject({ accounts: 1, messages: 1, contacts: 1, calendar_events: 1 });
    expect(fs.readFileSync(f.originalDatabasePath, "utf8")).toBe("existing data must remain");
    expect(resolveBackupStorage(f.originalDatabasePath, f.targetKey).databasePath).toBe(f.originalDatabasePath);
    await f.target.activate(preview.id);
    const restored = resolveBackupStorage(f.originalDatabasePath, f.targetKey);
    expect(restored.masterKey.equals(f.sourceKey)).toBe(true);
    const db = openBackupDatabase(restored.databasePath, restored.masterKey, false);
    try {
      expect(listContacts(db, restored.masterKey)).toHaveLength(1);
      expect(listCalendarEvents(db, restored.masterKey)[0]?.title).toBe("Private meeting");
      expect(getAppSettings(db).autoReply.enabled).toBe(false);
      expect(taskRow(db, task)?.status).toBe("cancelled");
      expect(submissionForId(db, restored.masterKey, submission.id)?.deliveryStatus).toBe("unknown_delivery");
      expect(messagePayloadForRow(db.prepare("SELECT * FROM messages WHERE id='message'").get() as MessageStorageRow, restored.masterKey).textBody).toBe("Private body");
      expect(resolveOutboundAttachments(db, path.join(path.dirname(restored.databasePath), "outbound-attachments"), restored.masterKey, "account", [attachment.token])[0]?.content.toString()).toBe("attachment secret");
    } finally { db.close(); restored.masterKey.fill(0); }
    expect(fs.readFileSync(f.originalDatabasePath, "utf8")).toBe("existing data must remain");
  });
  it("rejects wrong passwords, tampering and truncation without activating a restore", async () => {
    const f = fixture(); const archive = await collect(f.source.export(password));
    const changed = Buffer.from(archive); changed[100] = changed[100]! ^ 1;
    for (const [bytes, secret] of [[archive, "wrong-password-123"], [changed, password], [archive.subarray(0, -6), password]] as const) {
      await expect(f.target.preview(Readable.from([bytes]), secret)).rejects.toThrow();
      expect(resolveBackupStorage(f.originalDatabasePath, f.targetKey).databasePath).toBe(f.originalDatabasePath);
    }
    expect(fs.readdirSync(path.join(f.directory, "restored-data"))).toEqual([]);
  });
  it("serializes activation and discard so no startup pointer can outlive its directory", async () => {
    const f = fixture();
    const archive = await collect(f.source.export(password));

    // Discard begins first and yields inside the directory removal; activation
    // arrives while that removal is still in flight. Without the mutex the
    // pointer is written in the gap and then its directory is deleted beneath
    // it, so the next startup would refuse to open the application.
    const first = await f.target.preview(Readable.from([archive]), password);
    const [discardResult, activateResult] = await Promise.allSettled([
      f.target.discard(first.id),
      f.target.activate(first.id),
    ]);
    expect(discardResult.status).toBe("fulfilled");
    expect(activateResult.status).toBe("rejected");
    const afterDiscard = resolveBackupStorage(f.originalDatabasePath, f.targetKey);
    expect(afterDiscard.databasePath).toBe(f.originalDatabasePath);
    afterDiscard.masterKey.fill(0);

    // The other order: activation wins, and discard must refuse rather than
    // delete the directory the pointer just adopted.
    const second = await f.target.preview(Readable.from([archive]), password);
    const [activateFirst, discardSecond] = await Promise.allSettled([
      f.target.activate(second.id),
      f.target.discard(second.id),
    ]);
    expect(activateFirst.status).toBe("fulfilled");
    expect(discardSecond.status).toBe("rejected");
    const restored = resolveBackupStorage(f.originalDatabasePath, f.targetKey);
    expect(restored.databasePath).toBe(path.join(f.directory, "restored-data", second.id, "database.sqlite"));
    restored.masterKey.fill(0);
  });
  it("keeps the restore queue running after a rejected action", async () => {
    const f = fixture();
    const archive = await collect(f.source.export(password));
    const active = await f.target.preview(Readable.from([archive]), password);
    await f.target.activate(active.id);
    const spare = await f.target.preview(Readable.from([archive]), password);

    // Both are queued before either runs. The first is refused because its
    // directory is the activated one; that rejection must not strand the action
    // queued behind it.
    const rejected = f.target.discard(active.id);
    const proceeds = f.target.discard(spare.id);
    await expect(rejected).rejects.toThrow(/activated restore cannot be discarded/u);
    await expect(proceeds).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, "restored-data", spare.id))).toBe(false);
  });
  it("rejects authenticated unsafe file paths and incomplete file declarations", async () => {
    const f = fixture();
    for (const entry of [{ path: "../escape", size: 0 }, { path: "database.sqlite", size: 10 }]) {
      async function* frames(): AsyncGenerator<BackupFrame> {
        yield { type: "metadata", value: { version: 1, schemaVersion: 5, createdAt: new Date().toISOString(), masterKey: f.sourceKey.toString("base64url") } };
        yield { type: "file", ...entry }; yield { type: "file-end" }; yield { type: "end" };
      }
      await expect(f.target.preview(Readable.from([await collect(encodeBackup(frames(), password))]), password)).rejects.toThrow();
    }
    expect(fs.existsSync(path.join(f.directory, "escape"))).toBe(false);
  });
});
