import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localeDirectory = path.join(projectRoot, "apps", "web", "src", "locales");
const outputPaths = {
  server: path.join(projectRoot, "apps", "server", "src", "locale-catalog.generated.ts"),
  desktop: path.join(projectRoot, "apps", "desktop", "src", "native-locale-catalog.generated.mts"),
};
export const defaultLocale = "zh-CN";
const callbackKeys = {
  success: {
    title: "oauth.callback.success.title",
    message: "oauth.callback.success.message",
  },
  failure: {
    title: "oauth.callback.failure.title",
    message: "oauth.callback.failure.message",
  },
};
const nativeCopyKeys = {
  trayTooltip: "native.tray.tooltip",
  trayOpen: "native.tray.open",
  trayQuit: "native.tray.quit",
  trayFailureTitle: "native.tray.failure.title",
  trayFailureMessage: "native.tray.failure.message",
  closePromptTitle: "native.closePrompt.title",
  closePromptMessage: "native.closePrompt.message",
  closePromptDetail: "native.closePrompt.detail",
  closePromptMinimize: "native.closePrompt.minimize",
  closePromptQuit: "native.closePrompt.quit",
  closePromptCancel: "native.closePrompt.cancel",
  closePromptRemember: "native.closePrompt.remember",
  closePreferenceFailureTitle: "native.closePreference.failure.title",
  closePreferenceFailureMessage: "native.closePreference.failure.message",
  notificationUnknownSender: "native.notification.unknownSender",
  notificationSingleTitle: "native.notification.singleTitle",
  notificationMultipleTitle: "native.notification.multipleTitle",
  notificationMultipleBody: "native.notification.multipleBody",
  startupFailureTitle: "native.startup.failure.title",
  startupFailureMessage: "native.startup.failure.message",
};
export function canonicalLocale(value) {
  if (typeof value !== "string") return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

function stableTextOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

export function placeholderNames(message) {
  return [...new Set([...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1] ?? ""))]
    .filter(Boolean)
    .sort(stableTextOrder);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatPlaceholderNames(names) {
  return names.length > 0 ? names.map((name) => `{${name}}`).join(", ") : "(none)";
}

function validateLocalePack(file, pack, issues) {
  if (!isPlainRecord(pack)) {
    issues.push(`${file} must contain an object.`);
    return null;
  }
  if (!isPlainRecord(pack.meta)) {
    issues.push(`${file} is missing meta.`);
    return null;
  }
  if (!isNonBlankString(pack.meta.locale)) {
    issues.push(`${file} is missing meta.locale.`);
    return null;
  }
  if (!isNonBlankString(pack.meta.nativeName)) {
    issues.push(`${file} has a blank meta.nativeName.`);
    return null;
  }

  const locale = canonicalLocale(pack.meta.locale);
  if (!locale) {
    issues.push(`${file} has an invalid locale identifier: ${pack.meta.locale}`);
    return null;
  }
  if (pack.meta.locale !== locale) {
    issues.push(`${file} must use canonical BCP-47 locale ${locale}, not ${pack.meta.locale}.`);
  }
  if (file !== `${locale}.json`) {
    issues.push(`${file} must be named ${locale}.json to match its canonical locale.`);
  }

  const messageIssueCount = issues.length;
  if (!isPlainRecord(pack.messages)) {
    issues.push(`${file} is missing messages.`);
    return null;
  }
  const entries = Object.entries(pack.messages);
  if (entries.length === 0) {
    issues.push(`${file} must contain at least one message.`);
    return null;
  }
  for (const [key, value] of entries) {
    if (!key.trim()) issues.push(`${file} has a blank message key.`);
    if (typeof value !== "string") issues.push(`${file} has a non-string message: ${key}.`);
    else if (!value.trim()) issues.push(`${file} has a blank message: ${key}.`);
  }
  if (issues.length > messageIssueCount) return null;

  return {
    file,
    locale,
    nativeName: pack.meta.nativeName,
    messages: pack.messages,
  };
}

export function validateLocalePacks(records) {
  const issues = [];
  const packs = [];
  const locales = new Map();

  for (const record of records) {
    const pack = validateLocalePack(record.file, record.pack, issues);
    if (!pack) continue;
    packs.push(pack);
    const files = locales.get(pack.locale) ?? [];
    files.push(pack.file);
    locales.set(pack.locale, files);
  }

  for (const [locale, files] of locales) {
    if (files.length > 1) issues.push(`Duplicate locale ${locale}: ${files.join(", ")}`);
  }

  const baseline = packs.find((pack) => pack.locale === defaultLocale);
  if (!baseline) {
    issues.push(`Missing required ${defaultLocale} locale pack.`);
  } else {
    const baselineKeys = Object.keys(baseline.messages).sort(stableTextOrder);
    const baselineKeySet = new Set(baselineKeys);
    for (const pack of packs) {
      if (pack.locale === defaultLocale) continue;
      const keys = Object.keys(pack.messages).sort(stableTextOrder);
      const keySet = new Set(keys);
      for (const key of baselineKeys) {
        if (!keySet.has(key)) issues.push(`${pack.file} (${pack.locale}) is missing baseline key ${key}.`);
      }
      for (const key of keys) {
        if (!baselineKeySet.has(key)) issues.push(`${pack.file} (${pack.locale}) has an extra key ${key}.`);
      }
      for (const key of baselineKeys) {
        if (!keySet.has(key)) continue;
        const expected = placeholderNames(baseline.messages[key]);
        const actual = placeholderNames(pack.messages[key]);
        if (!sameValues(expected, actual)) {
          issues.push(
            `${pack.file} (${pack.locale}) has different placeholder names for ${key}: expected ${formatPlaceholderNames(expected)}, found ${formatPlaceholderNames(actual)}.`,
          );
        }
      }
    }
  }

  return {
    issues,
    packs: packs.sort((left, right) => stableTextOrder(left.locale, right.locale)),
  };
}

function requiredMessage(messages, key) {
  const value = messages[key];
  assert.equal(typeof value, "string", `Missing ${key}`);
  assert.ok(value.trim(), `${key} must not be blank`);
  return value;
}

function callbackCopy(messages, state) {
  const keys = callbackKeys[state];
  return {
    title: requiredMessage(messages, keys.title),
    message: requiredMessage(messages, keys.message),
  };
}

function nativeCopy(messages) {
  return Object.fromEntries(Object.entries(nativeCopyKeys).map(([name, key]) => [name, requiredMessage(messages, key)]));
}

function parseLocalePack(file, source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} contains invalid JSON: ${reason}`);
  }
}

async function loadLocalePacks() {
  const entries = await fs.readdir(localeDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(stableTextOrder);
  assert.ok(files.length > 0, "No JSON locale packs were found.");

  const records = await Promise.all(files.map(async (file) => {
    const source = await fs.readFile(path.join(localeDirectory, file), "utf8");
    const parsed = parseLocalePack(file, source);
    return { file, pack: parsed };
  }));
  const validation = validateLocalePacks(records);
  assert.equal(validation.issues.length, 0, `Invalid locale packs:\n- ${validation.issues.join("\n- ")}`);

  return validation.packs.map((pack) => ({
    locale: pack.locale,
    nativeName: pack.nativeName,
    oauthCallback: {
      success: callbackCopy(pack.messages, "success"),
      failure: callbackCopy(pack.messages, "failure"),
    },
    nativeCopy: nativeCopy(pack.messages),
  }));
}

function renderServerCatalog(packs) {
  const catalog = Object.fromEntries(packs.map((pack) => [pack.locale, {
    nativeName: pack.nativeName,
    oauthCallback: pack.oauthCallback,
  }]));
  return [
    "// Generated by scripts/build-locale-catalog.mjs. Do not edit manually.",
    `export const defaultLocale = ${JSON.stringify(defaultLocale)} as const;`,
    "",
    `export const localeCatalog = ${JSON.stringify(catalog, null, 2)} as const;`,
    "",
    "export type SupportedLocale = keyof typeof localeCatalog;",
    "",
  ].join("\n");
}

function renderDesktopCatalog(packs) {
  const catalog = Object.fromEntries(packs.map((pack) => [pack.locale, pack.nativeCopy]));
  return [
    "// Generated by scripts/build-locale-catalog.mjs. Do not edit manually.",
    `export const defaultNativeLocale = ${JSON.stringify(defaultLocale)} as const;`,
    "",
    `export const nativeLocaleCatalog = ${JSON.stringify(catalog, null, 2)} as const;`,
    "",
    "export type NativeSupportedLocale = keyof typeof nativeLocaleCatalog;",
    "",
  ].join("\n");
}

export function normalizeLineEndings(value) {
  return value?.replace(/\r\n?/g, "\n");
}

async function writeOrVerify(outputPath, output, checkOnly) {
  const current = await fs.readFile(outputPath, "utf8").catch(() => undefined);
  if (checkOnly) {
    assert.equal(normalizeLineEndings(current), output, `Generated locale catalog is stale: ${path.relative(projectRoot, outputPath)}`);
  } else if (normalizeLineEndings(current) !== output) {
    await fs.writeFile(outputPath, output, "utf8");
  }
}

export async function buildLocaleCatalog({ checkOnly = false } = {}) {
  const packs = await loadLocalePacks();
  await Promise.all([
    writeOrVerify(outputPaths.server, renderServerCatalog(packs), checkOnly),
    writeOrVerify(outputPaths.desktop, renderDesktopCatalog(packs), checkOnly),
  ]);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await buildLocaleCatalog({ checkOnly: process.argv.includes("--check") });
