#!/usr/bin/env node
/**
 * Copies the pdf.js runtime assets the attachment preview needs.
 *
 * The preview loads a PDF through pdf.js, which fetches CMaps, the standard
 * fonts, the ICC colour profiles and the wasm decoders at render time. They
 * are not part of the JS bundle, so a packaged build only works when they sit
 * next to the web dist that the local server serves. `apps/web/public/` is
 * Vite's copy-through directory, so the assets are staged there (200 files,
 * ~40 MB — gitignored) and shipped inside `apps/web/dist/pdfjs/`.
 *
 * The staged copy carries `manifest.json`: the installed `pdfjs-dist` version,
 * the per-directory file count, and a sha256 + byte size for every file. That
 * makes the copy verifiable instead of "a directory exists", and it means a
 * pdfjs upgrade is visible in review as a manifest diff rather than as silently
 * different bytes.
 *
 * Usage:
 *   node scripts/copy-pdfjs-assets.mjs           # copy, always
 *   node scripts/copy-pdfjs-assets.mjs --ensure  # copy only when version/manifest mismatch
 *   node scripts/copy-pdfjs-assets.mjs --check   # verify only; exit 1 on missing/mismatched
 *
 * Pure Node ESM, no dependencies: the asset copy must work before anything is
 * built (it is a `predev`/`prebuild`/`pretest` step).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = join(repoRoot, "apps", "web", "public", "pdfjs");
const manifestPath = join(targetDirectory, "manifest.json");

/** Directories pdf.js loads at runtime; nothing else from the package is copied. */
const assetDirectories = ["cmaps", "standard_fonts", "iccs", "wasm"];

/**
 * File counts shipped by pdfjs-dist 6.4.299 (LICENSE files included — they
 * must ship with the assets). The guard fails on an upgrade that changes the
 * set instead of silently copying different bytes: the preview tests assert
 * these numbers too, so both places must be updated together.
 */
const expectedFileCounts = Object.freeze({
  cmaps: 169,
  standard_fonts: 16,
  iccs: 2,
  wasm: 13,
});

