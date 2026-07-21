import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildApp: vi.fn(),
  cleanupExpiredOutboundAttachments: vi.fn(),
  config: {
    databasePath: ":memory:",
    host: "127.0.0.1",
    masterKeyPath: "master.key",
    microsoftOAuthClientId: undefined as string | undefined,
    port: 0,
    syncMessageLimit: 10,
  },
  getAppSettings: vi.fn(),
  loadOrCreateMasterKey: vi.fn(),
  migrateAccountCredentialStorage: vi.fn(),
  migrateKnownProviderUsernameCredentials: vi.fn(),
  openDatabase: vi.fn(),
  outboundAttachmentDirectory: vi.fn(),
  syncAccount: vi.fn(),
  updateAppSettings: vi.fn(),
}));

vi.mock("../src/account-credentials.js", () => ({
  migrateAccountCredentialStorage: mocks.migrateAccountCredentialStorage,
  migrateKnownProviderUsernameCredentials: mocks.migrateKnownProviderUsernameCredentials,
}));
vi.mock("../src/app.js", () => ({ buildApp: mocks.buildApp }));
vi.mock("../src/config.js", () => ({ config: mocks.config }));
vi.mock("../src/crypto.js", () => ({ loadOrCreateMasterKey: mocks.loadOrCreateMasterKey }));
vi.mock("../src/db.js", () => ({ openDatabase: mocks.openDatabase }));
vi.mock("../src/outbound-attachments.js", () => ({
  cleanupExpiredOutboundAttachments: mocks.cleanupExpiredOutboundAttachments,
  outboundAttachmentDirectory: mocks.outboundAttachmentDirectory,
}));
vi.mock("../src/settings.js", () => ({
  getAppSettings: mocks.getAppSettings,
  updateAppSettings: mocks.updateAppSettings,
}));
vi.mock("../src/sync.js", () => ({ syncAccount: mocks.syncAccount }));

import { startServer } from "../src/runtime.js";

function listenOnIpv6Loopback(): Promise<Server> {
  const blocker = createServer();
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      blocker.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      blocker.off("error", onError);
      resolve(blocker);
    };
    blocker.once("error", onError);
    blocker.once("listening", onListening);
    blocker.listen({ host: "::1", ipv6Only: true, port: 0 });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe("server runtime shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.config.microsoftOAuthClientId = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a supplied in-memory master key without loading a file-backed key and clears its copy on close", async () => {
    const database = {
      close: vi.fn(),
      prepare: vi.fn(() => ({ all: () => [] })),
    };
    const fastify = {
      close: vi.fn(async () => undefined),
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      server: {
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43187 }),
      },
    };
    const suppliedKey = Buffer.alloc(32, 7);

    mocks.openDatabase.mockReturnValue(database);
    mocks.outboundAttachmentDirectory.mockReturnValue("outbound");
    mocks.getAppSettings.mockReturnValue({ refreshIntervalSeconds: 300 });
    mocks.buildApp.mockResolvedValue(fastify);

    const server = await startServer({ masterKey: suppliedKey });
    const context = mocks.buildApp.mock.calls[0]?.[0] as { masterKey: Buffer };

    expect(mocks.loadOrCreateMasterKey).not.toHaveBeenCalled();
    expect(context.masterKey).not.toBe(suppliedKey);
    expect(context.masterKey).toEqual(suppliedKey);

    await server.close();

    expect(context.masterKey.equals(Buffer.alloc(32))).toBe(true);
    expect(suppliedKey.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it("stops HTTP intake and waits for mailbox sync before closing the database", async () => {
    let finishSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    const syncFinished = vi.fn();
    const database = {
      close: vi.fn(),
      prepare: vi.fn(() => ({
        all: () => [{ id: "account-1" }],
      })),
    };
    const fastify = {
      close: vi.fn(async () => undefined),
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      server: {
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43187 }),
      },
    };

    mocks.openDatabase.mockReturnValue(database);
    mocks.loadOrCreateMasterKey.mockReturnValue(Buffer.alloc(32));
    mocks.outboundAttachmentDirectory.mockReturnValue("outbound");
    mocks.getAppSettings.mockReturnValue({ refreshIntervalSeconds: 1 });
    mocks.buildApp.mockResolvedValue(fastify);
    mocks.syncAccount.mockImplementation(async () => {
      await syncGate;
      syncFinished();
      return { newInboxMessages: [] };
    });

    const server = await startServer();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.syncAccount).toHaveBeenCalledTimes(1);

    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    await Promise.resolve();

    expect(fastify.close).toHaveBeenCalledTimes(1);
    expect(database.close).not.toHaveBeenCalled();

    finishSync?.();
    await firstClose;

    expect(syncFinished).toHaveBeenCalledTimes(1);
    expect(fastify.close).toHaveBeenCalledTimes(1);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(fastify.close.mock.invocationCallOrder[0]).toBeLessThan(syncFinished.mock.invocationCallOrder[0]);
    expect(syncFinished.mock.invocationCallOrder[0]).toBeLessThan(database.close.mock.invocationCallOrder[0]);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.syncAccount).toHaveBeenCalledTimes(1);
  });

  it("keeps Microsoft OAuth unavailable when its localhost IPv6 callback cannot use the runtime port", async () => {
    vi.useRealTimers();
    mocks.config.microsoftOAuthClientId = "microsoft-client-for-tests";
    const blocker = await listenOnIpv6Loopback();
    const callbackPort = (blocker.address() as AddressInfo).port;
    const database = {
      close: vi.fn(),
      prepare: vi.fn(() => ({ all: () => [] })),
    };
    const fastify = {
      close: vi.fn(async () => undefined),
      inject: vi.fn(),
      listen: vi.fn(async () => undefined),
      log: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      server: {
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: callbackPort }),
      },
    };

    mocks.openDatabase.mockReturnValue(database);
    mocks.loadOrCreateMasterKey.mockReturnValue(Buffer.alloc(32));
    mocks.outboundAttachmentDirectory.mockReturnValue("outbound");
    mocks.getAppSettings.mockReturnValue({ refreshIntervalSeconds: 300 });
    mocks.buildApp.mockResolvedValue(fastify);

    let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      runtime = await startServer();
      const context = mocks.buildApp.mock.calls[0]?.[0] as {
        microsoftOAuthCallbackOrigin?: string;
        microsoftOAuthCallbackUnavailable?: string;
      };

      expect(context.microsoftOAuthCallbackOrigin).toBeUndefined();
      expect(context.microsoftOAuthCallbackUnavailable).toContain("IPv6");
      expect(fastify.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        "Microsoft OAuth callback bridge unavailable",
      );
    } finally {
      await runtime?.close();
      await closeServer(blocker);
    }
  });
});
