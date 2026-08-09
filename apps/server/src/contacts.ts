import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import type { DatabaseHandle } from "./db.js";

/**
 * Local address book. Contact fields are encrypted at rest with a derived
 * master-key envelope (AES-256-GCM). Because the columns are ciphertext,
 * matching/deduplication runs over decrypted rows in code; the address book is
 * user-scale data (typically hundreds of rows), so this stays cheap.
 */

export type Contact = {
  id: string;
  email: string;
  name: string;
  notes: string;
  /** True when the row was seeded automatically from an incoming message sender. */
  autoCollected: boolean;
  createdAt: string;
  updatedAt: string;
};

export class ContactConflictError extends Error {}

const contactPurpose = "nami-contacts-v1";

function contactAad(id: string): string {
  return `contacts\0${id}\0v1`;
}

function withContactKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, contactPurpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

export const contactCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();

export const contactUpdateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  name: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "至少需要更新一个字段。" });

type ContactRow = {
  id: string;
  email_enc: string;
  name_enc: string;
  notes_enc: string;
  auto_collected: number;
  created_at: string;
  updated_at: string;
};

const contactSelectColumns = "id, email_enc, name_enc, notes_enc, auto_collected, created_at, updated_at";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function contactFromRow(row: ContactRow, masterKey: Buffer): Contact {
  return withContactKey(masterKey, (key) => ({
    id: row.id,
    email: decryptTextEnvelope(row.email_enc, key, contactAad(row.id)),
    name: decryptTextEnvelope(row.name_enc, key, contactAad(row.id)),
    notes: decryptTextEnvelope(row.notes_enc, key, contactAad(row.id)),
    autoCollected: row.auto_collected === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function writeContact(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  values: { email: string; name: string; notes: string; autoCollected: boolean },
  createdAt: string,
  updatedAt: string,
): Contact {
  withContactKey(masterKey, (key) => {
    db.prepare(`
      INSERT INTO contacts (id, email_enc, name_enc, notes_enc, auto_collected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      encryptTextEnvelope(values.email, key, contactAad(id)),
      encryptTextEnvelope(values.name, key, contactAad(id)),
      encryptTextEnvelope(values.notes, key, contactAad(id)),
      values.autoCollected ? 1 : 0,
      createdAt,
      updatedAt,
    );
  });
  const row = db.prepare(`SELECT ${contactSelectColumns} FROM contacts WHERE id = ?`).get(id) as ContactRow;
  return contactFromRow(row, masterKey);
}

function findContactByEmail(db: DatabaseHandle, masterKey: Buffer, email: string): Contact | undefined {
  const needle = normalizeEmail(email);
  const rows = db.prepare(`SELECT ${contactSelectColumns} FROM contacts`).all() as ContactRow[];
  for (const row of rows) {
    const contact = contactFromRow(row, masterKey);
    if (normalizeEmail(contact.email) === needle) return contact;
  }
  return undefined;
}

export function contactForId(db: DatabaseHandle, masterKey: Buffer, id: string): Contact | undefined {
  const row = db.prepare(`SELECT ${contactSelectColumns} FROM contacts WHERE id = ?`).get(id) as ContactRow | undefined;
  return row ? contactFromRow(row, masterKey) : undefined;
}

/**
 * Lists contacts, optionally matching a case-insensitive substring against the
 * decrypted email or name. Used both by the address book UI and by recipient
 * autocomplete in the compose editor.
 */
export function listContacts(
  db: DatabaseHandle,
  masterKey: Buffer,
  query?: string,
  limit = 200,
): Contact[] {
  const needle = query?.trim().toLowerCase() ?? "";
  const rows = db.prepare(`SELECT ${contactSelectColumns} FROM contacts ORDER BY created_at ASC`).all() as ContactRow[];
  const contacts = rows.map((row) => contactFromRow(row, masterKey));
  const filtered = needle
    ? contacts.filter((contact) => contact.email.toLowerCase().includes(needle) || contact.name.toLowerCase().includes(needle))
    : contacts;
  return filtered
    .sort((left, right) => {
      const leftName = left.name || left.email;
      const rightName = right.name || right.email;
      return leftName.localeCompare(rightName) || left.email.localeCompare(right.email);
    })
    .slice(0, Math.max(1, Math.min(limit, 1000)));
}

export function createContact(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: z.infer<typeof contactCreateSchema>,
): Contact {
  const email = normalizeEmail(input.email);
  if (findContactByEmail(db, masterKey, email)) {
    throw new ContactConflictError(email);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  return writeContact(db, masterKey, id, {
    email,
    name: input.name ?? "",
    notes: input.notes ?? "",
    autoCollected: false,
  }, now, now);
}

export function updateContact(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  patch: z.infer<typeof contactUpdateSchema>,
): Contact | undefined {
  const existing = contactForId(db, masterKey, id);
  if (!existing) return undefined;
  const email = patch.email === undefined ? existing.email : normalizeEmail(patch.email);
  if (patch.email !== undefined && normalizeEmail(patch.email) !== normalizeEmail(existing.email)) {
    if (findContactByEmail(db, masterKey, email)) {
      throw new ContactConflictError(email);
    }
  }
  const now = new Date().toISOString();
  withContactKey(masterKey, (key) => {
    db.prepare(`
      UPDATE contacts SET email_enc = ?, name_enc = ?, notes_enc = ?, updated_at = ? WHERE id = ?
    `).run(
      encryptTextEnvelope(email, key, contactAad(id)),
      encryptTextEnvelope(patch.name === undefined ? existing.name : patch.name, key, contactAad(id)),
      encryptTextEnvelope(patch.notes === undefined ? existing.notes : patch.notes, key, contactAad(id)),
      now,
      id,
    );
  });
  const row = db.prepare(`SELECT ${contactSelectColumns} FROM contacts WHERE id = ?`).get(id) as ContactRow;
  return contactFromRow(row, masterKey);
}

export function deleteContact(db: DatabaseHandle, id: string): boolean {
  return db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes === 1;
}

/**
 * Seeds a contact from an incoming message sender. The sender's own addresses
 * are skipped so the address book never collects the user's own mailboxes. An
 * existing row is kept (autoCollected stays true) and only gains a display name
 * when it does not have one yet.
 */
export function autoCollectSender(
  db: DatabaseHandle,
  masterKey: Buffer,
  email: string,
  name: string,
  ownEmails: readonly string[],
): Contact {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("Sender email is empty.");
  if (ownEmails.some((own) => normalizeEmail(own) === normalized)) {
    throw new ContactConflictError("sender-is-self");
  }
  const existing = findContactByEmail(db, masterKey, normalized);
  if (existing) {
    if (existing.name) return existing;
    const updated = updateContact(db, masterKey, existing.id, { name });
    if (!updated) throw new Error("Contact row vanished during sender auto-collect.");
    return updated;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  return writeContact(db, masterKey, id, {
    email: normalized,
    name,
    notes: "",
    autoCollected: true,
  }, now, now);
}
