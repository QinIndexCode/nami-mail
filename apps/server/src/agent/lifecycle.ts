import type { DatabaseHandle } from "../db.js";
import {
  createAccountDataKey,
  unwrapAccountDataKey,
  wrapAccountDataKey,
  type AccountDataKeyWrapper,
} from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

export type AccountLifecycleState = "active" | "deleting" | "deleted";

export type AccountLifecycleRecord = {
  accountId: string;
  generation: number;
  state: AccountLifecycleState;
  encryptedDek: string | null;
  cryptoVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type AccountGenerationLease = Readonly<{
  accountId: string;
  generation: number;
}>;

export type AccountTask = {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
};

export class AccountLifecycleError extends Error {
  constructor(
    readonly code: "account_not_found" | "account_deleting" | "account_deleted" | "stale_account_generation" | "account_key_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AccountLifecycleError";
  }
}

type StoredLifecycleRow = {
  account_id: string;
  generation: number;
  state: AccountLifecycleState;
  encrypted_dek: string | null;
  crypto_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function publicRecord(row: StoredLifecycleRow): AccountLifecycleRecord {
  return {
    accountId: row.account_id,
    generation: row.generation,
    state: row.state,
    encryptedDek: row.encrypted_dek,
    cryptoVersion: row.crypto_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function validAccountId(accountId: string): void {
  if (!accountId || accountId.length > 512) throw new AccountLifecycleError("account_not_found", "Account id is invalid.");
}

/**
 * Coordinates durable account generations with in-process cancellation. A
 * generation is checked before each storage commit; cancellation only makes
 * already-running work stop sooner and is not the security boundary.
 */
export class AccountLifecycleStore {
  private readonly tasks = new Map<string, Set<AbortController>>();

  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private rowForAccount(accountId: string): StoredLifecycleRow | undefined {
    return this.db.prepare(`
      SELECT account_id, generation, state, encrypted_dek, crypto_version, created_at, updated_at, deleted_at
      FROM agent_account_lifecycle
      WHERE account_id = ?
    `).get(accountId) as StoredLifecycleRow | undefined;
  }

  private primaryAccountExists(accountId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId));
  }

  private createActiveLifecycle(accountId: string, generation = 0): AccountLifecycleRecord {
    const now = this.clock();
    const dek = createAccountDataKey();
    try {
      const wrapper = wrapAccountDataKey(this.masterKey, accountId, generation, dek);
      this.db.prepare(`
        INSERT INTO agent_account_lifecycle (
          account_id, generation, state, encrypted_dek, crypto_version, created_at, updated_at, deleted_at
        ) VALUES (?, ?, 'active', ?, ?, ?, ?, NULL)
      `).run(accountId, generation, wrapper.encryptedDek, wrapper.cryptoVersion, now, now);
    } finally {
      dek.fill(0);
    }
    const row = this.rowForAccount(accountId);
    if (!row) throw new AccountLifecycleError("account_key_unavailable", "Account lifecycle could not be created.");
    return publicRecord(row);
  }

  /** Creates a lifecycle entry lazily for an existing mail account. */
  ensureActive(accountId: string): AccountLifecycleRecord {
    validAccountId(accountId);
    assertAgentStoreReadable(this.db);
    return this.transaction(() => {
      const current = this.rowForAccount(accountId);
      if (current) {
        if (current.state === "active") return publicRecord(current);
        if (current.state === "deleting") throw new AccountLifecycleError("account_deleting", "The account is being removed.");
        throw new AccountLifecycleError("account_deleted", "The account has been removed and must be added again.");
      }
      if (!this.primaryAccountExists(accountId)) {
        throw new AccountLifecycleError("account_not_found", "The mail account no longer exists.");
      }
      return this.createActiveLifecycle(accountId);
    });
  }

  current(accountId: string): AccountLifecycleRecord | undefined {
    validAccountId(accountId);
    assertAgentStoreReadable(this.db);
    const row = this.rowForAccount(accountId);
    return row ? publicRecord(row) : undefined;
  }

  acquireLease(accountId: string): AccountGenerationLease {
    const lifecycle = this.ensureActive(accountId);
    return Object.freeze({ accountId: lifecycle.accountId, generation: lifecycle.generation });
  }

  /** Re-check this immediately before every local commit or external side effect. */
  assertCurrent(lease: AccountGenerationLease): AccountLifecycleRecord {
    validAccountId(lease.accountId);
    if (!Number.isSafeInteger(lease.generation) || lease.generation < 0) {
      throw new AccountLifecycleError("stale_account_generation", "Account generation is invalid.");
    }
    assertAgentStoreReadable(this.db);
    const row = this.rowForAccount(lease.accountId);
    if (!row) throw new AccountLifecycleError("account_not_found", "The account lifecycle is unavailable.");
    if (row.generation !== lease.generation) {
      throw new AccountLifecycleError("stale_account_generation", "The account changed while this operation was running.");
    }
    if (row.state === "deleting") throw new AccountLifecycleError("account_deleting", "The account is being removed.");
    if (row.state === "deleted") throw new AccountLifecycleError("account_deleted", "The account has been removed.");
    if (!row.encrypted_dek) throw new AccountLifecycleError("account_key_unavailable", "The account encryption key is unavailable.");
    return publicRecord(row);
  }

  /** Returns a cloned per-account key after a durable generation check. */
  accountDataKey(lease: AccountGenerationLease): Buffer {
    const lifecycle = this.assertCurrent(lease);
    const wrapper: AccountDataKeyWrapper = {
      encryptedDek: lifecycle.encryptedDek ?? "",
      cryptoVersion: lifecycle.cryptoVersion,
    };
    return unwrapAccountDataKey(this.masterKey, lifecycle.accountId, lifecycle.generation, wrapper);
  }

  registerTask(lease: AccountGenerationLease): AccountTask {
    this.assertCurrent(lease);
    const controller = new AbortController();
    let released = false;
    const controllers = this.tasks.get(lease.accountId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.tasks.set(lease.accountId, controllers);
    return {
      signal: controller.signal,
      assertCurrent: () => {
        if (controller.signal.aborted) {
          throw new AccountLifecycleError("stale_account_generation", "The account operation was cancelled.");
        }
        this.assertCurrent(lease);
      },
      release: () => {
        if (released) return;
        released = true;
        controllers.delete(controller);
        if (controllers.size === 0) this.tasks.delete(lease.accountId);
      },
    };
  }

  private cancelTasks(accountId: string): void {
    for (const controller of this.tasks.get(accountId) ?? []) controller.abort();
  }

  /**
   * Atomically removes the DEK wrapper and advances the generation before an
   * account deletion proceeds. Existing tasks cannot commit after this point.
   */
  beginDeletion(
    accountId: string,
    withinDeletionTransaction?: (result: { previousGeneration: number; deletionGeneration: number }) => void,
  ): { previousGeneration: number; deletionGeneration: number } {
    validAccountId(accountId);
    assertAgentStoreReadable(this.db);
    const result = this.transaction(() => {
      const current = this.rowForAccount(accountId);
      const now = this.clock();
      let result: { previousGeneration: number; deletionGeneration: number };
      if (!current) {
        this.db.prepare(`
          INSERT INTO agent_account_lifecycle (
            account_id, generation, state, encrypted_dek, crypto_version, created_at, updated_at, deleted_at
          ) VALUES (?, 1, 'deleting', NULL, 0, ?, ?, ?)
        `).run(accountId, now, now, now);
        result = { previousGeneration: 0, deletionGeneration: 1 };
      } else if (current.state === "deleted") {
        result = { previousGeneration: current.generation, deletionGeneration: current.generation };
      } else if (current.state === "deleting") {
        result = { previousGeneration: current.generation - 1, deletionGeneration: current.generation };
      } else {
        const nextGeneration = current.generation + 1;
        this.db.prepare(`
          UPDATE agent_account_lifecycle
          SET generation = ?, state = 'deleting', encrypted_dek = NULL, crypto_version = 0,
              updated_at = ?, deleted_at = ?
          WHERE account_id = ? AND generation = ? AND state = 'active'
        `).run(nextGeneration, now, now, accountId, current.generation);
        const updated = this.rowForAccount(accountId);
        if (!updated || updated.generation !== nextGeneration || updated.state !== "deleting" || updated.encrypted_dek !== null) {
          throw new AccountLifecycleError("stale_account_generation", "The account lifecycle changed while deletion was starting.");
        }
        result = { previousGeneration: current.generation, deletionGeneration: nextGeneration };
      }
      withinDeletionTransaction?.(result);
      return result;
    });
    this.cancelTasks(accountId);
    return result;
  }

  completeDeletion(accountId: string, deletionGeneration: number): AccountLifecycleRecord {
    validAccountId(accountId);
    assertAgentStoreReadable(this.db);
    return this.transaction(() => {
      const current = this.rowForAccount(accountId);
      if (!current || current.generation !== deletionGeneration || current.state !== "deleting") {
        throw new AccountLifecycleError("stale_account_generation", "The account deletion lease is no longer current.");
      }
      const now = this.clock();
      this.db.prepare(`
        UPDATE agent_account_lifecycle
        SET state = 'deleted', updated_at = ?, deleted_at = COALESCE(deleted_at, ?)
        WHERE account_id = ? AND generation = ? AND state = 'deleting'
      `).run(now, now, accountId, deletionGeneration);
      const updated = this.rowForAccount(accountId);
      if (!updated) throw new AccountLifecycleError("account_not_found", "The account lifecycle is unavailable.");
      return publicRecord(updated);
    });
  }

  /**
   * A failed mail-account deletion never restores the discarded key wrapper.
   * It creates a fresh DEK at the deletion generation, forcing Agent data to
   * be rebuilt rather than reviving data that should have become unreadable.
   */
  restoreAfterCancelledDeletion(accountId: string, deletionGeneration: number): AccountLifecycleRecord {
    validAccountId(accountId);
    assertAgentStoreReadable(this.db);
    return this.transaction(() => {
      const current = this.rowForAccount(accountId);
      if (!current || current.generation !== deletionGeneration || current.state !== "deleting") {
        throw new AccountLifecycleError("stale_account_generation", "The account deletion lease is no longer current.");
      }
      if (!this.primaryAccountExists(accountId)) {
        throw new AccountLifecycleError("account_not_found", "The mail account no longer exists.");
      }
      const dek = createAccountDataKey();
      try {
        const wrapper = wrapAccountDataKey(this.masterKey, accountId, deletionGeneration, dek);
        const now = this.clock();
        this.db.prepare(`
          UPDATE agent_account_lifecycle
          SET state = 'active', encrypted_dek = ?, crypto_version = ?, updated_at = ?, deleted_at = NULL
          WHERE account_id = ? AND generation = ? AND state = 'deleting'
        `).run(wrapper.encryptedDek, wrapper.cryptoVersion, now, accountId, deletionGeneration);
      } finally {
        dek.fill(0);
      }
      const updated = this.rowForAccount(accountId);
      if (!updated) throw new AccountLifecycleError("account_not_found", "The account lifecycle is unavailable.");
      return publicRecord(updated);
    });
  }
}
