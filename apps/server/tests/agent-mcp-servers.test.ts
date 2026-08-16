import { randomBytes } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { CallerContext } from "@nami/agent-contracts";
import type { ToolRegistry } from "@nami/agent-core";
import { PermissionEngine } from "@nami/agent-core";
import { AgentService } from "../src/agent-service.js";
import { AccountLifecycleStore } from "../src/agent/lifecycle.js";
import type { McpStdioClient } from "../src/agent/mcp-client.js";
import { createMcpAgentTools, jsonSchemaToZod, sanitizeMcpToolName, serverSlug, uniqueToolName } from "../src/agent/mcp-tool-adapter.js";
import { applyAgentStoreSchema } from "../src/agent/schema.js";
import { AgentSourceEventOutbox } from "../src/agent/source-events.js";
import { openDatabase } from "../src/db.js";

const fixturePath = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));
const missingFixturePath = fileURLToPath(new URL("./fixtures/does-not-exist.mjs", import.meta.url));
const timestamp = "2026-08-03T00:00:00.000Z";

function fixture() {
  const db = openDatabase(":memory:");
  const masterKey = randomBytes(32);
  applyAgentStoreSchema(db, timestamp);
  const lifecycle = new AccountLifecycleStore(db, masterKey);
  const sourceEvents = new AgentSourceEventOutbox(db, masterKey, lifecycle);
  const service = new AgentService({ db, masterKey, lifecycle, sourceEvents });
  return { db, masterKey, service };
}

function internalRegistry(service: AgentService): ToolRegistry {
  return (service as unknown as { tools: ToolRegistry }).tools;
}

function mcpInput(label: string, overrides: Partial<{ command: string; enabled: boolean; env: Record<string, string>; envRemove: string[]; args: string[]; timeoutMs: number }> = {}) {
  return {
    label,
    command: overrides.command ?? process.execPath,
    args: overrides.args ?? [fixturePath],
    env: overrides.env,
    envRemove: overrides.envRemove,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    enabled: overrides.enabled ?? true,
  };
}

const desktopCaller: CallerContext = {
  callerId: "desktop-ui",
  kind: "desktop-ui",
  entryPoint: "desktop",
  // The default UI permission level: every write tool is confirmed.
  accessLevel: "send-confirmed",
  scopes: ["read:accounts", "read:folders", "read:messages", "read:attachments", "read:rag", "write:drafts", "write:mail", "send:mail"],
  accountScope: { mode: "none" },
  interactive: true,
  canRequestConfirmation: true,
};

describe("Agent MCP server configuration CRUD", () => {
  it("creates, lists, checks, updates, and deletes a server with write-only env", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server", { env: { ANTHROPIC_API_KEY: "secret-value" } }));
      expect(created.id).toMatch(/^mcp-server-/);
      expect(created.envKeys).toEqual(["ANTHROPIC_API_KEY"]);
      expect(JSON.stringify(created)).not.toContain("secret-value");

      const listed = service.mcpServerList().items;
      expect(listed).toHaveLength(1);
      expect(listed[0]!.label).toBe("Mock server");

      const checked = await service.checkMcpServer(created.id);
      expect(checked.toolCount).toBe(6);
      expect(checked.toolNames).toContain("get_weather");
      expect(checked.serverInfo?.name).toBe("mock-mcp-server");
      expect(checked.lastError).toBeUndefined();

      const updated = service.updateMcpServer(created.id, mcpInput("Renamed", { envRemove: ["ANTHROPIC_API_KEY"] }));
      expect(updated.label).toBe("Renamed");
      expect(updated.envKeys).toEqual([]);
      expect(JSON.stringify(updated)).not.toContain("secret-value");

      service.deleteMcpServer(created.id);
      expect(service.mcpServerList().items).toHaveLength(0);
    } finally {
      await service.close();
      db.close();
    }
  });

  it("preserves stored env values when an update omits them", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server", { env: { ANTHROPIC_API_KEY: "secret-value", SECOND_KEY: "other" } }));
      expect(created.envKeys).toEqual(["ANTHROPIC_API_KEY", "SECOND_KEY"]);

      // A label-only edit must not wipe write-only env values.
      const relabeled = service.updateMcpServer(created.id, mcpInput("Renamed"));
      expect(relabeled.label).toBe("Renamed");
      expect(relabeled.envKeys).toEqual(["ANTHROPIC_API_KEY", "SECOND_KEY"]);
      expect(JSON.stringify(relabeled)).not.toContain("secret-value");

      // Updating one key replaces only that key and keeps the other.
      const partiallyUpdated = service.updateMcpServer(created.id, mcpInput("Renamed", { env: { ANTHROPIC_API_KEY: "new-secret" } }));
      expect(partiallyUpdated.envKeys).toEqual(["ANTHROPIC_API_KEY", "SECOND_KEY"]);
      expect(JSON.stringify(partiallyUpdated)).not.toContain("secret-value");
      expect(JSON.stringify(partiallyUpdated)).not.toContain("new-secret");

      // Explicit removal still deletes the key.
      const removed = service.updateMcpServer(created.id, mcpInput("Renamed", { envRemove: ["SECOND_KEY"] }));
      expect(removed.envKeys).toEqual(["ANTHROPIC_API_KEY"]);
    } finally {
      await service.close();
      db.close();
    }
  });

  it("rejects invalid server configurations", async () => {
    const { db, service } = fixture();
    try {
      expect(() => service.createMcpServer(mcpInput("", { timeoutMs: 1_000 }))).toThrow();
      expect(() => service.createMcpServer(mcpInput("Bad env", { env: { "1INVALID": "x" } }))).toThrow();
      expect(() => service.createMcpServer(mcpInput("Bad timeout", { timeoutMs: 1 }))).toThrow();
      expect(service.mcpServerList().items).toHaveLength(0);
    } finally {
      await service.close();
      db.close();
    }
  });

  it("records a failed connection check on the summary", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Broken", { args: [missingFixturePath] }));
      const checked = await service.checkMcpServer(created.id);
      expect(checked.toolCount).toBeUndefined();
      expect(checked.lastError?.retryable).toBe(true);
    } finally {
      await service.close();
      db.close();
    }
  });
});

