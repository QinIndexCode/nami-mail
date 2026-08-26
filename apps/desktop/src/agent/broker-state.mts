import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createBrokerPairingRecord,
  isValidBrokerPairingRecord,
  type BrokerPairingRecord,
  type BrokerPairingStore,
  type BrokerPairingStoreAdvanceResult,
} from "./broker-protocol.mjs";
import { accountIdSchema } from "@nami/agent-contracts";
import { agentDesktopError } from "./contracts.mjs";

const schemaVersion = 1;
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const opaqueIdentifierPattern = /^[A-Za-z0-9_-]{16,160}$/;
const counterPattern = /^(0|[1-9]\d{0,18})$/;
const publicKeyPattern = /^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/;
const privateKeyPattern = /^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\r?\n?$/;

/** New pairings stay valid for 90 days; the user re-approves them afterwards. */
export const defaultPairingLifetimeMs = 90 * 24 * 60 * 60 * 1_000;

export type DesktopSafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (cipherText: Buffer) => string;
};

export type BrokerHostIdentity = {
  hostId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type BrokerClientProfile = {
  profile: string;
  clientId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  lastAcceptedCounter: string;
  createdAt: string;
  pairedAt?: string;
  hostId?: string;
  hostPublicKeyPem?: string;
};

export type PairingRequest = {
  schemaVersion: typeof schemaVersion;
  requestId: string;
  operation: "pair" | "revoke";
  profile: string;
  clientId: string;
  clientPublicKeyPem: string;
  requestedAt: string;
};

export type PairingOutcome = {
  schemaVersion: typeof schemaVersion;
  requestId: string;
  status: "approved" | "rejected" | "failed";
  completedAt: string;
  hostId?: string;
  hostPublicKeyPem?: string;
};

type BrokerState = {
  schemaVersion: typeof schemaVersion;
  host: BrokerHostIdentity;
  pairings: BrokerPairingRecord[];
};

export type BrokerStateDiagnostics = {
  pairingCount: number;
  activePairingCount: number;
  revokedPairingCount: number;
};

type ClientProfileState = {
  schemaVersion: typeof schemaVersion;
  profiles: Record<string, BrokerClientProfile>;
};

type SecretEnvelope = {
  schemaVersion: typeof schemaVersion;
  encrypted: string;
};

function now(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validOpaqueIdentifier(value: unknown): value is string {
  return typeof value === "string" && opaqueIdentifierPattern.test(value);
}

function validProfile(value: unknown): value is string {
  return typeof value === "string" && profilePattern.test(value);
}

function validPem(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && value.length >= 64 && value.length <= 16_384 && pattern.test(value) && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value); // eslint-disable-line no-control-regex -- control characters are rejected on purpose
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCounter(value: unknown): value is string {
  return typeof value === "string" && counterPattern.test(value);
}

function cloneProfile(value: BrokerClientProfile): BrokerClientProfile {
  return { ...value };
}

function clonePairing(value: BrokerPairingRecord): BrokerPairingRecord {
  return { ...value, scopes: [...value.scopes], ...(value.accountIds ? { accountIds: [...value.accountIds] } : {}) };
}

function validHostIdentity(value: unknown): value is BrokerHostIdentity {
  return isPlainObject(value)
    && validOpaqueIdentifier(value.hostId)
    && validPem(value.publicKeyPem, publicKeyPattern)
    && validPem(value.privateKeyPem, privateKeyPattern);
}

function validProfileRecord(value: unknown, profile?: string): value is BrokerClientProfile {
  return isPlainObject(value)
    && validProfile(value.profile)
    && (profile === undefined || value.profile === profile)
    && validOpaqueIdentifier(value.clientId)
    && validPem(value.publicKeyPem, publicKeyPattern)
    && validPem(value.privateKeyPem, privateKeyPattern)
    && validCounter(value.lastAcceptedCounter)
    && validTimestamp(value.createdAt)
    && (value.pairedAt === undefined || validTimestamp(value.pairedAt))
    && (value.hostId === undefined || validOpaqueIdentifier(value.hostId))
    && (value.hostPublicKeyPem === undefined || validPem(value.hostPublicKeyPem, publicKeyPattern));
}

function validBrokerState(value: unknown): value is BrokerState {
  return isPlainObject(value)
    && value.schemaVersion === schemaVersion
    && validHostIdentity(value.host)
    && Array.isArray(value.pairings)
    && value.pairings.every(isValidBrokerPairingRecord)
    && new Set(value.pairings.map((pairing) => pairing.clientId)).size === value.pairings.length;
}

function validClientProfileState(value: unknown): value is ClientProfileState {
  return isPlainObject(value)
    && value.schemaVersion === schemaVersion
    && isPlainObject(value.profiles)
    && Object.entries(value.profiles).every(([profile, record]) => validProfileRecord(record, profile));
}

function generatedIdentity(prefix: "host" | "client"): BrokerHostIdentity | Pick<BrokerClientProfile, "clientId" | "publicKeyPem" | "privateKeyPem"> {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const id = `${prefix}-${randomBytes(18).toString("base64url")}`;
  return prefix === "host"
    ? { hostId: id, publicKeyPem, privateKeyPem }
    : { clientId: id, publicKeyPem, privateKeyPem };
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

class EncryptedJsonFile<T> {
  private value: T | undefined;
  private initializePromise: Promise<T> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: DesktopSafeStorage,
    private readonly isValid: (value: unknown) => value is T,
    private readonly create: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.value) return this.value;
    if (!this.initializePromise) this.initializePromise = this.load();
    return this.initializePromise;
  }

  async mutate<TResult>(operation: (value: T) => TResult | Promise<TResult>): Promise<TResult> {
    const run = async () => {
      const value = await this.read();
      const result = await operation(value);
      await this.persist(value);
      return result;
    };
    const pending = this.writeTail.then(run);
    this.writeTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async load(): Promise<T> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw agentDesktopError(
        "BROKER_SECURITY_UNAVAILABLE",
        "NamiMail cannot protect external Agent pairing material on this Windows account.",
      );
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      if (!isPlainObject(parsed) || parsed.schemaVersion !== schemaVersion || typeof parsed.encrypted !== "string") {
        throw new Error("invalid envelope");
      }
      const plaintext = this.safeStorage.decryptString(Buffer.from(parsed.encrypted, "base64"));
      const value = JSON.parse(plaintext) as unknown;
      if (!this.isValid(value)) throw new Error("invalid state");
      this.value = value;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw agentDesktopError(
          "BROKER_SECURITY_UNAVAILABLE",
          "NamiMail could not read protected external Agent pairing material.",
          false,
          "Remove only the NamiMail Agent pairing state and pair clients again.",
        );
      }
      const value = this.create();
      this.value = value;
      await this.persist(value);
      return value;
    }
  }

  private async persist(value: T): Promise<void> {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw agentDesktopError("BROKER_SECURITY_UNAVAILABLE", "NamiMail cannot protect external Agent pairing material on this Windows account.");
    }
    const encrypted = this.safeStorage.encryptString(JSON.stringify(value)).toString("base64");
    const envelope: SecretEnvelope = { schemaVersion, encrypted };
    await writeAtomically(this.filePath, JSON.stringify(envelope));
  }
}

