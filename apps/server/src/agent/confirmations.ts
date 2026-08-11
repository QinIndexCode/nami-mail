import type {
  AgentError,
  CallerContext,
  ConfirmationDecision,
  ConfirmationRequest,
} from "@nami/agent-contracts";
import { randomUUID } from "node:crypto";
import type { ConfirmationAuthority } from "@nami/agent-core";
import type { DatabaseHandle } from "../db.js";
import type { AccountLifecycleStore } from "./lifecycle.js";
import { decryptPersistentAgentRecord, encryptPersistentAgentRecord } from "./record-envelopes.js";
import { agentOpaqueDigest, canonicalAgentJson } from "./store-crypto.js";
import { assertAgentStoreReadable } from "./schema.js";

type ConfirmationRecordType = "requested" | "confirmed" | "rejected" | "consumed" | "expired";

type ConfirmationRecordRow = {
  record_id: string;
  intent_id: string;
  account_id: string | null;
  account_generation: number | null;
  confirmation_token_hash: string;
  event_type: ConfirmationRecordType;
  encrypted_snapshot: string;
  crypto_version: number;
  created_at: string;
};

type ConfirmationSnapshot =
  | { kind: "request"; request: ConfirmationRequest }
  | { kind: "decision"; decision: ConfirmationDecision; callerId: string }
  | { kind: "consumed"; confirmationId: string; requestId: string; callerId: string; consumedAt: string };

export type TrustedDesktopConfirmation = Readonly<{
  principalId: string;
  surfaceId: string;
}>;

export type DesktopConfirmationVerificationInput = Readonly<{
  capability: unknown;
  caller: CallerContext;
  confirmationId: string;
  requestId: string;
  operation: "record-decision" | "consume-approval";
}>;

/**
 * The desktop main process must inject this verifier after authenticating a
 * capability that did not originate as renderer-controlled JSON.
 */
export interface TrustedDesktopConfirmationVerifier {
  verify(input: DesktopConfirmationVerificationInput): TrustedDesktopConfirmation | undefined;
}

function agentError(code: AgentError["code"], message: string, suggestion?: string): AgentError {
  return { code, message, retryable: false, ...(suggestion ? { suggestion } : {}) };
}

function validRequest(request: ConfirmationRequest): void {
  if (!request.id || !request.requestId || !request.immutablePayloadHash || !request.oneTime) {
    throw new Error("Confirmation request is incomplete.");
  }
  if (new Set(request.accountIds).size !== request.accountIds.length) {
    throw new Error("Confirmation request account scope contains duplicates.");
  }
}

function validDecision(decision: ConfirmationDecision): void {
  if (!decision.confirmationId || !decision.requestId || !decision.decision) {
    throw new Error("Confirmation decision is incomplete.");
  }
}

function isExpired(request: ConfirmationRequest, now: string): boolean {
  const expiry = Date.parse(request.expiresAt);
  const current = Date.parse(now);
  return !Number.isFinite(expiry) || !Number.isFinite(current) || current >= expiry;
}

/**
 * Stores GUI confirmations as append-only receipt events. Only the visible
 * desktop caller may approve a request, and each approval can be consumed once.
 */
export class ImmutableGuiConfirmationStore implements ConfirmationAuthority {
  constructor(
    private readonly db: DatabaseHandle,
    private readonly masterKey: Buffer,
    private readonly lifecycle: AccountLifecycleStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly desktopConfirmationVerifier?: TrustedDesktopConfirmationVerifier,
  ) {}

