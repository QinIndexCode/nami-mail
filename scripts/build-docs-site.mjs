#!/usr/bin/env node
/**
 * Build the static documentation site that ships with the GitHub Pages artifact.
 *
 * `docs/` stays the single source of truth. This script pre-renders it into real
 * HTML pages at build time, so the deployed site needs no Markdown runtime, no
 * CDN and no client-side routing:
 *
 * - every language-suffixed document becomes one page per language
 *   (`docs/agent/usage.zh-CN.md` -> `site/docs/agent/usage.zh-CN.html`);
 * - repository-root documents (README, SUPPORT, SECURITY, CONTRIBUTING,
 *   CODE_OF_CONDUCT, CHANGELOG) are published under `site/docs/_root/`, so the
 *   `../SUPPORT.zh-CN.md` style links keep resolving;
 * - `site/docs/index.html` is a bilingual overview of the same tree;
 * - links are rewritten from `.md` to the page that now holds the content, and
 *   headings get GitHub-compatible anchors so `#existing-fragment` links keep
 *   working;
 * - every rewritten link is verified: unresolvable targets and missing heading
 *   anchors are reported and fail the build.
 *
 * Documents without a language suffix are navigation shells (`docs/README.md`)
 * or the bilingual release note consumed by the release pipeline; they are not
 * published as pages, and links to them land on the overview.
 *
 * Usage:
 *   node scripts/build-docs-site.mjs            # build into site/
 *   node scripts/build-docs-site.mjs --report   # also list every link decision
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docsRoot = join(repoRoot, "docs");
const siteRoot = join(repoRoot, "site");
const siteDocs = join(siteRoot, "docs");
const siteAssets = join(siteRoot, "assets");

/** Canonical public origin, used for canonical and hreflang links. */
const SITE_ORIGIN = "https://qinindexcode.github.io/nami-mail/";
/** Where links to things outside the docs tree are sent instead. */
const REPO_BLOB = "https://github.com/QinIndexCode/nami-mail/blob/main/";
const REPO_URL = "https://github.com/QinIndexCode/nami-mail";

const LANG_EXT = { zh: ".zh-CN.md", en: ".en.md" };
const LANG_HTML = { zh: ".zh-CN.html", en: ".en.html" };
const LANG_TAG = { zh: "zh-CN", en: "en" };
const LANGS = ["zh", "en"];
/** Label of the language the reader would switch *to*. */
const SWITCH_LABEL = { zh: "EN", en: "中文" };
/** Overview shortcuts: a topic id plus the label and line shown on the card. */
const QUICK_LINKS = [
  {
    id: "INSTALLING",
    label: { zh: "安装与升级", en: "Install and upgrade" },
    blurb: { zh: "从 Release 安装、就地升级与卸载。", en: "Install from a release, upgrade in place, uninstall." },
  },
  {
    id: "PRIVACY",
    label: { zh: "隐私与本地数据", en: "Privacy and local data" },
    blurb: { zh: "哪些数据留在本机，数据放在哪里。", en: "What stays on your machine, and where it lives." },
  },
  {
    id: "cli/README",
    label: { zh: "CLI 参考", en: "CLI reference" },
    blurb: { zh: "namimail 命令、参数、输出与退出码。", en: "Commands, arguments, output and exit codes." },
  },
  {
    id: "mcp/README",
    label: { zh: "MCP 接入", en: "MCP setup" },
    blurb: { zh: "配对、权限档与外露的工具清单。", en: "Pairing, access levels and the exposed tools." },
  },
];

/** Repository-root documents published under `_root/`; also their sidebar order. */
const ROOT_DOCS = ["README", "SUPPORT", "SECURITY", "CONTRIBUTING", "CODE_OF_CONDUCT", "CHANGELOG"];

/**
 * Assets the landing page references, as [source, destination] pairs relative to
 * the repository root. Copying them keeps the landing page independent of how
 * the docs tree is laid out.
 */
const SITE_ASSETS = [
  ["apps/web/public/brand/mark-light.png", "brand/mark-light.png"],
  ["apps/web/public/brand/mark-dark.png", "brand/mark-dark.png"],
  ["build/icon.svg", "brand/icon.svg"],
  ["docs/nami-mail-inbox-zh.png", "nami-mail-inbox-zh.png"],
  ["docs/nami-mail-inbox-en.png", "nami-mail-inbox-en.png"],
  ["docs/nami-mail-agent-zh.png", "nami-mail-agent-zh.png"],
  ["docs/nami-mail-agent-en.png", "nami-mail-agent-en.png"],
];

