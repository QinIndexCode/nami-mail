#!/usr/bin/env node
/**
 * Keeps the factual claims in the published documents derived from the code
 * that owns them.
 *
 * `scripts/sync-site-version.mjs` already keeps the *release version* in step
 * across the handful of surfaces that quote it. This module covers the other
 * hand-maintained facts, which drifted repeatedly during the 2026-10 branch:
 *
 * - the "current build status" blockquote near the top of 44 documents still
 *   advertised 0.4.0 while package.json said 0.5.1;
 * - the same documents count the external CLI/MCP tools in prose ("恰好十六个
 *   工具：九个只读 + 七个写"), so a contract change silently outdates them;
 * - several documents called the external interface read-only while the
 *   contract shipped seven write tools and their own neighbours said so;
 * - CHANGELOG lost its `[Unreleased]` heading, so trunk changes had nowhere to
 *   go and the roadmap kept pointing at a section that did not exist;
 * - behaviour documents never say which release they describe, so a branch
 *   that adds a behaviour makes them look wrong instead of out of date.
 *
 * Two tiers, mirroring sync-site-version.mjs:
 *   repairable — a fact this module rewrites (or reports under `--check`);
 *   asserted   — a claim a human must re-word; the check names file and line.
 *
 * Usage:
 *   node scripts/docs-claims.mjs            # rewrite the repairable surfaces
 *   node scripts/docs-claims.mjs --check    # report every problem, exit 1
 *
 * Documents that are immutable by definition are never inspected: release
 * notes under `docs/releases/`, the CHANGELOG bodies, and `*.archive.*` pages.
 * They record what a past version shipped and must keep saying exactly that.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The blockquote that opens every CLI/MCP page and the root READMEs. */
const STATUS_LINE = /^>\s*\*\*(?:当前构建状态|Current-build status)/;

/** Claim words that mean "the external read tier" / "the external write tier". */
const READ_TIER = /^(?:只读|read-only)$/;
const WRITE_TIER = /^(?:写|受限写|write)$/;
const TOTAL_TIER = /^(?:工具|tools?)$/;

/**
 * Documents that state which release their behaviour claims describe.
 *
 * Adding behaviour to the branch does not make these wrong; it makes them a
 * statement about the current release. The marker is what lets the release
 * review list the pages that must be rewritten at the version cut.
 */
const SCOPED_DOCUMENTS = [
  "README.md",
  "README.zh-CN.md",
  "README.en.md",
  "docs/PRIVACY.zh-CN.md",
  "docs/PRIVACY.en.md",
  "docs/ARCHITECTURE.zh-CN.md",
  "docs/ARCHITECTURE.en.md",
  "docs/CALENDAR.zh-CN.md",
  "docs/CALENDAR.en.md",
  "docs/EXTERNAL-MAIL-INTERFACE.zh-CN.md",
  "docs/EXTERNAL-MAIL-INTERFACE.en.md",
];

const SHIPPED_AS = /<!--\s*shipped-as:\s*v?(\d+\.\d+\.\d+)\s*-->/;

/**
 * Absolute read-only claims. The external interface defaults to read-only but
 * ships seven write tools behind `send-confirmed` and `full-access`, so a
 * document that also counts those tools must not also deny them.
 */
const ABSOLUTE_READ_ONLY = [
  { pattern: /不会写入邮件/, wording: "不会写入邮件", approved: "默认只读，可在桌面设置中提升" },
  { pattern: /本机、只读/, wording: "本机、只读", approved: "已配对、本机，默认只读" },
  { pattern: /只读\s*(?:的\s*)?CLI/i, wording: "只读 CLI", approved: "默认只读，可在桌面设置中提升" },
  { pattern: /never\s+write\s+mail/i, wording: "never write mail", approved: "read-only by default, promoted in desktop settings" },
  { pattern: /paired,\s+local,\s*read-only(?!\s+by default)/i, wording: "paired, local, read-only", approved: "paired and local, read-only by default" },
  { pattern: /read-only\s+CLI/i, wording: "read-only CLI", approved: "read-only by default, promoted in desktop settings" },
];

/** A whole-document claim that the external surface has write tools. */
const WRITE_TIER_CLAIM = /(?:[一二三四五六七八九十百零\d]+\s*个\s*(?:受限)?写|\b(?:seven|7)\s+write)/i;

/** Test-suite sizes belong to CI output, not to prose. */
const SUITE_SIZE_CLAIM = /(?:\d{2,}\s*\/\s*\d{2,}\s*项\s*(?:测试|用例|桌面)|\b\d{3,}\s+(?:passed|tests? passed))/;

