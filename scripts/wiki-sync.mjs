#!/usr/bin/env node
/**
 * Generate and merge the GitHub Wiki tree from `docs/`.
 *
 * GitHub Wiki is a flat page repository (`<owner>/<repo>.wiki.git`): every
 * page is a top-level Markdown file and the homepage is `Home.md`. This script
 * flattens the two-language docs tree into wiki page names without collisions
 * and writes the navigation pages the wiki cannot derive from a directory
 * layout:
 *
 * - `Home.md` / `Home.zh-CN.md`: generated index with a language switch and
 *   the same topic groups the docs site uses.
 * - `_Sidebar.md`: compact grouped navigation for the wiki sidebar.
 * - `.wiki-sync.json`: the generated page list, so a later sync can remove
 *   pages that no longer exist in docs/ while leaving hand-written wiki pages
 *   untouched.
 *
 * Page names keep the language suffix and flatten subdirectories with `-`:
 * `docs/agent/usage.en.md` -> `agent-usage.en.md`, `docs/INSTALLING.en.md`
 * stays `INSTALLING.en.md`. A collision (for example an `a/b.en.md` next to
 * `a-b.en.md`) fails the build instead of silently overwriting.
 *
 * Usage:
 *   node scripts/wiki-sync.mjs --out <dir>               # generate the full tree
 *   node scripts/wiki-sync.mjs --out <dir> --docs <dir>  # generate from another docs root
 *   node scripts/wiki-sync.mjs --sync --tree <dir> --wiki <dir>
 *                                                        # merge a generated tree into a
 *                                                        # checked-out wiki clone
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const LANG_EXT = { zh: ".zh-CN.md", en: ".en.md" };
const HOME_PAGES = { en: "Home.md", zh: "Home.zh-CN.md" };
const SIDEBAR_PAGE = "_Sidebar.md";
const MANIFEST = ".wiki-sync.json";

// Topic groups and labels (zh / en), matching scripts/sync-docs.mjs. Unknown
// directories fall back to "misc". "root" is not used here: the wiki tree
// never includes repository-root documents.
const GROUPS = [
  { id: "guide", label: { zh: "使用指南", en: "Guide" } },
  { id: "agent", label: { zh: "Agent", en: "Agent" } },
  { id: "rag", label: { zh: "邮件检索 (RAG)", en: "Mail search (RAG)" } },
  { id: "mcp", label: { zh: "MCP Server", en: "MCP Server" } },
  { id: "cli", label: { zh: "CLI 命令行", en: "CLI" } },
  { id: "development", label: { zh: "开发", en: "Development" } },
  { id: "releases", label: { zh: "版本发布", en: "Releases" } },
  { id: "misc", label: { zh: "其他", en: "Misc" } },
];

function walkMarkdown(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkMarkdown(full, base));
    } else if (name.endsWith(".md")) {
      out.push(relative(base, full).split("\\").join("/"));
    }
  }
  return out;
}

function extractTitle(text, fallback) {
  const match = /^#\s+(.+?)\s*$/m.exec(text.replace(/^\uFEFF/, "").trimStart());
  if (match) return match[1].replace(/[*_`]/g, "").trim();
  return fallback;
}

function groupOf(relPath) {
  const seg = relPath.split("/")[0];
  if (relPath.includes("/")) return GROUPS.some((g) => g.id === seg) ? seg : "misc";
  return "guide";
}

/**
 * Map every language-suffixed docs file to its flat wiki page name. The
 * homepage sources (`docs/README.*.md`) are returned separately.
 */
export function collectWikiPages(docsDir) {
  const pages = [];
  for (const rel of walkMarkdown(docsDir, docsDir)) {
    let ext = null;
    for (const suffix of Object.values(LANG_EXT)) {
      if (rel.endsWith(suffix)) {
        ext = suffix;
        break;
      }
    }
    if (!ext) continue; // README.md and other unsuffixed files are not topics.
    const id = rel.slice(0, -ext.length);
    if (id === "README") continue; // becomes the wiki homepage below.
    pages.push({ id, sourceRel: rel, pageName: id.replaceAll("/", "-") + ext });
  }
  const seen = new Set();
  for (const page of pages) {
    if (seen.has(page.pageName)) {
      throw new Error(
        `Wiki page collision: "${page.sourceRel}" and another docs file both map to "${page.pageName}". Rename one of them.`,
      );
    }
    seen.add(page.pageName);
  }
  return pages;
}

function readSource(docsDir, rel) {
  return readFileSync(join(docsDir, rel), "utf8");
}

