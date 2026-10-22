// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configPath = path.join(repoRoot, "apps", "web", "vite.config.ts");
const source = readFileSync(configPath, "utf8");

function importSpecifiers(text: string): string[] {
  const staticSpecifiers = [...text.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1] ?? "");
  const dynamicSpecifiers = [...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1] ?? "");
  return [...staticSpecifiers, ...dynamicSpecifiers];
}

describe("apps/web/vite.config.ts", () => {
  it("does not import server source", () => {
    const specifiers = importSpecifiers(source);
    expect(specifiers.length, "the config must have imports for this assertion to mean anything").toBeGreaterThan(2);
    const serverImports = specifiers.filter((specifier) => /(?:^|\/)server(?:\/|$)/.test(specifier));
    expect(serverImports).toEqual([]);
  });

  it("does not set a Content-Security-Policy", () => {
    // The document policy is owned by the server (apps/server/src/security/csp.ts)
    // and served with every response; a second header here would silently shadow
    // or duplicate it in dev.
    expect(source.toLowerCase()).not.toContain("content-security-policy");
  });

  it("guards builds against missing pdf.js assets", () => {
    expect(source).toContain("nami-pdfjs-assets-guard");
    expect(source).toMatch(/apply:\s*["']build["']/);
    expect(source).toContain("public/pdfjs/manifest.json");
    expect(source).toContain("pdfjs 资产缺失：先运行 npm run assets:pdfjs");
  });

  it("keeps the /api dev proxy rewriting the Host header", () => {
    expect(source).toMatch(/"\/api"\s*:\s*\{/);
    expect(source).toContain("changeOrigin: true");
  });
});
