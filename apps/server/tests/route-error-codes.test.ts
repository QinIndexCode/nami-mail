import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OAUTH_ERROR_CODES,
  REFERENCED_AGENT_ERROR_CODES,
  REFERENCED_MAIL_ERROR_CODES,
  ROUTE_ERROR_CODE_DEFINITIONS,
  ROUTE_ERROR_CODES,
  ROUTE_ERROR_CODE_LIST,
  TRANSLATION_SERVICE_ERROR_CODES,
  WIRE_ERROR_CODES,
  isWireErrorCode,
  routeErrorCodeForStatus,
} from "../src/routes/error-codes.js";

const ROUTES_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
const ROUTE_SOURCE_FILES = fs
  .readdirSync(ROUTES_DIRECTORY)
  .filter((name) => name.endsWith(".ts"))
  .sort();

type CodeSite = { file: string; line: number; value: string };

/**
 * Upper-snake codes the Agent layer constructs and hands to `error.code`, which
 * `agentFailure` forwards verbatim. Read-only: this test observes the Agent
 * layer to keep the wire vocabulary honest about what can escape through it.
 */
function agentLayerCodes(): string[] {
  const agentDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agent");
  const sources = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agent-service.ts"),
    ...listTypeScriptFiles(agentDirectory),
  ];
  const codes = new Set<string>();
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf-8");
    for (const match of text.matchAll(/\b(?:AgentServiceError|AgentMcpServerStoreError|McpClientError|agentError|createAgentError)\s*\(\s*(?:"([A-Z_]+)"|\{[^}]*\bcode:\s*"([A-Z_]+)")/g)) {
      const value = match[1] ?? match[2];
      if (value) codes.add(value);
    }
  }
  return [...codes].sort();
}

function listTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** `code: "..."` and not `error.code === "..."` — the colon is what separates them. */
const CODE_LITERAL = /\bcode:\s*"([a-z0-9_]+)"/gi;

/**
 * Every `code:` string literal in the routing layer, with the file and line it
 * sits on. This is the defence that makes a fourth spelling a red test: a new
 * route that writes its own literal shows up here and has to be in the table.
 */
function codeLiterals(): CodeSite[] {
  const sites: CodeSite[] = [];
  for (const name of ROUTE_SOURCE_FILES) {
    const lines = fs.readFileSync(path.join(ROUTES_DIRECTORY, name), "utf-8").split("\n");
    lines.forEach((text, index) => {
      if (name === "error-codes.ts") return; // the table itself declares the vocabulary
      for (const match of text.matchAll(CODE_LITERAL)) {
        sites.push({ file: name, line: index + 1, value: match[1]! });
      }
    });
  }
  return sites;
}

/**
 * Error responses whose `code` arrives by spreading a helper that always carries
 * one. Each entry names that helper; a site that stops spreading it stops being
 * an exception.
 */
const DYNAMIC_CODE_SPREADS: Record<string, string> = {
  "oauth.ts": "oauthErrorBody(error) always returns { code, message }",
  "accounts.ts": "mailFailure() body always carries a MAIL_ERROR_CODES value",
};

type MissingCodeSite = { file: string; line: number; reason: string };

/**
 * Every `.send({ … })` whose object literal declares `ok: false`, checked for a
 * `code` key. This is the other half of the defence: the literal scan catches a
 * bad *spelling*, this catches a *missing* code, which is the state the routes
 * were in before (`{ ok: false, message: "邮件不存在。" }`).
 */
function errorResponsesMissingCode(): MissingCodeSite[] {
  const missing: MissingCodeSite[] = [];
  for (const name of ROUTE_SOURCE_FILES) {
    if (name === "error-codes.ts") continue;
    const source = fs.readFileSync(path.join(ROUTES_DIRECTORY, name), "utf-8");
    for (const start of sendObjectLiterals(source)) {
      if (!/\bok:\s*false\b/.test(start.literal)) continue;
      if (/\bcode\s*:/.test(start.literal)) continue;
      const reason = DYNAMIC_CODE_SPREADS[name];
      if (reason && /\.\.\./.test(start.literal)) continue;
      missing.push({ file: name, line: start.line, reason: reason ?? "no code and no spreading helper" });
    }
  }
  return missing;
}

/** Object-literal arguments of `.send(`, located with a string-aware brace match. */
function sendObjectLiterals(source: string): Array<{ line: number; literal: string }> {
  const found: Array<{ line: number; literal: string }> = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith(".send(", index)) {
      let cursor = index + ".send(".length;
      while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
      if (source[cursor] !== "{") continue;
      const end = matchingBrace(source, cursor);
      if (end < 0) continue;
      found.push({
        line: source.slice(0, cursor).split("\n").length,
        literal: source.slice(cursor, end + 1),
      });
    }
  }
  return found;
}

