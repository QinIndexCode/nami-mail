import { randomBytes, randomUUID } from "node:crypto";
import {
  agentSourceLocatorSchema,
  type AgentSourceEvent,
  type AgentSourceEventType,
} from "@nami/agent-contracts";
import type { DatabaseHandle } from "../db.js";
import { AccountLifecycleStore, type AccountGenerationLease } from "./lifecycle.js";
import {
  AGENT_STORE_CRYPTO_VERSION,
  agentOpaqueDigest,
  canonicalAgentJson,
  decryptAccountAgentRecord,
  encryptAccountAgentRecord,
} from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

export type SourceEventState = "pending" | "processing" | "completed" | "failed" | "cancelled";

export type SourceEventPersistenceInput = {
  /** Canonical cross-entrypoint event; the store never interprets its payload. */
  event: AgentSourceEvent;
  /** Required for message and attachment events while the account is active. */
  lease?: AccountGenerationLease;
  payloadForDigest?: unknown;
};

export type StoredSourceEvent = {
  eventId: string;
  accountId: string;
  accountGeneration: number;
  sourceLocatorOpaque: string;
  sourceRevision: string;
  eventType: AgentSourceEventType;
  payloadDigest: string;
  occurredAt: string;
  state: SourceEventState;
  attemptCount: number;
  claimedAt: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  createdAt: string;
};

export type SourceEventClaim = Readonly<{
  eventId: string;
  owner: string;
  token: string;
  version: number;
  expiresAt: string;
}>;

export type ClaimedSourceEvent = StoredSourceEvent & Readonly<{
  claim: SourceEventClaim;
}>;

export type SourceEventClaimOptions = Readonly<{
  limit?: number;
  owner?: string;
  claimTtlMs?: number;
}>;

export class SourceEventClaimError extends Error {
  constructor(
    readonly code: "source_event_claim_lost" | "source_event_claim_invalid",
    message: string,
  ) {
    super(message);
    this.name = "SourceEventClaimError";
  }
}

type StoredSourceEventRow = {
  event_id: string;
  account_id: string;
  account_generation: number;
  source_locator_opaque: string;
  encrypted_source_locator: string | null;
  source_locator_crypto_version: number;
  source_revision: string;
  event_type: AgentSourceEventType;
  payload_digest: string;
  occurred_at: string;
  state: SourceEventState;
  attempt_count: number;
  claimed_at: string | null;
  claim_owner: string | null;
  claim_token_hash: string | null;
  claim_version: number;
  claim_expires_at: string | null;
  next_attempt_at: string | null;
  completed_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
};

const lifecycleEventTypes = new Set<AgentSourceEventType>([
  "account-generation-advanced",
  "account-deleted",
]);

const defaultClaimTtlMs = 60_000;
const minimumClaimTtlMs = 1_000;
const maximumClaimTtlMs = 15 * 60_000;
const maximumRetryBackoffMs = 5 * 60_000;

export const enqueueSourceEventSql = `
INSERT INTO agent_source_events (
  event_id, account_id, account_generation, source_locator_opaque,
  encrypted_source_locator, source_locator_crypto_version, source_revision,
  event_type, payload_digest, occurred_at, state, attempt_count, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
ON CONFLICT(account_id, account_generation, source_locator_opaque, source_revision, event_type)
DO UPDATE SET
  event_id = excluded.event_id,
  encrypted_source_locator = excluded.encrypted_source_locator,
  source_locator_crypto_version = excluded.source_locator_crypto_version,
  payload_digest = excluded.payload_digest,
  occurred_at = excluded.occurred_at,
  state = 'pending',
  attempt_count = 0,
  claimed_at = NULL,
  claim_owner = NULL,
  claim_token_hash = NULL,
  claim_version = agent_source_events.claim_version + 1,
  claim_expires_at = NULL,
  next_attempt_at = NULL,
  completed_at = NULL,
  last_error_code = NULL,
  last_error_at = NULL,
  created_at = excluded.created_at
WHERE agent_source_events.state = 'cancelled'
  AND agent_source_events.encrypted_source_locator IS NULL
  AND agent_source_events.last_error_code = 'source_locator_unrecoverable_after_migration'
`;

function publicEvent(row: StoredSourceEventRow): StoredSourceEvent {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    accountGeneration: row.account_generation,
    sourceLocatorOpaque: row.source_locator_opaque,
    sourceRevision: row.source_revision,
    eventType: row.event_type,
    payloadDigest: row.payload_digest,
    occurredAt: row.occurred_at,
    state: row.state,
    attemptCount: row.attempt_count,
    claimedAt: row.claimed_at,
    nextAttemptAt: row.next_attempt_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
  };
}

