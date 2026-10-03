import fs from "node:fs";
import path from "node:path";

const [,, targetModuleRel, startLineStr, endLineStr] = process.argv;
if (!targetModuleRel || !startLineStr || !endLineStr) {
  console.error("Usage: node scripts/slice-module.mjs <targetModuleRelPath> <startLine1Indexed> <endLine1Indexed>");
  process.exit(1);
}

const start = parseInt(startLineStr, 10);
const end = parseInt(endLineStr, 10);

const stylesPath = path.resolve("apps/web/src/styles.css");
const targetModulePath = path.resolve("apps/web/src", targetModuleRel);

const stylesContent = fs.readFileSync(stylesPath, "utf8").replace(/\r\n/g, "\n");
const lines = stylesContent.split("\n");

console.log(`Extracting lines ${start} to ${end} (total ${end - start + 1} lines)...`);
console.log(`First line: ${lines[start - 1]}`);
console.log(`Last line:  ${lines[end - 1]}`);

const extracted = lines.slice(start - 1, end).join("\n") + "\n";
fs.mkdirSync(path.dirname(targetModulePath), { recursive: true });
fs.writeFileSync(targetModulePath, extracted, "utf8");

const importStatement = `@import "./${targetModuleRel.replace(/\\/g, "/")}";`;
const newStylesLines = [
  ...lines.slice(0, start - 1),
  importStatement,
  ...lines.slice(end)
];

fs.writeFileSync(stylesPath, newStylesLines.join("\n"), "utf8");
console.log(`Successfully extracted to ${targetModulePath}`);
console.log(`Inserted ${importStatement} into styles.css`);
console.log(`New styles.css line count: ${newStylesLines.length}`);