/** Durable, DPAPI-protected pairing registry used only by the desktop Broker. */
export class DesktopBrokerState implements BrokerPairingStore {
  private readonly file: EncryptedJsonFile<BrokerState>;

  constructor(filePath: string, safeStorage: DesktopSafeStorage) {
    this.file = new EncryptedJsonFile(filePath, safeStorage, validBrokerState, () => ({
      schemaVersion,
      host: generatedIdentity("host") as BrokerHostIdentity,
      pairings: [],
    }));
  }

  async hostIdentity(): Promise<BrokerHostIdentity> {
    const state = await this.file.read();
    return { ...state.host };
  }

  /** Summarizes protected pairings for `namimail doctor` without exposing keys or counters. */
  async diagnostics(): Promise<BrokerStateDiagnostics> {
    const state = await this.file.read();
    let activePairingCount = 0;
    let revokedPairingCount = 0;
    for (const pairing of state.pairings) {
      if (pairing.revokedAt) revokedPairingCount += 1;
      else activePairingCount += 1;
    }
    return {
      pairingCount: state.pairings.length,
      activePairingCount,
      revokedPairingCount,
    };
  }

  async read(clientId: string): Promise<BrokerPairingRecord | undefined> {
    const state = await this.file.read();
    const pairing = state.pairings.find((entry) => entry.clientId === clientId);
    return pairing ? clonePairing(pairing) : undefined;
  }

  async save(record: BrokerPairingRecord): Promise<void> {
    if (!isValidBrokerPairingRecord(record)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing record is invalid.");
    }
    await this.file.mutate((state) => {
      const index = state.pairings.findIndex((entry) => entry.clientId === record.clientId);
      if (index === -1) state.pairings.push(clonePairing(record));
      else state.pairings[index] = clonePairing(record);
    });
  }

