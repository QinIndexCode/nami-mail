import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  collectDocs,
  documentTitle,
  extractTitle,
  groupedTopics,
  prepareDocument,
  relativeSiteHref,
  rewriteHref,
  serializeHast,
  slugify,
  summarizeReport,
} from "./build-docs-site.mjs";

/** A tiny repository-shaped fixture: `docs/` plus repository-root documents. */
function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "nami-docs-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "agent"), { recursive: true });
  const write = (relPath, text) => {
    const target = join(root, relPath);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, text, "utf8");
  };

  write("docs/README.md", "# Docs / 文档\n\n<a href=\"README.zh-CN.md\">中文</a>\n");
  write("docs/usage.zh-CN.md", "# 使用\n\n第一段足够长，可以当作这个页面的描述文字来使用，不会被当成语言切换行。\n\n## 目标\n\n见 [安全](agent/security.zh-CN.md) 与 [日志](../CHANGELOG.zh-CN.md)。\n");
  write("docs/usage.en.md", "# Usage\n\nA paragraph long enough to be the page description for this document.\n\n## Goal\n\nSee [security](agent/security.en.md).\n");
  write("docs/agent/security.zh-CN.md", "# 安全\n\n## 发布后真实更新验证\n");
  write("docs/agent/security.en.md", "# Security\n\n## 目标\n\n## 目标\n");
  write("CHANGELOG.zh-CN.md", "# 变更日志\n");
  write("CHANGELOG.en.md", "# Changelog\n");
  // A source file outside the docs tree, so the "point this at GitHub" rule can
  // be exercised end to end.
  write("apps/server/src/db.ts", "export {};\n");

  try {
    return run({ root, docs, write });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("slugify matches GitHub's heading anchors", () => {
  assert.equal(slugify("1. Prose measure"), "1-prose-measure");
  assert.equal(slugify("When !important is allowed"), "when-important-is-allowed");
  assert.equal(slugify("Contrast floor (enforced by a test)"), "contrast-floor-enforced-by-a-test");
  assert.equal(slugify("10. Automated baseline (the two tests in apps/web)"), "10-automated-baseline-the-two-tests-in-appsweb");
  assert.equal(slugify("设计规范（Design System）"), "设计规范design-system");
  assert.equal(slugify("发布后真实更新验证"), "发布后真实更新验证");
  assert.equal(slugify("  Trimmed  "), "trimmed");
  assert.equal(slugify("!!!"), "");
});

test("extractTitle reads the first heading and tolerates a BOM", () => {
  assert.equal(extractTitle("# Hello *there*\n", "fallback"), "Hello there");
  assert.equal(extractTitle("\uFEFF\n# 标题\n", "fallback"), "标题");
  assert.equal(extractTitle("no heading", "fallback"), "fallback");
});

test("documentTitle does not repeat the product name", () => {
  assert.equal(documentTitle("MCP Tools"), "MCP Tools · Nami Mail");
  assert.equal(documentTitle("Nami Mail"), "Nami Mail");
});

test("relativeSiteHref names the file when a link points at its own page", () => {
  assert.equal(relativeSiteHref("agent/usage.zh-CN.html", "agent/security.zh-CN.html"), "security.zh-CN.html");
  assert.equal(relativeSiteHref("agent/usage.zh-CN.html", "_root/README.en.html"), "../_root/README.en.html");
  assert.equal(relativeSiteHref("agent/usage.zh-CN.html", "agent/usage.zh-CN.html"), "usage.zh-CN.html");
});

test("collectDocs publishes language-suffixed documents and root documents", () => {
  withFixture(({ docs, root }) => {
    const topics = collectDocs({ docsDirectory: docs, repoDirectory: root });
    const ids = topics.map((topic) => topic.id);
    // `CHANGELOG` only exists at the repository root, so it is published as a
    // root document rather than as a docs-tree topic.
    assert.deepEqual([...ids].sort(), ["_root/CHANGELOG", "agent/security", "usage"].sort());

    const usage = topics.find((topic) => topic.id === "usage");
    assert.equal(usage.title.zh, "使用");
    assert.equal(usage.title.en, "Usage");
    assert.equal(usage.files.zh.repoPath, "docs/usage.zh-CN.md");
    assert.equal(usage.files.zh.sitePath, "usage.zh-CN.html");
    assert.equal(usage.group, "guide");

    // The unsuffixed navigation shell is not a page of its own.
    assert.equal(
      topics.some((topic) => topic.id === "README"),
      false,
    );

    const security = topics.find((topic) => topic.id === "agent/security");
    assert.equal(security.group, "agent");
    assert.equal(security.files.en.sitePath, "agent/security.en.html");

    const changelog = topics.find((topic) => topic.id === "_root/CHANGELOG");
    assert.equal(changelog.group, "root");
    assert.equal(changelog.files.zh.repoPath, "CHANGELOG.zh-CN.md");
    assert.equal(changelog.files.zh.sitePath, "_root/CHANGELOG.zh-CN.html");
  });
});

test("groupedTopics only lists a language that has the document", () => {
  withFixture(({ docs, root }) => {
    const topics = collectDocs({ docsDirectory: docs, repoDirectory: root });
    const groups = groupedTopics(topics, "en");
    assert.deepEqual(
      groups.map((group) => group.id),
      ["guide", "agent", "root"],
    );
    const guide = groups[0];
    assert.deepEqual(
      guide.items.map((item) => item.id),
      ["usage"],
    );
  });
});

test("prepareDocument adds GitHub anchors, keeps duplicates unique and wraps tables", () => {
  const prepared = prepareDocument(
    "# Title\n\nA paragraph long enough to become the description of this page.\n\n## 目标\n\n## 目标\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
  );
  assert.deepEqual(
    prepared.headings.map((heading) => heading.slug),
    ["title", "目标", "目标-1"],
  );
  assert.equal(prepared.description, "A paragraph long enough to become the description of this page.");

  const html = serializeHast(prepared.tree);
  assert.match(html, /<h2 id="目标">/);
  assert.match(html, /<h2 id="目标-1">/);
  assert.match(html, /class="heading-anchor"/);
  assert.match(html, /<div class="table-scroll"[^>]*>\s*<table>/);
});

test("prepareDocument skips a short leading line when choosing the description", () => {
  const prepared = prepareDocument("# Title\n\n简体中文 | English\n\nThe real description of this document.\n");
  assert.equal(prepared.description, "The real description of this document.");
});

test("serializeHast escapes text and attributes and knows void elements", () => {
  assert.equal(
    serializeHast({
      type: "element",
      tagName: "a",
      properties: { href: 'a"b', className: ["x", "y"] },
      children: [{ type: "text", value: "<script> & more" }],
    }),
    '<a href="a&quot;b" class="x y">&lt;script&gt; &amp; more</a>',
  );
  assert.equal(
    serializeHast({ type: "element", tagName: "img", properties: { src: "a.png", alt: "" }, children: [] }),
    '<img src="a.png" alt="">',
  );
  assert.equal(serializeHast({ type: "element", tagName: "input", properties: { disabled: true }, children: [] }), "<input disabled>");
});

test("rewriteHref resolves every link shape the repository uses", () => {
  withFixture(({ docs, root, write }) => {
    const topics = collectDocs({ docsDirectory: docs, repoDirectory: root });
    const pages = [];
    for (const topic of topics) {
      for (const lang of ["zh", "en"]) {
        const file = topic.files[lang];
        if (!file) continue;
        const prepared = prepareDocument(readFileSync(join(root, file.repoPath), "utf8"));
        pages.push({
          topic,
          lang,
          sitePath: file.sitePath,
          repoPath: file.repoPath,
          headings: prepared.headings,
        });
      }
    }
    const pageByRepoPath = new Map(pages.map((page) => [page.repoPath, page]));
    const makeIndex = () => ({ pageByRepoPath, assetByBasename: new Map(), report: [] });

    const usageZh = pages.find((page) => page.repoPath === "docs/usage.zh-CN.md");
    const index = makeIndex();

    // Same directory, nested directory, and repository-root documents.
    assert.equal(rewriteHref("agent/security.zh-CN.md", usageZh, index), "agent/security.zh-CN.html");
    assert.equal(rewriteHref("../CHANGELOG.zh-CN.md", usageZh, index), "_root/CHANGELOG.zh-CN.html");
    assert.equal(rewriteHref("#目标", usageZh, index), "#目标");
    assert.equal(rewriteHref("https://example.com", usageZh, index), "https://example.com");

    // A fragment that exists in the target is carried over, encoded or not.
    write("docs/agent/security.zh-CN.md", "# 安全\n\n## 发布后真实更新验证\n");
    const securityZh = pages.find((page) => page.repoPath === "docs/agent/security.zh-CN.md");
    securityZh.headings = prepareDocument(readFileSync(join(root, "docs/agent/security.zh-CN.md"), "utf8")).headings;
    assert.equal(rewriteHref("agent/security.zh-CN.md#发布后真实更新验证", usageZh, makeIndex()), "agent/security.zh-CN.html#发布后真实更新验证");
    assert.equal(
      rewriteHref("agent/security.zh-CN.md#%E5%8F%91%E5%B8%83%E5%90%8E%E7%9C%9F%E5%AE%9E%E6%9B%B4%E6%96%B0%E9%AA%8C%E8%AF%81", usageZh, makeIndex()),
      "agent/security.zh-CN.html#发布后真实更新验证",
    );

    // Unsuffixed documents land on the overview; unknown targets are reported.
    assert.equal(rewriteHref("../README.md", usageZh, makeIndex()), "index.html");
    const missIndex = makeIndex();
    assert.equal(rewriteHref("agent/nope.zh-CN.md", usageZh, missIndex), "agent/nope.zh-CN.md");
    assert.deepEqual(summarizeReport(missIndex.report), new Map([["unresolved", 1]]));

    const anchorIndex = makeIndex();
    rewriteHref("agent/security.zh-CN.md#nope", usageZh, anchorIndex);
    assert.deepEqual(summarizeReport(anchorIndex.report), new Map([["missing-anchor", 1]]));

    // Source-code pointers become GitHub links, including the `docs/<group>`
    // spelling that resolves one directory too high.
    const securityPage = pages.find((page) => page.repoPath === "docs/agent/security.zh-CN.md");
    const sourceIndex = makeIndex();
    assert.equal(
      rewriteHref("../apps/server/src/db.ts", securityPage, sourceIndex),
      "https://github.com/QinIndexCode/nami-mail/blob/main/apps/server/src/db.ts",
    );
    assert.deepEqual(summarizeReport(sourceIndex.report), new Map([["repository-file-docs-root", 1]]));
  });
});

test("buildManifest lists only groups that have topics", () => {
  withFixture(({ docs, root }) => {
    const topics = collectDocs({ docsDirectory: docs, repoDirectory: root });
    const manifest = buildManifest(topics, "2026-09-13");
    assert.equal(manifest.generated, "2026-09-13");
    assert.deepEqual(
      manifest.groups.map((group) => group.id),
      ["guide", "agent", "root"],
    );
    const guide = manifest.groups[0];
    assert.deepEqual(guide.items[0].html, { zh: "usage.zh-CN.html", en: "usage.en.html" });
    assert.equal(
      manifest.groups.some((group) => group.id === "misc"),
      false,
    );
  });
});

test("summarizeReport counts by kind", () => {
  const counts = summarizeReport([
    { kind: "repository-file" },
    { kind: "repository-file" },
    { kind: "unresolved" },
  ]);
  assert.equal(counts.get("repository-file"), 2);
  assert.equal(counts.get("unresolved"), 1);
  assert.equal(counts.get("missing-anchor"), undefined);
});
