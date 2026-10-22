/**
 * Pins the claim checks that keep docs/ honest about the code.
 *
 * The failure mode these guard against was real on the 2026-10 branch: 44 pages
 * still advertised a 0.4.0 installer after the package reached 0.5.1, two
 * pages denied that the external interface writes mail while counting the seven
 * write tools in the same paragraph, the CHANGELOG lost its `[Unreleased]`
 * heading, and no page said which release it described, so branch behaviour
 * read as a documentation bug instead of an unreleased change.
 *
 * Every fixture is a throwaway repository under the OS temp directory, so the
 * rules are proven against a controlled document set rather than by trusting
 * the current state of docs/ (which the last test in this file does check).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  findClaimProblems,
  fixLine,
  isTrunkDocument,
  readFacts,
  syncClaimSurfaces,
  trunkDocuments,
} from "../docs-claims.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

const factsFor = (overrides = {}) => ({
  version: "1.2.3",
  readTools: 9,
  writeTools: 7,
  totalTools: 16,
  ...overrides,
});

function contractSource(name, count) {
  const entries = Array.from(
    { length: count },
    (_, index) => `  {\n    toolName: "tool.${index}",\n    cliWords: ["tool"],\n  },`,
  ).join("\n");
  return `export const ${name} = [\n${entries}\n] as const;\n`;
}

function writeRepoFile(root, relative, text) {
  const absolute = join(root, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
}

function makeRepo(t, { version = "1.2.3", readTools = 9, writeTools = 7, documents = {}, changelogs = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nami-docs-claims-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeRepoFile(root, "package.json", JSON.stringify({ name: "nami-claims-test", version }));
  writeRepoFile(root, "packages/agent-contracts/src/external-mail.ts", contractSource("externalReadMailContracts", readTools));
  writeRepoFile(root, "packages/agent-contracts/src/external-write-mail.ts", contractSource("externalWriteMailContracts", writeTools));
  for (const [relative, text] of Object.entries(documents)) writeRepoFile(root, relative, text);
  for (const [relative, text] of Object.entries(changelogs)) writeRepoFile(root, relative, text);
  return root;
}

const CHANGELOG = "## [Unreleased]\n\n### Fixed\n\n- something noted\n\n## [1.2.3] - 2026-01-01\n\n- shipped\n";

test("package.json exposes docs:claims and docs:claims:check", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["docs:claims"], "node scripts/docs-claims.mjs");
  assert.equal(pkg.scripts["docs:claims:check"], "node scripts/docs-claims.mjs --check");
});

test("readFacts counts the external contracts and the package version", () => {
  const facts = readFacts({ repoRoot });
  assert.equal(facts.version, JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version);
  assert.equal(facts.readTools + facts.writeTools, facts.totalTools);
  assert.ok(facts.readTools > 0 && facts.writeTools > 0, "both contract sets must be counted");
});

test("isTrunkDocument skips the pages a past version owns", () => {
  assert.equal(isTrunkDocument("README.zh-CN.md"), true);
  assert.equal(isTrunkDocument("docs/PRIVACY.zh-CN.md"), true);
  assert.equal(isTrunkDocument("docs/releases/v0.5.1.zh-CN.md"), false);
  assert.equal(isTrunkDocument("docs/CHANGELOG.zh-CN.md"), false);
  assert.equal(isTrunkDocument("CHANGELOG.en.md"), false);
  assert.equal(isTrunkDocument("docs/development/migration-plan.zh-CN.md"), true);
  assert.equal(isTrunkDocument("docs/development/rag-index-plan-progress.archive.zh-CN.md"), false);
});

test("trunkDocuments lists every page but the archived and released ones", (t) => {
  const root = makeRepo(t, {
    documents: {
      "README.zh-CN.md": "# readme\n",
      "docs/PRIVACY.zh-CN.md": "# privacy\n",
      "docs/releases/v1.2.3.zh-CN.md": "# release\n",
      "docs/development/old.archive.zh-CN.md": "# archived\n",
    },
  });
  assert.deepEqual(trunkDocuments(root), ["README.zh-CN.md", "docs/PRIVACY.zh-CN.md"]);
});

test("fixLine rewrites a build-status version that is not the package version", () => {
  const { next, problems } = fixLine("> **当前构建状态：可用。** 0.4.0 安装包随附 CLI。", factsFor());
  assert.match(next, /1\.2\.3 安装包/);
  assert.doesNotMatch(next, /0\.4\.0/);
  assert.equal(problems.length, 1);
});

test("fixLine leaves an accurate build-status version alone", () => {
  const line = "> **Current-build status: available.** The 1.2.3 installer ships the CLI.";
  const { next, problems } = fixLine(line, factsFor());
  assert.equal(next, line);
  assert.deepEqual(problems, []);
});

test("fixLine keeps Chinese tool counts in the notation the page used", () => {
  const line = "> **当前构建状态：可用。** 1.2.3 安装包随附十六个工具：九个只读 + 七个写。";
  const { next, problems } = fixLine(line, factsFor({ readTools: 10, writeTools: 7, totalTools: 17 }));
  assert.match(next, /十七个工具：十个只读 \+ 七个写/);
  assert.deepEqual(problems, [
    "states 十六 工具, but the external contract has 17",
    "states 九 只读, but the external contract has 10",
  ]);
});

test("fixLine keeps English tool counts as words", () => {
  const line = "It ships exactly sixteen tools (nine read-only and seven write).";
  const { next } = fixLine(line, factsFor({ readTools: 9, writeTools: 6, totalTools: 15 }));
  assert.match(next, /exactly fifteen tools/);
  assert.match(next, /nine read-only/);
  assert.match(next, /six write/);
});

test("fixLine leaves the agent's own tool list and unrelated counts alone", () => {
  for (const line of [
    "单次最多加载 100 个工具；超大结果会截断。",
    "内置 33 个内置工具供 Agent 调用。",
    "A single server may contribute one hundred tools.",
  ]) {
    assert.equal(fixLine(line, factsFor()).next, line);
  }
});

test("a page that denies writing mail while counting write tools is reported", (t) => {
  const root = makeRepo(t, {
    documents: {
      "README.zh-CN.md": "<!-- shipped-as: v1.2.3 -->\n\n本机、只读。共 16 个工具：9 个只读 + 7 个写。\n",
    },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  const problems = findClaimProblems({ repoRoot: root });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /README\.zh-CN\.md:3/);
  assert.match(problems[0], /默认只读/);
});

test("a behaviour page without a released-scope marker is reported", (t) => {
  const root = makeRepo(t, {
    documents: { "docs/PRIVACY.zh-CN.md": "# 隐私\n\n本页说明加密边界。\n" },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  const problems = findClaimProblems({ repoRoot: root });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /docs\/PRIVACY\.zh-CN\.md does not say which release it describes/);
});

test("a scope marker newer than the package version is reported", (t) => {
  const root = makeRepo(t, {
    documents: { "docs/PRIVACY.zh-CN.md": "<!-- shipped-as: v9.9.9 -->\n\n# 隐私\n" },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  const problems = findClaimProblems({ repoRoot: root });
  assert.match(problems.join("\n"), /claims to describe v9\.9\.9, which is newer/);
});

test("both changelogs must carry an [Unreleased] section", (t) => {
  const root = makeRepo(t, {
    documents: { "README.zh-CN.md": "<!-- shipped-as: v1.2.3 -->\n\n# readme\n" },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": "## [1.2.3] - 2026-01-01\n\n- shipped\n" },
  });
  const problems = findClaimProblems({ repoRoot: root });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /CHANGELOG\.en\.md has no "## \[Unreleased\]" section/);
});

test("a clean repository reports no problems", (t) => {
  const root = makeRepo(t, {
    documents: {
      "README.zh-CN.md": "<!-- shipped-as: v1.2.3 -->\n\n> **当前构建状态：可用。** 1.2.3 安装包随附十六个工具：九个只读 + 七个写。\n",
      "docs/PRIVACY.zh-CN.md": "<!-- shipped-as: v1.2.3 -->\n\n# 隐私\n",
    },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  assert.deepEqual(findClaimProblems({ repoRoot: root }), []);
});

test("syncClaimSurfaces rewrites the stale surfaces, keeps CRLF and is idempotent", (t) => {
  const root = makeRepo(t, {
    documents: {
      "docs/agent/runtime.zh-CN.md": "> **当前构建状态：可用。** 0.4.0 安装包随附十六个工具：九个只读 + 七个写。\r\n",
    },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  const first = syncClaimSurfaces({ repoRoot: root });
  assert.deepEqual(first.updated, ["docs/agent/runtime.zh-CN.md"]);
  const rewritten = readFileSync(join(root, "docs/agent/runtime.zh-CN.md"), "utf8");
  assert.match(rewritten, /1\.2\.3 安装包/);
  assert.match(rewritten, /\r\n/, "the rewrite must not normalise line endings");

  const second = syncClaimSurfaces({ repoRoot: root });
  assert.deepEqual(second.updated, [], "a second pass must find nothing to rewrite");
});

test("syncClaimSurfaces does not write when asked to check only", (t) => {
  const original = "> **当前构建状态：可用。** 0.4.0 安装包随附 CLI。\n";
  const root = makeRepo(t, {
    documents: { "docs/cli/README.zh-CN.md": original },
    changelogs: { "CHANGELOG.zh-CN.md": CHANGELOG, "CHANGELOG.en.md": CHANGELOG },
  });
  const result = syncClaimSurfaces({ repoRoot: root, checkOnly: true });
  assert.deepEqual(result.updated, ["docs/cli/README.zh-CN.md"]);
  assert.equal(readFileSync(join(root, "docs/cli/README.zh-CN.md"), "utf8"), original);
});
