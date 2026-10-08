import { describe, expect, it } from "vitest";
import { configuredProviderId, resolveConversationProvider } from "./agent-utils";

const local = { id: "provider-local", configured: true };
const cloud = { id: "provider-cloud", configured: true };
const unconfigured = { id: "provider-off", configured: false };

describe("resolveConversationProvider", () => {
  it("prefers the recorded conversation provider when it exists and is configured", () => {
    expect(resolveConversationProvider("provider-cloud", [local, cloud], "provider-local")).toBe("provider-cloud");
  });

  it("falls back to the default when the recorded provider is unconfigured or gone", () => {
    expect(resolveConversationProvider("provider-off", [local, unconfigured], "provider-local")).toBe("provider-local");
    expect(resolveConversationProvider("provider-gone", [local], "provider-local")).toBe("provider-local");
  });

  it("falls back to the default when no provider was recorded", () => {
    expect(resolveConversationProvider("", [local, cloud], "provider-local")).toBe("provider-local");
    expect(resolveConversationProvider(null, [local], null)).toBe("provider-local");
  });

  it("degrades to an empty id when nothing is usable", () => {
    expect(resolveConversationProvider("", [], null)).toBe("");
    expect(resolveConversationProvider("provider-off", [unconfigured], null)).toBe("provider-off");
  });
});

describe("configuredProviderId", () => {
  it("prefers the server default, then the first configured provider, then any provider", () => {
    expect(configuredProviderId([unconfigured, cloud, local], "provider-local")).toBe("provider-local");
    expect(configuredProviderId([unconfigured, cloud, local], null)).toBe("provider-cloud");
    expect(configuredProviderId([unconfigured], null)).toBe("provider-off");
    expect(configuredProviderId([], null)).toBe("");
  });
});
