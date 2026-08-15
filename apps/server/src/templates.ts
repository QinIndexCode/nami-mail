import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import type { DatabaseHandle } from "./db.js";
import { BUILTIN_TEMPLATES } from "./builtin-templates.js";

/**
 * Local mail template library (M3: templates / quick replies). A template is a
 * reusable subject + body the user can insert while composing. Like the
 * address book, name/subject/body are encrypted at rest with a derived
 * master-key envelope (AES-256-GCM); listing runs over decrypted rows in code
 * because the template library is user-scale data.
 *
 * The app ships a few built-in starter templates (`builtin: true`). They are
 * seeded on first run and behave like any other template once the user edits
 * or deletes them.
 */

export type MailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** True for templates shipped with the app and not yet edited by the user. */
  builtin: boolean;
};

const templatePurpose = "nami-templates-v1";
const maximumTemplateNameLength = 200;
const maximumTemplateSubjectLength = 500;
const maximumTemplateBodyLength = 100_000;

function templateAad(id: string): string {
  return `templates\0${id}\0v1`;
}

function withTemplateKey<T>(masterKey: Buffer, callback: (key: Buffer) => T): T {
  const key = deriveEncryptionKey(masterKey, templatePurpose);
  try {
    return callback(key);
  } finally {
    key.fill(0);
  }
}

export const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(maximumTemplateNameLength),
  subject: z.string().trim().max(maximumTemplateSubjectLength).optional(),
  body: z.string().trim().min(1).max(maximumTemplateBodyLength),
}).strict();

export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(maximumTemplateNameLength).optional(),
  subject: z.string().trim().max(maximumTemplateSubjectLength).optional(),
  body: z.string().trim().min(1).max(maximumTemplateBodyLength).optional(),
}).strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "至少需要更新一个字段。" });

type TemplateRow = {
  id: string;
  name_enc: string;
  subject_enc: string;
  body_enc: string;
  created_at: string;
  updated_at: string;
  builtin: number;
};

const templateSelectColumns = "id, name_enc, subject_enc, body_enc, created_at, updated_at, builtin";

