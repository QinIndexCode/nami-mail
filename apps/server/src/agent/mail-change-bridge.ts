import { emitMailChanged, type ServerEventBus } from "../events.js";
import type { AccountGenerationLease } from "./lifecycle.js";
import type {
  AgentAccountDeletion,
  AgentMailEventState,
  AgentMailStateEventSink,
} from "./mail-state-events.js";

/**
 * The explicit seam between the two event systems.
 *
 * `AgentMailEventSink` records durable, opaque source events for the Agent;
 * `ServerEventBus` pushes frames to connected renderers. They are not the same
 * type and must not be assumed to be (contract §7). This class implements the
 * sink, forwards every state change to the recorder untouched, and publishes a
 * coalesced `mail-changed` frame so a renderer that did not make the write —
 * today that means the web UI while the Agent is acting — learns about it
 * without waiting for the 60-second poll.
 *
 * ## Why the frame is deferred by one microtask
 *
 * The sink is called **inside** the caller's SQLite transaction (its methods are
 * named `...WithinTransaction` for that reason), so emitting there would publish
 * a change that is not committed yet. `queueMicrotask` runs when the current
 * synchronous stack unwinds, which for better-sqlite3's synchronous
 * `db.transaction(fn)()` is after the commit. A rolled-back transaction can
 * therefore still produce one frame; that costs a refresh that reads the
 * unchanged truth and never shows a row the database does not hold.
 *
 * The same deferral coalesces a whole pass — a sync or a multi-message Agent
 * edit issues hundreds of sink calls in one stack — into one frame per account.
 */

export type AgentMailChangeBridgeOptions = {
  /**
   * How the deferred flush is scheduled. Injectable so a test can run it
   * deterministically; production uses the microtask queue.
   */
  schedule?: (flush: () => void) => void;
};

/** The state fields that name a mailbox the change touched. */
const FOLDER_KEYS = ["mailbox", "pendingMoveDestination"] as const;

export class AgentMailChangeBridge implements AgentMailStateEventSink {
  private pending = new Map<string, Set<string>>();
  private scheduled = false;

  constructor(
    private readonly inner: AgentMailStateEventSink,
    private readonly bus: ServerEventBus | undefined,
    private readonly options: AgentMailChangeBridgeOptions = {},
  ) {}

  acquireLease(accountId: string): AccountGenerationLease {
    return this.inner.acquireLease(accountId);
  }

  messageUpsertedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void {
    this.inner.messageUpsertedWithinTransaction(lease, messageId, state);
    this.record(lease.accountId, state);
  }

  messageDeletedWithinTransaction(
    lease: AccountGenerationLease,
    messageId: string,
    state: AgentMailEventState,
  ): void {
    this.inner.messageDeletedWithinTransaction(lease, messageId, state);
    this.record(lease.accountId, state);
  }

  beginAccountDeletion(
    accountId: string,
    deletePrimaryAccountWithinTransaction: () => void,
  ): AgentAccountDeletion {
    return this.inner.beginAccountDeletion(accountId, deletePrimaryAccountWithinTransaction);
  }

  completeAccountDeletion(accountId: string, deletionGeneration: number): void {
    this.inner.completeAccountDeletion(accountId, deletionGeneration);
  }

  /**
   * Publishes everything buffered so far. Called by the scheduler seam and by
   * tests; idempotent, and a no-op when nothing was recorded.
   */
  flush(): void {
    this.scheduled = false;
    const pending = this.pending;
    this.pending = new Map();
    for (const [accountId, folders] of pending) {
      emitMailChanged(this.bus, { accountId, folders: [...folders].sort() });
    }
  }

  private record(accountId: string, state: AgentMailEventState): void {
    if (!this.bus) return;
    let folders = this.pending.get(accountId);
    if (!folders) {
      folders = new Set<string>();
      this.pending.set(accountId, folders);
    }
    for (const key of FOLDER_KEYS) {
      const value = state[key];
      if (typeof value === "string" && value) folders.add(value);
    }
    if (this.scheduled) return;
    this.scheduled = true;
    (this.options.schedule ?? queueMicrotask)(() => this.flush());
  }
}