const EN_NUMERALS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const EN_WORDS = Object.fromEntries(Object.entries(EN_NUMERALS).map(([word, value]) => [value, word]));
const ZH_DIGITS = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_DIGITS_OUT = Object.fromEntries(Object.entries(ZH_DIGITS).map(([glyph, value]) => [value, glyph]));

const readText = (repoRoot, relative) => readFileSync(join(repoRoot, relative), "utf8");

/** Chinese numerals up to three digits, which is all a tool count needs. */
function parseChineseNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  let total = 0;
  let digit = 0;
  for (const glyph of token) {
    if (glyph === "百") {
      total += (digit || 1) * 100;
      digit = 0;
    } else if (glyph === "十") {
      total += (digit || 1) * 10;
      digit = 0;
    } else if (glyph in ZH_DIGITS) {
      digit = ZH_DIGITS[glyph];
    } else {
      return undefined;
    }
  }
  return total + digit;
}

function formatChineseNumber(value) {
  if (value < 10) return ZH_DIGITS_OUT[value];
  if (value === 10) return "十";
  if (value < 20) return `十${ZH_DIGITS_OUT[value - 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const rest = value % 10;
    return `${ZH_DIGITS_OUT[tens]}十${rest === 0 ? "" : ZH_DIGITS_OUT[rest]}`;
  }
  return String(value);
}

/** Parses a claim token in whichever notation the document used. */
function parseCountToken(token) {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return { value: Number(trimmed), style: "arabic" };
  const lower = trimmed.toLowerCase();
  if (lower in EN_NUMERALS) return { value: EN_NUMERALS[lower], style: "english" };
  const chinese = parseChineseNumber(trimmed);
  return chinese === undefined ? undefined : { value: chinese, style: "chinese" };
}

function formatCountToken(value, style) {
  if (style === "chinese") return formatChineseNumber(value);
  if (style === "english") return EN_WORDS[value] ?? String(value);
  return String(value);
}

/** Slices the `export const <name> = [ ... ]` literal out of a TypeScript source. */
function arrayLiteral(source, name, file) {
  const start = source.indexOf(`export const ${name} = [`);
  if (start < 0) {
    throw new Error(`${file} must declare \`export const ${name} = [...];\` so the claims check can count it.`);
  }
  const end = source.slice(start).search(/\n\]/);
  if (end < 0) {
    throw new Error(`${file} must close \`${name}\` with a \`] as const;\` line so the claims check can count it.`);
  }
  return source.slice(start, start + end);
}