  async revoke(clientId: string, revokedAt: string): Promise<boolean> {
    if (!validOpaqueIdentifier(clientId) || !validTimestamp(revokedAt)) return false;
    return this.file.mutate((state) => {
      const pairing = state.pairings.find((entry) => entry.clientId === clientId);
      if (!pairing) return false;
      pairing.revokedAt = revokedAt;
      return true;
    });
  }

  async list(): Promise<BrokerPairingRecord[]> {
    const state = await this.file.read();
    return state.pairings.map(clonePairing);
  }

  async advanceCounter(input: {
    clientId: string;
    expectedLastCounter: string;
    nextCounter: string;
  }): Promise<BrokerPairingStoreAdvanceResult> {
    return this.file.mutate((state) => {
      const pairing = state.pairings.find((entry) => entry.clientId === input.clientId);
      if (!pairing) return { status: "missing" };
      if (pairing.revokedAt) return { status: "revoked" };
      if (pairing.lastAcceptedCounter !== input.expectedLastCounter) {
        return { status: "counter-conflict", lastAcceptedCounter: pairing.lastAcceptedCounter };
      }
      const expectedNext = BigInt(input.expectedLastCounter) + 1n;
      if (!validCounter(input.nextCounter) || BigInt(input.nextCounter) !== expectedNext) {
        return { status: "counter-conflict", lastAcceptedCounter: pairing.lastAcceptedCounter };
      }
      pairing.lastAcceptedCounter = input.nextCounter;
      return { status: "advanced" };
    });
  }

  async createReadOnlyPairing(input: { clientId: string; clientPublicKeyPem: string; accountIds: readonly string[] }): Promise<BrokerPairingRecord> {
    const host = await this.hostIdentity();
    if (
      !validOpaqueIdentifier(input.clientId)
      || !validPem(input.clientPublicKeyPem, publicKeyPattern)
      || input.accountIds.length === 0
      || input.accountIds.length > 100
      || new Set(input.accountIds).size !== input.accountIds.length
      || !input.accountIds.every((accountId) => accountIdSchema.safeParse(accountId).success)
    ) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing request is invalid.");
    }
    const record = createBrokerPairingRecord({
      clientId: input.clientId,
      clientPublicKeyPem: input.clientPublicKeyPem,
      hostId: host.hostId,
      hostPublicKeyPem: host.publicKeyPem,
      scopes: ["mail-read"],
      accountIds: [...input.accountIds],
      createdAt: now(),
      expiresAt: new Date(Date.now() + defaultPairingLifetimeMs).toISOString(),
    });
    await this.save(record);
    return record;
  }
}

/** DPAPI-protected per-profile client identity used by the managed launcher. */
export class DesktopClientProfileStore {
  private readonly file: EncryptedJsonFile<ClientProfileState>;

  constructor(filePath: string, safeStorage: DesktopSafeStorage) {
    this.file = new EncryptedJsonFile(filePath, safeStorage, validClientProfileState, () => ({ schemaVersion, profiles: {} }));
  }

  async read(profile: string): Promise<BrokerClientProfile | undefined> {
    if (!validProfile(profile)) return undefined;
    const state = await this.file.read();
    const value = state.profiles[profile];
    return value ? cloneProfile(value) : undefined;
  }

  async createPending(profile: string): Promise<BrokerClientProfile> {
    if (!validProfile(profile)) throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent profile name is invalid.");
    return this.file.mutate((state) => {
      const existing = state.profiles[profile];
      if (existing?.pairedAt) {
        throw agentDesktopError(
          "CONFLICT",
          "This NamiMail Agent profile is already paired.",
          false,
          "Use a different profile name or revoke the existing profile in NamiMail first.",
        );
      }
      const identity = generatedIdentity("client") as Pick<BrokerClientProfile, "clientId" | "publicKeyPem" | "privateKeyPem">;
      const value: BrokerClientProfile = {
        profile,
        ...identity,
        lastAcceptedCounter: "0",
        createdAt: now(),
      };
      state.profiles[profile] = value;
      return cloneProfile(value);
    });
  }

  async completePairing(profile: string, outcome: PairingOutcome & { status: "approved" }): Promise<BrokerClientProfile> {
    if (!validProfile(profile) || !validOpaqueIdentifier(outcome.hostId) || !validPem(outcome.hostPublicKeyPem, publicKeyPattern)) {
      throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing response is invalid.");
    }
    return this.file.mutate((state) => {
      const current = state.profiles[profile];
      if (!current) throw agentDesktopError("PAIRING_REQUIRED", "The pending NamiMail Agent client profile is unavailable.");
      current.hostId = outcome.hostId;
      current.hostPublicKeyPem = outcome.hostPublicKeyPem;
      current.pairedAt = now();
      current.lastAcceptedCounter = "0";
      return cloneProfile(current);
    });
  }

