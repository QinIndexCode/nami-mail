import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as mailModule from "../src/mail.js";

const { imapClientForAccount } = vi.hoisted(() => ({ imapClientForAccount: vi.fn() }));

vi.mock("../src/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof mailModule>();
  return { ...actual, imapClientForAccount };
});

import { accountById } from "../src/account-store.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { indexMessageFts } from "../src/message-search.js";
import { messagePayloadForRow, protectedMessageColumns, type MessageStorageRow } from "../src/message-storage.js";
import { markSubmissionSubmitted, prepareSubmission, submissionForId } from "../src/outbox.js";
import { writePendingSentRow, claimPendingSentRow } from "../src/pending-sent.js";
import { syncAccount } from "../src/sync.js";

const MASTER_KEY = Buffer.alloc(32, 21);
const SENT_UID = 42;

const sentFolder = { path: "Sent", name: "Sent", listed: true, flags: new Set<string>(), specialUse: "\\Sent" };
const inboxFolder = { path: "INBOX", name: "Inbox", listed: true, flags: new Set<string>(), specialUse: "\\Inbox" };

const request = {
  to: ["recipient@example.test"],
  subject: "A durable send request",
  text: "Claims must land on the row the acceptance wrote.",
  attachmentTokens: [],
};

/**
 * The optimistic Sent row is written at acceptance and filled by the provider's
 * copy one sync later. These tests drive that pair through the real
 * `syncAccount` path, so the claim is exercised where it runs in production:
 * inside the Sent folder's body fetch, before the payload is sealed.
 *
 * The fake server reports no `emailId` on any message -- the Dovecot-shaped
 * case where every `remote_id_lookup` the *sync* path derives is NULL. Only the
 * claim's RFC Message-ID probe can match there, which is exactly why the probe
 * is keyed on the ENVELOPE instead of on the provider's own id.
 */