function validValue(value: string, name: string, maximum = 4_096): void {
  if (!value || value.length > maximum) throw new Error(`${name} is invalid.`);
}

function validTimestamp(value: string, name: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} is invalid.`);
  return milliseconds;
}

function lifecycleEvent(type: AgentSourceEventType): boolean {
  return lifecycleEventTypes.has(type);
}

function retryBackoffMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 8);
  return Math.min(1_000 * (2 ** exponent), maximumRetryBackoffMs);
}

function addMilliseconds(now: string, milliseconds: number): string {
  return new Date(validTimestamp(now, "Current time") + milliseconds).toISOString();
}

function claimFrom(input: ClaimedSourceEvent | SourceEventClaim): SourceEventClaim {
  return "claim" in input ? input.claim : input;
}

/**
 * A durable local outbox for committed mail-state changes. Source locators are
 * encrypted under the account DEK and can only be recovered by a current
 * account lease after a worker has obtained an exclusive claim.
 */
export class AgentSourceEventOutbox {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly lifecycle: AccountLifecycleStore,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private row(eventId: string): StoredSourceEventRow | undefined {
    return this.db.prepare("SELECT * FROM agent_source_events WHERE event_id = ?").get(eventId) as StoredSourceEventRow | undefined;
  }

  private claimHash(claim: Pick<SourceEventClaim, "eventId" | "owner" | "token" | "version">): string {
    return agentOpaqueDigest(
      this.masterKey,
      "source-event-claim",
      canonicalAgentJson({
        eventId: claim.eventId,
        owner: claim.owner,
        token: claim.token,
        version: claim.version,
      }),
    );
  }

  private normalizeClaimOptions(limitOrOptions: number | SourceEventClaimOptions): Required<SourceEventClaimOptions> {
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Source event claim limit is invalid.");
    }
    const claimTtlMs = options.claimTtlMs ?? defaultClaimTtlMs;
    if (!Number.isSafeInteger(claimTtlMs) || claimTtlMs < minimumClaimTtlMs || claimTtlMs > maximumClaimTtlMs) {
      throw new Error("Source event claim lease duration is invalid.");
    }
    const owner = options.owner ?? `worker-${randomUUID()}`;
    validValue(owner, "Source event claim owner", 512);
    return { limit, claimTtlMs, owner };
  }

  private assertClaimCurrent(claim: SourceEventClaim): StoredSourceEventRow {
    validValue(claim.eventId, "Event id", 512);
    validValue(claim.owner, "Source event claim owner", 512);
    validValue(claim.token, "Source event claim token", 512);
    if (!Number.isSafeInteger(claim.version) || claim.version < 1) {
      throw new SourceEventClaimError("source_event_claim_invalid", "Source event claim version is invalid.");
    }
    validTimestamp(claim.expiresAt, "Source event claim expiry");
    const row = this.row(claim.eventId);
    const now = this.clock();
    if (
      !row
      || row.state !== "processing"
      || row.claim_owner !== claim.owner
      || row.claim_version !== claim.version
      || !row.claim_token_hash
      || !row.claim_expires_at
      || row.claim_expires_at <= now
      || row.claim_token_hash !== this.claimHash(claim)
    ) {
      throw new SourceEventClaimError("source_event_claim_lost", "The source event claim is no longer current.");
    }
    return row;
  }

  private eligibleForClaim(row: Pick<StoredSourceEventRow, "account_id" | "account_generation" | "event_type">): boolean {
    const lifecycle = this.lifecycle.current(row.account_id);
    if (!lifecycle || lifecycle.generation !== row.account_generation) return false;
    if (lifecycleEvent(row.event_type)) return true;
    try {
      this.lifecycle.assertCurrent({ accountId: row.account_id, generation: row.account_generation });
      return true;
    } catch {
      return false;
    }
  }

  private cancelCandidate(eventId: string, now: string): void {
    this.db.prepare(`
      UPDATE agent_source_events
      SET state = 'cancelled', completed_at = ?, claim_owner = NULL,
          claim_token_hash = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
          last_error_code = 'account_generation_revoked', last_error_at = ?
      WHERE event_id = ? AND state IN ('pending', 'failed')
    `).run(now, now, eventId);
  }

  private recoverExpiredClaimsWithinTransaction(now: string): void {
    const stale = this.db.prepare(`
      SELECT event_id, attempt_count, claim_version
      FROM agent_source_events
      WHERE state = 'processing' AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
    `).all(now) as Array<{ event_id: string; attempt_count: number; claim_version: number }>;
    const recover = this.db.prepare(`
      UPDATE agent_source_events
      SET state = 'failed', claim_owner = NULL, claim_token_hash = NULL,
          claim_expires_at = NULL, next_attempt_at = ?, completed_at = NULL,
          last_error_code = 'claim_expired', last_error_at = ?
      WHERE event_id = ? AND state = 'processing' AND claim_version = ?
        AND (claim_expires_at IS NULL OR claim_expires_at <= ?)
    `);
    for (const row of stale) {
      recover.run(
        addMilliseconds(now, retryBackoffMs(row.attempt_count)),
        now,
        row.event_id,
        row.claim_version,
        now,
      );
    }
  }

  private assertLifecycleEventCurrent(row: StoredSourceEventRow): void {
    const current = this.lifecycle.current(row.account_id);
    if (!current || current.generation !== row.account_generation) {
      throw new Error("Source event account lifecycle is no longer current.");
    }
    if (row.event_type === "account-deleted" && current.state !== "deleting" && current.state !== "deleted") {
      throw new Error("Account deletion source event is no longer valid.");
    }
  }

  /**
   * Persists a source event in the caller's active SQLite transaction. The
   * caller must invoke it from the transaction that commits the primary mail
   * state; this method deliberately does not start or commit a transaction.
   */
  enqueueWithinTransaction(input: SourceEventPersistenceInput): StoredSourceEvent {
    assertAgentStoreReadable(this.db);
    const isLifecycleEvent = lifecycleEvent(input.event.type);
    const lifecycle = this.lifecycle.current(input.event.accountId);
    if (!lifecycle || lifecycle.generation !== input.event.accountGeneration) {
      throw new Error("Source event account lifecycle is no longer current.");
    }
    if (isLifecycleEvent) {
      const validLifecycleState = input.event.type === "account-deleted"
        ? lifecycle.state === "deleting" || lifecycle.state === "deleted"
        : lifecycle.state === "active" || lifecycle.state === "deleting" || lifecycle.state === "deleted";
      if (!validLifecycleState || input.event.source) {
        throw new Error("Source event account lifecycle is invalid.");
      }
    } else {
      if (!input.lease || input.event.accountId !== input.lease.accountId || input.event.accountGeneration !== input.lease.generation) {
        throw new Error("Source event account lifecycle does not match its lease.");
      }
      this.lifecycle.assertCurrent(input.lease);
      if (!agentSourceLocatorSchema.safeParse(input.event.source).success) {
        throw new Error("Source event locator is invalid.");
      }
    }
    const eventId = input.event.eventId || randomUUID();
    validValue(eventId, "Event id", 512);
    const sourceRevision = String(input.event.revision);
    validValue(sourceRevision, "Source revision", 256);
    validTimestamp(input.event.occurredAt, "Source event occurrence time");
    const sourceLocatorOpaque = agentOpaqueDigest(
      this.masterKey,
      "source-locator",
      canonicalAgentJson({ accountId: input.event.accountId, source: input.event.source ?? { kind: "account" } }),
    );
    const payloadDigest = agentOpaqueDigest(
      this.masterKey,
      "source-event",
      canonicalAgentJson(input.payloadForDigest ?? input.event),
    );
    const createdAt = this.clock();
    let encryptedSourceLocator: string | null = null;
    if (!isLifecycleEvent) {
      const lease = input.lease!;
      const accountDek = this.lifecycle.accountDataKey(lease);
      try {
        encryptedSourceLocator = encryptAccountAgentRecord(
          accountDek,
          lease.accountId,
          lease.generation,
          "source-event-locator",
          eventId,
          canonicalAgentJson(input.event.source),
        );
      } finally {
        accountDek.fill(0);
      }
      // Re-check in the same local transaction as the source-state change.
      this.lifecycle.assertCurrent(lease);
    }
    this.db.prepare(enqueueSourceEventSql).run(
      eventId,
      input.event.accountId,
      input.event.accountGeneration,
      sourceLocatorOpaque,
      encryptedSourceLocator,
      isLifecycleEvent ? 0 : AGENT_STORE_CRYPTO_VERSION,
      sourceRevision,
      input.event.type,
      payloadDigest,
      input.event.occurredAt,
      createdAt,
    );
    const stored = this.db.prepare(`
      SELECT * FROM agent_source_events
      WHERE account_id = ? AND account_generation = ? AND source_locator_opaque = ?
        AND source_revision = ? AND event_type = ?
    `).get(
      input.event.accountId,
      input.event.accountGeneration,
      sourceLocatorOpaque,
      sourceRevision,
      input.event.type,
    ) as StoredSourceEventRow | undefined;
    if (!stored) throw new Error("Agent source event could not be persisted.");
    return publicEvent(stored);
  }

  /** Convenience wrapper for standalone local callers without another state change. */
  enqueue(input: SourceEventPersistenceInput): StoredSourceEvent {
    return this.transaction(() => this.enqueueWithinTransaction(input));
  }

  /**
   * Claims eligible jobs with a short-lived, owner-bound capability. Passing a
   * number remains supported for simple callers; service workers should pass a
   * stable owner id and then complete or fail with the returned claim object.
   */
  claimPending(limitOrOptions: number | SourceEventClaimOptions = 25): ClaimedSourceEvent[] {
    assertAgentStoreReadable(this.db);
    const options = this.normalizeClaimOptions(limitOrOptions);
    return this.transaction(() => {
      const now = this.clock();
      this.recoverExpiredClaimsWithinTransaction(now);
      const candidates = this.db.prepare(`
        SELECT event_id, account_id, account_generation, event_type, claim_version
        FROM agent_source_events
        WHERE state = 'pending'
          OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        ORDER BY occurred_at, created_at
        LIMIT ?
      `).all(now, options.limit) as Array<Pick<StoredSourceEventRow,
        "event_id" | "account_id" | "account_generation" | "event_type" | "claim_version"
      >>;
      const claimed: ClaimedSourceEvent[] = [];
      const claimAt = now;
      const expiresAt = addMilliseconds(now, options.claimTtlMs);
      const claim = this.db.prepare(`
        UPDATE agent_source_events
        SET state = 'processing', attempt_count = attempt_count + 1, claimed_at = ?,
            claim_owner = ?, claim_token_hash = ?, claim_version = claim_version + 1,
            claim_expires_at = ?, next_attempt_at = NULL, completed_at = NULL,
            last_error_code = NULL, last_error_at = NULL
        WHERE event_id = ? AND claim_version = ?
          AND (state = 'pending' OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))
      `);
      for (const candidate of candidates) {
        if (!this.eligibleForClaim(candidate)) {
          this.cancelCandidate(candidate.event_id, now);
          continue;
        }
        const claimVersion = candidate.claim_version + 1;
        const token = randomBytes(32).toString("base64url");
        const claimCapability: SourceEventClaim = {
          eventId: candidate.event_id,
          owner: options.owner,
          token,
          version: claimVersion,
          expiresAt,
        };
        if (claim.run(
          claimAt,
          options.owner,
          this.claimHash(claimCapability),
          expiresAt,
          candidate.event_id,
          candidate.claim_version,
          now,
        ).changes !== 1) {
          continue;
        }
        const row = this.row(candidate.event_id);
        if (row) claimed.push({ ...publicEvent(row), claim: claimCapability });
      }
      return claimed;
    });
  }

  /**
   * Decrypts a claimed event's locator only after owner, lease, and generation
   * checks. Lifecycle cleanup events intentionally have no source locator.
   */
  recoverClaimedEvent(input: ClaimedSourceEvent | SourceEventClaim, lease?: AccountGenerationLease): AgentSourceEvent {
    assertAgentStoreReadable(this.db);
    const claim = claimFrom(input);
    const row = this.assertClaimCurrent(claim);
    if (lifecycleEvent(row.event_type)) {
      if (lease) {
        if (lease.accountId !== row.account_id || lease.generation !== row.account_generation) {
          throw new Error("Source event account lifecycle does not match its lease.");
        }
      }
      this.assertLifecycleEventCurrent(row);
      this.assertClaimCurrent(claim);
      return {
        eventId: row.event_id,
        type: row.event_type,
        accountId: row.account_id,
        accountGeneration: row.account_generation,
        revision: row.source_revision,
        occurredAt: row.occurred_at,
      };
    }
    if (!lease || lease.accountId !== row.account_id || lease.generation !== row.account_generation) {
      throw new Error("Source event recovery requires its current account lease.");
    }
    if (!row.encrypted_source_locator || row.source_locator_crypto_version !== AGENT_STORE_CRYPTO_VERSION) {
      throw new Error("Source event locator is unavailable.");
    }
    this.lifecycle.assertCurrent(lease);
    const accountDek = this.lifecycle.accountDataKey(lease);
    try {
      const plaintext = decryptAccountAgentRecord(
        accountDek,
        lease.accountId,
        lease.generation,
        "source-event-locator",
        row.event_id,
        row.encrypted_source_locator,
      );
      let source: unknown;
      try {
        source = JSON.parse(plaintext) as unknown;
      } catch {
        throw new Error("Encrypted source event locator is invalid.");
      }
      const parsed = agentSourceLocatorSchema.safeParse(source);
      if (!parsed.success) throw new Error("Encrypted source event locator is invalid.");
      this.lifecycle.assertCurrent(lease);
      this.assertClaimCurrent(claim);
      return {
        eventId: row.event_id,
        type: row.event_type,
        accountId: row.account_id,
        accountGeneration: row.account_generation,
        revision: row.source_revision,
        source: parsed.data,
        occurredAt: row.occurred_at,
      };
    } finally {
      accountDek.fill(0);
    }
  }

  complete(input: ClaimedSourceEvent | SourceEventClaim): StoredSourceEvent {
    assertAgentStoreReadable(this.db);
    const claim = claimFrom(input);
    return this.transitionClaim(claim, "completed");
  }

  fail(input: ClaimedSourceEvent | SourceEventClaim, errorCode: string): StoredSourceEvent {
    assertAgentStoreReadable(this.db);
    validValue(errorCode, "Source event error code", 256);
    const claim = claimFrom(input);
    return this.transitionClaim(claim, "failed", errorCode);
  }

  private transitionClaim(
    claim: SourceEventClaim,
    state: "completed" | "failed",
    errorCode?: string,
  ): StoredSourceEvent {
    return this.transaction(() => {
      const current = this.assertClaimCurrent(claim);
      const now = this.clock();
      const nextAttemptAt = state === "failed"
        ? addMilliseconds(now, retryBackoffMs(current.attempt_count))
        : null;
      const updated = this.db.prepare(`
        UPDATE agent_source_events
        SET state = ?, completed_at = ?, claim_owner = NULL,
            claim_token_hash = NULL, claim_expires_at = NULL, next_attempt_at = ?,
            last_error_code = ?, last_error_at = ?
        WHERE event_id = ? AND state = 'processing' AND claim_owner = ?
          AND claim_token_hash = ? AND claim_version = ? AND claim_expires_at > ?
      `).run(
        state,
        state === "completed" ? now : null,
        nextAttemptAt,
        errorCode ?? null,
        state === "failed" ? now : null,
        claim.eventId,
        claim.owner,
        this.claimHash(claim),
        claim.version,
        now,
      );
      if (updated.changes !== 1) {
        throw new SourceEventClaimError("source_event_claim_lost", "The source event claim is no longer current.");
      }
      const row = this.row(claim.eventId);
      if (!row) throw new Error("Agent source event was not found.");
      return publicEvent(row);
    });
  }

  /** Cancels all stale work after the lifecycle generation has advanced. */
  cancelForAccount(accountId: string, generationAtMost: number): number {
    assertAgentStoreReadable(this.db);
    validValue(accountId, "Account id", 512);
    if (!Number.isSafeInteger(generationAtMost) || generationAtMost < 0) throw new Error("Account generation is invalid.");
    return this.transaction(() => this.cancelForAccountWithinTransaction(accountId, generationAtMost));
  }

  /** Cancels stale work from the caller's already-open lifecycle transaction. */
  cancelForAccountWithinTransaction(accountId: string, generationAtMost: number): number {
    assertAgentStoreReadable(this.db);
    validValue(accountId, "Account id", 512);
    if (!Number.isSafeInteger(generationAtMost) || generationAtMost < 0) throw new Error("Account generation is invalid.");
    const now = this.clock();
    return this.db.prepare(`
      UPDATE agent_source_events
      SET state = 'cancelled', completed_at = ?, claim_owner = NULL,
          claim_token_hash = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
          last_error_code = 'account_generation_revoked', last_error_at = ?
      WHERE account_id = ? AND account_generation <= ?
        AND state IN ('pending', 'failed', 'processing')
    `).run(now, now, accountId, generationAtMost).changes;
  }

  listForAccount(accountId: string, generation: number): StoredSourceEvent[] {
    assertAgentStoreReadable(this.db);
    validValue(accountId, "Account id", 512);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Account generation is invalid.");
    return (this.db.prepare(`
      SELECT * FROM agent_source_events
      WHERE account_id = ? AND account_generation = ?
      ORDER BY created_at, event_id
    `).all(accountId, generation) as StoredSourceEventRow[]).map(publicEvent);
  }
}
