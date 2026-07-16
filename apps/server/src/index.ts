import "dotenv/config";
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { loadOrCreateMasterKey } from "./crypto.js";
import { openDatabase } from "./db.js";
import { syncAccount } from "./sync.js";
import type { AccountRecord } from "./types.js";

const db = openDatabase(config.databasePath);
const masterKey = loadOrCreateMasterKey(config.masterKeyPath);
const app = await buildApp({ db, masterKey });

const syncAll = async () => {
  const accounts = db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRecord[];
  await Promise.allSettled(
    accounts.map((account) => syncAccount(db, masterKey, account.id, config.syncMessageLimit)),
  );
};

const timer = setInterval(() => void syncAll(), config.syncIntervalSeconds * 1000);
timer.unref();

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  db.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Nami Mail is available at http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
