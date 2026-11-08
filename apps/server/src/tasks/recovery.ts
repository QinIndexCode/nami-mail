import { z } from "zod";
import { messagePayloadForRow, type MessageStorageRow } from "../message-storage.js";
import { messageFlagNames, type MessageFlagsPatch } from "../message-flags.js";
import { acceptFlagsTask, type FlagsTaskDeps } from "./kinds/flags.js";
import { acceptMoveTask, type MoveTaskDestination } from "./kinds/move.js";
import { openTaskPayload, taskRow, type TaskHandle } from "./store.js";
import type { TaskItemRow } from "./types.js";
import type { DatabaseHandle } from "../db.js";

const flagPatch = z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }).strict();
const frozenEntry = z.object({ id: z.string(), mailbox: z.string(), uid: z.number(), uidValidity: z.string().nullable().optional(), add: z.array(z.string()), remove: z.array(z.string()) });
const flagsPayload = z.union([z.object({ entries: z.array(frozenEntry) }), z.object({ patch: flagPatch })]);
const movePayload = z.union([z.object({ target: z.enum(["archive", "trash", "junk", "inbox"]) }), z.object({ folderPath: z.string().min(1) })]);
export type RecoveryItem = { id: string; subject: string; eligible: boolean; reason: string };
export function dismissTask(db: DatabaseHandle, id: string): void { db.prepare("INSERT OR IGNORE INTO task_acknowledgements VALUES(?)").run(id); }

export function taskRecoveryDetails(db: DatabaseHandle, key: Buffer, id: string, offset = 0, selectedIds?: readonly string[]) {
  const task = taskRow(db, id);
  if (!task) return undefined;
  const payload = openTaskPayload<unknown>(key, task);
  const flags = flagsPayload.safeParse(payload);
  const move = movePayload.safeParse(payload);
  const supported = task.completed_at !== null && task.status !== "cancelled"
    && ((task.kind === "flags" && flags.success) || (task.kind === "move" && move.success));
  const selected = selectedIds ? ` AND message_id IN (${selectedIds.map(() => "?").join(",")})` : "";
  const params = [id, ...(selectedIds ?? [])];
  const total = db.prepare(`SELECT COUNT(*) FROM task_items WHERE task_id=?${selected}`).pluck().get(...params) as number;
  const page = db.prepare(`SELECT * FROM task_items WHERE task_id=?${selected} ORDER BY rowid LIMIT 100 OFFSET ?`).all(...params, offset) as TaskItemRow[];
  const items: RecoveryItem[] = page.map((item) => {
    const row = db.prepare(`SELECT m.*,f.uid_validity AS live_generation FROM messages m
      LEFT JOIN folders f ON f.account_id=m.account_id AND f.path=m.mailbox WHERE m.id=?`).get(item.message_id) as (MessageStorageRow & { live_generation: string | null }) | undefined;
    let reason = supported ? "ready" : "unsupported";
    const entry = flags.success && "entries" in flags.data ? flags.data.entries.find((value) => value.id === item.message_id) : undefined;
    const mailbox = entry?.mailbox ?? item.origin_mailbox;
    const uid = entry?.uid ?? item.origin_uid;
    const generation = entry?.uidValidity ?? item.origin_uid_validity;
    if (!row || row.account_id !== task.account_id) reason = "missing";
    else if (db.prepare("SELECT 1 FROM task_recovery_attempts WHERE task_id=? AND message_id=?").get(id, item.message_id)) reason = "retried";
    else if (db.prepare(`SELECT 1 FROM task_items i JOIN tasks t ON t.id=i.task_id
      WHERE i.message_id=? AND t.rowid>(SELECT rowid FROM tasks WHERE id=?) AND t.kind IN ('flags','move') LIMIT 1`).get(item.message_id, id)) reason = "superseded";
    else if (task.kind === "move" && row.mailbox === item.destination_mailbox) reason = "delivered";
    else if (!generation || row.live_generation !== generation || row.mailbox !== mailbox || row.uid !== uid
      || row.pending_move_state || row.pending_move_destination || row.remote_id_lookup) reason = "syncRequired";
    return { id: item.message_id, subject: row ? messagePayloadForRow(row, key).subject : "", eligible: reason === "ready", reason };
  });
  return { id, kind: task.kind, status: task.status, total, items, nextOffset: offset + 100 < total ? offset + 100 : null };
}

export function retryTaskItems(deps: FlagsTaskDeps, id: string, ids: readonly string[]): { taskIds: string[]; retried: number; skipped: number } {
  const handles: TaskHandle[] = [];
  let retried = 0;
  deps.db.transaction(() => {
    const task = taskRow(deps.db, id);
    if (!task || task.completed_at === null) throw new Error("Only settled tasks can be recovered.");
    const selected = new Set(ids);
    const eligible = new Set<string>();
    for (let offset = 0;; offset += 100) {
      const details = taskRecoveryDetails(deps.db, deps.masterKey, id, offset, ids)!;
      for (const item of details.items) if (item.eligible && selected.has(item.id)) eligible.add(item.id);
      if (details.nextOffset === null) break;
    }
    const payload = openTaskPayload<unknown>(deps.masterKey, task);
    if (task.kind === "flags") {
      const value = flagsPayload.parse(payload);
      for (const messageId of eligible) {
        let patch: MessageFlagsPatch;
        if ("patch" in value) patch = value.patch;
        else {
          const entry = value.entries.find((item) => item.id === messageId);
          if (!entry) continue;
          patch = {};
          for (const [property, flag] of Object.entries(messageFlagNames)) {
            if (entry.add.includes(flag)) patch[property as keyof MessageFlagsPatch] = true;
            if (entry.remove.includes(flag)) patch[property as keyof MessageFlagsPatch] = false;
          }
        }
        const accepted = acceptFlagsTask(deps, { messageIds: [messageId], patch, retryUnchanged: true });
        handles.push(...accepted.handles);
        if (accepted.handles.length) { deps.db.prepare("INSERT INTO task_recovery_attempts VALUES(?,?)").run(id, messageId); retried++; }
      }
    } else if (task.kind === "move") {
      const accepted = acceptMoveTask(deps, { messageIds: [...eligible], destination: movePayload.parse(payload) as MoveTaskDestination });
      handles.push(...accepted.handles);
      const refused = new Set(accepted.refusals.map((entry) => entry.id));
      if (accepted.handles.length) for (const messageId of eligible) if (!refused.has(messageId)) {
        deps.db.prepare("INSERT INTO task_recovery_attempts VALUES(?,?)").run(id, messageId); retried++;
      }
    }
    for (const handle of handles) deps.db.prepare("UPDATE tasks SET parent_id=? WHERE id=?").run(id, handle.id);
  })();
  for (const handle of handles) handle.start();
  return { taskIds: handles.map((handle) => handle.id), retried, skipped: new Set(ids).size - retried };
}
