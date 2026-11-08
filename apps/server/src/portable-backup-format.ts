import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

const MAGIC = Buffer.from("NAMIBAK1");
const FRAME_BYTES = 1024 * 1024;
export const MAX_BACKUP_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_FRAMES = 100_000;
export class BackupError extends Error {}
export type BackupFrame = { type: "metadata"; value: unknown } | { type: "file"; path: string; size: number }
  | { type: "chunk"; data: string } | { type: "file-end" } | { type: "end" };

async function passwordKey(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new BackupError("Use a backup password of at least 12 characters (at most 1024 UTF-8 bytes).");
  }
  return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
function aad(header: Buffer, index: number): Buffer {
  const sequence = Buffer.alloc(8); sequence.writeBigUInt64BE(BigInt(index));
  return Buffer.concat([header, sequence]);
}
export async function* encodeBackup(frames: AsyncIterable<BackupFrame>, password: string): AsyncGenerator<Buffer> {
  const header = Buffer.concat([MAGIC, randomBytes(32)]);
  const key = await passwordKey(password, header.subarray(8));
  let index = 0;
  let bytes = header.length;
  try {
    yield header;
    for await (const frame of frames) {
      if (++index > MAX_FRAMES) throw new BackupError("Backup has too many records.");
      const plaintext = Buffer.from(JSON.stringify(frame));
      if (plaintext.length > FRAME_BYTES) throw new BackupError("Backup record is too large.");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(header, index));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const length = Buffer.alloc(4); length.writeUInt32BE(ciphertext.length + 28);
      bytes += length.length + ciphertext.length + 28;
      if (bytes > MAX_BACKUP_BYTES) throw new BackupError("Backup exceeds the 3 GiB limit.");
      yield Buffer.concat([length, nonce, cipher.getAuthTag(), ciphertext]);
    }
  } finally { key.fill(0); }
}

export async function* decodeBackup(source: AsyncIterable<Buffer>, password: string): AsyncGenerator<BackupFrame> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let total = 0;
  const read = async (length: number, eof = false): Promise<Buffer | undefined> => {
    while (pending.length < length) {
      const next = await iterator.next();
      if (next.done) {
        if (eof && !pending.length) return undefined;
        throw new BackupError("Backup is truncated.");
      }
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > MAX_BACKUP_BYTES) throw new BackupError("Backup exceeds the 3 GiB limit.");
      pending = Buffer.concat([pending, chunk]);
    }
    const result = pending.subarray(0, length); pending = pending.subarray(length); return result;
  };
  const header = (await read(40))!;
  if (!header.subarray(0, 8).equals(MAGIC)) throw new BackupError("Unsupported application backup format.");
  const key = await passwordKey(password, header.subarray(8));
  let ended = false;
  let index = 0;
  try {
    for (;;) {
      const lengthBytes = await read(4, true);
      if (!lengthBytes) break;
      const length = lengthBytes.readUInt32BE();
      if (ended || length < 28 || length > FRAME_BYTES + 28 || ++index > MAX_FRAMES) throw new BackupError("Invalid backup record.");
      const payload = (await read(length))!;
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
        decipher.setAAD(aad(header, index)); decipher.setAuthTag(payload.subarray(12, 28));
        plaintext = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
      } catch { throw new BackupError("Wrong backup password or damaged backup."); }
      let frame: BackupFrame;
      try { frame = JSON.parse(plaintext.toString("utf8")) as BackupFrame; }
      catch { throw new BackupError("Invalid backup record."); }
      if (!frame || typeof frame !== "object") throw new BackupError("Invalid backup record.");
      ended = frame.type === "end";
      yield frame;
    }
    if (!ended) throw new BackupError("Backup is missing its authenticated end marker.");
  } finally { key.fill(0); await iterator.return?.(); }
}