export function templateFromRow(row: TemplateRow, masterKey: Buffer): MailTemplate {
  return withTemplateKey(masterKey, (key) => ({
    id: row.id,
    name: decryptTextEnvelope(row.name_enc, key, templateAad(row.id)),
    subject: decryptTextEnvelope(row.subject_enc, key, templateAad(row.id)),
    body: decryptTextEnvelope(row.body_enc, key, templateAad(row.id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    builtin: row.builtin === 1,
  }));
}

function writeTemplate(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  values: { name: string; subject: string; body: string },
  createdAt: string,
  updatedAt: string,
  builtin = false,
): MailTemplate {
  withTemplateKey(masterKey, (key) => {
    db.prepare(`
      INSERT INTO mail_templates (id, name_enc, subject_enc, body_enc, created_at, updated_at, builtin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      encryptTextEnvelope(values.name, key, templateAad(id)),
      encryptTextEnvelope(values.subject, key, templateAad(id)),
      encryptTextEnvelope(values.body, key, templateAad(id)),
      createdAt,
      updatedAt,
      builtin ? 1 : 0,
    );
  });
  const row = db.prepare(`SELECT ${templateSelectColumns} FROM mail_templates WHERE id = ?`).get(id) as TemplateRow;
  return templateFromRow(row, masterKey);
}

/**
 * Seeds the app's built-in templates exactly once. A persisted flag on
 * app_settings guards the seeding, so a template the user deleted later is
 * never re-seeded and an edited one is never overwritten — the app respects the
 * user's choices across restarts and upgrades. Called during server startup.
 */
export function seedBuiltinTemplates(db: DatabaseHandle, masterKey: Buffer): void {
  const state = db.prepare("SELECT builtin_templates_seeded FROM app_settings WHERE id = 1").get() as
    | { builtin_templates_seeded: number }
    | undefined;
  // Once seeded, deletions and edits are respected: never re-insert a built-in
  // template the user removed, even after a restart or upgrade.
  if (state?.builtin_templates_seeded) return;

  const now = new Date().toISOString();
  for (const seed of BUILTIN_TEMPLATES) {
    // Idempotent against databases created by an earlier version that seeded
    // some (or all) built-ins without persisting the flag: existing rows are
    // skipped, never overwritten.
    const existing = db.prepare("SELECT id FROM mail_templates WHERE id = ?").get(seed.id);
    if (existing) continue;
    withTemplateKey(masterKey, (key) => {
      db.prepare(`
        INSERT INTO mail_templates (id, name_enc, subject_enc, body_enc, created_at, updated_at, builtin)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        seed.id,
        encryptTextEnvelope(seed.name, key, templateAad(seed.id)),
        encryptTextEnvelope(seed.subject, key, templateAad(seed.id)),
        encryptTextEnvelope(seed.body, key, templateAad(seed.id)),
        now,
        now,
      );
    });
  }
  db.prepare("UPDATE app_settings SET builtin_templates_seeded = 1 WHERE id = 1").run();
}

export function templateForId(db: DatabaseHandle, masterKey: Buffer, id: string): MailTemplate | undefined {
  const row = db.prepare(`SELECT ${templateSelectColumns} FROM mail_templates WHERE id = ?`).get(id) as TemplateRow | undefined;
  return row ? templateFromRow(row, masterKey) : undefined;
}

/**
 * Lists templates, optionally matching a case-insensitive substring against
 * the decrypted name. Ordered by name so the compose picker stays stable.
 */
export function listTemplates(
  db: DatabaseHandle,
  masterKey: Buffer,
  query?: string,
  limit = 200,
): MailTemplate[] {
  const needle = query?.trim().toLowerCase() ?? "";
  const rows = db.prepare(`SELECT ${templateSelectColumns} FROM mail_templates ORDER BY created_at ASC`).all() as TemplateRow[];
  const templates = rows.map((row) => templateFromRow(row, masterKey));
  const filtered = needle
    ? templates.filter((template) => template.name.toLowerCase().includes(needle))
    : templates;
  return filtered
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(limit, 1000)));
}

export function createTemplate(
  db: DatabaseHandle,
  masterKey: Buffer,
  input: z.infer<typeof templateCreateSchema>,
): MailTemplate {
  const id = randomUUID();
  const now = new Date().toISOString();
  return writeTemplate(db, masterKey, id, {
    name: input.name,
    subject: input.subject ?? "",
    body: input.body,
  }, now, now);
}

export function updateTemplate(
  db: DatabaseHandle,
  masterKey: Buffer,
  id: string,
  patch: z.infer<typeof templateUpdateSchema>,
): MailTemplate | undefined {
  const existing = templateForId(db, masterKey, id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  withTemplateKey(masterKey, (key) => {
    db.prepare(`
      UPDATE mail_templates
      SET name_enc = ?, subject_enc = ?, body_enc = ?, updated_at = ?, builtin = 0
      WHERE id = ?
    `).run(
      encryptTextEnvelope(patch.name === undefined ? existing.name : patch.name, key, templateAad(id)),
      encryptTextEnvelope(patch.subject === undefined ? existing.subject : patch.subject, key, templateAad(id)),
      encryptTextEnvelope(patch.body === undefined ? existing.body : patch.body, key, templateAad(id)),
      now,
      id,
    );
  });
  // Editing a built-in template promotes it to a normal user template so the
  // UI stops showing the "built-in" badge and the user fully owns the content.
  const row = db.prepare(`SELECT ${templateSelectColumns} FROM mail_templates WHERE id = ?`).get(id) as TemplateRow;
  return templateFromRow(row, masterKey);
}

export function deleteTemplate(db: DatabaseHandle, id: string): boolean {
  return db.prepare("DELETE FROM mail_templates WHERE id = ?").run(id).changes === 1;
}
