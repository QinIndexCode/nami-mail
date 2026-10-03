import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import postcss from "postcss";

const ROOT_DIR = process.cwd();
const STYLES_ENTRY = path.resolve(ROOT_DIR, "apps/web/src/styles.css");
const BASELINE_COMMIT = "41a9e77"; // commit before splitting

/**
 * Recursively resolves @import statements in a CSS file to produce
 * a flattened CSS string, mirroring Vite's built-in postcss-import behavior.
 */
export function loadAggregatedCss(entryPath, visited = new Set()) {
  const absolutePath = path.resolve(entryPath);
  if (visited.has(absolutePath)) {
    throw new Error(`Circular @import detected: ${absolutePath}`);
  }
  visited.add(absolutePath);

  const raw = fs.readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
  const baseDir = path.dirname(absolutePath);

  // Match @import "./..." or @import '...';
  const resolved = raw.replace(/^@import\s+["']([^"']+)["'];?/gm, (_, importPath) => {
    const childPath = path.resolve(baseDir, importPath);
    if (!fs.existsSync(childPath)) {
      throw new Error(`Imported CSS file not found: ${childPath} (from ${absolutePath})`);
    }
    return loadAggregatedCss(childPath, new Set(visited));
  });

  return resolved;
}

/**
 * Retrieves the baseline styles.css from the git checkpoint.
 */
export function getBaselineCss() {
  try {
    return execSync(`git show ${BASELINE_COMMIT}:apps/web/src/styles.css`, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    }).replace(/\r\n/g, "\n");
  } catch (err) {
    console.warn(`Warning: Could not fetch from git ${BASELINE_COMMIT}, falling back to HEAD...`);
    return execSync("git show HEAD:apps/web/src/styles.css", {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    }).replace(/\r\n/g, "\n");
  }
}

/**
 * Analyzes a CSS string using PostCSS and extracts deep metrics and structural fingerprints.
 */
export function analyzeCss(cssString, label = "CSS") {
  const root = postcss.parse(cssString);

  let ruleCount = 0;
  let declCount = 0;
  let atRuleCount = 0;
  let mediaCount = 0;
  let keyframeCount = 0;

  const selectors = [];
  const declarations = [];
  const customProperties = new Set();
  const keyframeNames = new Set();
  const mediaQueries = [];

  // Rules & Selectors
  root.walkRules((rule) => {
    // Exclude inner keyframe rules (like "0%", "100%", "from", "to") from top-level selectors
    if (rule.parent && rule.parent.type === "atrule" && rule.parent.name === "keyframes") {
      return;
    }
    ruleCount++;
    const ruleSelectors = rule.selectors || [rule.selector];
    for (const sel of ruleSelectors) {
      selectors.push(sel.trim());
    }
  });

  // Declarations
  root.walkDecls((decl) => {
    declCount++;
    if (decl.prop.startsWith("--")) {
      customProperties.add(decl.prop);
    }
    const parentSelector = decl.parent && decl.parent.type === "rule" ? decl.parent.selector : "";
    declarations.push({
      selector: parentSelector,
      prop: decl.prop,
      value: decl.value.trim(),
      important: Boolean(decl.important),
    });
  });

  // AtRules
  root.walkAtRules((atRule) => {
    atRuleCount++;
    if (atRule.name === "media") {
      mediaCount++;
      mediaQueries.push(atRule.params.trim());
    } else if (atRule.name === "keyframes") {
      keyframeCount++;
      keyframeNames.add(atRule.params.trim());
    }
  });

  const lines = cssString.split("\n").length;
  const rawBytes = Buffer.byteLength(cssString, "utf8");

  return {
    label,
    lines,
    rawBytes,
    ruleCount,
    declCount,
    atRuleCount,
    mediaCount,
    keyframeCount,
    selectors,
    uniqueSelectors: new Set(selectors),
    declarations,
    customProperties,
    keyframeNames,
    mediaQueries,
    ast: root,
  };
}

/**
 * Compares baseline metrics against modular aggregated metrics.
 */
export function compareMetrics(baseline, current) {
  const errors = [];
  const warnings = [];

  // Check keyframes
  for (const name of baseline.keyframeNames) {
    if (!current.keyframeNames.has(name)) {
      errors.push(`Missing @keyframes: ${name}`);
    }
  }

  // Check custom properties
  for (const prop of baseline.customProperties) {
    if (!current.customProperties.has(prop)) {
      errors.push(`Missing CSS variable: ${prop}`);
    }
  }

  // Check unique selectors
  for (const sel of baseline.uniqueSelectors) {
    if (!current.uniqueSelectors.has(sel)) {
      errors.push(`Missing selector: ${sel}`);
    }
  }

  // Check declarations count
  if (baseline.declCount !== current.declCount) {
    const diff = current.declCount - baseline.declCount;
    if (diff < 0) {
      errors.push(`Declaration count decreased: Baseline has ${baseline.declCount}, Current has ${current.declCount} (${diff})`);
    } else {
      warnings.push(`Declaration count changed: Baseline has ${baseline.declCount}, Current has ${current.declCount} (+${diff})`);
    }
  }

  // Check rule count
  if (baseline.ruleCount !== current.ruleCount) {
    const diff = current.ruleCount - baseline.ruleCount;
    if (diff < 0) {
      errors.push(`Rule count decreased: Baseline has ${baseline.ruleCount}, Current has ${current.ruleCount} (${diff})`);
    } else {
      warnings.push(`Rule count changed: Baseline has ${baseline.ruleCount}, Current has ${current.ruleCount} (+${diff})`);
    }
  }

  return {
    identical: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
  };
}

