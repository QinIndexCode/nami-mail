// Read-only check: find t("...") static keys referenced in src that are missing
// from either locale catalog.
import fs from "node:fs";
import path from "node:path";

const root = "apps/web/src";
const readCatalog = (file) => {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return parsed.messages ?? parsed;
};
const zh = readCatalog("locales/zh-CN.json");
const en = readCatalog("locales/en-US.json");
const zhKeys = new Set(Object.keys(zh));
const enKeys = new Set(Object.keys(en));
const used = new Set();

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(tsx?)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      const s = fs.readFileSync(p, "utf8");
      const re = /\bt\(\s*"([^"]+)"\s*(?:,|\))/g;
      let m;
      while ((m = re.exec(s))) {
        if (m[1].includes("${")) continue;
        used.add(m[1]);
      }
    }
  }
}

walk(root);
const missingZh = [...used].filter((k) => !zhKeys.has(k)).sort();
const missingEn = [...used].filter((k) => !enKeys.has(k)).sort();
console.log("referenced static keys:", used.size);
console.log(`MISSING in zh-CN (${missingZh.length}):`);
missingZh.forEach((k) => console.log("  " + k));
console.log(`MISSING in en-US (${missingEn.length}):`);
missingEn.forEach((k) => console.log("  " + k));
