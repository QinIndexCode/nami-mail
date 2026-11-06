import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Settings → Agent Tools renders a hand-maintained catalog of the built-in
 * tools. The registry that actually executes them lives in the server, so the
 * two can drift without any type error: the page would keep advertising a tool
 * that no longer exists (or hide one that does). These checks make the catalog
 * fail loudly instead of quietly lying.
 */

const repoRoot = join(import.meta.dirname, "..", "..");
const agentDir = join(repoRoot, "apps", "server", "src", "agent");
const catalogPath = join(repoRoot, "apps", "web", "src", "settings", "builtin-tools-data.ts");
const localesDir = join(repoRoot, "apps", "web", "src", "locales");
const LOCALES = ["en-US", "zh-CN"];

function catalogEntries() {
  const text = readFileSync(catalogPath, "utf8");
  const table = text.slice(text.indexOf("BUILTIN_AGENT_TOOLS"));
  const pattern =
    /\{\s*name:\s*"([^"]+)",\s*domain:\s*"([^"]+)",\s*type:\s*"(read|write)",\s*descKey:\s*"([^"]+)"\s*\}/g;
  return [...table.matchAll(pattern)].map((match) => ({
    name: match[1],
    domain: match[2],
    type: match[3],
    descKey: match[4],
  }));
}

/** Every `*-tools.ts` module is a built-in toolset; discovery stays in step with new modules. */
function registryToolNames() {
  const names = new Set();
  for (const file of readdirSync(agentDir).filter((name) => name.endsWith("-tools.ts"))) {
    const text = readFileSync(join(agentDir, file), "utf8");
    for (const match of text.matchAll(/\bname:\s*"([a-z][a-z0-9_.-]*)"/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

function messagesOf(locale) {
  return JSON.parse(readFileSync(join(localesDir, `${locale}.json`), "utf8")).messages;
}

test("the in-app catalog lists exactly the tools the server registers", () => {
  const catalog = catalogEntries();
  const registered = registryToolNames();

  assert.ok(catalog.length > 0, "builtin-tools-data.ts must declare the catalog");
  assert.equal(
    new Set(catalog.map((entry) => entry.name)).size,
    catalog.length,
    "the catalog must not list a tool twice",
  );
  assert.deepEqual(
    catalog.map((entry) => entry.name).sort(),
    [...registered].sort(),
    "Settings → Agent Tools and apps/server/src/agent/*-tools.ts disagree; update both",
  );
});

test("every catalog entry is well formed and carries a known domain", () => {
  const text = readFileSync(catalogPath, "utf8");
  const domains = [...text.matchAll(/domain:\s*"([^"]+)"/g)].map((match) => match[1]);
  const declared = new Set(
    [...(text.slice(text.indexOf("BUILTIN_TOOL_DOMAINS")).matchAll(/"([^"]+)"/g) ?? [])].map(
      (match) => match[1],
    ),
  );

  for (const entry of catalogEntries()) {
    assert.ok(["read", "write"].includes(entry.type), `${entry.name}: unknown type ${entry.type}`);
    assert.ok(declared.has(entry.domain), `${entry.name}: domain ${entry.domain} is not in BUILTIN_TOOL_DOMAINS`);
    assert.match(entry.descKey, /^[a-z][A-Za-z0-9]*$/, `${entry.name}: descKey must be camelCase key fodder`);
  }

  // The filter chips are built from BUILTIN_TOOL_DOMAINS, so a domain used by a
  // tool but missing from that list would leave the tool unreachable by chip.
  for (const domain of domains) {
    assert.ok(declared.has(domain), `domain ${domain} used by a tool but missing from BUILTIN_TOOL_DOMAINS`);
  }
});

test("the external tool flag matches the contract in both directions", () => {
  const flagged = new Set();
  for (const file of readdirSync(agentDir).filter((name) => name.endsWith("-tools.ts"))) {
    const text = readFileSync(join(agentDir, file), "utf8");
    for (const match of text.matchAll(
      /name:\s*"([^"]+)"(?:(?!name:\s*")[\s\S])*?availableToExternal:\s*true/g,
    )) {
      flagged.add(match[1]);
    }
  }

  const contractDir = join(repoRoot, "packages", "agent-contracts", "src");
  const contracted = new Set();
  for (const file of ["external-mail.ts", "external-write-mail.ts"]) {
    const text = readFileSync(join(contractDir, file), "utf8");
    for (const match of text.matchAll(/toolName:\s*"([^"]+)"/g)) contracted.add(match[1]);
  }

  assert.deepEqual(
    [...flagged].sort(),
    [...contracted].sort(),
    "availableToExternal:true tools and @nami/agent-contracts' external tools disagree; update both",
  );

  const broker = readFileSync(
    join(repoRoot, "apps", "desktop", "src", "agent", "desktop-broker.mts"),
    "utf8",
  );
  assert.match(
    broker,
    /externalReadMailContracts\.map/,
    "the broker must derive its allow-list from the contract, not a local copy",
  );
});

test("both locales describe every catalog entry and no orphan descriptions", () => {
  const catalogKeys = new Set(catalogEntries().map((entry) => entry.descKey));

  for (const locale of LOCALES) {
    const messages = messagesOf(locale);
    const prefix = "settings.tools.builtin.";
    const suffix = ".desc";

    for (const descKey of catalogKeys) {
      const key = `${prefix}${descKey}${suffix}`;
      const value = messages[key];
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty ${key}`);
    }

    const translated = Object.keys(messages)
      .filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
      .map((key) => key.slice(prefix.length, -suffix.length));
    const orphans = translated.filter((descKey) => !catalogKeys.has(descKey));
    assert.deepEqual(orphans, [], `${locale} describes tools the catalog does not list`);
  }
});
