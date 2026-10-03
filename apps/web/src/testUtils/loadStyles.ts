import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function getDefaultStylesPath(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url && import.meta.url.startsWith("file:")) {
      return fileURLToPath(new URL("../styles.css", import.meta.url));
    }
  } catch {
    // In jsdom environment, import.meta.url is not a file: URL
  }
  const candidate = path.resolve(process.cwd(), "src/styles.css");
  if (existsSync(candidate)) return candidate;
  return path.resolve(process.cwd(), "apps/web/src/styles.css");
}

/**
 * Loads styles.css and recursively resolves all `@import` statements,
 * returning a single aggregated CSS string.
 *
 * This allows test suites (overlayStacking, designTokens, themeContrast,
 * overlayCentering, MessageList) to remain 100% compatible while styles.css
 * is decoupled into modular partials.
 */
export function loadAggregatedCss(entryPath?: string, visited: Set<string> = new Set()): string {
  const target = entryPath ?? getDefaultStylesPath();
  const absolutePath = path.resolve(target);
  if (visited.has(absolutePath)) {
    throw new Error(`Circular @import detected: ${absolutePath}`);
  }
  visited.add(absolutePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`CSS file not found: ${absolutePath}`);
  }

  const raw = readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
  const baseDir = path.dirname(absolutePath);

  return raw.replace(/^@import\s+["']([^"']+)["'];?/gm, (_, importPath: string) => {
    const childPath = path.resolve(baseDir, importPath);
    return loadAggregatedCss(childPath, new Set(visited));
  });
}
