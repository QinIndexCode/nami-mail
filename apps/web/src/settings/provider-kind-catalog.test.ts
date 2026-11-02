import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentProviderKinds } from "@nami/agent-contracts";
import { isAgentProviderKind } from "../agentTypes";
import { providerServesChat } from "../agent/agent-utils";
import { providerKindMetadata, providerKindMetadataFor } from "./settings-models";
import { PROVIDER_KIND_OPTIONS } from "./SettingsModelProviderDialog";

/**
 * The provider kind vocabulary lives in four places that cannot see each other
 * at compile time: the contracts enum, the form metadata record, the dialog's
 * kind picker, and the locale files. This guard fails the build when they
 * drift — the same failure mode the builtin tools catalog test covers.
 */

type Messages = Record<string, string>;

function localeMessages(file: string): Messages {
  const parsed = JSON.parse(readFileSync(fileURLToPath(new URL(`../locales/${file}`, import.meta.url)), "utf8")) as {
    messages: Messages;
  };
  return parsed.messages;
}

const zhMessages = localeMessages("zh-CN.json");
const enMessages = localeMessages("en-US.json");

function expectKeyInBothLocales(key: string): void {
  expect(zhMessages[key], `zh-CN is missing "${key}"`).toBeTruthy();
  expect(enMessages[key], `en-US is missing "${key}"`).toBeTruthy();
}

describe("provider kind catalog drift guard", () => {
  it("form metadata covers exactly the kinds this build can write", () => {
    expect(Object.keys(providerKindMetadata).sort()).toEqual([...agentProviderKinds].sort());
    for (const kind of agentProviderKinds) {
      const meta = providerKindMetadataFor(kind);
      expect(meta, `metadata missing for ${kind}`).toBeDefined();
      expect(meta?.endpointHintKey).toBeTruthy();
      expect(meta?.modelPlaceholder).toBeTruthy();
      expectKeyInBothLocales(meta!.endpointHintKey);
    }
    // A kind from a newer build resolves to nothing instead of a bad record read.
    expect(providerKindMetadataFor("brand-new-transport")).toBeUndefined();
    expect(isAgentProviderKind("brand-new-transport")).toBe(false);
  });

  it("the dialog offers every writable kind with a localized label", () => {
    expect(PROVIDER_KIND_OPTIONS.map((option) => option.kind).sort()).toEqual([...agentProviderKinds].sort());
    for (const option of PROVIDER_KIND_OPTIONS) {
      expectKeyInBothLocales(option.labelKey);
    }
  });

  it("unsupported-row and role-badge copy exists in both locales", () => {
    for (const key of [
      "agent.providers.status.unsupported",
      "agent.providers.roleBadge.decision",
      "agent.providers.unsupportedEditHint",
    ]) {
      expectKeyInBothLocales(key);
    }
  });

  it("providerServesChat gates on configured and the chat role", () => {
    expect(providerServesChat({ configured: true, roles: ["chat"] })).toBe(true);
    expect(providerServesChat({ configured: true, roles: ["decision"] })).toBe(false);
    expect(providerServesChat({ configured: true, roles: ["chat", "decision"] })).toBe(true);
    expect(providerServesChat({ configured: true, roles: [] })).toBe(false);
    // Snapshots predating the role vocabulary were chat-only by construction.
    expect(providerServesChat({ configured: true })).toBe(true);
    expect(providerServesChat({ configured: false, roles: ["chat"] })).toBe(false);
  });
});
