import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const provider = {
  id: "local-ollama",
  label: "本机 Ollama",
  kind: "ollama" as const,
  endpoint: "http://127.0.0.1:11434/v1",
  model: "llama3.2",
  timeoutMs: 45_000,
  apiKeyConfigured: false,
  configured: true,
  cloud: false,
  cloudContentConsent: false,
  streaming: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Agent provider API", () => {
  it("reads non-secret provider summaries and their authoritative default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      items: [provider],
      defaultProviderId: provider.id,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.agentProviders()).resolves.toEqual({ items: [provider], defaultProviderId: provider.id });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/agent/providers");
    expect(init.body).toBeUndefined();
  });

  it("submits a provider key only when the user explicitly saves it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...provider,
      id: "cloud-compatible",
      label: "团队模型",
      kind: "openai-compatible",
      endpoint: "https://models.example.test/v1",
      model: "nami-chat",
      apiKeyConfigured: true,
      configured: true,
      cloud: true,
      cloudContentConsent: true,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createAgentProvider({
      label: "团队模型",
      kind: "openai-compatible",
      endpoint: "https://models.example.test/v1",
      model: "nami-chat",
      apiKey: "write-only-secret",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: true,
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/agent/providers");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({
      label: "团队模型",
      kind: "openai-compatible",
      endpoint: "https://models.example.test/v1",
      model: "nami-chat",
      apiKey: "write-only-secret",
      timeoutMs: 30_000,
      allowCloudMailContent: true,
      makeDefault: true,
    }));
  });

  it("uses the dedicated route for key removal and provider deletion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...provider, apiKeyConfigured: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateAgentProvider("provider / 1", {
      label: provider.label,
      kind: provider.kind,
      endpoint: provider.endpoint,
      model: provider.model,
      clearApiKey: true,
      timeoutMs: provider.timeoutMs,
      allowCloudMailContent: false,
    });
    await api.deleteAgentProvider("provider / 1");

    const [updatePath, updateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [deletePath, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(updatePath).toBe("/api/agent/providers/provider%20%2F%201");
    expect(updateInit.method).toBe("PATCH");
    expect(updateInit.body).toContain('"clearApiKey":true');
    expect(updateInit.body).not.toContain("write-only-secret");
    expect(deletePath).toBe("/api/agent/providers/provider%20%2F%201");
    expect(deleteInit.method).toBe("DELETE");
  });
});