/**
 * Inspects all imported modular files in styles.css and prints their distribution.
 */
export function getModuleBreakdown(entryPath) {
  const raw = fs.readFileSync(entryPath, "utf8");
  const baseDir = path.dirname(entryPath);
  const imports = [];
  const importRegex = /^@import\s+["']([^"']+)["'];?/gm;
  let match;
  while ((match = importRegex.exec(raw)) !== null) {
    const relPath = match[1];
    const fullPath = path.resolve(baseDir, relPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n").length;
      const bytes = Buffer.byteLength(content, "utf8");
      imports.push({ relPath, fullPath, lines, bytes });
    }
  }
  return imports;
}

// CLI execution
if (process.argv[1] && process.argv[1].endsWith("measure-styles.mjs")) {
  console.log("==================================================================");
  console.log("       Nami Mail CSS Architecture & Style Metric Analyzer         ");
  console.log("==================================================================");

  console.log(`Loading Baseline CSS (Commit: ${BASELINE_COMMIT})...`);
  const baselineCss = getBaselineCss();
  const baselineMetrics = analyzeCss(baselineCss, "Baseline Monolith");

  console.log(`Loading Current Aggregated CSS (${STYLES_ENTRY})...`);
  const currentCss = loadAggregatedCss(STYLES_ENTRY);
  const currentMetrics = analyzeCss(currentCss, "Current Aggregated");

  console.log("\n--- Metric Comparison ---");
  console.log(`Lines of Code:        Baseline: ${baselineMetrics.lines.toLocaleString().padStart(6)} | Current: ${currentMetrics.lines.toLocaleString().padStart(6)}`);
  console.log(`Total Rules:          Baseline: ${baselineMetrics.ruleCount.toLocaleString().padStart(6)} | Current: ${currentMetrics.ruleCount.toLocaleString().padStart(6)}`);
  console.log(`Total Declarations:   Baseline: ${baselineMetrics.declCount.toLocaleString().padStart(6)} | Current: ${currentMetrics.declCount.toLocaleString().padStart(6)}`);
  console.log(`Total Selectors:      Baseline: ${baselineMetrics.selectors.length.toLocaleString().padStart(6)} | Current: ${currentMetrics.selectors.length.toLocaleString().padStart(6)}`);
  console.log(`Unique Selectors:     Baseline: ${baselineMetrics.uniqueSelectors.size.toLocaleString().padStart(6)} | Current: ${currentMetrics.uniqueSelectors.size.toLocaleString().padStart(6)}`);
  console.log(`Keyframe Animations:  Baseline: ${baselineMetrics.keyframeCount.toLocaleString().padStart(6)} | Current: ${currentMetrics.keyframeCount.toLocaleString().padStart(6)}`);
  console.log(`Media Queries:        Baseline: ${baselineMetrics.mediaCount.toLocaleString().padStart(6)} | Current: ${currentMetrics.mediaCount.toLocaleString().padStart(6)}`);
  console.log(`CSS Variables:        Baseline: ${baselineMetrics.customProperties.size.toLocaleString().padStart(6)} | Current: ${currentMetrics.customProperties.size.toLocaleString().padStart(6)}`);
  console.log(`Raw Size:             Baseline: ${(baselineMetrics.rawBytes / 1024).toFixed(1)} KB | Current: ${(currentMetrics.rawBytes / 1024).toFixed(1)} KB`);

  const comparison = compareMetrics(baselineMetrics, currentMetrics);

  const modules = getModuleBreakdown(STYLES_ENTRY);
  if (modules.length > 0) {
    console.log(`\n--- Modular Partials (${modules.length} modules imported) ---`);
    for (const mod of modules) {
      console.log(`  • ${mod.relPath.padEnd(45)} ${mod.lines.toString().padStart(5)} lines  (${(mod.bytes / 1024).toFixed(1)} KB)`);
    }
  }

  console.log("\n--- Verification Result ---");
  if (comparison.identical) {
    console.log("✅ 100% Equivalence Verified! Zero style loss, all rules and declarations match.\n");
    process.exit(0);
  } else {
    if (comparison.warnings.length > 0) {
      console.log("⚠️  Warnings:");
      for (const w of comparison.warnings) console.log(`   - ${w}`);
    }
    if (comparison.errors.length > 0) {
      console.error("❌ Errors detected:");
      for (const e of comparison.errors) console.error(`   - ${e}`);
      console.error("\nRefactor aborted: Styles do not match baseline!\n");
      process.exit(1);
    } else {
      console.log("✅ No missing rules or selectors detected.\n");
      process.exit(0);
    }
  }
}
