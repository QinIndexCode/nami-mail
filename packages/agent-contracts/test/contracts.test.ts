import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  AGENT_CONTRACT_VERSION,
  AGENT_PROTOCOL_VERSION,
  BROKER_PROTOCOL_VERSION,
  agentConfirmationActions,
  agentPermissionScopes,
  agentResponseEnvelopeSchema,
  agentSourceEventSchema,
  agentStreamEventSchema,
  agentUiStreamEventSchema,
  brokerRequestEnvelopeSchema,
  brokerResponseEnvelopeSchema,
  confirmationDecisionSchema,
  createAgentFailureEnvelope,
  createAgentSuccessEnvelope,
} from "../src/index.js";

const timestamp = "2026-07-27T12:00:00.000Z";
const requestId = "1a1fba7f-3e8d-4db5-a2f7-9f06d01cb2d9";

test("versioned response envelopes keep success and failure shapes distinct", () => {
  const schema = agentResponseEnvelopeSchema(z.object({ value: z.string() }).strict());
  const success = createAgentSuccessEnvelope({
    requestId,
    data: { value: "ready" },
    meta: { durationMs: 7 },
  });
  const failure = createAgentFailureEnvelope({
    requestId,
    error: {
      code: "NOT_SUPPORTED",
      message: "Embedding is not supported by this host.",
      retryable: false,
    },
  });

  assert.equal(success.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.equal(success.meta.contractVersion, AGENT_CONTRACT_VERSION);
  assert.equal(schema.safeParse(success).success, true);
  assert.equal(schema.safeParse(failure).success, true);
  assert.equal(schema.safeParse({ ...success, error: failure.error }).success, false);
});

test("approved confirmations must bind the immutable payload", () => {
  const common = {
    confirmationId: "confirm_1",
    requestId,
    decidedAt: timestamp,
  };

  assert.equal(confirmationDecisionSchema.safeParse({ ...common, decision: "approved" }).success, false);
  assert.equal(confirmationDecisionSchema.safeParse({
    ...common,
    decision: "approved",
    immutablePayloadHash: "a".repeat(64),
  }).success, true);
  assert.equal(confirmationDecisionSchema.safeParse({ ...common, decision: "rejected" }).success, true);
});

test("source events distinguish account lifecycle events from message events", () => {
  const base = {
    eventId: "source_1",
    accountId: "account_1",
    accountGeneration: 2,
    revision: 9,
    occurredAt: timestamp,
  };

  assert.equal(agentSourceEventSchema.safeParse({
    ...base,
    type: "message-upserted",
    source: { kind: "message", messageId: "message_1" },
  }).success, true);
  assert.equal(agentSourceEventSchema.safeParse({ ...base, type: "message-deleted" }).success, false);
  assert.equal(agentSourceEventSchema.safeParse({ ...base, type: "account-deleted" }).success, true);
  assert.equal(agentSourceEventSchema.safeParse({
    ...base,
    type: "account-deleted",
    source: { kind: "message", messageId: "message_1" },
  }).success, false);
});

test("broker frames bind client, host, boot and decimal counters before signature verification", () => {
  const schema = brokerRequestEnvelopeSchema(z.object({ requested: z.literal("status") }).strict());
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(64)}\n-----END PUBLIC KEY-----\n`;
  const request = {
    type: "request",
    protocolVersion: BROKER_PROTOCOL_VERSION,
    requestId,
    hostId: "host_identity_0001",
    bootId: "boot_identity_0001",
    clientId: "client_identity_01",
    counter: "0",
    payload: { requested: "status" },
    signature: "signature_value",
  };

  assert.equal(schema.safeParse(request).success, true);
  assert.equal(schema.safeParse({ ...request, counter: "01" }).success, false);
  assert.equal(schema.safeParse({ ...request, counter: "9223372036854775808" }).success, false);
  assert.equal(schema.safeParse({ ...request, bootId: "other_boot_identity" }).success, true);

  const responseSchema = brokerResponseEnvelopeSchema(z.object({ ready: z.boolean() }).strict());
  assert.equal(responseSchema.safeParse({
    type: "response",
    protocolVersion: BROKER_PROTOCOL_VERSION,
    requestId,
    requestCounter: "0",
    hostIdentity: {
      protocolVersion: BROKER_PROTOCOL_VERSION,
      hostId: request.hostId,
      bootId: request.bootId,
      publicKeyPem,
      issuedAt: timestamp,
      signature: "host_proof_signature",
    },
    payload: { ready: true },
    signature: "response_signature",
  }).success, true);
});

test("stream events carry bounded memory suggestions", () => {
  const base = { eventId: "event_1", requestId, sequence: 0, emittedAt: timestamp };
  assert.equal(agentStreamEventSchema.safeParse({ ...base, type: "memory_suggestion", summary: "User prefers concise English replies" }).success, true);
  assert.equal(agentStreamEventSchema.safeParse({ ...base, type: "memory_suggestion", summary: "" }).success, false);
  assert.equal(agentStreamEventSchema.safeParse({ ...base, type: "memory_suggestion", summary: "x", extra: true }).success, false);
  assert.equal(agentStreamEventSchema.safeParse({ ...base, type: "memory_suggestion" }).success, false);
});

test("account deletion is an explicit confirmation action with a manage scope", () => {
  assert.ok(agentConfirmationActions.includes("delete-account" as (typeof agentConfirmationActions)[number]));
  assert.ok(agentPermissionScopes.includes("manage:accounts" as (typeof agentPermissionScopes)[number]));
});

test("UI stream schema accepts every event variant of the server/web wire vocabulary", () => {
  const citation = {
    id: "c1", messageId: "m1", accountId: "a1", subject: "Hello", sender: "s@example.test",
    sentAt: timestamp, excerpt: "Preview", confidence: 0.8,
  };
  const activity = { id: "t1", toolName: "mail.draft.create", title: "Create draft", state: "running", summary: "Almost done" };
  const confirmation = {
    id: "k1", title: "Send draft?", summary: "One message ready", expiresAt: "2030-07-27T12:00:00.000Z",
    fields: [{ label: "To", value: "s@example.test" }], state: "pending",
  };
  const events = [
    { type: "status" },
    { type: "status", message: "Preparing context" },
    { type: "text_delta", delta: "Hello" },
    { type: "citation", citation },
    { type: "tool", activity },
    { type: "confirmation", confirmation },
    { type: "memory_suggestion", summary: "User prefers concise replies" },
    { type: "title", title: "Review draft" },
    { type: "error", error: { code: "PROVIDER_TIMEOUT", message: "Timed out", suggestion: "Retry", retryable: true } },
    { type: "completed", reason: "stop" },
    { type: "completed", reason: "length" },
    { type: "completed", reason: "cancelled" },
    { type: "completed", reason: "error" },
  ];
  for (const event of events) {
    assert.equal(agentUiStreamEventSchema.safeParse(event).success, true, JSON.stringify(event));
  }
});

test("UI stream schema rejects malformed events", () => {
  const cases = [
    { type: "unknown_variant" },
    { type: "text_delta" },
    { type: "text_delta", delta: 42 },
    { type: "completed", reason: "banana" },
    { type: "completed", reason: "stop", extra: true },
    { type: "tool", activity: { id: "t1", toolName: "x", title: "y", state: "weird" } },
    { type: "citation", citation: { id: "c1", messageId: "m1", accountId: "a1", subject: "s", sender: "q", sentAt: timestamp, excerpt: "e", confidence: "high" } },
    { type: "confirmation", confirmation: { id: "k1", title: "t", summary: "s", expiresAt: timestamp, fields: "nope", state: "pending" } },
    { type: "error", error: { code: "X" } },
    { type: "memory_suggestion" },
    { type: "title" },
    null,
    [],
    "completed",
  ];
  for (const event of cases) {
    assert.equal(agentUiStreamEventSchema.safeParse(event).success, false, JSON.stringify(event));
  }
});
