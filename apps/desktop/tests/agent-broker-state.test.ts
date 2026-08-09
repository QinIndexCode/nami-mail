import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createBrokerPairingRecord,
  signBrokerRequest,
  verifyBrokerResponse,
  type BrokerPairingRecord,
} from "../src/agent/broker-protocol.mts";
import {
  brokerStatePath,
  clientProfilesPath,
  DesktopBrokerState,
  DesktopClientProfileStore,
  type BrokerHostIdentity,
  type DesktopSafeStorage,
} from "../src/agent/broker-state.mts";
import { DesktopAgentBrokerHost, probeDesktopBrokerLiveness } from "../src/agent/desktop-broker.mts";

const safeStorage: DesktopSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, "utf8"),
  decryptString: (cipherText) => cipherText.toString("utf8"),
};

const issuedAt = "2026-07-29T12:00:00.000Z";
const agentPipeScriptPath = fileURLToPath(new URL("../resources/nami-agent-pipe.ps1", import.meta.url));

type EncryptedEnvelope = {
  schemaVersion: number;
  encrypted: string;
};

type BrokerHostInternals = {
  state: DesktopBrokerState;
  identity: BrokerHostIdentity | undefined;
  bootId: string | undefined;
  acceptingRequests: boolean;
  handleRawRequest: (raw: string) => Promise<string>;
};

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nami-agent-broker-state-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function clientIdentity(clientId = "client-account-scope-0001") {
  const pair = generateKeyPairSync("ed25519");
  return {
    clientId,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function encryptedEnvelope(filePath: string): Promise<EncryptedEnvelope> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as EncryptedEnvelope;
}

async function decryptedBrokerState(directory: string): Promise<Record<string, unknown>> {
  const envelope = await encryptedEnvelope(brokerStatePath(directory));
  return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, "base64"))) as Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

test("persists an immutable approved account snapshot inside the protected Broker state", async () => {
  await withTemporaryDirectory(async (directory) => {
    const state = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    const client = clientIdentity();
    const approvedAccounts = ["account-1", "account-2"];

    const pairing = await state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: approvedAccounts,
    });
    approvedAccounts.push("account-3");

    assert.deepEqual(pairing.accountIds, ["account-1", "account-2"]);
    const stored = await state.read(client.clientId);
    assert.deepEqual(stored?.accountIds, ["account-1", "account-2"]);
    if (stored?.accountIds) (stored.accountIds as string[]).push("mutated-by-caller");
    assert.deepEqual((await state.read(client.clientId))?.accountIds, ["account-1", "account-2"]);

    const envelope = await encryptedEnvelope(brokerStatePath(directory));
    assert.deepEqual(Object.keys(envelope).sort(), ["encrypted", "schemaVersion"]);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal("pairings" in envelope, false);
    const plaintext = await decryptedBrokerState(directory);
    assert.deepEqual(
      ((plaintext.pairings as Array<{ accountIds?: readonly string[] }>)[0])?.accountIds,
      ["account-1", "account-2"],
    );
  });
});

test("new pairings carry a 90-day expiry and list() returns summaries", async () => {
  await withTemporaryDirectory(async (directory) => {
    const state = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    const client = clientIdentity();

    const pairing = await state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });
    const lifetime = Date.parse(pairing.expiresAt ?? "") - Date.parse(pairing.createdAt);
    assert.ok(lifetime >= 89 * 24 * 60 * 60 * 1_000 && lifetime <= 91 * 24 * 60 * 60 * 1_000, `unexpected pairing lifetime: ${lifetime}ms`);

    const all = await state.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.clientId, client.clientId);
    assert.equal(all[0]?.expiresAt, pairing.expiresAt);

    const reopened = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    const reloaded = await reopened.list();
    assert.equal(reloaded[0]?.expiresAt, pairing.expiresAt);
  });
});