describe("Agent MCP tool registration and lifecycle", () => {
  it("registers discovered tools with namespaced names and classifies read/write", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server"));
      const report = await service.syncMcpServers();
      expect(report.connected).toEqual([created.id]);
      expect(report.failed).toEqual([]);

      const registry = internalRegistry(service);
      const names = registry.list().map((descriptor) => descriptor.name);
      const slug = serverSlug(created.id);
      const weatherName = `${slug}.get_weather`;
      const noteName = `${slug}.send_note`;
      const deleteName = `${slug}.delete_file`;
      expect(names).toContain(weatherName);
      expect(names).toContain(noteName);
      expect(names).toContain(deleteName);

      const weather = registry.get(weatherName)!;
      expect(weather.descriptor.executionMode).toBe("read");
      expect(weather.descriptor.availableToExternal).toBe(true);
      expect(weather.descriptor.category).toBe("system");
      expect(weather.descriptor.accountAccess).toBe("none");
      expect(weather.descriptor.parametersSchema).toHaveProperty("type", "object");

      const note = registry.get(noteName)!;
      expect(note.descriptor.executionMode).toBe("write");
      expect(note.descriptor.availableToExternal).toBe(false);
      expect(note.descriptor.confirmationPolicy).toBe("required");
      expect(note.descriptor.confirmationAction).toBe("external-network");

      // A tool with no annotations must default to the conservative write
      // classification: hidden from external callers, confirmed in the UI.
      const deleteFile = registry.get(deleteName)!;
      expect(deleteFile.descriptor.executionMode).toBe("write");
      expect(deleteFile.descriptor.availableToExternal).toBe(false);
      expect(deleteFile.descriptor.confirmationPolicy).toBe("required");
      expect(deleteFile.descriptor.confirmationAction).toBe("external-network");
      expect(deleteFile.confirmationPreview).toBeDefined();
    } finally {
      await service.close();
      db.close();
    }
  });

  it("confirms write MCP tools in the desktop UI and hides them from external callers", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server"));
      await service.syncMcpServers();
      const registry = internalRegistry(service);
      const name = `${serverSlug(created.id)}.delete_file`;
      const tool = registry.get(name)!;
      const permissionEngine = new PermissionEngine();
      const desktop = permissionEngine.evaluate({
        caller: desktopCaller,
        tool: tool.descriptor,
        accountIds: [],
      });
      expect(desktop.status).toBe("confirmation_required");

      const external: CallerContext = {
        callerId: "external-client",
        kind: "mcp",
        entryPoint: "mcp",
        accessLevel: "read-only",
        scopes: ["read:messages"],
        accountScope: { mode: "none" },
        interactive: false,
        canRequestConfirmation: false,
      };
      const denied = permissionEngine.evaluate({
        caller: external,
        tool: tool.descriptor,
        accountIds: [],
      });
      expect(denied.status).toBe("denied");
      if (denied.status === "denied") expect(denied.error.code).toBe("NOT_SUPPORTED");

      // Read MCP tools stay usable by external callers.
      const readTool = registry.get(`${serverSlug(created.id)}.get_weather`)!;
      const allowed = permissionEngine.evaluate({ caller: external, tool: readTool.descriptor, accountIds: [] });
      expect(allowed.status).toBe("allowed");
    } finally {
      await service.close();
      db.close();
    }
  });

  it("executes a registered MCP tool through the shared registry", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server"));
      await service.syncMcpServers();
      const registry = internalRegistry(service);
      const name = `${serverSlug(created.id)}.get_weather`;
      const call = { id: "call-1", toolName: name, input: { city: "Kyoto" }, requestedAt: timestamp };
      const resolution = registry.resolve(call, []);
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        const result = await registry.executeResolved(resolution, {
          requestId: "req-1",
          caller: desktopCaller,
          accountIds: [],
        });
        expect(result.status).toBe("succeeded");
        if (result.status === "succeeded") {
          const output = result.output as { content?: Array<{ text?: string }> };
          expect(output.content?.[0]?.text).toBe("Weather in Kyoto: sunny");
        }
      }
    } finally {
      await service.close();
      db.close();
    }
  });

  it("unregisters tools when the server is deleted and registers none for disabled servers", async () => {
    const { db, service } = fixture();
    try {
      const disabled = service.createMcpServer(mcpInput("Disabled", { enabled: false }));
      const enabled = service.createMcpServer(mcpInput("Enabled"));
      const report = await service.syncMcpServers();
      expect(report.connected).toEqual([enabled.id]);

      const registry = internalRegistry(service);
      expect(registry.get(`${serverSlug(enabled.id)}.get_weather`)).toBeDefined();
      expect(registry.get(`${serverSlug(disabled.id)}.get_weather`)).toBeUndefined();

      service.deleteMcpServer(enabled.id);
      expect(registry.get(`${serverSlug(enabled.id)}.get_weather`)).toBeUndefined();
      // All MCP tools are gone; only the built-in calendar, memory, auto-reply,
      // and settings tools remain.
      expect(registry.list().filter((tool) => !tool.name.startsWith("calendar.") && !tool.name.startsWith("memory.") && !tool.name.startsWith("auto-reply.") && !tool.name.startsWith("settings."))).toHaveLength(0);
    } finally {
      await service.close();
      db.close();
    }
  });

  it("reconnects and re-registers after an update and reports failures", async () => {
    const { db, service } = fixture();
    try {
      const created = service.createMcpServer(mcpInput("Mock server"));
      await service.syncMcpServers();
      const registry = internalRegistry(service);
      expect(registry.get(`${serverSlug(created.id)}.get_weather`)).toBeDefined();

      // Break the command; the next sync must drop the tools and report a failure.
      service.updateMcpServer(created.id, mcpInput("Mock server", { args: [missingFixturePath] }));
      const broken = await service.syncMcpServers();
      expect(broken.connected).toEqual([]);
      expect(broken.failed).toHaveLength(1);
      expect(broken.failed[0]!.label).toBe("Mock server");
      expect(registry.get(`${serverSlug(created.id)}.get_weather`)).toBeUndefined();

      // Restore the command; the next sync reconnects and re-registers.
      service.updateMcpServer(created.id, mcpInput("Mock server"));
      const restored = await service.syncMcpServers();
      expect(restored.connected).toEqual([created.id]);
      expect(registry.get(`${serverSlug(created.id)}.get_weather`)).toBeDefined();
    } finally {
      await service.close();
      db.close();
    }
  });
});