function findPdfjsPackage() {
  const candidates = [
    join(repoRoot, "node_modules", "pdfjs-dist", "package.json"),
    join(repoRoot, "apps", "web", "node_modules", "pdfjs-dist", "package.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const packageJson = JSON.parse(readFileSync(candidate, "utf8"));
    return { root: dirname(candidate), version: String(packageJson.version) };
  }
  throw new Error("找不到 pdfjs-dist：先运行 npm install");
}

/** Sorted recursive file listing, relative to `directory`, using forward slashes. */
function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** The manifest the installed pdfjs-dist should produce. */
function buildExpectedManifest(pdfjs) {
  const directories = {};
  const files = {};
  for (const directory of assetDirectories) {
    const sourceDirectory = join(pdfjs.root, directory);
    if (!existsSync(sourceDirectory)) {
      throw new Error(`pdfjs-dist ${pdfjs.version} 缺少 ${directory}/：安装不完整，先运行 npm install`);
    }
    const names = listFiles(sourceDirectory);
    const expected = expectedFileCounts[directory];
    if (names.length !== expected) {
      throw new Error(
        `pdfjs-dist ${pdfjs.version} 的 ${directory}/ 有 ${names.length} 个文件，预期 ${expected}；`
          + "升级 pdfjs 后请同步更新本脚本的 expectedFileCounts 与 apps/web/src/pdfjs-assets.test.ts",
      );
    }
    directories[directory] = names.length;
    for (const name of names) {
      const data = readFileSync(join(sourceDirectory, name));
      files[`${directory}/${name}`] = { sha256: sha256(data), bytes: data.byteLength };
    }
  }
  return { package: "pdfjs-dist", version: pdfjs.version, directories, files };
}

function totalManifestFiles(manifest) {
  return Object.keys(manifest.files).length;
}

/**
 * Everything wrong with the staged copy, as short human-readable problems.
 * An empty array means the copy is exactly the manifest.
 */
function collectProblems(pdfjs, expected) {
  const problems = [];
  if (!existsSync(manifestPath)) {
    return ["缺少 apps/web/public/pdfjs/manifest.json；先运行 npm run assets:pdfjs"];
  }

  let actual;
  try {
    actual = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return ["apps/web/public/pdfjs/manifest.json 不是合法 JSON；重新运行 npm run assets:pdfjs"];
  }

  if (actual.version !== expected.version) {
    problems.push(`manifest 记录 pdfjs-dist ${actual.version}，已安装 ${expected.version}；运行 npm run assets:pdfjs`);
  }
  if (JSON.stringify(actual.directories) !== JSON.stringify(expected.directories)) {
    problems.push(`manifest 的目录计数 ${JSON.stringify(actual.directories)} 与预期 ${JSON.stringify(expected.directories)} 不一致`);
  }

  const recordedFiles = actual.files && typeof actual.files === "object" ? actual.files : {};
  const recordedNames = new Set(Object.keys(recordedFiles));
  const missing = [];
  const mismatched = [];
  for (const [name, expectedEntry] of Object.entries(expected.files)) {
    const targetFile = join(targetDirectory, ...name.split("/"));
    if (!existsSync(targetFile)) {
      missing.push(name);
      continue;
    }
    const data = readFileSync(targetFile);
    if (data.byteLength !== expectedEntry.bytes) mismatched.push(`${name}（字节数 ${data.byteLength} ≠ ${expectedEntry.bytes}）`);
    else if (sha256(data) !== expectedEntry.sha256) mismatched.push(`${name}（sha256 不符）`);
  }
  if (missing.length > 0) {
    problems.push(`缺少 ${missing.length} 个资产文件（如 ${missing.slice(0, 3).join("、")}）`);
  }
  if (mismatched.length > 0) {
    problems.push(`${mismatched.length} 个资产文件内容不符（如 ${mismatched.slice(0, 3).join("、")}）`);
  }
  for (const name of recordedNames) {
    if (!(name in expected.files)) problems.push(`manifest 记录了多余的 ${name}`);
  }
  for (const directory of assetDirectories) {
    const targetDir = join(targetDirectory, directory);
    if (!existsSync(targetDir)) continue;
    for (const name of listFiles(targetDir)) {
      if (!(`${directory}/${name}` in expected.files)) problems.push(`目录里多出 ${directory}/${name}`);
    }
  }
  return problems;
}

function copyAssets(pdfjs, expected) {
  rmSync(targetDirectory, { recursive: true, force: true });
  mkdirSync(targetDirectory, { recursive: true });
  for (const directory of assetDirectories) {
    cpSync(join(pdfjs.root, directory), join(targetDirectory, directory), { recursive: true });
  }
  writeFileSync(manifestPath, `${JSON.stringify(expected, null, 2)}\n`, "utf8");
}

function reportProblems(problems) {
  console.error("[pdfjs-assets] 校验失败：");
  for (const problem of problems) console.error(`  - ${problem}`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== "--check" && arg !== "--ensure");
  if (unknown.length > 0) {
    console.error(`[pdfjs-assets] 未知参数：${unknown.join(" ")}（可用：--ensure、--check）`);
    process.exitCode = 1;
    return;
  }
  const mode = args.has("--check") ? "check" : args.has("--ensure") ? "ensure" : "copy";

  const pdfjs = findPdfjsPackage();
  const expected = buildExpectedManifest(pdfjs);
  const summary = `${totalManifestFiles(expected)} 个文件，pdfjs-dist ${pdfjs.version}`;

  if (mode === "copy") {
    copyAssets(pdfjs, expected);
    console.log(`[pdfjs-assets] 已复制 ${summary} → apps/web/public/pdfjs`);
    return;
  }

  const problems = collectProblems(pdfjs, expected);
  if (problems.length === 0) {
    console.log(`[pdfjs-assets] ${mode} 通过：${summary}`);
    return;
  }
  if (mode === "check") {
    reportProblems(problems);
    process.exitCode = 1;
    return;
  }
  console.log(`[pdfjs-assets] 清单不符（${problems.length} 项），重新复制…`);
  copyAssets(pdfjs, expected);
  console.log(`[pdfjs-assets] 已刷新 ${summary} → apps/web/public/pdfjs`);
}

try {
  main();
} catch (error) {
  console.error(`[pdfjs-assets] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
