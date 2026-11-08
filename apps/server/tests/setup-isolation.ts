import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Config-dependent caches resolve their paths during module loading, before
// beforeEach runs. Every test file must start with its own disposable root.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nami-server-test-"));
const previousDatabasePath = process.env.DATABASE_PATH;
const previousMasterKeyPath = process.env.MASTER_KEY_PATH;
process.env.DATABASE_PATH = path.join(root, "fixture.db");
process.env.MASTER_KEY_PATH = path.join(root, "master.key");
afterAll(() => {
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousMasterKeyPath === undefined) delete process.env.MASTER_KEY_PATH;
  else process.env.MASTER_KEY_PATH = previousMasterKeyPath;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
