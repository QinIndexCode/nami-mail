import { createHash } from "node:crypto";
import type { ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import type { DatabaseHandle } from "./db.js";
import { imapClientForAccount } from "./mail.js";
import type { AccountRecord } from "./types.js";

const running = new Set<string>();

function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

function addressValues(address: AddressObject | AddressObject[] | undefined): Array<{ name: string; address: string }> {
  if (!address) return [];
  return (Array.isArray(address) ? address : [address]).flatMap((item) =>
    item.value.map((entry) => ({ name: entry.name ?? "", address: entry.address ?? "" })),
  );
}

function snippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function messageKey(accountId: string, mailbox: string, uid: number): string {
  return createHash("sha256").update(`${accountId}\0${mailbox}\0${uid}`).digest("hex").slice(0, 32);
}

function isSelectableFolder(folder: ListResponse): boolean {
  return folder.listed && !folder.flags.has("\\Noselect");
}

function folderPriority(folder: ListResponse): number {
  const priorities: Record<string, number> = {
    "\\Inbox": 0,
    "\\Sent": 1,
    "\\Drafts": 2,
    "\\Flagged": 3,
    "\\Important": 4,
    "\\All": 5,
    "\\Archive": 6,
    "\\Junk": 7,
    "\\Spam": 7,
    "\\Trash": 8,
  };
  return priorities[folder.specialUse ?? ""] ?? 20;
}

export async function syncAccount(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  messageLimit: number,
): Promise<{ synced: number; folders: number; failedFolders: number }> {
  if (running.has(accountId)) return { synced: 0, folders: 0, failedFolders: 0 };
  const account = accountById(db, accountId);
  if (!account) throw new Error("Account not found.");
  running.add(accountId);
  const client = imapClientForAccount(account, masterKey);

  try {
    await client.connect();
    const folders = (await client.list())
      .filter(isSelectableFolder)
      .sort((a, b) => folderPriority(a) - folderPriority(b) || a.name.localeCompare(b.name));
    const upsertFolder = db.prepare(`
      INSERT INTO folders (account_id, path, name, special_use, total, unseen)
      VALUES (@accountId, @path, @name, @specialUse, @total, @unseen)
      ON CONFLICT(account_id, path) DO UPDATE SET
        name = excluded.name,
        special_use = excluded.special_use,
        total = excluded.total,
        unseen = excluded.unseen
    `);

    const folderRows: Array<{ path: string; name: string; specialUse: string | null; total: number; unseen: number }> = [];
    for (const folder of folders) {
      let status: { messages?: number; unseen?: number } = {};
      try {
        status = await client.status(folder.path, { messages: true, unseen: true });
      } catch {
        // Some providers do not permit STATUS for every virtual folder.
      }
      folderRows.push({
        path: folder.path,
        name: folder.name || folder.path,
        specialUse: folder.specialUse ?? null,
        total: status.messages ?? 0,
        unseen: status.unseen ?? 0,
      });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM folders WHERE account_id = ?").run(accountId);
      for (const folder of folderRows) upsertFolder.run({ accountId, ...folder });
    })();

    const upsert = db.prepare(`
      INSERT INTO messages (
        id, account_id, mailbox, uid, message_id, subject, from_name, from_address,
        to_json, sent_at, snippet, text_body, html_body, flags_json,
        has_attachments, size, created_at
      ) VALUES (
        @id, @accountId, @mailbox, @uid, @messageId, @subject, @fromName, @fromAddress,
        @toJson, @sentAt, @snippet, @textBody, @htmlBody, @flagsJson,
        @hasAttachments, @size, @createdAt
      )
      ON CONFLICT(account_id, mailbox, uid) DO UPDATE SET
        subject = excluded.subject,
        from_name = excluded.from_name,
        from_address = excluded.from_address,
        to_json = excluded.to_json,
        sent_at = excluded.sent_at,
        snippet = excluded.snippet,
        text_body = excluded.text_body,
        html_body = excluded.html_body,
        flags_json = excluded.flags_json,
        has_attachments = excluded.has_attachments,
        size = excluded.size
    `);
    const findMessage = db.prepare("SELECT 1 FROM messages WHERE account_id = ? AND mailbox = ? AND uid = ?");
    const updateFlags = db.prepare("UPDATE messages SET flags_json = ? WHERE account_id = ? AND mailbox = ? AND uid = ?");
    let synced = 0;
    let failedFolders = 0;
    let firstFolderError: unknown;

    for (const folder of folders) {
      let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | undefined;
      try {
        lock = await client.getMailboxLock(folder.path);
        const exists = client.mailbox && typeof client.mailbox !== "boolean" ? client.mailbox.exists : 0;
        if (exists <= 0) continue;
        const start = Math.max(1, exists - messageLimit + 1);
        const newUids: number[] = [];

        for await (const message of client.fetch(`${start}:*`, { uid: true, flags: true })) {
          if (!message.uid) continue;
          const flagsJson = JSON.stringify([...(message.flags ?? [])]);
          if (findMessage.get(accountId, folder.path, message.uid)) {
            updateFlags.run(flagsJson, accountId, folder.path, message.uid);
          } else {
            newUids.push(message.uid);
          }
        }

        if (!newUids.length) continue;
        for await (const message of client.fetch(
          newUids,
          { uid: true, envelope: true, flags: true, internalDate: true, size: true, source: true },
          { uid: true },
        )) {
          if (!message.uid) continue;
          const parsed = message.source ? await simpleParser(message.source) : null;
          const from = addressValues(parsed?.from)[0] ?? {
            name: message.envelope?.from?.[0]?.name ?? "",
            address: message.envelope?.from?.[0]?.address ?? "",
          };
          const recipients = addressValues(parsed?.to);
          const text = parsed?.text ?? "";
          const html = typeof parsed?.html === "string" ? parsed.html : "";
          const sentAtValue = parsed?.date ?? message.envelope?.date ?? message.internalDate ?? new Date();
          const sentAt = sentAtValue instanceof Date ? sentAtValue : new Date(sentAtValue);
          upsert.run({
            id: messageKey(accountId, folder.path, message.uid),
            accountId,
            mailbox: folder.path,
            uid: message.uid,
            messageId: parsed?.messageId ?? message.envelope?.messageId ?? null,
            subject: parsed?.subject ?? message.envelope?.subject ?? "（无主题）",
            fromName: from.name,
            fromAddress: from.address,
            toJson: JSON.stringify(recipients),
            sentAt: sentAt.toISOString(),
            snippet: snippet(text || html.replace(/<[^>]+>/g, " ")),
            textBody: text,
            htmlBody: html,
            flagsJson: JSON.stringify([...(message.flags ?? [])]),
            hasAttachments: parsed?.attachments?.length ? 1 : 0,
            size: message.size ?? message.source?.length ?? 0,
            createdAt: new Date().toISOString(),
          });
          synced += 1;
        }
      } catch (error) {
        failedFolders += 1;
        firstFolderError ??= error;
      } finally {
        lock?.release();
      }
    }

    if (folders.length > 0 && failedFolders === folders.length) throw firstFolderError;

    db.prepare(`
      UPDATE accounts SET status = 'connected', last_error = NULL, last_synced_at = ? WHERE id = ?
    `).run(new Date().toISOString(), accountId);
    return { synced, folders: folders.length, failedFolders };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Sync failed";
    db.prepare("UPDATE accounts SET status = 'error', last_error = ? WHERE id = ?").run(message, accountId);
    throw error;
  } finally {
    running.delete(accountId);
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

export async function markMessageSeen(
  db: DatabaseHandle,
  masterKey: Buffer,
  messageId: string,
  seen: boolean,
): Promise<void> {
  const message = db
    .prepare("SELECT account_id, mailbox, uid, flags_json FROM messages WHERE id = ?")
    .get(messageId) as { account_id: string; mailbox: string; uid: number; flags_json: string } | undefined;
  if (!message) throw new Error("Message not found.");
  const account = accountById(db, message.account_id);
  if (!account) throw new Error("Account not found.");
  const client = imapClientForAccount(account, masterKey);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(message.mailbox);
    try {
      if (seen) await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
      else await client.messageFlagsRemove(message.uid, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
    const flags = new Set<string>(JSON.parse(message.flags_json));
    if (seen) flags.add("\\Seen");
    else flags.delete("\\Seen");
    db.prepare("UPDATE messages SET flags_json = ? WHERE id = ?").run(JSON.stringify([...flags]), messageId);
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}
