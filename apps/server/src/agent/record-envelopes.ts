import { AccountLifecycleStore, type AccountGenerationLease } from "./lifecycle.js";
import {
  canonicalAgentJson,
  decryptMultiAccountAgentRecord,
  decryptRootAgentRecord,
  encryptMultiAccountAgentRecord,
  encryptRootAgentRecord,
  type AccountEnvelopeScope,
  type EncryptedAccountEnvelope,
} from "./store-crypto.js";

type RootEnvelope = {
  format: "nami-agent-root-envelope-v1";
  encryptedPayload: string;
};

type AccountEnvelope = {
  format: "nami-agent-account-envelope-v1";
  envelopes: EncryptedAccountEnvelope[];
};

type PersistedEnvelope = RootEnvelope | AccountEnvelope;

function accountScopes(lifecycle: AccountLifecycleStore, accountIds: readonly string[]): AccountEnvelopeScope[] {
  const unique = [...new Set(accountIds)].sort();
  if (unique.length !== accountIds.length) throw new Error("Agent record account scope contains duplicates.");
  const scopes: AccountEnvelopeScope[] = [];
  try {
    for (const accountId of unique) {
      const lease = lifecycle.acquireLease(accountId);
      scopes.push({
        accountId: lease.accountId,
        generation: lease.generation,
        accountDek: lifecycle.accountDataKey(lease),
      });
    }
    return scopes;
  } catch (error) {
    zero(scopes);
    throw error;
  }
}

function zero(scopes: readonly AccountEnvelopeScope[]): void {
  for (const scope of scopes) scope.accountDek.fill(0);
}

/**
 * Serializes only ciphertext. Account-scoped envelopes require every source
 * account to remain available during decryption; an account deletion therefore
 * fails closed for audit and confirmation records as well as conversations.
 */
export function encryptPersistentAgentRecord(
  masterKey: Buffer,
  lifecycle: AccountLifecycleStore,
  accountIds: readonly string[],
  recordType: string,
  recordId: string,
  value: unknown,
): string {
  const plaintext = canonicalAgentJson(value);
  if (!accountIds.length) {
    return JSON.stringify({
      format: "nami-agent-root-envelope-v1",
      encryptedPayload: encryptRootAgentRecord(masterKey, recordType, recordId, plaintext),
    } satisfies RootEnvelope);
  }
  const scopes = accountScopes(lifecycle, accountIds);
  try {
    return JSON.stringify({
      format: "nami-agent-account-envelope-v1",
      envelopes: encryptMultiAccountAgentRecord(scopes, recordType, recordId, plaintext),
    } satisfies AccountEnvelope);
  } finally {
    zero(scopes);
  }
}

function parseEnvelope(value: string): PersistedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Encrypted Agent record envelope is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Encrypted Agent record envelope is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.format === "nami-agent-root-envelope-v1" && typeof record.encryptedPayload === "string") {
    return { format: record.format, encryptedPayload: record.encryptedPayload };
  }
  if (record.format === "nami-agent-account-envelope-v1" && Array.isArray(record.envelopes)) {
    const envelopes = record.envelopes.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const envelope = candidate as Record<string, unknown>;
      const generation = envelope.generation;
      if (
        typeof envelope.accountId !== "string"
        || typeof generation !== "number"
        || !Number.isSafeInteger(generation)
        || typeof envelope.encryptedPayload !== "string"
        || typeof envelope.cryptoVersion !== "number"
      ) return [];
      return [{
        accountId: envelope.accountId,
        generation,
        encryptedPayload: envelope.encryptedPayload,
        cryptoVersion: envelope.cryptoVersion,
      } satisfies EncryptedAccountEnvelope];
    });
    if (!envelopes.length || envelopes.length !== record.envelopes.length) {
      throw new Error("Encrypted Agent record envelope is invalid.");
    }
    return { format: record.format, envelopes };
  }
  throw new Error("Encrypted Agent record envelope is invalid.");
}

export function decryptPersistentAgentRecord(
  masterKey: Buffer,
  lifecycle: AccountLifecycleStore,
  recordType: string,
  recordId: string,
  encryptedEnvelope: string,
): unknown {
  const envelope = parseEnvelope(encryptedEnvelope);
  const plaintext = envelope.format === "nami-agent-root-envelope-v1"
    ? decryptRootAgentRecord(masterKey, recordType, recordId, envelope.encryptedPayload)
    : decryptMultiAccountAgentRecord(envelope.envelopes, recordType, recordId, (accountId, generation) => {
      const lease: AccountGenerationLease = { accountId, generation };
      lifecycle.assertCurrent(lease);
      return lifecycle.accountDataKey(lease);
    });
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new Error("Decrypted Agent record is invalid.");
  }
}