/** Index of the `}` closing the `{` at `start`, ignoring braces in strings. */
function matchingBrace(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(source, index);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

/** Index of the closing quote of the string starting at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  return source.length - 1;
}

describe("local API error-code vocabulary", () => {  it("declares route codes as a single, duplicate-free, lower-snake table", () => {
    const values = Object.values(ROUTE_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
    for (const code of ROUTE_ERROR_CODE_LIST) {
      // Upper-snake is reserved for the frozen Agent/Broker family; a route
      // that starts using it would silently join two contracts.
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(ROUTE_ERROR_CODE_DEFINITIONS[code].status).toBeGreaterThanOrEqual(400);
      expect(ROUTE_ERROR_CODE_DEFINITIONS[code].meaning.length).toBeGreaterThan(0);
    }
  });

  it("keeps one code per meaning for the two shapes this change collapsed", () => {
    // A 400 is `invalid_argument` and a 404 is `not_found` everywhere. The
    // per-route spellings this replaces — `invalid_request`,
    // `confirmation_not_found`, and a missing `code` altogether — must be gone
    // from the table, not merely unused.
    expect(isWireErrorCode("invalid_request")).toBe(false);
    expect(isWireErrorCode("confirmation_not_found")).toBe(false);
    expect(isWireErrorCode("not_found")).toBe(true);
    expect(isWireErrorCode("invalid_argument")).toBe(true);
  });

  it("emits no route code literal that is outside the vocabulary", () => {
    const outside = codeLiterals().filter((site) => !isWireErrorCode(site.value));
    expect(outside.map((site) => `${site.file}:${site.line} ${site.value}`)).toEqual([]);
  });

  it("draws the code a route writes from the table, not from a bare literal", () => {
    // `code: "…"` in a route file is by definition a second source of truth,
    // whatever its value. There must be exactly zero of them.
    expect(codeLiterals()).toEqual([]);
  });

  it("gives every error response a code, so a client can branch on one field", () => {
    const missing = errorResponsesMissingCode();
    expect(missing.map((site) => `${site.file}:${site.line} (${site.reason})`)).toEqual([]);
  });

  it("covers the referenced families exactly", () => {
    // MAIL_ERROR_CODES and agentErrorCodes are imported, so these are set
    // equality by construction — asserted anyway so a copy-paste swap fails.
    expect(new Set([...ROUTE_ERROR_CODE_LIST, ...REFERENCED_MAIL_ERROR_CODES, ...REFERENCED_AGENT_ERROR_CODES]).size)
      .toBeGreaterThan(0);
    for (const code of [...REFERENCED_MAIL_ERROR_CODES, ...REFERENCED_AGENT_ERROR_CODES, ...OAUTH_ERROR_CODES, ...TRANSLATION_SERVICE_ERROR_CODES]) {
      expect(isWireErrorCode(code)).toBe(true);
    }
    expect(new Set(WIRE_ERROR_CODES).size).toBe(WIRE_ERROR_CODES.length);
  });

  it("freezes the Agent/Broker family as upper-snake on the wire", () => {
    // Documented in docs/EXTERNAL-MAIL-INTERFACE, docs/cli/output-schema,
    // docs/cli/permissions and docs/mcp/security, and matched case-sensitively
    // by the renderer. Lower-casing it here would break both.
    expect(isWireErrorCode("NOT_FOUND")).toBe(true);
    expect(isWireErrorCode("not_found")).toBe(true);
    expect(isWireErrorCode("INVALID_ARGUMENT")).toBe(true);
    expect(isWireErrorCode("SERVER_CHANGED")).toBe(true);
    expect(isWireErrorCode("PROVIDER_CHANGED")).toBe(true);
    expect(REFERENCED_AGENT_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it("declares every upper-snake code the Agent layer can put on the wire", () => {
    // `agentFailure` forwards `error.code` untouched, so the Agent layer — not
    // this table — decides the spelling. Re-derive that set from its sources
    // and require every member to be declared: a new `AgentServiceError("…")`
    // is a red test here instead of an undeclared dialect on the wire.
    const thrown = agentLayerCodes();
    const undeclared = thrown.filter((code) => !isWireErrorCode(code));
    expect(undeclared).toEqual([]);
    expect(thrown.length).toBeGreaterThan(0);
  });

  it("maps a dynamically chosen status onto a declared route code", () => {
    expect(routeErrorCodeForStatus(400)).toBe(ROUTE_ERROR_CODES.invalid_argument);
    expect(routeErrorCodeForStatus(404)).toBe(ROUTE_ERROR_CODES.not_found);
    expect(routeErrorCodeForStatus(409)).toBe(ROUTE_ERROR_CODES.conflict);
    expect(routeErrorCodeForStatus(413)).toBe(ROUTE_ERROR_CODES.payload_too_large);
    expect(routeErrorCodeForStatus(499)).toBe(ROUTE_ERROR_CODES.cancelled);
    expect(routeErrorCodeForStatus(500)).toBe(ROUTE_ERROR_CODES.internal_error);
    expect(routeErrorCodeForStatus(503)).toBe(ROUTE_ERROR_CODES.internal_error);
  });
});