describe("MCP tool naming and schema conversion", () => {
  it("sanitizes MCP tool names into valid registry identifiers", () => {
    expect(sanitizeMcpToolName("Get Weather")).toBe("get-weather");
    expect(sanitizeMcpToolName("  hello world! ")).toBe("hello-world");
    expect(sanitizeMcpToolName("123abc")).toBe("t-123abc");
    expect(sanitizeMcpToolName("...")).toBe("tool");
  });

  it("namespaces names under the server id and deduplicates collisions", () => {
    const used = new Set<string>();
    const first = uniqueToolName("mcp-server-abc123", "get_weather", used)!;
    expect(first).toBe("mcp-server-abc123.get_weather");
    const second = uniqueToolName("mcp-server-abc123", "get-weather", used)!;
    expect(second).not.toBe(first);
    expect(second).toMatch(/^mcp-server-abc123\./);
  });

  it("converts common JSON schemas to Zod and falls back to unknown", () => {
    const object = jsonSchemaToZod({
      type: "object",
      properties: { city: { type: "string" }, count: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
      required: ["city"],
    });
    expect(object.safeParse({ city: "Osaka", count: 3, tags: ["a"] }).success).toBe(true);
    expect(object.safeParse({ count: 3 }).success).toBe(false);
    expect(object.safeParse({ city: 1 }).success).toBe(false);

    const enums = jsonSchemaToZod({ type: "string", enum: ["small", "large"] });
    expect(enums.safeParse("small").success).toBe(true);
    expect(enums.safeParse("huge").success).toBe(false);

    const anyOf = jsonSchemaToZod({ anyOf: [{ type: "string" }, { type: "number" }] });
    expect(anyOf.safeParse("x").success).toBe(true);
    expect(anyOf.safeParse(5).success).toBe(true);
    expect(anyOf.safeParse(true).success).toBe(false);

    const open = jsonSchemaToZod({});
    expect(open.safeParse({ anything: [1, 2, 3] }).success).toBe(true);
    expect(jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }).safeParse({ a: "x", b: 1 }).success).toBe(false);
    expect(jsonSchemaToZod("not-a-schema").safeParse(undefined).success).toBe(true);
  });
});

