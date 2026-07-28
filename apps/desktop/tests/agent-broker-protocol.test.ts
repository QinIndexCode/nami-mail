import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createBrokerPairingRecord,
  createHostIdentityProof,
  InMemoryBrokerPairingStore,
  signBrokerRequest,
  signBrokerResponse,
  verifyBrokerRequest,
  verifyBrokerResponse,
} from "../src/agent/broker-protocol.mts";

const hostId = "host-identity-0001";
const bootId = "boot-identity-0001";
const clientId = "client-identity-01";
const issuedAt = "2026-07-27T10:00:00.000Z";

function createFixture() {
  const host = generateKeyPairSync("ed25519");
  const client = generateKeyPairSync("ed25519");
  const hostPublicKeyPem = host.publicKey.export({ type: "spki", format: "pem" }).toString();
  const clientPublicKeyPem = client.publicKey.export({ type: "spki", format: "pem" }).toString();
  const pairing = createBrokerPairingRecord({
    clientId,
    clientPublicKeyPem,
    hostId,
    hostPublicKeyPem,
    scopes: ["read-only"],
    createdAt: issuedAt,
  });
  return { host, client, hostPublicKeyPem, pairing };
}

test("accepts a signed request once and persists the accepted counter", async () => {
  const { client, pairing, hostPublicKeyPem } = createFixture();
  const store = new InMemoryBrokerPairingStore();
  await store.save(pairing);
  const request = signBrokerRequest({
    requestId: "123e4567-e89b-12d3-a456-426614174000",
    hostId,
    bootId,
    clientId,
    counter: "1",
    payload: { command: "messages.list" },
    privateKey: client.privateKey,
  });

  const result = await verifyBrokerRequest(request, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(result.ok, true);
  assert.equal((await store.read(clientId))?.lastAcceptedCounter, "1");

  const replay = await verifyBrokerRequest(request, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.equal(replay.error.code, "BROKER_REPLAY_DETECTED");
});

test("rejects ambiguous pairing scopes before they can reach persistent storage", () => {
  const { hostPublicKeyPem, pairing } = createFixture();
  assert.throws(
    () => createBrokerPairingRecord({
      ...pairing,
      hostPublicKeyPem,
      scopes: ["read-only", "read-only"],
    }),
    /pairing record is not valid/i,
  );
});

test("rejects a request with a wrong host boot identity before a pairing mutation", async () => {
  const { client, pairing, hostPublicKeyPem } = createFixture();
  const store = new InMemoryBrokerPairingStore();
  await store.save(pairing);
  const request = signBrokerRequest({
    requestId: "123e4567-e89b-12d3-a456-426614174001",
    hostId,
    bootId: "other-boot-identity",
    clientId,
    counter: "1",
    payload: { command: "messages.list" },
    privateKey: client.privateKey,
  });
  const result = await verifyBrokerRequest(request, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BROKER_AUTHENTICATION_FAILED");
  assert.equal((await store.read(clientId))?.lastAcceptedCounter, "0");
});

test("rejects a pairing record that is bound to another host public key", async () => {
  const { client, pairing, hostPublicKeyPem } = createFixture();
  const otherHost = generateKeyPairSync("ed25519");
  const store = new InMemoryBrokerPairingStore();
  await store.save({
    ...pairing,
    hostPublicKeyPem: otherHost.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const request = signBrokerRequest({
    requestId: "123e4567-e89b-12d3-a456-426614174004",
    hostId,
    bootId,
    clientId,
    counter: "1",
    payload: { command: "messages.list" },
    privateKey: client.privateKey,
  });
  const result = await verifyBrokerRequest(request, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BROKER_AUTHENTICATION_FAILED");
  assert.equal((await store.read(clientId))?.lastAcceptedCounter, "0");
});

test("rejects revoked clients and tampered request bodies", async () => {
  const { client, pairing, hostPublicKeyPem } = createFixture();
  const store = new InMemoryBrokerPairingStore();
  await store.save(pairing);
  const request = signBrokerRequest({
    requestId: "123e4567-e89b-12d3-a456-426614174002",
    hostId,
    bootId,
    clientId,
    counter: "1",
    payload: { command: "messages.list" },
    privateKey: client.privateKey,
  });
  const tampered = { ...request, payload: { command: "messages.get" } };
  const rejectedTamper = await verifyBrokerRequest(tampered, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(rejectedTamper.ok, false);
  if (!rejectedTamper.ok) assert.equal(rejectedTamper.error.code, "BROKER_AUTHENTICATION_FAILED");

  assert.equal(await store.revoke(clientId, "2026-07-27T10:01:00.000Z"), true);
  const rejectedRevocation = await verifyBrokerRequest(request, { pairingStore: store, hostId, bootId, hostPublicKeyPem });
  assert.equal(rejectedRevocation.ok, false);
  if (!rejectedRevocation.ok) assert.equal(rejectedRevocation.error.code, "PAIRING_REVOKED");
});

test("validates the signed host identity and response binding on a client", () => {
  const { host, hostPublicKeyPem, pairing } = createFixture();
  const hostIdentity = createHostIdentityProof({
    hostId,
    bootId,
    publicKeyPem: hostPublicKeyPem,
    issuedAt,
    privateKey: host.privateKey,
  });
  const response = signBrokerResponse({
    requestId: "123e4567-e89b-12d3-a456-426614174005",
    requestCounter: "1",
    hostIdentity,
    payload: { messages: 3 },
    privateKey: host.privateKey,
  });
  const verified = verifyBrokerResponse(response, {
    pairing,
    requestId: response.requestId,
    requestCounter: "1",
  });
  assert.equal(verified.ok, true);

  const tampered = { ...response, requestCounter: "2" };
  const rejected = verifyBrokerResponse(tampered, {
    pairing,
    requestId: response.requestId,
    requestCounter: "2",
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "BROKER_AUTHENTICATION_FAILED");
});
