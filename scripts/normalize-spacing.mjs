/**
 * One-off codemod: snap off-grid spacing to the 4px grid (design system §8).
 *
 * `7px` and `9px` are the two most common off-grid values (100+ occurrences) and
 * both sit one pixel from `8px`, so the visual delta is imperceptible while the
 * rhythm becomes consistent. Only the spacing properties are touched — width,
 * height, top, left, font-size and border-radius are deliberately left alone,
 * because for those a pixel is a real dimension rather than a rhythm.
 *
 * Usage: node scripts/normalize-spacing.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(repoRoot, "apps", "web", "src", "styles.css");
const checkOnly = process.argv.includes("--check");

const SPACING_PROPERTY = /^(gap|row-gap|column-gap|margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
const OFF_GRID = /\b(7|9)px\b/g;

const source = readFileSync(target, "utf8");
const lines = source.split("\n");
let changedLines = 0;
let replacements = 0;

const rewritten = lines.map((line) => {
  const declaration = line.match(/^([a-z-]+):(.+?)(;?)$/);
  if (!declaration) return line;
  const [, property, value, terminator] = declaration;
  if (!SPACING_PROPERTY.test(property)) return line;
  const nextValue = value.replace(OFF_GRID, (match, size) => {
    replacements += 1;
    return `${size === "7" || size === "9" ? 8 : size}px`;
  });
  if (nextValue === value) return line;
  changedLines += 1;
  return `${property}:${nextValue}${terminator}`;
});

if (checkOnly) {
  console.log(`${changedLines} line(s) still off the 4px grid`);
  process.exit(changedLines === 0 ? 0 : 1);
}

writeFileSync(target, rewritten.join("\n"), "utf8");
console.log(`${changedLines} line(s) snapped to the grid (${replacements} value(s))`);