test("revokes a Broker pairing and removes the corresponding protected client profile", async () => {
  await withTemporaryDirectory(async (directory) => {
    const brokerState = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    const profileStore = new DesktopClientProfileStore(clientProfilesPath(directory), safeStorage);
    const client = clientIdentity();
    const pairing = await brokerState.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });
    const pending = await profileStore.createPending("work");
    await profileStore.completePairing("work", {
      schemaVersion: 1,
      requestId: "123e4567-e89b-12d3-a456-426614174010",
      status: "approved",
      completedAt: issuedAt,
      hostId: pairing.hostId,
      hostPublicKeyPem: pairing.hostPublicKeyPem,
    });

    assert.equal((await profileStore.read("work"))?.pairedAt !== undefined, true);
    assert.equal(await brokerState.revoke(client.clientId, issuedAt), true);
    assert.equal((await brokerState.advanceCounter({
      clientId: client.clientId,
      expectedLastCounter: "0",
      nextCounter: "1",
    })).status, "revoked");
    assert.equal((await brokerState.read(client.clientId))?.revokedAt, issuedAt);
    assert.equal(await profileStore.remove("work"), true);
    assert.equal(await profileStore.read("work"), undefined);
    assert.equal(await profileStore.remove("work"), false);
    assert.notEqual(pending.clientId, "");
  });
});

test("fails closed when encrypted Broker persistence contains an unknown pairing field", async () => {
  await withTemporaryDirectory(async (directory) => {
    const state = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    const client = clientIdentity();
    await state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });
    const envelope = await encryptedEnvelope(brokerStatePath(directory));
    const plaintext = await decryptedBrokerState(directory);
    const pairings = plaintext.pairings as Array<Record<string, unknown>>;
    pairings[0]!.unexpected = "must not be accepted";
    envelope.encrypted = safeStorage.encryptString(JSON.stringify(plaintext)).toString("base64");
    await fs.writeFile(brokerStatePath(directory), JSON.stringify(envelope), "utf8");

    const reopened = new DesktopBrokerState(brokerStatePath(directory), safeStorage);
    await assert.rejects(reopened.hostIdentity(), (error: unknown) => errorCode(error) === "BROKER_SECURITY_UNAVAILABLE");
  });
});

test("denies a legacy pairing that has no approved account snapshot before invoking mail tools", async () => {
  await withTemporaryDirectory(async (directory) => {
    let externalToolCalls = 0;
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: path.join(directory, "unused-agent-pipe.ps1"),
      invokeExternalAgentTool: async () => {
        externalToolCalls += 1;
        throw new Error("A legacy pairing must not reach the external mail bridge.");
      },
    });
    const internals = host as unknown as BrokerHostInternals;
    const identity = await internals.state.hostIdentity();
    internals.identity = identity;
    internals.bootId = "boot-legacy-account-scope-0001";
    internals.acceptingRequests = true;
    const client = clientIdentity();
    const legacyPairing: BrokerPairingRecord = createBrokerPairingRecord({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      hostId: identity.hostId,
      hostPublicKeyPem: identity.publicKeyPem,
      scopes: ["mail-read"],
      createdAt: issuedAt,
    });
    await internals.state.save(legacyPairing);
    const requestId = "123e4567-e89b-12d3-a456-426614174011";
    const request = signBrokerRequest({
      requestId,
      hostId: identity.hostId,
      bootId: internals.bootId,
      clientId: client.clientId,
      counter: "1",
      payload: { entryPoint: "cli", command: "messages.list", arguments: {} },
      privateKey: client.privateKeyPem,
    });

    const response = JSON.parse(await internals.handleRawRequest(JSON.stringify(request))) as {
      payload: { success?: boolean; error?: { code?: string } };
    };
    const verified = verifyBrokerResponse(response, {
      pairing: legacyPairing,
      requestId,
      requestCounter: "1",
    });
    assert.equal(verified.ok, true);
    assert.equal(response.payload.success, false);
    assert.equal(response.payload.error?.code, "PAIRING_REQUIRED");
    assert.equal(externalToolCalls, 0);
    await host.close();
  });
});

test("a paired client can request host shutdown through host.shutdown", async () => {
  await withTemporaryDirectory(async (directory) => {
    let shutdownRequests = 0;
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: path.join(directory, "unused-agent-pipe.ps1"),
      invokeExternalAgentTool: async () => {
        throw new Error("host.shutdown must not invoke external mail tools.");
      },
      onHostShutdown: () => { shutdownRequests += 1; },
    });
    const internals = host as unknown as BrokerHostInternals;
    const identity = await internals.state.hostIdentity();
    internals.identity = identity;
    internals.bootId = "boot-host-shutdown-000001";
    internals.acceptingRequests = true;
    const client = clientIdentity();
    const pairing = await internals.state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });
    assert.equal(pairing.hostId, identity.hostId);
    const requestId = "123e4567-e89b-12d3-a456-426614174022";
    const request = signBrokerRequest({
      requestId,
      hostId: identity.hostId,
      bootId: internals.bootId,
      clientId: client.clientId,
      counter: "1",
      payload: { entryPoint: "cli", command: "host.shutdown", arguments: {} },
      privateKey: client.privateKeyPem,
    });

    const response = JSON.parse(await internals.handleRawRequest(JSON.stringify(request))) as {
      payload: { success?: boolean; data?: { status?: string } };
    };
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data?.status, "stopping");
    // The shutdown callback fires after the response is delivered.
    assert.equal(shutdownRequests, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(shutdownRequests, 1);
    await host.close();
  });
});