  async advanceCounter(profile: string, expectedLastCounter: string, nextCounter: string): Promise<void> {
    await this.file.mutate((state) => {
      const current = state.profiles[profile];
      if (!current || current.lastAcceptedCounter !== expectedLastCounter || !validCounter(nextCounter)) {
        throw agentDesktopError("BROKER_REPLAY_DETECTED", "The NamiMail Agent client counter is no longer current.");
      }
      current.lastAcceptedCounter = nextCounter;
    });
  }

  async remove(profile: string): Promise<boolean> {
    if (!validProfile(profile)) return false;
    return this.file.mutate((state) => {
      if (!state.profiles[profile]) return false;
      delete state.profiles[profile];
      return true;
    });
  }
}

function pairingDirectory(root: string): string {
  return path.join(root, "agent-pairing");
}

function pairingPath(root: string, requestId: string, kind: "request" | "outcome"): string {
  if (!validOpaqueIdentifier(requestId)) throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing request identifier is invalid.");
  return path.join(pairingDirectory(root), `${kind}-${requestId}.json`);
}

function validPairingRequest(value: unknown): value is PairingRequest {
  return isPlainObject(value)
    && value.schemaVersion === schemaVersion
    && validOpaqueIdentifier(value.requestId)
    && (value.operation === "pair" || value.operation === "revoke")
    && validProfile(value.profile)
    && validOpaqueIdentifier(value.clientId)
    && validPem(value.clientPublicKeyPem, publicKeyPattern)
    && validTimestamp(value.requestedAt);
}

function validPairingOutcome(value: unknown): value is PairingOutcome {
  return isPlainObject(value)
    && value.schemaVersion === schemaVersion
    && validOpaqueIdentifier(value.requestId)
    && (value.status === "approved" || value.status === "rejected" || value.status === "failed")
    && validTimestamp(value.completedAt)
    && (value.hostId === undefined || validOpaqueIdentifier(value.hostId))
    && (value.hostPublicKeyPem === undefined || validPem(value.hostPublicKeyPem, publicKeyPattern))
    && (value.status !== "approved" || (validOpaqueIdentifier(value.hostId) && validPem(value.hostPublicKeyPem, publicKeyPattern)));
}

export async function writePairingRequest(
  root: string,
  input: Omit<PairingRequest, "schemaVersion" | "requestId" | "requestedAt" | "operation"> & { operation?: PairingRequest["operation"] },
): Promise<PairingRequest> {
  if (!validProfile(input.profile) || !validOpaqueIdentifier(input.clientId) || !validPem(input.clientPublicKeyPem, publicKeyPattern)) {
    throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing request is invalid.");
  }
  const request: PairingRequest = {
    schemaVersion,
    requestId: randomUUID(),
    operation: input.operation ?? "pair",
    profile: input.profile,
    clientId: input.clientId,
    clientPublicKeyPem: input.clientPublicKeyPem,
    requestedAt: now(),
  };
  await writeAtomically(pairingPath(root, request.requestId, "request"), JSON.stringify(request));
  return request;
}

export async function readPairingRequest(root: string, requestId: string): Promise<PairingRequest | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(pairingPath(root, requestId, "request"), "utf8")) as unknown;
    return validPairingRequest(value) && value.requestId === requestId ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writePairingOutcome(root: string, input: Omit<PairingOutcome, "schemaVersion" | "completedAt">): Promise<PairingOutcome> {
  const outcome: PairingOutcome = { schemaVersion, ...input, completedAt: now() };
  if (!validPairingOutcome(outcome)) throw agentDesktopError("INVALID_ARGUMENT", "The NamiMail Agent pairing outcome is invalid.");
  await writeAtomically(pairingPath(root, outcome.requestId, "outcome"), JSON.stringify(outcome));
  return outcome;
}

export async function readPairingOutcome(root: string, requestId: string): Promise<PairingOutcome | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(pairingPath(root, requestId, "outcome"), "utf8")) as unknown;
    return validPairingOutcome(value) && value.requestId === requestId ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function removePairingExchange(root: string, requestId: string): Promise<void> {
  await Promise.all([
    fs.unlink(pairingPath(root, requestId, "request")).catch(() => undefined),
    fs.unlink(pairingPath(root, requestId, "outcome")).catch(() => undefined),
  ]);
}

export function brokerStatePath(userDataPath: string): string {
  return path.join(userDataPath, "agent-broker-state.json");
}

export function clientProfilesPath(userDataPath: string): string {
  return path.join(userDataPath, "agent-client-profiles.json");
}

export function isValidAgentProfile(value: unknown): value is string {
  return validProfile(value);
}
