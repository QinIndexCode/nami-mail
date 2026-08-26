#!/usr/bin/env node
/**
 * Sync repository documentation into the static site for GitHub Pages.
 *
 * - Copies `docs/` into `site/docs/` (so the docs site works over the Pages CDN,
 *   no runtime dependency on raw.githubusercontent.com).
 * - Copies root project documents (SUPPORT / SECURITY / CONTRIBUTING /
 *   CODE_OF_CONDUCT / CHANGELOG) into `site/docs/_root/`.
 * - Generates `site/docs/docs-manifest.json`: grouped topic list with
 *   per-language file paths and h1 titles, used by the docs site sidebar,
 *   routing and search.
 *
 * Usage:  node scripts/sync-docs.mjs
 */
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, posix } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDocs = join(root, "docs");
const siteDocs = join(root, "site", "docs");

const ROOT_DOCS = ["SUPPORT", "SECURITY", "CONTRIBUTING", "CODE_OF_CONDUCT", "CHANGELOG"];

const LANG_EXT = { zh: ".zh-CN.md", en: ".en.md" };

// Group order and labels (zh / en). Any unknown directory falls back to "misc".
const GROUPS = [
  { id: "guide", label: { zh: "使用指南", en: "Guide" } },
  { id: "agent", label: { zh: "Agent", en: "Agent" } },
  { id: "rag", label: { zh: "邮件检索 (RAG)", en: "Mail search (RAG)" } },
  { id: "mcp", label: { zh: "MCP Server", en: "MCP Server" } },
  { id: "cli", label: { zh: "CLI 命令行", en: "CLI" } },
  { id: "development", label: { zh: "开发", en: "Development" } },
  { id: "releases", label: { zh: "版本发布", en: "Releases" } },
  { id: "root", label: { zh: "项目文档", en: "Project" } },
  { id: "misc", label: { zh: "其他", en: "Misc" } },
];

function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, base));
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

function versionSort(a, b) {
  const va = a.match(/(\d+)\.(\d+)\.(\d+)/);
  const vb = b.match(/(\d+)\.(\d+)\.(\d+)/);
  if (va && vb) {
    for (let i = 1; i <= 3; i++) {
      if (+va[i] !== +vb[i]) return +vb[i] - +va[i]; // newest first
    }
    return 0;
  }
  return a.localeCompare(b);
}

function groupOf(relPath) {
  const seg = relPath.split("/")[0];
  if (seg === "_root") return "root";
  if (relPath.includes("/")) return GROUPS.find((g) => g.id === seg) ? seg : "misc";
  return "guide";
}

function naturalSort(a, b) {
  const aFile = a.id.includes("releases/") ? a.id.split("/").pop() : a.id;
  const bFile = b.id.includes("releases/") ? b.id.split("/").pop() : b.id;
  if (a.id.startsWith("releases/") && b.id.startsWith("releases/")) {
    return versionSort(aFile, bFile);
  }
  const na = aFile.match(/(\d+)/);
  const nb = bFile.match(/(\d+)/);
  if (na && nb) return +na[1] - +nb[1];
  return aFile.localeCompare(bFile, "en");
}

function buildManifest() {
  const byId = new Map();

  for (const rel of walk(siteDocs, siteDocs)) {
    // Only language-suffixed files become topics.
    let id = null;
    let lang = null;
    for (const [l, ext] of Object.entries(LANG_EXT)) {
      if (rel.endsWith(ext)) {
        id = rel.slice(0, -ext.length);
        lang = l;
        break;
      }
    }
    if (!id) continue;

    const text = readFileSync(join(siteDocs, rel), "utf8");
    const entry = byId.get(id) || { id, group: groupOf(rel), title: {}, files: {} };
    entry.title[lang] = extractTitle(text, id.split("/").pop());
    entry.files[lang] = rel;
    byId.set(id, entry);
  }

  const grouped = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: [],
  }));
  const items = [...byId.values()].sort(naturalSort);
  for (const it of items) {
    const g = grouped.find((x) => x.id === it.group);
    if (g) g.items.push({ id: it.id, title: it.title, files: it.files });
  }

  return {
    generated: new Date().toISOString().slice(0, 10),
    groups: grouped.filter((g) => g.items.length > 0),
  };
}

function main() {
  if (!existsSync(srcDocs)) {
    console.error("docs/ not found at " + srcDocs);
    process.exit(1);
  }

  // 1. Fresh copy of the full docs tree (keeps images and language pairs).
  rmSync(siteDocs, { recursive: true, force: true });
  mkdirSync(siteDocs, { recursive: true });
  cpSync(srcDocs, siteDocs, { recursive: true });

  // 2. Root project documents live under site/docs/_root so that
  //    `../SUPPORT.zh-CN.md` style links keep working after rewriting.
  const rootDir = join(siteDocs, "_root");
  mkdirSync(rootDir, { recursive: true });
  for (const name of ROOT_DOCS) {
    for (const lang of ["zh", "en"]) {
      const file = name + (lang === "zh" ? ".zh-CN.md" : ".en.md");
      const src = join(root, file);
      if (existsSync(src)) cpSync(src, join(rootDir, file));
    }
  }

  // 3. Manifest.
  const manifest = buildManifest();
  writeFileSync(join(siteDocs, "docs-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const count = manifest.groups.reduce((n, g) => n + g.items.length, 0);
  console.log(`docs synced -> ${relative(root, siteDocs)}`);
  console.log(`${count} topics in ${manifest.groups.length} groups; manifest written.`);
}

main();
