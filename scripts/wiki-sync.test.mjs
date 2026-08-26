import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWikiTree, collectWikiPages, syncWikiTree } from "./wiki-sync.mjs";

function makeDocs() {
  const dir = mkdtempSync(join(tmpdir(), "nami-wiki-docs-"));
  mkdirSync(join(dir, "agent"), { recursive: true });
  mkdirSync(join(dir, "cli"), { recursive: true });
  writeFileSync(join(dir, "INSTALLING.en.md"), "# Windows installation\n\nInstall steps.\n", "utf8");
  writeFileSync(join(dir, "INSTALLING.zh-CN.md"), "# Windows 安装\n\n安装步骤。\n", "utf8");
  writeFileSync(join(dir, "README.en.md"), "# Documentation\n", "utf8");
  writeFileSync(join(dir, "README.zh-CN.md"), "# 文档\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# unsuffixed is not a topic\n", "utf8");
  writeFileSync(join(dir, "agent", "usage.en.md"), "# Agent usage\n\nHow to use the agent.\n", "utf8");
  writeFileSync(join(dir, "agent", "usage.zh-CN.md"), "# Agent 使用\n\n如何使用。\n", "utf8");
  writeFileSync(join(dir, "cli", "usage.en.md"), "# CLI usage\n", "utf8");
  return dir;
}

function makeWikiClone() {
  const dir = mkdtempSync(join(tmpdir(), "nami-wiki-clone-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

test("collectWikiPages flattens subdirectories and keeps language suffixes", () => {
  const docs = makeDocs();
  const pages = collectWikiPages(docs);
  const names = pages.map((p) => p.pageName).sort();
  assert.deepEqual(names, ["INSTALLING.en.md", "INSTALLING.zh-CN.md", "agent-usage.en.md", "agent-usage.zh-CN.md", "cli-usage.en.md"]);
  assert.ok(pages.every((p) => p.sourceRel.includes("/") === p.pageName.includes("-") || !p.sourceRel.includes("/")));
  // README.* become the homepage, README.md (unsuffixed) is skipped.
  assert.ok(!names.some((n) => n.startsWith("README")));
  rmSync(docs, { recursive: true, force: true });
});

test("collectWikiPages fails on page-name collisions", () => {
  const docs = mkdtempSync(join(tmpdir(), "nami-wiki-collide-"));
  mkdirSync(join(docs, "a"), { recursive: true });
  writeFileSync(join(docs, "a", "b.en.md"), "# A/B\n", "utf8");
  writeFileSync(join(docs, "a-b.en.md"), "# A-B\n", "utf8");
  assert.throws(() => collectWikiPages(docs), /collision/);
  rmSync(docs, { recursive: true, force: true });
});

test("buildWikiTree writes pages, homepages, sidebar and manifest", () => {
  const docs = makeDocs();
  const out = mkdtempSync(join(tmpdir(), "nami-wiki-out-"));
  const count = buildWikiTree(docs, out);
  assert.equal(count, 5);
  const files = readdirSync(out).sort();
  assert.deepEqual(files, [
    ".wiki-sync.json",
    "Home.md",
    "Home.zh-CN.md",
    "INSTALLING.en.md",
    "INSTALLING.zh-CN.md",
    "_Sidebar.md",
    "agent-usage.en.md",
    "agent-usage.zh-CN.md",
    "cli-usage.en.md",
  ]);
  assert.equal(readFileSync(join(out, "INSTALLING.en.md"), "utf8"), "# Windows installation\n\nInstall steps.\n");
  const home = readFileSync(join(out, "Home.md"), "utf8");
  assert.match(home, /# Nami Mail Wiki/);
  assert.match(home, /\[English\]\(Home\.md\) \| \[简体中文\]\(Home\.zh-CN\.md\)/);
  assert.match(home, /\[Windows installation\]\(INSTALLING\.en\.md\) · \[简体中文\]\(INSTALLING\.zh-CN\.md\)/);
  assert.match(home, /\[Agent usage\]\(agent-usage\.en\.md\) · \[简体中文\]\(agent-usage\.zh-CN\.md\)/);
  const homeZh = readFileSync(join(out, "Home.zh-CN.md"), "utf8");
  assert.match(homeZh, /\[Windows 安装\]\(INSTALLING\.zh-CN\.md\) · \[English\]\(INSTALLING\.en\.md\)/);
  const sidebar = readFileSync(join(out, "_Sidebar.md"), "utf8");
  assert.match(sidebar, /^- \[Home\]\(Home\.md\)$/m);
  assert.match(sidebar, /\*\*Agent\*\*/);
  const manifest = JSON.parse(readFileSync(join(out, ".wiki-sync.json"), "utf8"));
  assert.equal(manifest.files["agent-usage.en.md"], "agent/usage.en.md");
  assert.equal(manifest.files["Home.md"], "docs/README.en.md");
  rmSync(docs, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("syncWikiTree removes stale generated pages but keeps hand-written ones", () => {
  const docs = makeDocs();
  const out = mkdtempSync(join(tmpdir(), "nami-wiki-out2-"));
  buildWikiTree(docs, out);

  const wiki = makeWikiClone();
  // Simulate one previous sync plus a hand-written page.
  syncWikiTree(out, wiki);
  writeFileSync(join(wiki, "Handwritten.md"), "# Kept\n", "utf8");

  // docs change: cli/usage.en.md is removed, a new page appears.
  rmSync(join(docs, "cli", "usage.en.md"));
  writeFileSync(join(docs, "agent", "tools.en.md"), "# Agent tools\n", "utf8");
  buildWikiTree(docs, out);
  syncWikiTree(out, wiki);

  assert.ok(existsSync(join(wiki, "agent-tools.en.md")), "new page copied");
  assert.ok(!existsSync(join(wiki, "cli-usage.en.md")), "stale page removed");
  assert.ok(existsSync(join(wiki, "Handwritten.md")), "hand-written page preserved");
  assert.ok(existsSync(join(wiki, ".wiki-sync.json")));
  rmSync(docs, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  rmSync(wiki, { recursive: true, force: true });
});

test("syncWikiTree rejects a directory that is not a git clone", () => {
  const dir = mkdtempSync(join(tmpdir(), "nami-wiki-nogit-"));
  assert.throws(() => syncWikiTree(dir, dir), /Not a git clone/);
  rmSync(dir, { recursive: true, force: true });
});