// Group order and labels (zh / en). Any unknown directory falls back to "misc".
export const GROUPS = [
  {
    id: "guide",
    label: { zh: "使用指南", en: "Guide" },
    blurb: { zh: "安装、账户、隐私与日常使用。", en: "Install, accounts, privacy and everyday use." },
  },
  {
    id: "agent",
    label: { zh: "Agent", en: "Agent" },
    blurb: {
      zh: "工作区、工具授权范围、确认与审计。",
      en: "The workspace, tool scopes, confirmations and auditing.",
    },
  },
  {
    id: "rag",
    label: { zh: "邮件检索 (RAG)", en: "Mail search (RAG)" },
    blurb: {
      zh: "本地索引、页面切分、查询扩展与检索排障。",
      en: "Local index, page chunking, query expansion and troubleshooting.",
    },
  },
  {
    id: "mcp",
    label: { zh: "MCP Server", en: "MCP Server" },
    blurb: {
      zh: "把 Nami Mail 接入 MCP 客户端：配对、权限档与工具清单。",
      en: "Connect Nami Mail to an MCP client: pairing, access levels and tools.",
    },
  },
  {
    id: "cli",
    label: { zh: "CLI 命令行", en: "CLI" },
    blurb: {
      zh: "namimail 命令、参数、输出与退出码。",
      en: "The namimail command, its arguments, output and exit codes.",
    },
  },
  {
    id: "development",
    label: { zh: "开发", en: "Development" },
    blurb: { zh: "架构、约定、测试口径与重构计划。", en: "Architecture, conventions, test scope and refactoring plans." },
  },
  {
    id: "releases",
    label: { zh: "版本发布", en: "Releases" },
    blurb: { zh: "每个版本的发布说明与升级注意事项。", en: "Release notes and upgrade notes for every version." },
  },
  {
    id: "root",
    label: { zh: "项目文档", en: "Project" },
    blurb: {
      zh: "仓库根目录的公开文档：支持、安全、贡献与变更日志。",
      en: "Public repository documents: support, security, contributing and the changelog.",
    },
  },
  {
    id: "misc",
    label: { zh: "其他", en: "Misc" },
    blurb: { zh: "未归类的文档。", en: "Documents outside the groups above." },
  },
];

const PAGE_STYLESHEETS = ["base.css", "docs.css"];

/**
 * The language control on a page that carries both languages: a button, because
 * there is no second URL to link to. Its label is switched by the same CSS that
 * switches the content, so it reads correctly whatever the page settled on.
 */
const LANGUAGE_BUTTON = `<button class="lang-button" id="lang-toggle" type="button">
            <span data-lang="zh" aria-hidden="true">EN</span>
            <span data-lang="en" aria-hidden="true">中文</span>
            <span class="sr-only" data-lang="zh">Switch to English</span>
            <span class="sr-only" data-lang="en">切换到中文</span>
          </button>`;

// ---------------------------------------------------------------------------
// Markdown -> hast -> HTML
// ---------------------------------------------------------------------------

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // The docs live in this repository and a few use small HTML blocks (for
  // example `<p align="center">` around a language switch). Passing those
  // through keeps the text intact instead of silently dropping it.
  .use(remarkRehype, { allowDangerousHtml: true });

/**
 * GitHub's heading anchor algorithm: lower-case, drop punctuation, symbols and
 * control characters, turn spaces into hyphens. CJK survives, which is why
 * `#发布后真实更新验证` keeps working. Implemented here rather than depended on so
 * the generated anchors match the fragments already written in `docs/`.
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\-_ ]/gu, "")
    .replace(/ /g, "-");
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** hast property name -> HTML attribute name. */
function attributeName(name) {
  if (name === "className") return "class";
  if (name === "htmlFor") return "for";
  return name;
}

function serializeAttributes(properties) {
  const parts = [];
  for (const [rawName, value] of Object.entries(properties || {})) {
    if (value === null || value === undefined || value === false) continue;
    const name = attributeName(rawName);
    if (value === true) {
      parts.push(` ${name}`);
      continue;
    }
    parts.push(` ${name}="${escapeAttribute(Array.isArray(value) ? value.join(" ") : value)}"`);
  }
  return parts.join("");
}

/**
 * Minimal hast serialiser. `hast-util-to-html` would do this too, but it is only
 * reachable through another package's dependency tree and the node types that
 * survive `remark-rehype` here are a small, well-defined set.
 */
export function serializeHast(node) {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(serializeHast).join("");
  switch (node.type) {
    case "root":
      return serializeHast(node.children || []);
    case "text":
      return escapeText(node.value);
    case "raw":
      return node.value;
    case "comment":
      return `<!--${node.value}-->`;
    case "element": {
      const open = `<${node.tagName}${serializeAttributes(node.properties)}>`;
      if (VOID_ELEMENTS.has(node.tagName)) return open;
      return `${open}${serializeHast(node.children || [])}</${node.tagName}>`;
    }
    default:
      return "";
  }
}

function textOf(node) {
  if (!node) return "";
  if (node.type === "text" || node.type === "raw") return node.value;
  return (node.children || []).map(textOf).join("");
}

/** Depth-first walk over element nodes, exposing the node and its parent. */
function walkElements(node, visit) {
  const children = node.children || [];
  for (const child of children) {
    if (child.type === "element") visit(child, node);
    walkElements(child, visit);
  }
}

/** Depth-first walk over every node, used where raw HTML has to be touched too. */
function walkNodes(node, visit) {
  for (const child of node.children || []) {
    visit(child, node);
    walkNodes(child, visit);
  }
}

