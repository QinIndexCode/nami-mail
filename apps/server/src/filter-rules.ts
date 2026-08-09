import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseHandle } from "./db.js";
import type { MessagePayload } from "./message-storage.js";

/**
 * Inbox filter rules. A rule matches incoming (new, unread) inbox messages
 * against a set of AND conditions and then runs its actions locally, without
 * modifying provider-side filter configuration. Actions reuse the same IMAP
 * operations as the user interface (flag changes, archive, move to folder).
 */

export type FilterRuleCondition =
  | { kind: "from"; value: string }
  | { kind: "to"; value: string }
  | { kind: "subject"; value: string }
  | { kind: "has_attachments"; value: boolean };

export type FilterRuleAction =
  | { kind: "mark_seen" }
  | { kind: "add_flag" }
  | { kind: "archive" }
  | { kind: "move_to_folder"; folderPath: string };

export type FilterRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** null applies the rule to every account; otherwise only that account. */
  accountId: string | null;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
  position: number;
  createdAt: string;
  updatedAt: string;
};

const filterRuleConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("from"), value: z.string().trim().min(1).max(320) }).strict(),
  z.object({ kind: z.literal("to"), value: z.string().trim().min(1).max(320) }).strict(),
  z.object({ kind: z.literal("subject"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("has_attachments"), value: z.boolean() }).strict(),
]);

const filterRuleActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mark_seen") }).strict(),
  z.object({ kind: z.literal("add_flag") }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
  z.object({ kind: z.literal("move_to_folder"), folderPath: z.string().trim().min(1).max(500) }).strict(),
]);

const filterRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  accountId: z.string().trim().min(1).max(128).nullable().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(filterRuleConditionSchema).min(1).max(10),
  actions: z.array(filterRuleActionSchema).min(1).max(10),
}).strict();

export const filterRuleCreateSchema = filterRuleInputSchema;
export const filterRuleUpdateSchema = filterRuleInputSchema.partial().strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "至少需要更新一个字段。" });

type FilterRuleRow = {
  id: string;
  name: string;
  enabled: number;
  account_id: string | null;
  conditions_json: string;
  actions_json: string;
  position: number;
  created_at: string;
  updated_at: string;
};

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ruleFromRow(row: FilterRuleRow): FilterRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    accountId: row.account_id,
    conditions: parseJsonArray(row.conditions_json) as FilterRuleCondition[],
    actions: parseJsonArray(row.actions_json) as FilterRuleAction[],
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ruleSelectColumns = `
  id, name, enabled, account_id, conditions_json, actions_json, position, created_at, updated_at
`;

export function listFilterRules(db: DatabaseHandle, accountId?: string): FilterRule[] {
  const rows = accountId
    ? db.prepare(`SELECT ${ruleSelectColumns} FROM filter_rules WHERE account_id IS NULL OR account_id = ? ORDER BY position ASC, created_at ASC`).all(accountId)
    : db.prepare(`SELECT ${ruleSelectColumns} FROM filter_rules ORDER BY position ASC, created_at ASC`).all();
  return (rows as FilterRuleRow[]).map(ruleFromRow);
}

export function listEnabledFilterRules(db: DatabaseHandle, accountId: string): FilterRule[] {
  const rows = db.prepare(`
    SELECT ${ruleSelectColumns} FROM filter_rules
    WHERE enabled = 1 AND (account_id IS NULL OR account_id = ?)
    ORDER BY position ASC, created_at ASC
  `).all(accountId);
  return (rows as FilterRuleRow[]).map(ruleFromRow);
}

export function createFilterRule(db: DatabaseHandle, input: z.infer<typeof filterRuleCreateSchema>): FilterRule {
  const positionRow = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM filter_rules").get() as { next_position: number };
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO filter_rules (id, name, enabled, account_id, conditions_json, actions_json, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.enabled === false ? 0 : 1,
    input.accountId ?? null,
    JSON.stringify(input.conditions),
    JSON.stringify(input.actions),
    positionRow.next_position,
    now,
    now,
  );
  const row = db.prepare(`SELECT ${ruleSelectColumns} FROM filter_rules WHERE id = ?`).get(id) as FilterRuleRow;
  return ruleFromRow(row);
}

export function updateFilterRule(
  db: DatabaseHandle,
  id: string,
  input: z.infer<typeof filterRuleUpdateSchema>,
): FilterRule | undefined {
  const existing = db.prepare(`SELECT ${ruleSelectColumns} FROM filter_rules WHERE id = ?`).get(id) as FilterRuleRow | undefined;
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE filter_rules
    SET name = ?, enabled = ?, account_id = ?, conditions_json = ?, actions_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name ?? existing.name,
    input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
    input.accountId === undefined ? existing.account_id : input.accountId,
    input.conditions === undefined ? existing.conditions_json : JSON.stringify(input.conditions),
    input.actions === undefined ? existing.actions_json : JSON.stringify(input.actions),
    now,
    id,
  );
  const row = db.prepare(`SELECT ${ruleSelectColumns} FROM filter_rules WHERE id = ?`).get(id) as FilterRuleRow;
  return ruleFromRow(row);
}

export function deleteFilterRule(db: DatabaseHandle, id: string): boolean {
  return db.prepare("DELETE FROM filter_rules WHERE id = ?").run(id).changes === 1;
}

/**
 * All conditions are ANDed. Subject and address comparisons are ASCII
 * case-insensitive literal substrings; has_attachments compares the boolean.
 */
export function matchesFilterRuleConditions(conditions: FilterRuleCondition[], payload: MessagePayload): boolean {
  return conditions.every((condition) => {
    switch (condition.kind) {
      case "from": {
        const needle = asciiFold(condition.value);
        return asciiFold(payload.fromAddress).includes(needle) || asciiFold(payload.fromName).includes(needle);
      }
      case "to": {
        const needle = asciiFold(condition.value);
        return payload.to.some((recipient) =>
          asciiFold(recipient.address).includes(needle) || asciiFold(recipient.name).includes(needle));
      }
      case "subject":
        return asciiFold(payload.subject).includes(asciiFold(condition.value));
      case "has_attachments": {
        const hasAttachments = (payload.attachments?.length ?? 0) > 0;
        return hasAttachments === condition.value;
      }
    }
  });
}
