import { randomUUID } from "node:crypto";
import type { AccountGenerationLease } from "./lifecycle.js";
import type { AccountLifecycleStore } from "./lifecycle.js";
import type { AgentSourceEventOutbox } from "./source-events.js";
import { agentOpaqueDigest, canonicalAgentJson } from "./store-crypto.js";

export type AgentMailEventState = Readonly<Record<string, unknown>>;

export type AgentMailEventSink = {
  acquireLease(accountId: string): AccountGenerationLease;
  messageUpsertedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void;
  messageDeletedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void;
};

export type AgentAccountDeletion = {
  previousGeneration: number;
  deletionGeneration: number;
};

/**
 * Turns committed primary-mail mutations into opaque Agent source events.
 * Callers own the surrounding SQLite transaction; this class never starts a
 * second transaction for message events.
 */
export class AgentMailStateEvents implements AgentMailEventSink {
  constructor(
    private readonly masterKey: Buffer,
    private readonly lifecycle: AccountLifecycleStore,
    private readonly outbox: AgentSourceEventOutbox,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  acquireLease(accountId: string): AccountGenerationLease {
    return this.lifecycle.acquireLease(accountId);
  }

  messageUpsertedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void {
    this.enqueueMessageEventWithinTransaction("message-upserted", lease, messageId, state);
  }

  messageDeletedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void {
    this.enqueueMessageEventWithinTransaction("message-deleted", lease, messageId, state);
  }

  /**
   * Deletes the primary account row only after its Agent generation is
   * revoked and the durable cleanup event has been appended in the same
   * SQLite transaction.
   */
  beginAccountDeletion(accountId: string, deletePrimaryAccountWithinTransaction: () => void): AgentAccountDeletion {
    return this.lifecycle.beginDeletion(accountId, ({ previousGeneration, deletionGeneration }) => {
      this.outbox.cancelForAccountWithinTransaction(accountId, previousGeneration);
      this.outbox.enqueueWithinTransaction({
        event: {
          eventId: randomUUID(),
          type: "account-deleted",
          accountId,
          accountGeneration: deletionGeneration,
          revision: this.revision("account-deleted", accountId, deletionGeneration, {
            previousGeneration,
            deletionGeneration,
          }),
          occurredAt: this.clock(),
        },
        payloadForDigest: {
          action: "account-deleted",
          accountId,
          previousGeneration,
          deletionGeneration,
        },
      });
      deletePrimaryAccountWithinTransaction();
    });
  }

  completeAccountDeletion(accountId: string, deletionGeneration: number): void {
    this.lifecycle.completeDeletion(accountId, deletionGeneration);
  }

  private enqueueMessageEventWithinTransaction(
    type: "message-upserted" | "message-deleted",
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void {
    const occurredAt = this.clock();
    this.outbox.enqueueWithinTransaction({
      lease,
      event: {
        eventId: randomUUID(),
        type,
        accountId: lease.accountId,
        accountGeneration: lease.generation,
        revision: this.revision(type, lease.accountId, lease.generation, { messageId, state }),
        source: { kind: "message", messageId },
        occurredAt,
      },
      payloadForDigest: { type, messageId, state },
    });
  }

  private revision(
    eventType: string,
    accountId: string,
    accountGeneration: number,
    state: AgentMailEventState,
  ): string {
    return agentOpaqueDigest(
      this.masterKey,
      "mail-source-revision",
      canonicalAgentJson({ eventType, accountId, accountGeneration, state }),
    );
  }
}
