import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@nami/agent-core";
import { createSettingsTools } from "../src/agent/settings-tools.js";
import { getAppSettings } from "../src/settings.js";
import { openDatabase } from "../src/db.js";

function fixture(hasCustomBackground = false) {
  const db = openDatabase(":memory:");
  const changes: Array<{ theme: string }> = [];
  const registry = createToolRegistry(createSettingsTools(db, {
    hasCustomBackground: () => hasCustomBackground,
    onChanged: (updated) => changes.push({ theme: updated.theme }),
  }));
  const context = {
    requestId: "req-1",
    caller: {
      callerId: "test",
      kind: "test" as const,
      entryPoint: "test" as const,
      accessLevel: "full-access" as const,
      scopes: ["manage:settings"],
      accountScope: { mode: "none" as const },
      interactive: true,
      canRequestConfirmation: false,
    },
    accountIds: [],
  };
  return { db, registry, context, changes };
}

describe("settings tool", () => {
  it("registers settings.update with a cosmetic/UX write descriptor", () => {
    const { registry } = fixture();
    const tool = registry.get("settings.update");
    expect(tool).toBeDefined();
    expect(tool?.descriptor.executionMode).toBe("write");
    expect(tool?.descriptor.requiredScopes).toEqual(["manage:settings"]);
    expect(tool?.descriptor.accountAccess).toBe("none");
    expect(tool?.descriptor.confirmationPolicy).toBe("never");
    expect(tool?.descriptor.availableToExternal).toBe(false);
    expect(tool?.descriptor.category).toBe("system");
  });

  it("applies a safe setting and fires the change hook", async () => {
    const { registry, context, db, changes } = fixture();
    const result = await registry.get("settings.update")!.execute(context, { theme: "dark", listDensity: "compact" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.updated).toBe(true);
      expect(result.value.settings.theme).toBe("dark");
      expect(result.value.settings.listDensity).toBe("compact");
    }
    expect(getAppSettings(db).theme).toBe("dark");
    expect(getAppSettings(db).listDensity).toBe("compact");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.theme).toBe("dark");
  });

  it("rejects the custom background preset when no image exists", async () => {
    const { registry, context } = fixture(false);
    const result = await registry.get("settings.update")!.execute(context, { backgroundPreset: "custom" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
  });

  it("allows the custom background preset once an image exists", async () => {
    const { registry, context, db } = fixture(true);
    const result = await registry.get("settings.update")!.execute(context, { backgroundPreset: "custom" });
    expect(result.ok).toBe(true);
    expect(getAppSettings(db).backgroundPreset).toBe("custom");
  });

  it("rejects empty patches and unknown (LLM/agent) fields at the schema boundary", () => {
    const { registry } = fixture();
    const schema = registry.get("settings.update")!.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    // LLM/Agent-coupled settings must not be settable through this tool.
    expect(schema.safeParse({ agentAccessLevel: "full-access" }).success).toBe(false);
    expect(schema.safeParse({ agentToolRoundLimit: 1 }).success).toBe(false);
    expect(schema.safeParse({ refreshIntervalSeconds: 30 }).success).toBe(false);
    expect(schema.safeParse({ autoReply: {} }).success).toBe(false);
  });
});
