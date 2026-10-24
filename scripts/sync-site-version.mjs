#!/usr/bin/env node
/**
 * Keep every hand-maintained copy of the current release version in step with
 * package.json, which is the single source of truth.
 *
 * Two kinds of surface are covered.
 *
 * Repairable — derived from the version, with no release-specific prose, so it
 * can be rewritten mechanically by `syncSiteVersion`:
 *   - the hero version badge in site/index.html
 *   - the `namimail version` sample output in docs/cli/examples.{en,zh-CN}.md
 *   - the `meta.version` sample output in docs/cli/output-schema.{en,zh-CN}.md
 *
 * Verified — sentences written per release, which no script may invent, because
 * guessing them would silently label one release with another's notes.
 * `verifyVersionReferences` throws and names the file to edit:
 *   - each README's release section, pinned by a `<!-- whats-new: vX.Y.Z -->`
 *     marker and required to link the notes for the current version
 *   - the release index entries in docs/releases/README.{en,zh-CN}.md
 *   - the current-release claim in docs/RELEASING.{en,zh-CN}.md
 *   - the existence of docs/releases/v<version>.{en,zh-CN}.md
 *
 * `--check` reports drift instead of writing, so CI fails on a stale landing
 * page rather than silently repairing a checkout nobody commits.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Documentation languages that carry their own copy of the version. */
const DOC_LANGUAGES = ["en", "zh-CN"];

/** Surfaces whose content is derived from the version and safe to rewrite. */
function repairableSurfaces(version) {
  return [
    {
      file: "site/index.html",
      label: "hero version badge",
      pattern: /<span class="meta-tag">v[^<]+<\/span>/,
      replacement: `<span class="meta-tag">v${version}</span>`,
      missing: 'site/index.html is missing a <span class="meta-tag">v...</span> hero version tag',
    },
    ...DOC_LANGUAGES.map((lang) => ({
      file: `docs/cli/examples.${lang}.md`,
      label: "`namimail version` sample output",
      pattern: /\{"name":"NamiMail","version":"[^"]*"\}/,
      replacement: `{"name":"NamiMail","version":"${version}"}`,
      missing: `docs/cli/examples.${lang}.md is missing the {"name":"NamiMail","version":"..."} sample output`,
    })),
    ...DOC_LANGUAGES.map((lang) => ({
      file: `docs/cli/output-schema.${lang}.md`,
      label: "`meta.version` sample output",
      pattern: /"version": "[^"]*"/,
      replacement: `"version": "${version}"`,
      missing: `docs/cli/output-schema.${lang}.md is missing a "version": "..." meta sample`,
    })),
  ];
}

/** The marker a README carries on the line above its release section. */
export function whatsNewMarker(version) {
  return `<!-- whats-new: v${version} -->`;
}

export function readPackageVersion(repoRoot) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const version = manifest.version?.trim();
  if (!version) {
    throw new Error("package.json is missing a valid version string");
  }
  return version;
}

export function syncSiteVersion({ repoRoot = defaultRepoRoot, checkOnly = false } = {}) {
  const version = readPackageVersion(repoRoot);
  const stale = [];

  for (const surface of repairableSurfaces(version)) {
    const filePath = join(repoRoot, surface.file);
    // Fixture roots and partial checkouts may not carry every documentation
    // surface. A surface that is present but unparseable is still an error.
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    const match = content.match(surface.pattern);
    if (!match) throw new Error(surface.missing);
    if (match[0] !== surface.replacement) {
      stale.push({ surface, filePath, content, found: match[0] });
    }
  }

  if (stale.length > 0 && checkOnly) {
    const details = stale
      .map((entry) => `${entry.surface.file}: found ${entry.found}, expected ${entry.surface.replacement}`)
      .join("\n");
    throw new Error(
      `Version references are out of sync with package.json (v${version}):\n${details}\n` +
        'Run "npm run sync:version" or "npm run build:site" to synchronize.'
    );
  }

  for (const entry of stale) {
    writeFileSync(entry.filePath, entry.content.replace(entry.surface.pattern, entry.surface.replacement), "utf8");
    console.log(`[sync-site-version] ${entry.surface.file}: ${entry.surface.label} -> v${version}`);
  }

  return { version, updated: stale.length > 0, updatedFiles: stale.map((entry) => entry.surface.file) };
}

/** Every reason the published documents fail to describe the current release. */
export function findVersionReferenceProblems({ repoRoot = defaultRepoRoot, version = readPackageVersion(repoRoot) } = {}) {
  const problems = [];
  const readIfPresent = (file) => {
    const filePath = join(repoRoot, file);
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  };

  const readmes = [
    { file: "README.md", lang: "en" },
    { file: "README.en.md", lang: "en" },
    { file: "README.zh-CN.md", lang: "zh-CN" },
  ];
  for (const { file, lang } of readmes) {
    const content = readIfPresent(file);
    if (content === null) {
      problems.push(`${file} is missing`);
      continue;
    }
    const marker = whatsNewMarker(version);
    if (!content.includes(marker)) {
      problems.push(`  ${file}: add "${marker}" on the line above the section that describes v${version}`);
    }
    const link = `docs/releases/v${version}.${lang}.md`;
    if (!content.includes(link)) {
      problems.push(`  ${file}: the v${version} section must link ${link}`);
    }
  }

  for (const lang of DOC_LANGUAGES) {
    const file = `docs/releases/README.${lang}.md`;
    const content = readIfPresent(file);
    if (content === null) {
      problems.push(`${file} is missing`);
      continue;
    }
    const entry = `(v${version}.${lang}.md)`;
    if (!content.includes(entry)) {
      problems.push(`  ${file}: add a bullet for the current release linking ${entry}`);
    }
  }

  for (const lang of DOC_LANGUAGES) {
    const file = `docs/RELEASING.${lang}.md`;
    const content = readIfPresent(file);
    if (content === null) {
      problems.push(`${file} is missing`);
      continue;
    }
    const claim = `releases/v${version}.md`;
    if (!content.includes(claim)) {
      problems.push(`  ${file}: name the current release notes as ${claim}`);
    }
  }

  for (const lang of DOC_LANGUAGES) {
    const note = `docs/releases/v${version}.${lang}.md`;
    if (!existsSync(join(repoRoot, note))) {
      problems.push(`${note} is missing: every published language needs notes for the current release`);
    }
  }

  return problems;
}

/** Throws unless the published documents describe the current release. */
export function verifyVersionReferences(options = {}) {
  const problems = findVersionReferenceProblems(options);
  if (problems.length > 0) {
    throw new Error(
      "The published documents do not describe the current release:\n" +
        problems.join("\n") +
        "\nUpdate them together with the version bump, so the landing page never advertises a past release."
    );
  }
  return { problems: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const checkOnly = process.argv.includes("--check");
    const result = syncSiteVersion({ checkOnly });
    const state = checkOnly ? "verified" : result.updated ? "synchronized" : "already up to date";
    console.log(`[sync-site-version] version surfaces ${state} (v${result.version})`);
    verifyVersionReferences();
    console.log(`[sync-site-version] published documents describe v${result.version}`);
  } catch (error) {
    console.error(`sync-site-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
