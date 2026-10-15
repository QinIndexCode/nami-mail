#!/usr/bin/env node
/**
 * Automatically synchronize the official landing site's interactive demo
 * with the latest frontend implementation in apps/web.
 *
 * Runs during release preparation (package:win / release packaging)
 * or manually via `npm run sync:demo`.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { syncSiteVersion } from "./sync-site-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(repoRoot, "apps", "web");
const demoOutput = join(repoRoot, "site", "demo");

const offlineCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'self' blob: data:",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
].join("; ");

function ensureContracts() {
  console.log("[sync-site-demo] Building contracts and brand assets...");
  execSync("npm run build:brand", { cwd: repoRoot, stdio: "inherit" });
  execSync("npm --workspace @nami/agent-contracts run build", { cwd: repoRoot, stdio: "inherit" });
}

export async function syncSiteDemo({ silent = false } = {}) {
  const startedAt = Date.now();
  if (!silent) {
    console.log("[sync-site-demo] Synchronizing site demo with latest apps/web implementation...");
  }

  syncSiteVersion({ repoRoot });
  ensureContracts();

  let appEntry = null;
  await build({
    configFile: join(webRoot, "vite.config.ts"),
    root: webRoot,
    base: "./",
    logLevel: silent ? "error" : "info",
    build: {
      outDir: demoOutput,
      emptyOutDir: true,
      sourcemap: false,
    },
    plugins: [
      {
        name: "nami-demo-offline-csp",
        transformIndexHtml: {
          order: "post",
          handler(html) {
            const tag = `<meta http-equiv="Content-Security-Policy" content="${offlineCsp}">`;
            const appScript = html.match(/<script\b(?=[^>]*\btype="module")[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i);
            if (!appScript) throw new Error("Vite output is missing its module entry script");
            appEntry = appScript[1];
            return html
              .replace(/<head([^>]*)>/i, `<head$1>\n  ${tag}`)
              .replace(/<script\b[^>]*src="[^"]*locale-boot\.js"[^>]*><\/script>/i, "")
              .replace(appScript[0], '<script type="module" src="./site-demo-entry.js"></script>');
          },
        },
      },
    ],
  });

  if (!appEntry) {
    throw new Error("Vite did not produce an application entry script for the demo.");
  }

  // Generate safe sandbox entry wrapper
  const entryWrapper = [
    `const current = new URL(window.location.href);`,
    `const incoming = current.searchParams;`,
    `const allowed = (value, choices, fallback) => choices.includes(value) ? value : fallback;`,
    `const safe = new URLSearchParams([`,
    `  ["demo", "1"], ["preview", "site"],`,
    `  ["theme", allowed(incoming.get("theme"), ["dark", "light"], "dark")],`,
    `  ["locale", allowed(incoming.get("locale"), ["zh-CN", "en-US"], "zh-CN")],`,
    `  ["view", allowed(incoming.get("view"), ["mail", "agent"], "mail")],`,
    `]);`,
    `const query = safe.toString();`,
    `if (current.search.slice(1) !== query) {`,
    `  current.search = query;`,
    `  window.location.replace(current.href);`,
    `} else {`,
    `  document.documentElement.lang = safe.get("locale");`,
    `  document.documentElement.dataset.theme = safe.get("theme");`,
    `  import(${JSON.stringify(appEntry)});`,
    `}`,
  ].join("\n");

  writeFileSync(join(demoOutput, "site-demo-entry.js"), entryWrapper + "\n", "utf8");

  // Verify build output
  const requiredFiles = ["index.html", "site-demo-entry.js"];
  for (const file of requiredFiles) {
    const fullPath = join(demoOutput, file);
    if (!existsSync(fullPath)) {
      throw new Error(`Demo verification failed: missing required file ${file}`);
    }
  }

  const assetsDir = join(demoOutput, "assets");
  const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const jsCount = assetFiles.filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).length;
  const cssCount = assetFiles.filter((f) => f.endsWith(".css")).length;
  let totalBytes = 0;
  for (const f of assetFiles) {
    totalBytes += statSync(join(assetsDir, f)).size;
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[sync-site-demo] Demo synchronized successfully in ${(durationMs / 1000).toFixed(2)}s: ` +
      `${jsCount} JS chunks, ${cssCount} CSS bundles (${(totalBytes / 1024 / 1024).toFixed(2)} MB) -> site/demo/`
  );

  return { demoOutput, jsCount, cssCount, totalBytes, durationMs };
}

// Run directly if invoked from CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  syncSiteDemo().catch((err) => {
    console.error(`[sync-site-demo] Error: ${err.message}`);
    process.exit(1);
  });
}