  private transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private requestRow(id: string): ConfirmationRecordRow | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_gui_confirmation_records
      WHERE intent_id = ? AND event_type = 'requested'
    `).get(id) as ConfirmationRecordRow | undefined;
  }

  private decisionRow(id: string): ConfirmationRecordRow | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_gui_confirmation_records
      WHERE intent_id = ? AND event_type IN ('confirmed', 'rejected', 'expired')
      ORDER BY created_at DESC, record_id DESC
      LIMIT 1
    `).get(id) as ConfirmationRecordRow | undefined;
  }

  private consumedRow(id: string): ConfirmationRecordRow | undefined {
    return this.db.prepare(`
      SELECT * FROM agent_gui_confirmation_records
      WHERE intent_id = ? AND event_type = 'consumed'
    `).get(id) as ConfirmationRecordRow | undefined;
  }

  private tokenHash(request: ConfirmationRequest): string {
    return agentOpaqueDigest(
      this.masterKey,
      "confirmation-token",
      canonicalAgentJson({ id: request.id, requestId: request.requestId, immutablePayloadHash: request.immutablePayloadHash }),
    );
  }

  private trustedDesktop(
    capability: unknown,
    caller: CallerContext,
    confirmationId: string,
    requestId: string,
    operation: DesktopConfirmationVerificationInput["operation"],
  ): TrustedDesktopConfirmation | undefined {
    // Both the Electron window and the local web surface resolve confirmations
    // interactively; each verifier only ever accepts its own capability, so a
    // desktop authority never trusts a web caller and vice versa.
    if (!capability || !caller.interactive || (caller.kind !== "desktop-ui" && caller.kind !== "web-ui")) return undefined;
    const trusted = this.desktopConfirmationVerifier?.verify({
      capability,
      caller,
      confirmationId,
      requestId,
      operation,
    });
    if (!trusted || !trusted.principalId || !trusted.surfaceId) return undefined;
    return trusted;
  }

  private readSnapshot<T extends ConfirmationSnapshot>(row: ConfirmationRecordRow, recordType: string): T {
    const value = decryptPersistentAgentRecord(
      this.masterKey,
      this.lifecycle,
      recordType,
      row.record_id,
      row.encrypted_snapshot,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Confirmation record is invalid.");
    }
    return value as T;
  }

  private requestFor(id: string): { row: ConfirmationRecordRow; request: ConfirmationRequest } | undefined {
    const row = this.requestRow(id);
    if (!row) return undefined;
    const snapshot = this.readSnapshot<{ kind: "request"; request: ConfirmationRequest }>(row, "gui-confirmation-request");
    if (snapshot.kind !== "request" || snapshot.request.id !== id) throw new Error("Confirmation request record is invalid.");
    return { row, request: snapshot.request };
  }

  private insertSnapshot(
    confirmationId: string,
    accountIds: readonly string[],
    tokenHash: string,
    type: ConfirmationRecordType,
    recordType: string,
    snapshot: ConfirmationSnapshot,
    createdAt: string,
  ): ConfirmationRecordRow {
    const recordId = `${confirmationId}:${type}:${randomUUID()}`;
    const accountId = accountIds[0] ?? null;
    const accountGeneration = accountId ? this.lifecycle.acquireLease(accountId).generation : null;
    const encryptedSnapshot = encryptPersistentAgentRecord(
      this.masterKey,
      this.lifecycle,
      accountIds,
      recordType,
      recordId,
      snapshot,
    );
    this.db.prepare(`
      INSERT INTO agent_gui_confirmation_records (
        record_id, intent_id, account_id, account_generation, confirmation_token_hash,
        event_type, encrypted_snapshot, crypto_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(recordId, confirmationId, accountId, accountGeneration, tokenHash, type, encryptedSnapshot, createdAt);
    const stored = this.db.prepare("SELECT * FROM agent_gui_confirmation_records WHERE record_id = ?").get(recordId) as ConfirmationRecordRow | undefined;
    if (!stored) throw new Error("Confirmation record could not be persisted.");
    return stored;
  }

  async create(request: ConfirmationRequest): Promise<ConfirmationRequest> {
    assertAgentStoreReadable(this.db);
    validRequest(request);
    return this.transaction(() => {
      const existing = this.requestFor(request.id);
      if (existing) {
        if (canonicalAgentJson(existing.request) !== canonicalAgentJson(request)) {
          throw new Error("Confirmation id already belongs to a different request.");
        }
        return existing.request;
      }
      this.insertSnapshot(
        request.id,
        request.accountIds,
        this.tokenHash(request),
        "requested",
        "gui-confirmation-request",
        { kind: "request", request },
        request.createdAt,
      );
      return request;
    });
  }

  /** Called only after desktop main has verified a visible confirmation capability. */
  recordDecision(
    decision: ConfirmationDecision,
    caller: CallerContext,
    desktopCapability?: unknown,
  ): ConfirmationDecision {
    assertAgentStoreReadable(this.db);
    validDecision(decision);
    const trusted = this.trustedDesktop(
      desktopCapability,
      caller,
      decision.confirmationId,
      decision.requestId,
      "record-decision",
    );
    if (!trusted) {
      throw new Error("A verified desktop confirmation capability is required.");
    }
    return this.writeDecision(decision, trusted.principalId);
  }

  /**
   * Records a decision that arrived through the host's external confirmation
   * bridge. The bridge is injected by the desktop main process and shows a
   * native dialog for a paired CLI/MCP caller, so no capability is required;
   * the caller must still be a non-interactive external caller.
   */
  recordExternalDecision(
    decision: ConfirmationDecision,
    caller: CallerContext,
  ): ConfirmationDecision {
    assertAgentStoreReadable(this.db);
    validDecision(decision);
    if (caller.kind !== "cli" && caller.kind !== "mcp") {
      throw new Error("An external confirmation decision requires a paired CLI or MCP caller.");
    }
    return this.writeDecision(decision, `external:${caller.kind}:${caller.callerId}`);
  }

  private writeDecision(decision: ConfirmationDecision, callerId: string): ConfirmationDecision {
    return this.transaction(() => {
      const requested = this.requestFor(decision.confirmationId);
      if (!requested || requested.request.requestId !== decision.requestId) {
        throw new Error("Confirmation request was not found.");
      }
      const now = this.clock();
      if (isExpired(requested.request, now)) {
        if (!this.decisionRow(decision.confirmationId)) {
          this.insertSnapshot(
            requested.request.id,
            requested.request.accountIds,
            requested.row.confirmation_token_hash,
            "expired",
            "gui-confirmation-decision",
            { kind: "decision", decision: { ...decision, decision: "expired", decidedAt: now }, callerId },
            now,
          );
        }
        throw new Error("Confirmation request has expired.");
      }
      const previous = this.decisionRow(decision.confirmationId);
      if (previous) throw new Error("Confirmation already has a decision.");
      if (decision.decision === "approved" && decision.immutablePayloadHash !== requested.request.immutablePayloadHash) {
        throw new Error("Confirmation approval is not bound to the requested immutable payload.");
      }
      const type: ConfirmationRecordType = decision.decision === "approved"
        ? "confirmed"
        : decision.decision === "expired"
          ? "expired"
          : "rejected";
      this.insertSnapshot(
        requested.request.id,
        requested.request.accountIds,
        requested.row.confirmation_token_hash,
        type,
        "gui-confirmation-decision",
        { kind: "decision", decision, callerId },
        decision.decidedAt,
      );
      return decision;
    });
  }

  async consumeApproval(input: {
    confirmationId: string;
    requestId: string;
    caller: CallerContext;
    immutablePayloadHash: string;
    desktopCapability?: unknown;
  }): Promise<{ approved: true } | { approved: false; error: AgentError }> {
    assertAgentStoreReadable(this.db);
    const trusted = this.trustedDesktop(
      input.desktopCapability,
      input.caller,
      input.confirmationId,
      input.requestId,
      "consume-approval",
    );
    if (!trusted) {
      return { approved: false, error: agentError("CONFIRMATION_REQUIRED", "This action requires a visible Nami Mail confirmation.") };
    }
    return this.consumeApprovalTransaction(
      input.confirmationId,
      input.requestId,
      input.immutablePayloadHash,
      trusted.principalId,
    );
  }

  /**
   * Consumes an approval recorded through the host's external confirmation
   * bridge. The consuming caller must be the same paired CLI/MCP caller that
   * triggered the confirmation, so a different caller cannot spend the receipt.
   */
  async consumeExternalApproval(input: {
    confirmationId: string;
    requestId: string;
    caller: CallerContext;
    immutablePayloadHash: string;
  }): Promise<{ approved: true } | { approved: false; error: AgentError }> {
    assertAgentStoreReadable(this.db);
    if (input.caller.kind !== "cli" && input.caller.kind !== "mcp") {
      return { approved: false, error: agentError("CONFIRMATION_REQUIRED", "This action requires a paired external Nami Mail caller.") };
    }
    return this.consumeApprovalTransaction(
      input.confirmationId,
      input.requestId,
      input.immutablePayloadHash,
      `external:${input.caller.kind}:${input.caller.callerId}`,
    );
  }

  private consumeApprovalTransaction(
    confirmationId: string,
    requestId: string,
    immutablePayloadHash: string,
    callerId: string,
  ): { approved: true } | { approved: false; error: AgentError } {
    return this.transaction(() => {
      const requested = this.requestFor(confirmationId);
      if (!requested || requested.request.requestId !== requestId) {
        return { approved: false, error: agentError("NOT_FOUND", "The confirmation request was not found.") };
      }
      const now = this.clock();
      if (isExpired(requested.request, now)) {
        if (!this.decisionRow(confirmationId)) {
          this.insertSnapshot(
            requested.request.id,
            requested.request.accountIds,
            requested.row.confirmation_token_hash,
            "expired",
            "gui-confirmation-decision",
            {
              kind: "decision",
              decision: { confirmationId: requested.request.id, requestId: requested.request.requestId, decision: "expired", decidedAt: now },
              callerId: "system",
            },
            now,
          );
        }
        return { approved: false, error: agentError("CONFIRMATION_EXPIRED", "The confirmation request has expired.") };
      }
      if (requested.request.immutablePayloadHash !== immutablePayloadHash) {
        return { approved: false, error: agentError("CONFIRMATION_REJECTED", "The action changed after confirmation was requested.") };
      }
      const decisionRow = this.decisionRow(confirmationId);
      if (!decisionRow) {
        return { approved: false, error: agentError("CONFIRMATION_REQUIRED", "Wait for a visible desktop confirmation before continuing.") };
      }
      const decisionSnapshot = this.readSnapshot<{ kind: "decision"; decision: ConfirmationDecision; callerId: string }>(decisionRow, "gui-confirmation-decision");
      if (decisionSnapshot.kind !== "decision" || decisionSnapshot.decision.decision !== "approved") {
        return { approved: false, error: agentError("CONFIRMATION_REJECTED", "The confirmation was not approved.") };
      }
      if (decisionSnapshot.callerId !== callerId) {
        return { approved: false, error: agentError("CONFIRMATION_REJECTED", "The approval was made by a different caller.") };
      }
      if (
        decisionSnapshot.decision.requestId !== requested.request.requestId
        || decisionSnapshot.decision.immutablePayloadHash !== requested.request.immutablePayloadHash
      ) {
        return { approved: false, error: agentError("CONFIRMATION_REJECTED", "The approval is not bound to the current immutable payload.") };
      }
      if (this.consumedRow(confirmationId)) {
        return { approved: false, error: agentError("CONFLICT", "The confirmation has already been used.") };
      }
      this.insertSnapshot(
        requested.request.id,
        requested.request.accountIds,
        requested.row.confirmation_token_hash,
        "consumed",
        "gui-confirmation-consumed",
        { kind: "consumed", confirmationId: requested.request.id, requestId: requested.request.requestId, callerId, consumedAt: now },
        now,
      );
      return { approved: true };
    });
  }
}