// ---------------------------------------------------------------------------
// Document collection
// ---------------------------------------------------------------------------

function walkMarkdown(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full, base));
    else if (name.endsWith(".md")) out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

function splitLanguage(relPath) {
  for (const lang of LANGS) {
    if (relPath.endsWith(LANG_EXT[lang])) return { id: relPath.slice(0, -LANG_EXT[lang].length), lang };
  }
  return null;
}

export function extractTitle(text, fallback) {
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
  if (relPath.includes("/")) {
    const seg = relPath.split("/")[0];
    return GROUPS.some((g) => g.id === seg) ? seg : "misc";
  }
  return "guide";
}

/**
 * Sidebar order inside a group: release notes newest-first, numbered documents
 * in numeric order, everything else alphabetically.
 */
function naturalSort(a, b) {
  const aFile = a.id.includes("/") ? a.id.split("/").pop() : a.id;
  const bFile = b.id.includes("/") ? b.id.split("/").pop() : b.id;
  if (a.id.startsWith("releases/") && b.id.startsWith("releases/")) return versionSort(aFile, bFile);
  const na = aFile.match(/(\d+)/);
  const nb = bFile.match(/(\d+)/);
  if (na && nb) return +na[1] - +nb[1];
  return aFile.localeCompare(bFile, "en");
}

/**
 * Every publishable document, keyed by a language-independent id. `files` maps a
 * language to the repository path the document lives at and the site path it
 * becomes.
 */
export function collectDocs({ docsDirectory = docsRoot, repoDirectory = repoRoot } = {}) {
  const byId = new Map();
  const ensure = (id, group) => {
    if (!byId.has(id)) byId.set(id, { id, group, files: {}, title: {} });
    return byId.get(id);
  };

  for (const rel of walkMarkdown(docsDirectory, docsDirectory)) {
    const parsed = splitLanguage(rel);
    // Unsuffixed documents are navigation shells or pipeline input, not pages.
    if (!parsed) continue;
    const entry = ensure(parsed.id, groupOf(rel));
    entry.files[parsed.lang] = { repoPath: `docs/${rel}`, sitePath: rel.replace(/\.md$/, ".html") };
  }

  for (const name of ROOT_DOCS) {
    for (const lang of LANGS) {
      const repoPath = `${name}${LANG_EXT[lang]}`;
      if (!existsSync(join(repoDirectory, repoPath))) continue;
      const entry = ensure(`_root/${name}`, "root");
      entry.files[lang] = { repoPath, sitePath: `_root/${name}${LANG_HTML[lang]}` };
    }
  }

  for (const entry of byId.values()) {
    for (const lang of LANGS) {
      const file = entry.files[lang];
      if (!file) continue;
      const text = readFileSync(join(repoDirectory, file.repoPath), "utf8");
      entry.title[lang] = extractTitle(text, entry.id.split("/").pop());
    }
  }

  return [...byId.values()].sort(naturalSort);
}

