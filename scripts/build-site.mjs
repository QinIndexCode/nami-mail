#!/usr/bin/env node
/** Build the public landing/docs site and the offline interactive app demo. */
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { build } from "vite";
import { buildDocsSite } from "./build-docs-site.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(repoRoot, "apps", "web");
const demoOutput = join(repoRoot, "site", "demo");
const fatalReportKinds = new Set(["unresolved", "missing-anchor", "unresolved-image"]);

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

function buildDocs() {
  const report = [];
  const result = buildDocsSite({ report });
  const fatal = report.filter((entry) => fatalReportKinds.has(entry.kind));
  if (fatal.length > 0) {
    const details = fatal.map((entry) => `${entry.kind}: ${entry.page} -> ${entry.href}`).join("\n");
    throw new Error(`Documentation build found ${fatal.length} broken references:\n${details}`);
  }
  console.log(`Documentation pages: ${result.pages}; all internal links and anchors resolve.`);
}

function buildContracts() {
  execSync("npm --workspace @nami/agent-contracts run build", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

function buildBrand() {
  execSync("npm run build:brand", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}

async function buildDemo() {
  let appEntry = null;
  await build({
    configFile: join(webRoot, "vite.config.ts"),
    root: webRoot,
    base: "./",
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
  if (!appEntry) throw new Error("Vite did not provide the demo module entry");
  writeFileSync(
    join(demoOutput, "site-demo-entry.js"),
    `const current = new URL(window.location.href);\n` +
      `const incoming = current.searchParams;\n` +
      `const allowed = (value, choices, fallback) => choices.includes(value) ? value : fallback;\n` +
      `const safe = new URLSearchParams([\n` +
      `  ["demo", "1"], ["preview", "site"],\n` +
      `  ["theme", allowed(incoming.get("theme"), ["dark", "light"], "dark")],\n` +
      `  ["locale", allowed(incoming.get("locale"), ["zh-CN", "en-US"], "zh-CN")],\n` +
      `  ["view", allowed(incoming.get("view"), ["mail", "agent"], "mail")],\n` +
      `]);\n` +
      `const query = safe.toString();\n` +
      `if (current.search.slice(1) !== query) {\n` +
      `  current.search = query;\n` +
      `  window.location.replace(current.href);\n` +
      `} else {\n` +
      `  document.documentElement.lang = safe.get("locale");\n` +
      `  document.documentElement.dataset.theme = safe.get("theme");\n` +
      `  import(${JSON.stringify(appEntry)});\n` +
      `}\n`,
    "utf8",
  );
  console.log(`Interactive demo -> ${demoOutput}`);
}

try {
  buildBrand();
  buildDocs();
  buildContracts();
  await buildDemo();
} catch (error) {
  console.error(`build-site: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