describe("sync claims the optimistic Sent row for a provider copy", () => {
  let db: DatabaseHandle;
  const masterKey = MASTER_KEY;
  const lock = { release: vi.fn() };
  const client = {
    usable: true,
    mailbox: { exists: 0, uidValidity: 7n },
    connect: vi.fn(async () => undefined),
    list: vi.fn(async () => [sentFolder]),
    status: vi.fn(async () => ({ messages: 0, unseen: 0 })),
    getMailboxLock: vi.fn(async () => lock),
    fetch: vi.fn(),
    logout: vi.fn(async () => undefined),
  };

  /** The uids a FETCH range selects, for both the array and the `n:*` forms. */
  function uidsInRange(range: unknown, all: number[]): number[] {
    if (Array.isArray(range)) return all.filter((uid) => (range as unknown[]).includes(uid));
    if (range === "*") return all.slice(-1);
    const [from, to] = String(range).split(":");
    const low = Number(from);
    if (!Number.isFinite(low)) return [];
    const high = to === "*" ? Number.POSITIVE_INFINITY : Number(to);
    return all.filter((uid) => uid >= low && uid <= high);
  }

  /**
   * Installs a provider that stores `uids` in the folder it is asked for and
   * answers the metadata pass with flags only. `body` is what the body pass
   * gets, i.e. the provider's own bytes for one stored message.
   */
  function installProvider(input: {
    uids?: number[];
    folders?: unknown[];
    /** The UID epoch the provider reports; a value the cache disagrees with is a reset. */
    uidValidity?: bigint;
    body?: (uid: number) => unknown;
  } = {}): void {
    const uids = input.uids ?? [];
    const uidValidity = input.uidValidity ?? 7n;
    const bodyFor = input.body ?? ((uid: number) => ({ uid, flags: new Set(["\\Seen"]) }));
    Object.assign(client, {
      usable: true,
      mailbox: { exists: uids.length, uidValidity },
      connect: vi.fn(async () => undefined),
      list: vi.fn(async () => input.folders ?? [sentFolder]),
      status: vi.fn(async () => ({ messages: uids.length, unseen: 0 })),
      getMailboxLock: vi.fn(async () => lock),
      fetch: vi.fn(async function* (range: unknown, query?: { source?: boolean }) {
        for (const uid of uidsInRange(range, uids)) {
          yield query?.source ? bodyFor(uid) : { uid, flags: new Set(["\\Seen"]) };
        }
      }),
      logout: vi.fn(async () => undefined),
    });
    imapClientForAccount.mockReturnValue(client);
  }

  /** The provider's stored copy of a sent mail, as the ENVELOPE and body pass report it. */
  function providerCopy(messageId: string, subject = "Provider copy subject", text = "PROVIDER-BODY-BYTES"): unknown {
    // `confirmSubmissionsInSent` bounds its Sent scan to the submission's
    // creation time minus a week. A fixed calendar date silently falls out of
    // that window as time passes, so the copy is dated just before "now" --
    // which is when the provider would really have stored it.
    const date = new Date(Date.now() - 60_000);
    const raw = [
      `Message-ID: ${messageId}`,
      "From: Demo <demo@example.test>",
      "To: recipient@example.test",
      `Subject: ${subject}`,
      `Date: ${date.toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
    ].join("\r\n");
    return {
      uid: SENT_UID,
      flags: new Set(["\\Seen"]),
      envelope: { messageId, date, from: [{ name: "Demo", address: "demo@example.test" }] },
      internalDate: date,
      size: Buffer.byteLength(raw),
      source: Buffer.from(raw, "utf8"),
    };
  }

  /** A provider-owned cached row, i.e. one the folder passes are free to delete. */
  function addCachedMessage(id: string, mailbox: string, uid: number): void {
    const now = new Date().toISOString();
    const protectedColumns = protectedMessageColumns(masterKey, id, "account-1", {
      messageId: `<${id}@example.test>`,
      subject: `Cached ${id}`,
      fromName: "Demo",
      fromAddress: "demo@example.test",
      to: [],
      cc: [],
      inReplyTo: null,
      references: [],
      snippet: id,
      textBody: `${id} body`,
      htmlBody: "",
      attachments: null,
    });
    db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, sent_at, flags_json, has_attachments,
        size, created_at, payload_metadata_ready, encrypted_payload, payload_version
      ) VALUES (?, 'account-1', ?, ?, ?, '[]', 0, 0, ?, 1, ?, ?)
    `).run(
      id, mailbox, uid, now, now,
      protectedColumns.encryptedPayload, protectedColumns.payloadVersion,
    );
    indexMessageFts(db, id, {
      subject: `Cached ${id}`,
      fromName: "Demo",
      fromAddress: "demo@example.test",
      textBody: `${id} body`,
    });
  }

  /** Accepts a send exactly as the route does: ledger row, then optimistic Sent row. */
  function acceptSend(idempotencyKey: string): { submissionId: string; messageId: string; placeholderId: string } {
    const prepared = prepareSubmission(db, masterKey, {
      accountId: "account-1",
      accountEmail: "demo@example.test",
      idempotencyKey,
      request,
    });
    const account = accountById(db, "account-1");
    if (!account) throw new Error("Account fixture missing.");
    const placeholderId = writePendingSentRow(db, masterKey, {
      account,
      submissionId: prepared.submission.id,
      rfcMessageId: prepared.submission.messageId,
      request,
      attachments: [],
    });
    if (!placeholderId) throw new Error("The fixture's account has no Sent mailbox.");
    return { submissionId: prepared.submission.id, messageId: prepared.submission.messageId, placeholderId };
  }

  function sentRows(): Array<{ id: string; uid: number; pending_send: string | null; payload_metadata_ready: number }> {
    return db.prepare("SELECT id, uid, pending_send, payload_metadata_ready FROM messages ORDER BY uid").all() as Array<{
      id: string;
      uid: number;
      pending_send: string | null;
      payload_metadata_ready: number;
    }>;
  }

  function ftsIds(): string[] {
    return (db.prepare("SELECT message_id FROM messages_fts ORDER BY message_id").all() as Array<{ message_id: string }>)
      .map((row) => row.message_id);
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    vi.clearAllMocks();
    installProvider();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO accounts (
        id, email, provider, provider_name, encrypted_password,
        imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
        username_mode, status, created_at
      ) VALUES (?, ?, 'custom', 'Demo', 'encrypted', 'imap.example.test', 993, 1,
        'smtp.example.test', 465, 1, 'email', 'connected', ?)
    `).run("account-1", "demo@example.test", now);
    // The cached Sent folder shares the provider's UID epoch, so an ordinary
    // pass holds no reset for it: the delete passes are exercised on their own.
    db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, uid_validity)
      VALUES ('account-1', 'Sent', 'Sent', '\\Sent', '7')
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it("re-keys the placeholder to the provider's uid and fills it with the provider's bytes", async () => {
    const { submissionId, messageId, placeholderId } = acceptSend("sub_claim_witness");
    // The write side's key is the bracketed form; the fetcher keeps the brackets
    // it found in the ENVELOPE. The probe only works while both hold.
    expect(messageId).toMatch(/^<[0-9a-f-]+@example\.test>$/);
    markSubmissionSubmitted(db, masterKey, submissionId, messageId);
    installProvider({ uids: [SENT_UID], body: () => providerCopy(messageId) });

    const before = sentRows();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ id: placeholderId, uid: -1, pending_send: submissionId });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ folders: 1, failedFolders: 0 });

    const after = sentRows();
    // One row, the same row: the claim hands the provider's copy the id the
    // payload was sealed under, so the AAD still holds and nothing is orphaned.
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: placeholderId, uid: SENT_UID, pending_send: null, payload_metadata_ready: 1 });
    const payload = messagePayloadForRow(db.prepare("SELECT * FROM messages").get() as MessageStorageRow, masterKey);
    expect(payload.subject).toBe("Provider copy subject");
    expect(payload.textBody).toContain("PROVIDER-BODY-BYTES");
    expect(payload.textBody).not.toContain("Claims must land on the row");
    // The search mirror follows the claimed id: an index row under the id the
    // sync would otherwise have derived is the duplicate-search failure.
    expect(ftsIds()).toEqual([placeholderId]);
    // Confirmed by the claimed row, which by then is the provider's copy.
    expect(submissionForId(db, masterKey, submissionId)).toMatchObject({ deliveryStatus: "confirmed" });

    // A second pass is a no-op: no second copy, no second index row.
    await syncAccount(db, masterKey, "account-1", 20);
    expect(sentRows()).toHaveLength(1);
    expect(ftsIds()).toEqual([placeholderId]);
  });

  it("keeps the placeholder and does not confirm the send while the provider has no copy", async () => {
    const { submissionId, messageId, placeholderId } = acceptSend("sub_claim_absent");
    markSubmissionSubmitted(db, masterKey, submissionId, messageId);
    installProvider({ uids: [] });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ failedFolders: 0 });

    // The optimistic row carries its own Message-ID, so a Sent scan that
    // counted it would confirm a delivery the provider never acknowledged --
    // for `unknown_delivery` that would answer the user's "check Sent" with
    // the row we wrote ourselves.
    expect(sentRows()).toMatchObject([{ id: placeholderId, uid: -1, pending_send: submissionId }]);
    expect(submissionForId(db, masterKey, submissionId)).toMatchObject({ deliveryStatus: "submitted" });
  });

  it("keeps a placeholder through the folder-removal pass while deleting provider-owned rows", async () => {
    const { placeholderId } = acceptSend("sub_claim_folder_removed");
    addCachedMessage("stale-sent-row", "Sent", 41);
    // The provider no longer lists Sent at all.
    installProvider({ uids: [], folders: [inboxFolder] });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ failedFolders: 0 });

    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("stale-sent-row")).toBeUndefined();
    expect(sentRows()).toMatchObject([{ id: placeholderId, uid: -1 }]);
  });

  it("keeps a placeholder through a UIDVALIDITY reset and still lands the copy on it", async () => {
    const { messageId, placeholderId } = acceptSend("sub_claim_reset");
    addCachedMessage("stale-epoch-row", "Sent", 41);
    // Same mailbox, new UID epoch: every provider-owned row of the folder is
    // re-fetched, and the placeholder is not one of them.
    installProvider({ uids: [SENT_UID], uidValidity: 8n, body: () => providerCopy(messageId, "Post-reset copy") });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ failedFolders: 0 });

    // The reset deleted the stale row, and the placeholder was the row the
    // copy landed on -- had the reset dropped it, this id would be a derived
    // one and the assertion below would fail.
    expect(db.prepare("SELECT id FROM messages WHERE id = ?").get("stale-epoch-row")).toBeUndefined();
    const rows = sentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: placeholderId, uid: SENT_UID, pending_send: null });
  });

  it("re-fetches a claimed row whose upsert never landed instead of freezing the local payload", async () => {
    const { messageId, placeholderId } = acceptSend("sub_claim_interrupted");
    installProvider({ uids: [SENT_UID], body: () => providerCopy(messageId) });

    // The claim and the upsert are two statements by construction: the id has
    // to be settled before the payload is sealed. This drives the claim alone,
    // i.e. exactly the state a crash between the two leaves behind -- the row
    // sits at the provider's uid still carrying the locally composed mail, with
    // attachment part ids that are still attachment tokens.
    const claimed = claimPendingSentRow(db, masterKey, {
      accountId: "account-1",
      mailbox: "Sent",
      messageId,
      uid: SENT_UID,
    });
    expect(claimed).toBe(placeholderId);
    expect(sentRows()).toMatchObject([{ id: placeholderId, uid: SENT_UID, pending_send: null, payload_metadata_ready: 0 }]);
    const interrupted = messagePayloadForRow(db.prepare("SELECT * FROM messages").get() as MessageStorageRow, masterKey);
    expect(interrupted.textBody).toContain("Claims must land on the row");

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ failedFolders: 0 });

    // The row must be re-hydrated, not left as a local-only copy: the sync's
    // metadata pass only re-fetches a row whose payload is marked incomplete,
    // so a claim that left the marker at 1 would freeze this row forever.
    const rows = sentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: placeholderId, uid: SENT_UID, payload_metadata_ready: 1 });
    const repaired = messagePayloadForRow(db.prepare("SELECT * FROM messages").get() as MessageStorageRow, masterKey);
    expect(repaired.textBody).toContain("PROVIDER-BODY-BYTES");
  });

  it("leaves a copy with no bracketed Message-ID to insert its own row", async () => {
    // The probe is an opaque token match on the bracketed RFC Message-ID. A
    // server that rewrites the header to a form the fetcher cannot extract
    // leaves the placeholder unclaimed and the copy is stored beside it; this
    // documents where the claim stops rather than pretending it cannot.
    const { submissionId, placeholderId } = acceptSend("sub_claim_unbracketed");
    installProvider({ uids: [SENT_UID], body: () => providerCopy("rewritten@example.test") });

    await expect(syncAccount(db, masterKey, "account-1", 20)).resolves.toMatchObject({ failedFolders: 0 });

    const rows = sentRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: placeholderId, uid: -1, pending_send: submissionId });
    expect(rows[1]).toMatchObject({ uid: SENT_UID, pending_send: null });
    expect(rows[1]?.id).not.toBe(placeholderId);
  });
});