/** Topics of one language, in sidebar order. */
export function groupedTopics(topics, lang) {
  const groups = [];
  for (const group of GROUPS) {
    const items = topics.filter((topic) => topic.group === group.id && topic.files[lang]);
    if (items.length > 0) groups.push({ ...group, items });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

const ABSOLUTE_HREF = /^[a-z][a-z0-9+.-]*:/i;

function splitFragment(href) {
  const index = href.indexOf("#");
  if (index < 0) return [href, ""];
  return [href.slice(0, index), href.slice(index + 1)];
}

/**
 * Heading anchors written by hand are sometimes percent-encoded (`#%E5%8F%91…`
 * for `#发布后…`), because that is what the browser shows once GitHub renders the
 * page. Decode before comparing so both spellings match the same heading.
 */
function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * `to` expressed relative to the directory holding `from`; both site-relative.
 * A link that points at its own page names the file rather than emitting an
 * empty href, which browsers treat as a reload of the current URL.
 */
export function relativeSiteHref(fromSitePath, toSitePath) {
  if (fromSitePath === toSitePath) return posix.basename(toSitePath);
  return posix.relative(posix.dirname(fromSitePath), toSitePath);
}

/**
 * Turn one Markdown href into the href the site should publish.
 *
 * `index` carries every page by repository path, the landing assets by file
 * name, and the report collector. Anything that cannot be resolved inside the
 * docs tree is audited: source-code pointers become GitHub links (which is what
 * the author meant), everything else is reported and fails the build.
 */
export function rewriteHref(href, page, index) {
  if (!href) return href;

  if (href.startsWith("#")) {
    const fragment = decodeFragment(href.slice(1));
    if (fragment && !page.headings.some((heading) => heading.slug === fragment)) {
      index.report.push({ kind: "missing-anchor", page: page.sitePath, href, resolved: page.sitePath });
    }
    return href;
  }
  if (ABSOLUTE_HREF.test(href) || href.startsWith("//")) return href;

  const [rawPath, fragment] = splitFragment(href);
  const anchor = fragment ? decodeFragment(fragment) : "";
  const targetRepoPath = posix.normalize(posix.join(posix.dirname(page.repoPath), rawPath));
  const suffix = anchor ? `#${anchor}` : "";
  const note = (kind, resolved) => {
    index.report.push({ kind, page: page.sitePath, href, resolved });
    return resolved + suffix;
  };

  const target = index.pageByRepoPath.get(targetRepoPath);
  if (target) {
    const relativeHref = relativeSiteHref(page.sitePath, target.sitePath);
    if (anchor && !target.headings.some((heading) => heading.slug === anchor)) {
      return note("missing-anchor", relativeHref);
    }
    return `${relativeHref}${suffix}`;
  }

  if (targetRepoPath.endsWith(".md")) {
    const basename = targetRepoPath.split("/").pop();
    // Unsuffixed documents: navigation shells, or the release note the release
    // pipeline reads. The overview is the page that replaces them.
    if (!/\.(zh-CN|en)\.md$/.test(basename)) {
      return note("mapped-to-overview", relativeSiteHref(page.sitePath, "index.html"));
    }
    return note("unresolved", href);
  }

  // Source-code pointers: prefer the file on GitHub over a dead relative link.
  // The trail is tried against the document's own directory, then against the
  // docs root — several documents under `docs/<group>/` write `../apps/...` as
  // if they sat at the top of `docs/`, which is one directory too high.
  const candidates = [targetRepoPath, posix.normalize(posix.join("docs", rawPath))];
  for (const candidate of candidates) {
    if (candidate.startsWith("..")) continue;
    if (existsSync(join(repoRoot, candidate))) {
      return note(candidate === targetRepoPath ? "repository-file" : "repository-file-docs-root", REPO_BLOB + candidate);
    }
  }

  return note("unresolved", href);
}

/**
 * Raw HTML blocks (the `<p align="center">` language switch at the top of a few
 * documents, and the images the root READMEs embed) carry the same repository
 * relative paths as Markdown links, but they are not nodes the Markdown walker
 * can see. Only `href` and `src` attributes are touched, and they go through the
 * same resolution as everything else.
 */
function rewriteRawHtml(value, page, index) {
  return value.replace(/(\shref=")([^"]+)(")/g, (match, before, href, after) => {
    return `${before}${rewriteHref(href, page, index)}${after}`;
  }).replace(/(\ssrc=")([^"]+)(")/g, (match, before, src, after) => {
    return `${before}${rewriteImageHref(src, page, index)}${after}`;
  });
}

function rewriteImageHref(src, page, index) {
  if (!src || ABSOLUTE_HREF.test(src) || src.startsWith("//") || src.startsWith("data:")) return src;
  const targetRepoPath = posix.normalize(posix.join(posix.dirname(page.repoPath), splitFragment(src)[0]));
  const basename = targetRepoPath.split("/").pop();
  // Site assets live in `site/assets/`, one level above the page namespace.
  if (index.assetByBasename.has(basename)) {
    return relativeSiteHref(page.sitePath, `../assets/${index.assetByBasename.get(basename)}`);
  }
  if (existsSync(join(repoRoot, targetRepoPath))) {
    const published = `_media/${basename}`;
    mkdirSync(dirname(join(siteDocs, published)), { recursive: true });
    cpSync(join(repoRoot, targetRepoPath), join(siteDocs, published));
    return relativeSiteHref(page.sitePath, published);
  }
  index.report.push({ kind: "unresolved-image", page: page.sitePath, href: src, resolved: targetRepoPath });
  return src;
}

// ---------------------------------------------------------------------------
// Document preparation
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Parse one document and prepare it for publishing: heading ids and anchors, a
 * table of contents, a meta description, and scroll wrappers for wide tables.
 */
export function prepareDocument(markdown) {
  const tree = processor.runSync(processor.parse(markdown));
  const headings = [];
  const used = new Map();

  walkElements(tree, (element) => {
    if (!/^h[1-6]$/.test(element.tagName)) return;
    const text = textOf(element);
    const base = slugify(text) || "section";
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen}`;
    headings.push({ depth: Number(element.tagName[1]), slug, text });
    element.properties = { ...element.properties, id: slug };
    element.children = [
      {
        type: "element",
        tagName: "a",
        properties: { className: ["heading-anchor"], href: `#${slug}`, ariaHidden: "true", tabIndex: -1 },
        children: [{ type: "text", value: "#" }],
      },
      ...element.children,
    ];
  });

  // Wide tables scroll on their own instead of pushing the article sideways.
  walkElements(tree, (element, parent) => {
    if (element.tagName !== "table" || !Array.isArray(parent.children)) return;
    if (parent.properties?.className?.includes("table-scroll")) return;
    parent.children[parent.children.indexOf(element)] = {
      type: "element",
      tagName: "div",
      properties: { className: ["table-scroll"], tabIndex: 0, role: "group" },
      children: [element],
    };
  });

  // Meta description: the first paragraph with enough substance to describe the
  // page. Several documents open with a one-line language switch
  // (`简体中文 | English`), which would otherwise become the description of every
  // page it appears on. The cut-off is low because a Chinese sentence carries
  // more meaning per character than the equivalent English one.
  const paragraphs = (tree.children || [])
    .filter((node) => node.type === "element" && node.tagName === "p")
    .map((node) => textOf(node).replace(/\s+/g, " ").trim());
  const description = (paragraphs.find((text) => text.length >= 24) || paragraphs[0] || "").slice(0, 180);

  return { tree, headings, description };
}

