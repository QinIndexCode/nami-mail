import { z } from "zod";
import { createAgentError, type AgentError } from "@nami/agent-contracts";
import type { AgentTool, ToolExecutionOutcome } from "@nami/agent-core";

const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  maxResults: z.number().int().min(1).max(10).optional(),
}).strict();

const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
}).strict();

const webSearchOutputSchema = z.object({
  query: z.string(),
  results: z.array(webSearchResultSchema),
  total: z.number(),
  note: z.string().optional(),
}).strict();

type WebSearchInput = z.infer<typeof webSearchInputSchema>;
type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

const SEARCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 5;

function searchFailure(error: unknown, signal?: AbortSignal): AgentError {
  if (signal?.aborted) {
    return createAgentError({
      code: "CANCELLED",
      message: "The web search was cancelled.",
      retryable: true,
    });
  }
  if (error instanceof WebSearchBlockedError) {
    return createAgentError({
      code: "TOOL_EXECUTION_FAILED",
      message: "The web search service refused this request.",
      retryable: false,
    });
  }
  return createAgentError({
    code: "TOOL_EXECUTION_FAILED",
    message: "The web search service could not be reached. Try again in a moment.",
    retryable: true,
  });
}

class WebSearchBlockedError extends Error {}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

/** Decodes DuckDuckGo's internal redirect hrefs back to the real destination. */
function normalizeUrl(href: string): string {
  const redirect = href.match(/[?&]uddg=([^&]+)/);
  if (redirect?.[1]) {
    try {
      return decodeURIComponent(redirect[1]);
    } catch {
      return href;
    }
  }
  return href;
}

function parseResultLinks(html: string): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  const linkPattern = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const rawUrl = decodeHtmlEntities(match[1]!.trim());
    const title = stripHtmlTags(decodeHtmlEntities(match[2]!)).trim();
    if (!title || !rawUrl) continue;
    links.push({ title, url: normalizeUrl(rawUrl) });
  }
  return links;
}

function parseResultSnippets(html: string): string[] {
  const snippets: string[] = [];
  const snippetPattern = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>(.*?)<\/td>/gi;
  for (const match of html.matchAll(snippetPattern)) {
    const snippet = stripHtmlTags(decodeHtmlEntities(match[1]!)).trim();
    snippets.push(snippet);
  }
  return snippets;
}

function parseDuckDuckGoResults(html: string, maxResults: number): WebSearchOutput["results"] {
  const links = parseResultLinks(html);
  const snippets = parseResultSnippets(html);
  const results: WebSearchOutput["results"] = [];
  for (let index = 0; index < links.length && results.length < maxResults; index += 1) {
    const link = links[index]!;
    results.push({
      title: link.title.slice(0, 200),
      url: link.url.slice(0, 500),
      snippet: (snippets[index] ?? "").slice(0, 300),
    });
  }
  return results;
}

async function fetchDuckDuckGoResults(query: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en,zh-CN;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status === 202 || response.status === 403) {
      throw new WebSearchBlockedError(`DuckDuckGo refused the request (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}.`);
    return await response.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * A read-only web search tool backed by DuckDuckGo's lightweight HTML endpoint
 * (no API key, no account). It is deliberately registered as `availableToExternal:
 * false` and hidden for cloud providers without mail-content consent: the search
 * query can carry mail-derived context, so it belongs to the external-leak
 * tool set like an MCP tool. Results are best-effort and never persisted.
 */
export function createSearchTools(): AgentTool<any, any>[] {
  return [
    {
      descriptor: {
        name: "web.search",
        title: "Search the web",
        description: [
          "Searches the public web (DuckDuckGo) and returns a compact list of result titles, URLs, and short snippets.",
          "Use it for current events, factual lookups, company or product information, verifying claims, or anything outside the user's local mail.",
          "The query must NOT contain email content, quoted message text, full names of mail contacts, or other private data — search with general keywords instead.",
          "If the results do not answer the question, say so honestly; do not invent facts from the snippet text.",
          "Input: { query: string, maxResults?: number (1-10, default 5) }.",
        ].join(" "),
        category: "search",
        executionMode: "read",
        requiredScopes: ["web:search"],
        accountAccess: "none",
        confirmationPolicy: "never",
        availableToExternal: false,
        timeoutMs: 15_000,
      },
      inputSchema: webSearchInputSchema,
      outputSchema: webSearchOutputSchema,
      execute: async (context, input: WebSearchInput): Promise<ToolExecutionOutcome<WebSearchOutput>> => {
        if (context.signal?.aborted) return { ok: false, error: searchFailure(undefined, context.signal) };
        try {
          const html = await fetchDuckDuckGoResults(input.query, context.signal);
          const results = parseDuckDuckGoResults(html, input.maxResults ?? DEFAULT_MAX_RESULTS);
          return {
            ok: true,
            value: {
              query: input.query,
              results,
              total: results.length,
              ...(results.length === 0 ? { note: "No web results were returned for this query." } : {}),
            },
          };
        } catch (error) {
          return { ok: false, error: searchFailure(error, context.signal) };
        }
      },
    },
  ];
}