test("namimail doctor returns real diagnostics rows from a paired host", async () => {
  await withTemporaryDirectory(async (directory) => {
    let externalToolCalls = 0;
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: path.join(directory, "unused-agent-pipe.ps1"),
      invokeExternalAgentTool: async () => {
        externalToolCalls += 1;
        throw new Error("doctor must not invoke external mail tools.");
      },
    });
    const internals = host as unknown as BrokerHostInternals;
    const identity = await internals.state.hostIdentity();
    internals.identity = identity;
    internals.bootId = "boot-doctor-diagnostics-01";
    internals.acceptingRequests = true;
    const client = clientIdentity();
    const pairing = await internals.state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });
    const requestId = "123e4567-e89b-12d3-a456-426614174033";
    const request = signBrokerRequest({
      requestId,
      hostId: identity.hostId,
      bootId: internals.bootId,
      clientId: client.clientId,
      counter: "1",
      payload: { entryPoint: "cli", command: "doctor", arguments: {} },
      privateKey: client.privateKeyPem,
    });

    const response = JSON.parse(await internals.handleRawRequest(JSON.stringify(request))) as {
      payload: { success?: boolean; data?: Array<{ check: string; status: string; detail: string }> };
    };
    const verified = verifyBrokerResponse(response, {
      pairing,
      requestId,
      requestCounter: "1",
    });
    assert.equal(verified.ok, true);
    assert.equal(response.payload.success, true);
    const rows = response.payload.data;
    assert.ok(rows);
    const byCheck = new Map(rows.map((row) => [row.check, row]));
    assert.equal(byCheck.get("safe-storage")?.status, "ok");
    assert.equal(byCheck.get("broker-state")?.status, "ok");
    assert.equal(byCheck.get("pairings")?.status, "ok");
    assert.ok((byCheck.get("pairings")?.detail ?? "").includes("1 active"));
    assert.equal(byCheck.get("user-data")?.status, "ok");
    // The unit-test host never started a relay or published discovery.
    assert.equal(byCheck.get("discovery")?.status, "error");
    assert.equal(byCheck.get("agent-pipe")?.status, "error");
    assert.equal(externalToolCalls, 0);
    await host.close();
  });
});

test("namimail doctor reports active and revoked pairing counts", async () => {
  await withTemporaryDirectory(async (directory) => {
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: path.join(directory, "unused-agent-pipe.ps1"),
      invokeExternalAgentTool: async () => {
        throw new Error("doctor must not invoke external mail tools.");
      },
    });
    const internals = host as unknown as BrokerHostInternals;
    const identity = await internals.state.hostIdentity();
    internals.identity = identity;
    internals.bootId = "boot-doctor-unpaired-0001";
    internals.acceptingRequests = true;
    // One pairing stays active and signs the request; another is revoked.
    const activeClient = clientIdentity("client-active-0001");
    await internals.state.createReadOnlyPairing({
      clientId: activeClient.clientId,
      clientPublicKeyPem: activeClient.publicKeyPem,
      accountIds: ["account-1"],
    });
    const revokedClient = clientIdentity("client-revoked-0002");
    await internals.state.createReadOnlyPairing({
      clientId: revokedClient.clientId,
      clientPublicKeyPem: revokedClient.publicKeyPem,
      accountIds: ["account-2"],
    });
    await internals.state.revoke(revokedClient.clientId, issuedAt);
    const pairing = await internals.state.read(activeClient.clientId);
    assert.ok(pairing);
    const requestId = "123e4567-e89b-12d3-a456-426614174034";
    const request = signBrokerRequest({
      requestId,
      hostId: identity.hostId,
      bootId: internals.bootId,
      clientId: activeClient.clientId,
      counter: "1",
      payload: { entryPoint: "cli", command: "doctor", arguments: {} },
      privateKey: activeClient.privateKeyPem,
    });

    const response = JSON.parse(await internals.handleRawRequest(JSON.stringify(request))) as {
      payload: { success?: boolean; data?: Array<{ check: string; status: string; detail: string }> };
    };
    assert.equal(response.payload.success, true);
    const rows = response.payload.data;
    assert.ok(rows);
    const byCheck = new Map(rows.map((row) => [row.check, row]));
    assert.equal(byCheck.get("pairings")?.status, "ok");
    assert.ok((byCheck.get("pairings")?.detail ?? "").includes("1 active"));
    assert.ok((byCheck.get("pairings")?.detail ?? "").includes("1 revoked"));
    await host.close();
  });
});