/**
 * How to get from a page back to `site/`. A page path is relative to
 * `site/docs/`, so every page needs at least one `../` — the docs directory
 * itself — plus one more per nested directory.
 */
function prefixOf(sitePath) {
  const depth = posix.dirname(sitePath).split("/").filter((part) => part && part !== ".").length;
  return "../".repeat(depth + 1);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function brandMark(prefix) {
  return `<img class="mark mark-light" src="${prefix}assets/brand/mark-light.png" alt="" width="26" height="26" />
          <img class="mark mark-dark" src="${prefix}assets/brand/mark-dark.png" alt="" width="26" height="26" />`;
}

function themeToggle(lang) {
  return `<button class="icon-button" type="button" id="theme-toggle" aria-label="${
    lang === "zh" ? "切换主题" : "Switch theme"
  }">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" stroke-linecap="round" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          </button>`;
}

function pageHead({ title, description, canonical, alternates, prefix, bilingual, locale, alternateLocale }) {
  const alternateLinks = alternates
    .map((alt) => `    <link rel="alternate" hreflang="${alt.hreflang}" href="${alt.href}" />`)
    .join("\n");
  const styleLinks = PAGE_STYLESHEETS.map((file) => `    <link rel="stylesheet" href="${prefix}${file}" />`).join("\n");
  // A page that carries one language states it; a bilingual one would have to
  // pick arbitrarily, so it says nothing.
  const localeTags = locale
    ? `    <meta property="og:locale" content="${locale}" />\n    <meta property="og:locale:alternate" content="${alternateLocale}" />\n`
    : "";
  return `    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${canonical}" />
${alternateLinks}
    <link rel="icon" href="${prefix}assets/brand/icon.svg" />
${styleLinks}
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ececef" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#050506" />
    <script src="${prefix}theme-init.js"></script>
    <meta property="og:type" content="${bilingual ? "website" : "article"}" />
    <meta property="og:site_name" content="Nami Mail" />
${localeTags}    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />`;
}

/** Open Graph locales for a page that carries exactly one language. */
const OG_LOCALE = { zh: "zh_CN", en: "en_US" };

function siteHeader({ prefix, lang, languageControl, current }) {
  return `    <header class="site-header">
      <div class="wrap">
        <a class="brand" href="${prefix}">
          ${brandMark(prefix)}
          <span>Nami Mail</span>
        </a>
        <nav class="site-nav" aria-label="${lang === "zh" ? "主导航" : "Main"}">
          <a href="${prefix}docs/"${current === "docs" ? ' class="is-current"' : ""}>${lang === "zh" ? "文档" : "Docs"}</a>
          <a href="${prefix}#features"${current === "site" ? ' class="is-current"' : ""}>${lang === "zh" ? "功能" : "Features"}</a>
          <a href="https://github.com/QinIndexCode/nami-mail/releases/latest" data-nav="secondary" rel="noopener">${lang === "zh" ? "下载" : "Download"}</a>
          <a href="${REPO_URL}" data-nav="secondary" rel="noopener">GitHub</a>
        </nav>
        <div class="header-actions">
          ${languageControl}
          ${themeToggle(lang)}
        </div>
      </div>
    </header>`;
}

function siteFooter({ prefix, lang, editHref }) {
  return `    <footer class="site-footer">
      <div class="wrap">
        <div class="footer-grid">
          <div class="footer-brand">
            <img class="mark mark-light" src="${prefix}assets/brand/mark-light.png" alt="" width="22" height="22" />
            <img class="mark mark-dark" src="${prefix}assets/brand/mark-dark.png" alt="" width="22" height="22" />
            <span>Nami Mail</span>
          </div>
          <nav class="footer-nav" aria-label="${lang === "zh" ? "页脚" : "Footer"}">
            <a href="${prefix}docs/">${lang === "zh" ? "文档总览" : "Docs overview"}</a>
            <a href="${editHref}" rel="noopener">${lang === "zh" ? "在 GitHub 上查看原文" : "View source on GitHub"}</a>
            <a href="${prefix}#download">${lang === "zh" ? "下载" : "Download"}</a>
            <a href="https://github.com/QinIndexCode/nami-mail/wiki" rel="noopener">Wiki</a>
            <a href="${REPO_URL}/issues" rel="noopener">${lang === "zh" ? "反馈" : "Issues"}</a>
          </nav>
        </div>
        <div class="footer-legal">
          <span>© <span id="year">2026</span> Nami Mail</span>
          <span>${
            lang === "zh"
              ? "本页由仓库 <code>docs/</code> 在构建时生成，与应用共用同一套设计规范；不使用 Cookie 或分析脚本。"
              : "Built at deploy time from the repository <code>docs/</code> directory and using the same design system as the app. No cookies, no analytics."
          }</span>
        </div>
      </div>
    </footer>`;
}

function renderSidebar(page, topics, lang) {
  const homeHref = relativeSiteHref(page.sitePath, "index.html");
  const sections = groupedTopics(topics, lang)
    .map((group) => {
      const links = group.items
        .map((item) => {
          const href = relativeSiteHref(page.sitePath, item.files[lang].sitePath);
          const current = item.files[lang].sitePath === page.sitePath;
          return `              <li><a href="${href}"${
            current ? ' class="is-current" aria-current="page"' : ""
          }>${escapeHtml(item.title[lang])}</a></li>`;
        })
        .join("\n");
      return `          <div class="docs-nav-group">
            <h2>${escapeHtml(group.label[lang])}</h2>
            <ul>
${links}
            </ul>
          </div>`;
    })
    .join("\n");

  return `<aside class="docs-sidebar">
      <details class="docs-nav" open>
        <summary>${lang === "zh" ? "全部文档" : "All documents"}</summary>
        <nav aria-label="${lang === "zh" ? "文档导航" : "Documentation"}">
          <a class="docs-nav-home" href="${homeHref}">${lang === "zh" ? "文档总览" : "Documentation overview"}</a>
${sections}
        </nav>
      </details>
    </aside>`;
}

function renderToc(headings, lang) {
  const items = headings.filter((heading) => heading.depth === 2);
  if (items.length < 2) return "";
  return `<nav class="docs-toc" aria-label="${lang === "zh" ? "本页目录" : "On this page"}">
        <h2>${lang === "zh" ? "本页目录" : "On this page"}</h2>
        <ul>
${items.map((item) => `          <li><a href="#${item.slug}">${escapeHtml(item.text)}</a></li>`).join("\n")}
        </ul>
      </nav>`;
}

function renderPager(page, topics, lang) {
  const linear = topics.filter((topic) => topic.files[lang]);
  const at = linear.findIndex((topic) => topic.files[lang].sitePath === page.sitePath);
  if (at < 0) return "";
  const previous = linear[at - 1];
  const next = linear[at + 1];
  if (!previous && !next) return "";
  const link = (item, direction) => {
    if (!item) return `<span class="pager-slot" aria-hidden="true"></span>`;
    const label =
      direction === "previous" ? (lang === "zh" ? "上一篇" : "Previous") : lang === "zh" ? "下一篇" : "Next";
    return `<a class="pager-link" href="${relativeSiteHref(page.sitePath, item.files[lang].sitePath)}">
            <span class="pager-label">${label}</span>
            <span class="pager-title">${escapeHtml(item.title[lang])}</span>
          </a>`;
  };
  return `<nav class="pager" aria-label="${lang === "zh" ? "翻页" : "Pagination"}">
          ${link(previous, "previous")}
          ${link(next, "next")}
        </nav>`;
}

/** `Page title · Nami Mail`, without repeating the product name twice. */
export function documentTitle(title) {
  return title.includes("Nami Mail") ? title : `${title} · Nami Mail`;
}

export function renderTopicPage(page, topics) {
  const prefix = prefixOf(page.sitePath);
  const otherLang = page.lang === "zh" ? "en" : "zh";
  const sibling = page.topic.files[otherLang];
  const switchHref = sibling ? relativeSiteHref(page.sitePath, sibling.sitePath) : relativeSiteHref(page.sitePath, "index.html");
  const group = GROUPS.find((item) => item.id === page.group) || GROUPS[GROUPS.length - 1];
  const alternates = LANGS.map((lang) => ({
    hreflang: LANG_TAG[lang],
    href: `${SITE_ORIGIN}docs/${page.topic.files[lang] ? page.topic.files[lang].sitePath : "index.html"}`,
  }));
  alternates.push({ hreflang: "x-default", href: `${SITE_ORIGIN}docs/index.html` });

  return `<!doctype html>
<html lang="${LANG_TAG[page.lang]}" data-lang="${page.lang}" data-theme="light">
  <head>
${pageHead({
  title: documentTitle(page.title),
  description: page.description || page.title,
  canonical: `${SITE_ORIGIN}docs/${page.sitePath}`,
  alternates,
  prefix,
  bilingual: false,
  locale: OG_LOCALE[page.lang],
  alternateLocale: OG_LOCALE[otherLang],
})}
  </head>
  <body class="docs-body">
    <a class="skip-link" href="#content">${page.lang === "zh" ? "跳到正文" : "Skip to content"}</a>
${siteHeader({
  prefix,
  lang: page.lang,
  current: "docs",
  languageControl: `<a class="lang-button" id="lang-toggle" href="${switchHref}" data-lang-switch="${
    sibling ? LANG_TAG[otherLang] : ""
  }">
            <span aria-hidden="true">${SWITCH_LABEL[page.lang]}</span>
            <span class="sr-only">${page.lang === "zh" ? "Switch to English" : "切换到中文"}</span>
          </a>`,
})}
    <div class="docs-layout wrap">
${renderSidebar(page, topics, page.lang)}
      <main class="docs-main" id="content">
        <nav class="crumbs" aria-label="${page.lang === "zh" ? "面包屑" : "Breadcrumb"}">
          <a href="${prefix}docs/">${page.lang === "zh" ? "文档" : "Docs"}</a>
          <span aria-hidden="true">/</span>
          <a href="${prefix}docs/#group-${group.id}">${escapeHtml(group.label[page.lang])}</a>
        </nav>
        <article class="prose"${page.lang !== "zh" ? ' lang="en"' : ""}>
${serializeHast(page.tree)}
        </article>
${renderPager(page, topics, page.lang)}
      </main>
${renderToc(page.headings, page.lang)}
    </div>
${siteFooter({ prefix, lang: page.lang, editHref: REPO_BLOB + page.repoPath })}
    <script src="${prefix}site.js" defer></script>
  </body>
</html>
`;
}

