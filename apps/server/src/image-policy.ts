import { z } from "zod";
import type { DatabaseHandle } from "./db.js";
import { decryptTextEnvelope, deriveEncryptionKey, encryptTextEnvelope } from "./crypto.js";
import { messagePayloadForRow, type MessageStorageRow } from "./message-storage.js";

export const imagePolicySchema = z.object({
  mode: z.enum(["block", "allow"]),
  trustedSenders: z.array(z.email().max(254)).max(500),
}).strict();
export type ImagePolicy = z.infer<typeof imagePolicySchema>;
export function clearImageGrants(db: DatabaseHandle): void { db.prepare("DELETE FROM image_message_grants").run(); }
export function setMessageImageGrant(db: DatabaseHandle, id: string, allowed: boolean): void {
  if (allowed) db.prepare("INSERT OR IGNORE INTO image_message_grants VALUES(?)").run(id);
  else db.prepare("DELETE FROM image_message_grants WHERE message_id=?").run(id);
}
export function ensureImagePolicySchema(db: DatabaseHandle): void {
  db.exec(`CREATE TABLE IF NOT EXISTS image_policy (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_message_grants (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE);`);
}
export function readImagePolicy(db: DatabaseHandle, masterKey: Buffer): ImagePolicy {
  const row = db.prepare("SELECT payload FROM image_policy WHERE id=1").get() as { payload: string } | undefined;
  if (!row) return { mode: "block", trustedSenders: [] };
  const key = deriveEncryptionKey(masterKey, "image-policy-v1");
  try { return imagePolicySchema.parse(JSON.parse(decryptTextEnvelope(row.payload, key, "image-policy-v1"))); }
  finally { key.fill(0); }
}
export function writeImagePolicy(db: DatabaseHandle, masterKey: Buffer, input: ImagePolicy): ImagePolicy {
  const policy = imagePolicySchema.parse(input);
  policy.trustedSenders = [...new Set(policy.trustedSenders.map((address) => address.toLowerCase()))];
  const key = deriveEncryptionKey(masterKey, "image-policy-v1");
  try { db.prepare("INSERT INTO image_policy VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
    .run(encryptTextEnvelope(JSON.stringify(policy), key, "image-policy-v1")); }
  finally { key.fill(0); }
  return policy;
}
export function messageImagePermission(db: DatabaseHandle, masterKey: Buffer, messageId?: string) {
  const policy = readImagePolicy(db, masterKey);
  const row = messageId ? db.prepare("SELECT * FROM messages WHERE id=?").get(messageId) as MessageStorageRow | undefined : undefined;
  const sender = row ? messagePayloadForRow(row, masterKey).fromAddress.toLowerCase() : "";
  const trusted = Boolean(sender && policy.trustedSenders.includes(sender));
  const granted = Boolean(row && db.prepare("SELECT 1 FROM image_message_grants WHERE message_id=?").get(messageId));
  return { allowed: policy.mode === "allow" || trusted || granted, trusted, granted, sender, exists: Boolean(row) };
}
