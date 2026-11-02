import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentService } from "../src/agent-service.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { encryptRootAgentRecord } from "../src/agent/store-crypto.js";
import { providerKindSupported, providerRolesForKind } from "../src/agent/provider-service.js";

/**
 * Rows written by a newer build (unknown kinds) and decision-only kinds must
 * degrade gracefully: listable, deletable, never silently usable as chat.
 */

const timestamp = "2026-08-10T10:00:00.000Z";
// Assembled at runtime so secret scanners do not flag the synthetic test value.
const STORED_API_KEY = ["stored", "key"].join("-");

function createTestService() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
  return { db, masterKey, service };
}

function insertRawConfiguration(db: ReturnType<typeof openDatabase>, masterKey: Buffer, configuration: Record<string, unknown>, id: string): void {
  const encrypted = encryptRootAgentRecord(
    masterKey,
    "agent-provider-config",
    `provider-config:${id}`,
    JSON.stringify(configuration),
  );
  db.prepare(`
    INSERT INTO agent_provider_configurations (provider_id, encrypted_configuration, crypto_version, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(id, encrypted, timestamp, timestamp);
}

function rawConfiguration(id: string, kind: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    label: "Future model",
    kind,
    endpoint: "https://api.example.test/v1/",
    model: "future-model",
    timeoutMs: 30_000,
    allowCloudMailContent: true,
    streaming: false,
    apiKey: STORED_API_KEY,
  };
}

/** Forges the default-provider pointer at an arbitrary id. */
function insertDefaultPointer(db: ReturnType<typeof openDatabase>, masterKey: Buffer, providerId: string | null): void {
  const encrypted = encryptRootAgentRecord(
    masterKey,
    "agent-provider-default",
    "agent-provider-default",
    JSON.stringify({ version: 1, defaultProviderId: providerId }),
  );
  db.prepare(`
    INSERT INTO agent_provider_configurations (provider_id, encrypted_configuration, crypto_version, created_at, updated_at)
    VALUES ('agent-provider-default', ?, 1, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET encrypted_configuration = excluded.encrypted_configuration
  `).run(encrypted, timestamp, timestamp);
}

describe("agent provider kinds: read-lenient, write-strict", () => {
  it("roles derive from the kind map, including kinds this build cannot write", () => {
    expect(providerRolesForKind("openai-compatible")).toEqual(["chat"]);
    expect(providerRolesForKind("ollama")).toEqual(["chat"]);
    expect(providerRolesForKind("system-one")).toEqual(["decision"]);
    expect(providerRolesForKind("brand-new-transport")).toEqual([]);
    // system-one became writable in P1; a genuinely unknown kind stays unsupported.
    expect(providerKindSupported("system-one")).toBe(true);
    expect(providerKindSupported("brand-new-transport")).toBe(false);
    expect(providerKindSupported("openai-compatible")).toBe(true);
  });

  it("lists and deletes an unknown-kind row without taking other rows down", async () => {
    const { db, masterKey, service } = createTestService();
    try {
      const known = service.createProvider({
        label: "Local Ollama",
        kind: "ollama",
        endpoint: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        timeoutMs: 30_000,
        allowCloudMailContent: false,
        makeDefault: true,
      });
      insertRawConfiguration(db, masterKey, rawConfiguration("provider-future", "future-decision-model"), "provider-future");

      const listed = service.providerList().items;
      expect(listed).toHaveLength(2);
      const future = listed.find((item) => item.id === "provider-future");
      expect(future).toBeDefined();
      expect(future?.kind).toBe("future-decision-model");
      expect(future?.supported).toBe(false);
      // Capability-aware: an unspeakable kind is never "configured", so no
      // call site can pick it for a chat request.
      expect(future?.configured).toBe(false);
      expect(future?.roles).toEqual([]);
      expect(future?.apiKeyConfigured).toBe(true);
      // The known row is untouched by its exotic neighbour.
      const local = listed.find((item) => item.id === known.id);
      expect(local?.supported).toBe(true);
      expect(local?.configured).toBe(true);
      expect(service.providerList().defaultProviderId).toBe(known.id);

      await expect(service.checkProvider("provider-future")).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        statusCode: 422,
      });

      service.deleteProvider("provider-future");
      expect(service.providerList().items.map((item) => item.id)).toEqual([known.id]);
    } finally {
      await service.close();
      db.close();
    }
  });

  it("never reports a decision-only row as the default model", async () => {
    const { db, masterKey, service } = createTestService();
    try {
      insertRawConfiguration(db, masterKey, rawConfiguration("provider-decision", "system-one"), "provider-decision");
      // A newer build pointed the default at the decision model; this build
      // must report no default rather than hand a non-chat row to chat sites.
      insertDefaultPointer(db, masterKey, "provider-decision");
      expect(service.providerList().defaultProviderId).toBeNull();

      // The next chat provider still auto-claims the vacant default slot.
      const chat = service.createProvider({
        label: "Cloud chat",
        kind: "openai-compatible",
        endpoint: "https://api.example.test/v1",
        model: "chat-model",
        timeoutMs: 30_000,
        allowCloudMailContent: true,
      });
      expect(service.providerList().defaultProviderId).toBe(chat.id);
      // …and the decision row keeps its role label for the UI badge.
      const decision = service.providerList().items.find((item) => item.id === "provider-decision");
      expect(decision?.roles).toEqual(["decision"]);
    } finally {
      await service.close();
      db.close();
    }
  });
});