function renderOverviewGroup(group, lang) {
  const links = group.items
    .map((item) => `            <li><a href="${item.files[lang].sitePath}">${escapeHtml(item.title[lang])}</a></li>`)
    .join("\n");
  return `          <section class="overview-group" id="group-${group.id}">
            <div class="overview-head">
              <h2>${escapeHtml(group.label[lang])}</h2>
              <p>${escapeHtml(group.blurb[lang])}</p>
            </div>
            <ul class="overview-list">
${links}
            </ul>
          </section>`;
}

function renderQuickLinks(topics, lang) {
  const cards = QUICK_LINKS.map((entry) => {
    const topic = topics.find((item) => item.id === entry.id && item.files[lang]);
    if (!topic) return "";
    return `          <a class="quick-link" href="${topic.files[lang].sitePath}">
            <span class="quick-link-body">
              <span class="quick-link-title">${escapeHtml(entry.label[lang])}</span>
              <span class="quick-link-blurb">${escapeHtml(entry.blurb[lang])}</span>
            </span>
            <span class="quick-link-arrow" aria-hidden="true">→</span>
          </a>`;
  })
    .filter(Boolean)
    .join("\n");
  if (!cards) return "";
  return `        <div class="quick-links" data-lang="${lang}">
${cards}
        </div>`;
}

