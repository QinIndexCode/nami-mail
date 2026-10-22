// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publicPdfjs = path.join(repoRoot, "apps", "web", "public", "pdfjs");
const manifestPath = path.join(publicPdfjs, "manifest.json");

/**
 * The directory inventory pdfjs-dist 6.4.299 ships for the preview. Asserted
 * per directory (not just via the manifest) so a manifest rewritten by hand to
 * match a wrong copy cannot pass: the counts come from the filesystem.
 */
const expectedDirectoryCounts: Record<string, number> = {
  cmaps: 169,
  standard_fonts: 16,
  iccs: 2,
  wasm: 13,
};

type ManifestEntry = { sha256: string; bytes: number };
type PdfjsAssetManifest = {
  package: string;
  version: string;
  directories: Record<string, number>;
  files: Record<string, ManifestEntry>;
};

function readManifest(): PdfjsAssetManifest {
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PdfjsAssetManifest;
}

function installedPdfjsVersion(): string {
  const packagePath = path.join(repoRoot, "node_modules", "pdfjs-dist", "package.json");
  return (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
}

function listFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(path.join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

describe("pdf.js runtime assets", () => {
  it("passes the copy script's own --check mode", () => {
    const output = execFileSync(process.execPath, [path.join(repoRoot, "scripts", "copy-pdfjs-assets.mjs"), "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(output).toContain("check 通过");
  });

  it("records the installed pdfjs-dist version and package name in the manifest", () => {
    const manifest = readManifest();
    expect(manifest.package).toBe("pdfjs-dist");
    expect(manifest.version).toBe(installedPdfjsVersion());
  });

  it("copies the four runtime directories with the exact file counts", () => {
    const manifest = readManifest();
    for (const [directory, expectedCount] of Object.entries(expectedDirectoryCounts)) {
      const directoryPath = path.join(publicPdfjs, directory);
      expect(existsSync(directoryPath), `${directory}/ must exist`).toBe(true);
      const files = listFiles(directoryPath);
      expect(files, `${directory}/ file count`).toHaveLength(expectedCount);
      expect(manifest.directories[directory], `manifest directory count for ${directory}`).toBe(expectedCount);
    }
    expect(Object.keys(manifest.files)).toHaveLength(
      Object.values(expectedDirectoryCounts).reduce((total, count) => total + count, 0),
    );
  });

  it("includes the wasm fallback shims pdf.js loads when WebAssembly is unavailable", () => {
    const manifest = readManifest();
    for (const shim of ["wasm/openjpeg_nowasm_fallback.js", "wasm/jbig2_nowasm_fallback.js", "wasm/quickjs-eval.js", "wasm/quickjs-eval.wasm"]) {
      expect(manifest.files[shim], `${shim} must be in the manifest`).toBeDefined();
      expect(existsSync(path.join(publicPdfjs, ...shim.split("/"))), `${shim} must exist on disk`).toBe(true);
    }
  });

  it("ships bytes that match the manifest's sha256 and size for every file", () => {
    const manifest = readManifest();
    for (const [name, entry] of Object.entries(manifest.files)) {
      const filePath = path.join(publicPdfjs, ...name.split("/"));
      expect(existsSync(filePath), `${name} must exist`).toBe(true);
      const bytes = readFileSync(filePath);
      expect(bytes.byteLength, `${name} byte size`).toBe(entry.bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest, `${name} sha256`).toBe(entry.sha256);
    }
  });
});