function groupLines(pages) {
  const groups = GROUPS.map((g) => ({ ...g, items: [] }));
  for (const page of pages) {
    groups.find((g) => g.id === groupOf(page.sourceRel)).items.push(page);
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Write the complete generated wiki tree (pages + homepage + sidebar +
 * manifest) into outDir. outDir is replaced entirely.
 */
export function buildWikiTree(docsDir, outDir) {
  const pages = collectWikiPages(docsDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const page of pages) {
    writeFileSync(join(outDir, page.pageName), readSource(docsDir, page.sourceRel), "utf8");
  }

  const groups = groupLines(pages);
  const homeEn = ["# Nami Mail Wiki", ""];
  const homeZh = ["# Nami Mail Wiki", ""];
  const sidebar = ["**Nami Mail**", "- [Home](Home.md)", "- [Home 中文](Home.zh-CN.md)", ""];
  const navLine = "[English](Home.md) | [简体中文](Home.zh-CN.md)";
  homeEn.push(navLine, "", "This wiki is maintained in the [docs/](https://github.com/QinIndexCode/nami-mail/tree/main/docs) directory and synced by the Sync Wiki workflow.", "");
  homeZh.push(navLine, "", "本 Wiki 由 [docs/](https://github.com/QinIndexCode/nami-mail/tree/main/docs) 目录维护，并由 Sync Wiki workflow 自动同步。", "");

  for (const group of groups) {
    homeEn.push(`## ${group.label.en} / ${group.label.zh}`, "");
    homeZh.push(`## ${group.label.zh} / ${group.label.en}`, "");
    sidebar.push(`**${group.label.en}**`);
    const ids = [...new Set(group.items.map((p) => p.id))];
    for (const id of ids) {
      const en = group.items.find((p) => p.pageName.endsWith(".en.md") && p.id === id);
      const zh = group.items.find((p) => p.pageName.endsWith(".zh-CN.md") && p.id === id);
      const enTitle = en ? extractTitle(readSource(docsDir, en.sourceRel), en.pageName) : null;
      const zhTitle = zh ? extractTitle(readSource(docsDir, zh.sourceRel), zh.pageName) : null;
      if (en) {
        homeEn.push(`- [${enTitle}](${en.pageName})${zh ? ` · [简体中文](${zh.pageName})` : ""}`);
        sidebar.push(`- [${enTitle}](${en.pageName})${zh ? ` · [中文](${zh.pageName})` : ""}`);
      }
      if (zh) {
        homeZh.push(`- [${zhTitle}](${zh.pageName})${en ? ` · [English](${en.pageName})` : ""}`);
        if (!en) sidebar.push(`- [${zhTitle}](${zh.pageName})`);
      }
    }
    homeEn.push("");
    homeZh.push("");
    sidebar.push("");
  }

  writeFileSync(join(outDir, HOME_PAGES.en), homeEn.join("\n"), "utf8");
  writeFileSync(join(outDir, HOME_PAGES.zh), homeZh.join("\n"), "utf8");
  writeFileSync(join(outDir, SIDEBAR_PAGE), sidebar.join("\n"), "utf8");

  const manifest = {
    generated: new Date().toISOString().slice(0, 10),
    files: Object.fromEntries([
      [HOME_PAGES.en, "docs/README.en.md"],
      [HOME_PAGES.zh, "docs/README.zh-CN.md"],
      [SIDEBAR_PAGE, "generated"],
      ...pages.map((p) => [p.pageName, p.sourceRel]),
    ]),
  };
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return pages.length;
}

/**
 * Merge a generated tree into a checked-out wiki clone: remove pages the
 * previous sync created that no longer exist, copy the new tree, and update
 * the manifest. Hand-written wiki pages (not listed in the old manifest) are
 * preserved.
 */
export function syncWikiTree(treeDir, wikiDir) {
  if (!existsSync(join(wikiDir, ".git"))) {
    throw new Error(`Not a git clone: ${wikiDir}`);
  }
  const manifestPath = join(wikiDir, MANIFEST);
  let previous = [];
  if (existsSync(manifestPath)) {
    try {
      previous = Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).files ?? {});
    } catch {
      previous = [];
    }
  }
  let removed = 0;
  for (const name of previous) {
    if (name === MANIFEST) continue;
    const full = join(wikiDir, name);
    if (existsSync(full)) {
      rmSync(full, { force: true });
      removed += 1;
    }
  }
  cpSync(treeDir, wikiDir, { recursive: true });
  console.log(`wiki sync: removed ${removed} stale page(s), copied ${previous.length} generated file(s) from tree.`);
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      docs: { type: "string", default: join(repoRoot, "docs") },
      sync: { type: "boolean", default: false },
      tree: { type: "string" },
      wiki: { type: "string" },
    },
  });
  try {
    if (values.sync) {
      if (!values.tree || !values.wiki) throw new Error("--sync requires --tree and --wiki.");
      syncWikiTree(values.tree, values.wiki);
      return;
    }
    if (!values.out) throw new Error("Missing --out <dir>.");
    const count = buildWikiTree(values.docs, values.out);
    console.log(`wiki tree -> ${values.out}`);
    console.log(`${count} pages, ${HOME_PAGES.en} / ${HOME_PAGES.zh}, ${SIDEBAR_PAGE} written.`);
  } catch (error) {
    console.error(`wiki-sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