export function renderOverviewPage(topics) {
  const columns = LANGS.map((lang) => {
    const groups = groupedTopics(topics, lang)
      .map((group) => renderOverviewGroup(group, lang))
      .join("\n");
    return `        <div class="overview-column" data-lang="${lang}">
${groups}
        </div>`;
  }).join("\n");

  const title = "文档 · Documentation · Nami Mail";
  const description =
    "Nami Mail 文档：安装、账户、隐私、检索、Agent 工作区、MCP 与 CLI 参考。Built at deploy time from the repository docs directory.";
  const languages = Object.fromEntries(LANGS.map((lang) => [lang, topics.filter((t) => t.files[lang]).length]));

  return `<!doctype html>
<html lang="zh-CN" data-lang="zh" data-theme="light" data-bilingual="true">
  <head>
${pageHead({
  title,
  description,
  canonical: `${SITE_ORIGIN}docs/`,
  alternates: [{ hreflang: "x-default", href: `${SITE_ORIGIN}docs/` }],
  prefix: "../",
  bilingual: true,
})}
  </head>
  <body class="docs-body">
    <a class="skip-link" href="#content">跳到正文 / Skip to content</a>
${siteHeader({ prefix: "../", lang: "zh", current: "docs", languageControl: LANGUAGE_BUTTON })}
    <main class="docs-overview wrap" id="content">
      <header class="overview-intro">
        <p class="eyebrow">
          <span class="dot" aria-hidden="true"></span>
          <span data-lang="zh">${languages.zh} 个主题 · 中英双语</span>
          <span data-lang="en">${languages.en} topics · bilingual</span>
        </p>
        <h1 data-lang="zh">文档</h1>
        <h1 data-lang="en">Documentation</h1>
        <p class="lede" data-lang="zh">
          由仓库的 <code>docs/</code> 目录在部署时生成，与应用共用同一套设计规范。下面是全部主题；进入任意一页后，左侧是同一棵树的导航。
        </p>
        <p class="lede" data-lang="en">
          Generated from the repository's <code>docs/</code> directory at deploy time, using the same design system as
          the app. Every topic is listed below; inside a page the sidebar carries the same tree.
        </p>
      </header>
${renderQuickLinks(topics, "zh")}
${renderQuickLinks(topics, "en")}
      <div class="overview-columns">
${columns}
      </div>
    </main>
${siteFooter({ prefix: "../", lang: "zh", editHref: `${REPO_URL}/tree/main/docs` })}
    <script src="../site.js" defer></script>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Manifest and assets
// ---------------------------------------------------------------------------

export function buildManifest(topics, generated = new Date().toISOString().slice(0, 10)) {
  return {
    generated,
    groups: GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      items: topics
        .filter((topic) => topic.group === group.id)
        .map((topic) => ({
          id: topic.id,
          title: topic.title,
          html: Object.fromEntries(
            LANGS.filter((lang) => topic.files[lang]).map((lang) => [lang, topic.files[lang].sitePath]),
          ),
        })),
    })).filter((group) => group.items.length > 0),
  };
}

function syncSiteAssets() {
  let copied = 0;
  for (const [from, to] of SITE_ASSETS) {
    const source = join(repoRoot, from);
    if (!existsSync(source)) throw new Error(`site asset is missing: ${from}`);
    const target = join(siteAssets, to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    copied += 1;
  }
  return copied;
}

/** Remove generated page files (and only those) before a fresh build. */
function resetOutput() {
  rmSync(siteDocs, { recursive: true, force: true });
  mkdirSync(siteDocs, { recursive: true });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildDocsSite({ report = [] } = {}) {
  if (!existsSync(docsRoot)) throw new Error(`docs/ not found at ${docsRoot}`);
  resetOutput();

  const topics = collectDocs();
  const assetByBasename = new Map(SITE_ASSETS.map(([, to]) => [to.split("/").pop(), to]));

  // 1. Prepare every page: parsing is the expensive step, so each file is read once.
  const pages = [];
  for (const topic of topics) {
    for (const lang of LANGS) {
      const file = topic.files[lang];
      if (!file) continue;
      const prepared = prepareDocument(readFileSync(join(repoRoot, file.repoPath), "utf8"));
      pages.push({
        topic,
        lang,
        group: topic.group,
        repoPath: file.repoPath,
        sitePath: file.sitePath,
        title: topic.title[lang] || prepared.headings[0]?.text || topic.id,
        description: prepared.description,
        headings: prepared.headings,
        tree: prepared.tree,
      });
    }
  }

  // 2. Rewrite links with every page in hand, then serialise.
  const index = {
    pageByRepoPath: new Map(pages.map((page) => [page.repoPath, page])),
    assetByBasename,
    report,
  };
  for (const page of pages) {
    walkNodes(page.tree, (node) => {
      if (node.type === "raw") {
        node.value = rewriteRawHtml(node.value, page, index);
        return;
      }
      if (node.type !== "element") return;
      if (node.tagName === "a" && typeof node.properties?.href === "string") {
        const href = rewriteHref(node.properties.href, page, index);
        node.properties.href = href;
        // Links that leave the site carry a marker, so the stylesheet can hint
        // that they open somewhere else.
        if (/^https?:/i.test(href) && !href.startsWith(SITE_ORIGIN)) {
          node.properties.className = [...(node.properties.className || []), "is-external"];
        }
      } else if (node.tagName === "img" && typeof node.properties?.src === "string") {
        node.properties.src = rewriteImageHref(node.properties.src, page, index);
        node.properties.loading = "lazy";
        node.properties.decoding = "async";
      }
    });
  }

  // 3. Write pages, overview and manifest.
  for (const page of pages) {
    const destination = join(siteDocs, page.sitePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, renderTopicPage(page, topics), "utf8");
  }
  writeFileSync(join(siteDocs, "index.html"), renderOverviewPage(topics), "utf8");
  writeFileSync(
    join(siteDocs, "docs-manifest.json"),
    JSON.stringify(buildManifest(topics), null, 2) + "\n",
    "utf8",
  );

  const assetCount = syncSiteAssets();
  return { pages: pages.length + 1, topics: topics.length, assetCount, report };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const FATAL = new Set(["unresolved", "missing-anchor", "unresolved-image"]);

export function summarizeReport(report) {
  const counts = new Map();
  for (const entry of report) counts.set(entry.kind, (counts.get(entry.kind) || 0) + 1);
  return counts;
}

export function main(argv = process.argv.slice(2)) {
  const verbose = argv.includes("--report");
  let result;
  try {
    result = buildDocsSite();
  } catch (error) {
    console.error(`build-docs-site: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return 1;
  }

  console.log(`docs site -> ${relative(repoRoot, siteDocs)}`);
  console.log(`${result.pages} pages from ${result.topics} topics; ${result.assetCount} landing assets synced.`);

  const notes = result.report.filter((entry) => !FATAL.has(entry.kind));
  if (notes.length > 0) {
    console.log("link notes:");
    for (const [kind, count] of summarizeReport(notes)) console.log(`  ${kind}: ${count}`);
    if (verbose) for (const entry of notes) console.log(`    ${entry.page}: ${entry.href} -> ${entry.resolved}`);
  }

  const problems = result.report.filter((entry) => FATAL.has(entry.kind));
  if (problems.length > 0) {
    console.error(`broken links (${problems.length}):`);
    for (const entry of problems) console.error(`  ${entry.kind}: ${entry.page} -> ${entry.href}`);
    process.exitCode = 1;
    return 1;
  }
  console.log("every internal link and heading anchor resolves.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