describe("MCP tool result size bounds", () => {
  const desktopCaller: CallerContext = {
    callerId: "desktop-ui",
    kind: "desktop-ui",
    entryPoint: "desktop",
    accessLevel: "full-access",
    scopes: [],
    accountScope: { mode: "none" },
    interactive: true,
    canRequestConfirmation: true,
  };

  function stubClient(callTool: McpStdioClient["callTool"]): McpStdioClient {
    return { callTool } as unknown as McpStdioClient;
  }

  function singleReadTool(client: McpStdioClient) {
    return createMcpAgentTools({
      client,
      serverId: "mcp-server-abc",
      serverLabel: "Stub server",
      tools: [{ name: "big", annotations: { readOnlyHint: true } }],
    })[0]!;
  }

  it("truncates a single oversized text entry to the per-entry limit", async () => {
    const client = stubClient(async () => ({
      content: [{ type: "text", text: "x".repeat(20_000) }],
      isError: false,
    }));
    const result = await singleReadTool(client).execute({ requestId: "req-1", caller: desktopCaller, accountIds: [] }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = (result.value as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(8_001);
      expect(text.endsWith("…")).toBe(true);
    }
  });

  it("caps the total joined text across many entries", async () => {
    const entries = Array.from({ length: 10 }, () => ({ type: "text", text: "y".repeat(5_000) }));
    const client = stubClient(async () => ({ content: entries, isError: false }));
    const result = await singleReadTool(client).execute({ requestId: "req-2", caller: desktopCaller, accountIds: [] }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = (result.value as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(32_001);
      expect(text.endsWith("…")).toBe(true);
    }
  });

  it("drops an oversized structuredContent payload while keeping the text", async () => {
    const client = stubClient(async () => ({
      content: [{ type: "text", text: "kept" }],
      structuredContent: { payload: "z".repeat(200_000) },
      isError: false,
    }));
    const result = await singleReadTool(client).execute({ requestId: "req-3", caller: desktopCaller, accountIds: [] }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { content?: Array<{ text?: string }>; structuredContent?: unknown };
      expect(value.content?.[0]?.text).toBe("kept");
      expect(value).not.toHaveProperty("structuredContent");
    }
  });

  it("keeps small structuredContent and text unchanged", async () => {
    const client = stubClient(async () => ({
      content: [{ type: "text", text: "small" }],
      structuredContent: { sum: 5 },
      isError: false,
    }));
    const result = await singleReadTool(client).execute({ requestId: "req-4", caller: desktopCaller, accountIds: [] }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { content?: Array<{ text?: string }>; structuredContent?: unknown };
      expect(value.content?.[0]?.text).toBe("small");
      expect(value.structuredContent).toEqual({ sum: 5 });
    }
  });
});