/** Reads the facts whose copies in prose are checked or rewritten. */
export function readFacts({ repoRoot = defaultRepoRoot } = {}) {
  const pkg = JSON.parse(readText(repoRoot, "package.json"));
  const readContractsFile = "packages/agent-contracts/src/external-mail.ts";
  const writeContractsFile = "packages/agent-contracts/src/external-write-mail.ts";
  const readContracts = arrayLiteral(readText(repoRoot, readContractsFile), "externalReadMailContracts", readContractsFile);
  const writeContracts = arrayLiteral(readText(repoRoot, writeContractsFile), "externalWriteMailContracts", writeContractsFile);
  const readTools = readContracts.match(/^\s*toolName: "/gm)?.length ?? 0;
  const writeTools = writeContracts.match(/^\s*toolName: "/gm)?.length ?? 0;
  if (readTools === 0 || writeTools === 0) {
    throw new Error("The external tool contracts listed no toolName entries; the claims check cannot count them.");
  }
  return {
    version: pkg.version,
    readTools,
    writeTools,
    totalTools: readTools + writeTools,
  };
}

/** Every Markdown page the check is allowed to touch. */
export function trunkDocuments(repoRoot = defaultRepoRoot) {
  const documents = [];
  for (const name of readdirSync(repoRoot)) {
    if (name.endsWith(".md")) documents.push(name);
  }
  // A checkout without docs/ (a test fixture, a trimmed export) still has the
  // root documents to check; the walk simply has nothing to add.
  const walk = (relativeDir) => {
    const absolute = join(repoRoot, relativeDir);
    if (!existsSync(absolute)) return;
    for (const name of readdirSync(absolute)) {
      const relative = `${relativeDir}/${name}`;
      const info = statSync(join(repoRoot, relative));
      if (info.isDirectory()) walk(relative);
      else if (name.endsWith(".md")) documents.push(relative);
    }
  };
  walk("docs");
  return documents.filter(isTrunkDocument).filter((document) => isPublished(repoRoot, document)).sort();
}

/**
 * Whether the repository publishes this page.
 *
 * A planning file the author keeps beside the checkout (`.gitignore` names some
 * of them, such as `/ARCHITECTURE-ROADMAP.zh-CN.md`) is not documentation: it
 * is never in the repository and never on the site, so rewriting or checking it
 * would be noise. Anything without git — a fixture — counts as published.
 */
function isPublished(repoRoot, document) {
  const tracked = trackedDocuments(repoRoot);
  return tracked === undefined || tracked.has(document);
}

/** One `git ls-files` per root, memoised for the process. */
const trackedCache = new Map();
function trackedDocuments(repoRoot) {
  if (trackedCache.has(repoRoot)) return trackedCache.get(repoRoot);
  let tracked;
  try {
    // Only trust the answer when this directory *is* the repository root: a
    // checkout nested inside some parent repository (a temp fixture under a
    // user profile that happens to be one) would otherwise report that parent's
    // file list and mark every document unpublished.
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolve(toplevel) !== resolve(repoRoot)) throw new Error("not the repository root");
    const output = execFileSync("git", ["ls-files", "--", "*.md", "docs"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    tracked = new Set(
      output
        .split(/\r?\n/)
        .filter((line) => line.endsWith(".md"))
        .map((line) => line.split("\\").join("/")),
    );
  } catch {
    tracked = undefined;
  }
  trackedCache.set(repoRoot, tracked);
  return tracked;
}

/** The documents a past version owns are not ours to rewrite. */
export function isTrunkDocument(relative) {
  const posix = relative.split(/[\\/]/).join("/");
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (posix.startsWith("docs/releases/")) return false;
  if (posix.startsWith("docs/archive/")) return false;
  if (/\.archive\.[A-Za-z-]+\.md$/.test(posix)) return false;
  // The changelog body is a version-by-version record; only its headings matter.
  if (/^CHANGELOG(\.[A-Za-z-]+)?\.md$/.test(base)) return false;
  return true;
}

/**
 * Fixes the tool counts and the build-status version on one line.
 *
 * Returns the rewritten line plus the problems that the rewrite could not
 * settle on its own (the caller decides whether to report or to write).
 */
export function fixLine(line, facts) {
  const problems = [];
  let next = line;

  if (STATUS_LINE.test(line)) {
    next = next.replace(/\b(\d+\.\d+\.\d+)\b/g, (token) => {
      if (token === facts.version) return token;
      problems.push(`the build-status line advertises ${token}; package.json says ${facts.version}`);
      return facts.version;
    });
  }

  // Chinese and English tool counts: "九个只读" / "7 个受限写" / "sixteen tools".
  const chineseClaim = /([一二三四五六七八九十百零\d]+)(\s*个\s*(?:受限)?)(只读|写|工具)/g;
  const englishClaim =
    /(\b\d+\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b)(\s+)(read-only|write|tools?)\b/gi;
  for (const pattern of [chineseClaim, englishClaim]) {
    next = next.replace(pattern, (match, token, separator, claim) => {
      const parsed = parseCountToken(token);
      if (!parsed) return match;
      const expected = expectedCount(claim, facts, next);
      if (expected === undefined || parsed.value === expected) return match;
      problems.push(`states ${token} ${claim}, but the external contract has ${expected}`);
      return `${formatCountToken(expected, parsed.style)}${separator}${claim}`;
    });
  }

  return { next, problems };
}

/**
 * The count a claim word refers to, or undefined when the line is not talking
 * about the external interface (the agent's own tool list is not this check).
 */
function expectedCount(claim, facts, line) {
  const normalized = claim.toLowerCase();
  if (READ_TIER.test(normalized)) return facts.readTools;
  if (WRITE_TIER.test(normalized)) return facts.writeTools;
  if (TOTAL_TIER.test(normalized)) {
    const namesATier = /只读|read-only|受限写|\bwrit(?:e|es)\b|\bwrites?\b/i.test(line);
    return namesATier ? facts.totalTools : undefined;
  }
  return undefined;
}

/** Collects every problem the trunk documents have right now. */
export function findClaimProblems({ repoRoot = defaultRepoRoot } = {}) {
  const facts = readFacts({ repoRoot });
  const problems = [];
  const documents = trunkDocuments(repoRoot);

  for (const document of documents) {
    const lines = readText(repoRoot, document).split(/\r?\n/);
    const wholeText = lines.join("\n");
    const claimsWriteTools = WRITE_TIER_CLAIM.test(wholeText);
    let reportedAbsoluteClaim = false;

    lines.forEach((line, index) => {
      const where = `${document}:${index + 1}`;
      const fixed = fixLine(line, facts);
      for (const problem of fixed.problems) problems.push(`${where} ${problem}`);

      if (SUITE_SIZE_CLAIM.test(line)) {
        problems.push(`${where} quotes a test-suite size; sizes belong to CI output, not to prose`);
      }

      if (claimsWriteTools && !reportedAbsoluteClaim) {
        for (const claim of ABSOLUTE_READ_ONLY) {
          if (!claim.pattern.test(line)) continue;
          problems.push(
            `${where} says "${claim.wording}" while the same page counts the write tools; ` +
              `state "${claim.approved}" instead`,
          );
          reportedAbsoluteClaim = true;
          break;
        }
      }
    });

    const marker = wholeText.match(SHIPPED_AS);
    if (SCOPED_DOCUMENTS.includes(document)) {
      if (!marker) {
        problems.push(
          `${document} does not say which release it describes; add <!-- shipped-as: v${facts.version} --> ` +
            "below the title so the release review can list it",
        );
      } else if (compareVersions(marker[1], facts.version) > 0) {
        problems.push(
          `${document} claims to describe v${marker[1]}, which is newer than package.json's ${facts.version}`,
        );
      }
    }
  }

  problems.push(...unreleasedProblems({ repoRoot }));
  return problems;
}

/** `[Unreleased]` is where trunk changes live; without it they live nowhere. */
function unreleasedProblems({ repoRoot }) {
  const commits = commitsPastLatestTag(repoRoot);
  const problems = [];
  for (const changelog of ["CHANGELOG.zh-CN.md", "CHANGELOG.en.md"]) {
    let text;
    try {
      text = readText(repoRoot, changelog);
    } catch {
      problems.push(`${changelog} is missing; the changelog is the only home for unreleased changes`);
      continue;
    }
    const heading = text.match(/^##\s+\[Unreleased\][^\n]*$/m);
    if (!heading) {
      problems.push(
        `${changelog} has no "## [Unreleased]" section; ${commits > 0 ? `${commits} commit(s) sit past the latest tag` : "trunk changes need one"}`,
      );
      continue;
    }
    const body = text.slice(heading.index + heading[0].length).split(/^##\s+/m)[0];
    if (commits > 0 && !/^\s*[-*]\s+\S/m.test(body)) {
      problems.push(
        `${changelog}'s [Unreleased] section is empty while ${commits} commit(s) sit past the latest tag`,
      );
    }
  }
  return problems;
}

/** Commits past the newest tag, or 0 when the checkout cannot answer. */
function commitsPastLatestTag(repoRoot) {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!tag) return 0;
    const count = execFileSync("git", ["rev-list", "--count", `${tag}..HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

function compareVersions(left, right) {
  const parse = (value) => value.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Rewrites every repairable surface, or reports drift when `checkOnly`. */
export function syncClaimSurfaces({ repoRoot = defaultRepoRoot, checkOnly = false } = {}) {
  const facts = readFacts({ repoRoot });
  const updated = [];
  for (const document of trunkDocuments(repoRoot)) {
    const before = readText(repoRoot, document);
    // Keep the file's own line endings: docs/ is checked out CRLF on Windows and
    // normalising them here would rewrite every page for no reason.
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const after = before
      .split(/\r?\n/)
      .map((line) => fixLine(line, facts).next)
      .join(eol);
    if (after === before) continue;
    updated.push(document);
    if (!checkOnly) writeFileSync(join(repoRoot, document), after, "utf8");
  }
  return { facts, updated, checkOnly };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const checkOnly = process.argv.includes("--check");
  try {
    const { facts, updated } = syncClaimSurfaces({ checkOnly });
    const factsLine =
      `[docs-claims] v${facts.version}, external tools ${facts.readTools} read + ${facts.writeTools} write`;
    if (updated.length === 0) {
      console.log(`${factsLine}; every count and status line already matches`);
    } else if (checkOnly) {
      console.log(`${factsLine}; ${updated.length} document(s) need rewriting:`);
      for (const document of updated) console.log(`  - ${document}`);
    } else {
      console.log(`${factsLine}; rewrote ${updated.length} document(s)`);
    }
    const problems = findClaimProblems();
    if (problems.length > 0) {
      console.error(`\n[docs-claims] ${problems.length} claim(s) need a human edit:`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
    console.log("[docs-claims] every claim matches its source");
  } catch (error) {
    console.error(`docs-claims: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