test("Broker allow-list routes only declared external tools and rejects unknown commands", async () => {
  await withTemporaryDirectory(async (directory) => {
    const routed: Array<{ toolName: string }> = [];
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: path.join(directory, "unused-agent-pipe.ps1"),
      invokeExternalAgentTool: async (input) => {
        routed.push({ toolName: input.toolName });
        return {
          protocolVersion: "1.0",
          requestId: input.requestId,
          success: true,
          data: { tool: input.toolName },
          error: null,
          meta: { contractVersion: "1.0", durationMs: 0 },
        };
      },
    });
    const internals = host as unknown as BrokerHostInternals;
    const identity = await internals.state.hostIdentity();
    internals.identity = identity;
    internals.bootId = "boot-allow-list-guard-01";
    internals.acceptingRequests = true;
    const client = clientIdentity();
    await internals.state.createReadOnlyPairing({
      clientId: client.clientId,
      clientPublicKeyPem: client.publicKeyPem,
      accountIds: ["account-1"],
    });

    const send = async (command: string, counter: string, argumentsValue: unknown, entryPoint: "cli" | "mcp" = "mcp") => {
      const requestId = `123e4567-e89b-12d3-a456-42661417${counter.padStart(4, "0")}`;
      const request = signBrokerRequest({
        requestId,
        hostId: identity.hostId,
        bootId: internals.bootId,
        clientId: client.clientId,
        counter,
        payload: { entryPoint, command, arguments: argumentsValue as never },
        privateKey: client.privateKeyPem,
      });
      const response = JSON.parse(await internals.handleRawRequest(JSON.stringify(request))) as {
        payload: { success?: boolean; data?: { tool?: string }; error?: { code?: string } };
      };
      return { requestId, response };
    };

    const summarize = await send("mail.summarize", "1", { mailbox: "INBOX", limit: 10 });
    assert.equal(summarize.response.payload.success, true);
    assert.equal(summarize.response.payload.data?.tool, "mail.summarize");

    const move = await send("messages.move", "2", { messageId: "message-1", target: "archive" });
    assert.equal(move.response.payload.success, true);
    assert.equal(move.response.payload.data?.tool, "messages.move");

    const batchGet = await send("messages.batch_get", "3", { messageIds: ["message-1", "message-2"] }, "cli");
    assert.equal(batchGet.response.payload.success, true);
    assert.equal(batchGet.response.payload.data?.tool, "messages.batch_get");

    const unknown = await send("mail.search", "4", { query: "invoice" });
    assert.equal(unknown.response.payload.success, false);
    assert.equal(unknown.response.payload.error?.code, "NOT_SUPPORTED");

    const obsolete = await send("messages.search", "5", { query: "invoice" });
    assert.equal(obsolete.response.payload.success, false);
    assert.equal(obsolete.response.payload.error?.code, "NOT_SUPPORTED");

    assert.deepEqual(routed.map((entry) => entry.toolName), ["mail.summarize", "messages.move", "messages.batch_get"]);
    await host.close();
  });
});

test("desktop Broker liveness requires a signed response from the discovered host", {
  skip: process.platform !== "win32" ? "Requires Windows SID-DACL named pipes." : false,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const host = new DesktopAgentBrokerHost({
      userDataPath: directory,
      safeStorage,
      scriptPath: agentPipeScriptPath,
      invokeExternalAgentTool: async () => {
        throw new Error("The liveness probe must not invoke external mail tools.");
      },
    });
    const discovery = await host.start();
    try {
      assert.equal(await probeDesktopBrokerLiveness(directory), true);
    } finally {
      await host.close();
    }

    await fs.writeFile(
      path.join(directory, "agent-broker-discovery.json"),
      JSON.stringify(discovery),
      "utf8",
    );
    assert.equal(await probeDesktopBrokerLiveness(directory, 300), false);
  });
});
