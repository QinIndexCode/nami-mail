#!/usr/bin/env node
/**
 * update-contributors.mjs
 *
 * Fetches the contributor list from the GitHub API, filters out bot accounts,
 * and rewrites the <!-- contributors-start / contributors-end --> block inside
 * each target README file.
 *
 * Usage:
 *   node scripts/update-contributors.mjs
 *
 * Required environment variable (provided automatically by GitHub Actions):
 *   GITHUB_TOKEN – a token with public read access (the default GITHUB_TOKEN works).
 *
 * Optional environment variable:
 *   GITHUB_REPOSITORY – e.g. "QinIndexCode/nami-mail" (defaults to that value).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── configuration ──────────────────────────────────────────────────────────

const REPO = process.env.GITHUB_REPOSITORY ?? "QinIndexCode/nami-mail";
const TOKEN = process.env.GITHUB_TOKEN;

/** README files to update, relative to the project root. */
const README_FILES = ["README.md", "README.zh-CN.md", "README.en.md"];

/** Commit label used to format the commit count in each language. */
const COMMIT_LABEL = {
  "README.md": (n) => `${n} commit${n === 1 ? "" : "s"}`,
  "README.zh-CN.md": (n) => `${n} 次提交`,
  "README.en.md": (n) => `${n} commit${n === 1 ? "" : "s"}`,
};

const START_MARKER = "<!-- contributors-start -->";
const END_MARKER = "<!-- contributors-end -->";

// ── fetch contributors ──────────────────────────────────────────────────────

/**
 * Returns all non-bot contributors sorted by commit count descending.
 * Handles pagination automatically.
 */
async function fetchContributors() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "update-contributors-script",
  };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

  const all = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${REPO}/contributors?per_page=100&page=${page}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}\n${await res.text()}`);
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;

    all.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return all
    .filter((c) => c.type !== "Bot" && !c.login.includes("[bot]"))
    .sort((a, b) => b.contributions - a.contributions);
}

// ── build table HTML ────────────────────────────────────────────────────────

/** Number of contributor cards per table row. */
const COLS = 7;

function buildTable(contributors, labelFn) {
  if (contributors.length === 0) return "<p><em>No contributors yet.</em></p>";

  const rows = [];
  for (let i = 0; i < contributors.length; i += COLS) {
    const row = contributors.slice(i, i + COLS);
    const cells = row
      .map(
        (c) =>
          `    <td align="center">\n` +
          `      <a href="https://github.com/${c.login}">\n` +
          `        <img src="${c.avatar_url}" width="64" height="64" style="border-radius:50%" alt="${c.login}" /><br />\n` +
          `        <sub><b>${c.login}</b></sub>\n` +
          `      </a><br />\n` +
          `      <sub>${labelFn(c.contributions)}</sub>\n` +
          `    </td>`
      )
      .join("\n");
    rows.push(`  <tr>\n${cells}\n  </tr>`);
  }

  return `<table>\n${rows.join("\n")}\n</table>`;
}

// ── update a single README file ─────────────────────────────────────────────

function updateFile(filePath, table) {
  let content = readFileSync(filePath, "utf8");

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    console.warn(`  ⚠  Markers not found in ${filePath}, skipping.`);
    return false;
  }

  const before = content.slice(0, startIdx + START_MARKER.length);
  const after = content.slice(endIdx);
  const updated = `${before}\n${table}\n${after}`;

  if (updated === content) {
    console.log(`  ✓  No changes needed in ${filePath}`);
    return false;
  }

  writeFileSync(filePath, updated, "utf8");
  console.log(`  ✓  Updated ${filePath}`);
  return true;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching contributors for ${REPO} …`);
  const contributors = await fetchContributors();
  console.log(`  Found ${contributors.length} human contributor(s).`);
  contributors.forEach((c) => console.log(`  • ${c.login} (${c.contributions} commits)`));

  let anyChanged = false;
  for (const rel of README_FILES) {
    const abs = join(ROOT, rel);
    const labelFn = COMMIT_LABEL[rel] ?? ((n) => `${n} commits`);
    const table = buildTable(contributors, labelFn);
    const changed = updateFile(abs, table);
    if (changed) anyChanged = true;
  }

  // Signal to the workflow whether a commit is needed.
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${anyChanged}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
