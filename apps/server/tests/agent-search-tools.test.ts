import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolExecutionContext } from "@nami/agent-core";
import { createSearchTools } from "../src/agent/search-tools.js";

// Fixed from a real DuckDuckGo Lite response (2026-09): result anchors now use
// single-quoted attributes with href BEFORE class plus a rel attribute — a
// form the previous double-quote/order-sensitive regex silently matched zero
// of. The older double-quoted variant and a wrapped anchor stay in the sample
// so both markup generations and line breaks remain covered.
const htmlSample = `
<html><body>
<div class="result">
  <a rel="nofollow" href="https://example.com/intro" class='result-link'>Example Intro</a>
  <table><tr><td class='result-snippet'>A sample &amp; page about <b>Nami</b> mail.</td></tr></table>
</div>
<div class="result">
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&amp;rut=abc" class='result-link'>Docs Guide</a>
  <table><tr><td class='result-snippet'>How to set it up.</td></tr></table>
</div>
<div class="result">
  <a rel="nofollow" class="result-link" href="https://legacy.example.com/old">Legacy Markup</a>
  <table><tr><td class="result-snippet">Older double-quoted markup still parses.</td></tr></table>
</div>
<div class="result">
  <a rel="nofollow" class="result-link"
     href="https://multiline.example.com/page">Multiline Anchor</a>
  <table><tr><td class='result-snippet'>Anchors can wrap across lines.</td></tr></table>
</div>
</body></html>
`;

function context(partial: Partial<AgentToolExecutionContext> = {}): AgentToolExecutionContext {
  return {
    requestId: "request-1",
    caller: {
      callerId: "desktop-ui",
      kind: "desktop-ui",
      entryPoint: "desktop",
      accessLevel: "full-access",
      scopes: ["read:accounts", "read:messages", "web:search"],
      accountScope: { mode: "all" },
      interactive: true,
      canRequestConfirmation: true,
    },
    accountIds: [],
    ...partial,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web.search tool", () => {
  it("registers with a search descriptor and the web:search scope", () => {
    const [tool] = createSearchTools();
    expect(tool.descriptor.name).toBe("web.search");
    expect(tool.descriptor.category).toBe("search");
    expect(tool.descriptor.executionMode).toBe("read");
    expect(tool.descriptor.requiredScopes).toEqual(["web:search"]);
    expect(tool.descriptor.accountAccess).toBe("none");
    expect(tool.descriptor.confirmationPolicy).toBe("never");
    expect(tool.descriptor.availableToExternal).toBe(false);
  });

  it("fetches DuckDuckGo Lite and parses titled results with real URLs", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => htmlSample }));
    vi.stubGlobal("fetch", fetchMock);
    const [tool] = createSearchTools();
    const outcome = await tool.execute(context(), { query: "nami mail", maxResults: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("lite.duckduckgo.com/lite/");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("q=nami%20mail");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.total).toBe(4);
    expect(outcome.value.results[0]).toEqual({
      title: "Example Intro",
      url: "https://example.com/intro",
      snippet: "A sample & page about Nami mail.",
    });
    expect(outcome.value.results[1]?.url).toBe("https://docs.example.com/guide");
    // The legacy double-quoted markup and the wrapped anchor must keep parsing.
    expect(outcome.value.results[2]).toMatchObject({ title: "Legacy Markup", url: "https://legacy.example.com/old" });
    expect(outcome.value.results[3]).toMatchObject({ title: "Multiline Anchor", url: "https://multiline.example.com/page" });
  });

  it("caps results at maxResults", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => htmlSample }));
    vi.stubGlobal("fetch", fetchMock);
    const [tool] = createSearchTools();
    const outcome = await tool.execute(context(), { query: "anything", maxResults: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.results).toHaveLength(1);
  });

  it("returns an empty result set with a note when no links are parsed", async () => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html><body>no results here</body></html>" }));
    vi.stubGlobal("fetch", fetchMock);
    const [tool] = createSearchTools();
    const outcome = await tool.execute(context(), { query: "unlikely", maxResults: 5 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.total).toBe(0);
    expect(outcome.value.note).toBeTruthy();
  });

  it("maps a refused response and network errors to a retryable failure", async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 403, text: async () => "blocked" }));
    vi.stubGlobal("fetch", fetchMock);
    const [tool] = createSearchTools();
    const outcome = await tool.execute(context(), { query: "test" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("TOOL_EXECUTION_FAILED");
    expect(outcome.error.retryable).toBe(false);

    fetchMock = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", fetchMock);
    const retryable = await tool.execute(context(), { query: "test" });
    expect(retryable.ok).toBe(false);
    if (retryable.ok) return;
    expect(retryable.error.code).toBe("TOOL_EXECUTION_FAILED");
    expect(retryable.error.retryable).toBe(true);
  });

  it("reports CANCELLED when the run is aborted before the request", async () => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const [tool] = createSearchTools();
    const outcome = await tool.execute(context({ signal: controller.signal }), { query: "test" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("CANCELLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects empty queries through the input schema", () => {
    const [tool] = createSearchTools();
    const parsed = tool.inputSchema.safeParse({ query: "   " });
    expect(parsed.success).toBe(false);
  });
});
