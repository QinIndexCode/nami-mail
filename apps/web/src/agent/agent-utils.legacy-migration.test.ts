// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { saveLastActiveConversationId, readLastActiveConversationId } from "./agent-utils";

/**
 * R13: pre-durable-layer preferences must MIGRATE on read, not merely fall
 * back. A read-only fallback leaves the legacy entry authoritative: a later
 * clear (the user picks "no conversation") reads the new key (absent) and
 * revives the legacy value — the same resurrection the durable layer exists
 * to prevent. Migration means: legacy read → durable write → legacy key
 * removed, in that order, so the two surfaces can never disagree again.
 */

const LEGACY_KEY = "nami.agent.lastConversation";
const CURRENT_KEY = "nami-mail.agent-last-conversation";

function installLocalStorage(seed: Record<string, string> = {}): Map<string, string> {
  const entries = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    },
  });
  return entries;
}

describe("legacy preference migration (R13)", () => {
  beforeEach(() => {
    delete (window as unknown as { namiDesktop?: unknown }).namiDesktop;
  });

  it("migrates the legacy agent conversation id on read and removes the legacy key", () => {
    const entries = installLocalStorage({ [LEGACY_KEY]: "conversation-legacy-1" });

    expect(readLastActiveConversationId()).toBe("conversation-legacy-1");
    // The value now lives in the durable layer; the legacy key is gone, so
    // no later read can resurrect an inconsistent copy.
    expect(entries.has(LEGACY_KEY)).toBe(false);
    expect(entries.get(CURRENT_KEY)).toBe("conversation-legacy-1");
  });

  it("a clear after migration reads cleared, not the stale legacy value", () => {
    const entries = installLocalStorage({ [LEGACY_KEY]: "conversation-legacy-2" });

    // First read migrates.
    expect(readLastActiveConversationId()).toBe("conversation-legacy-2");
    // The user closes the panel with no active conversation: the clear must
    // win over the already-migrated legacy entry.
    saveLastActiveConversationId(null);

    expect(readLastActiveConversationId()).toBeNull();
    expect(entries.has(LEGACY_KEY)).toBe(false);
  });

  it("a fresh install with no legacy key is untouched by the migration", () => {
    const entries = installLocalStorage();

    expect(readLastActiveConversationId()).toBeNull();
    expect(entries.size).toBe(0);
  });
});
