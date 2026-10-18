#!/usr/bin/env node
/**
 * Extracts brand icon path data from simple-icons into src/brand-avatars/icons.json.
 *
 * The registry keeps only our curated metadata (display names and the domain mapping);
 * every glyph and its color come from here, so no path data is ever hand-written.
 *
 * Usage: node scripts/sync-brand-icons.mjs
 *
 * Network access is only required when this script runs - the app itself never fetches icons.
 */
import { get } from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const ICONS_JSON = path.join(WEB_ROOT, "src", "brand-avatars", "icons.json");
const SVG_CACHE = path.resolve(WEB_ROOT, "..", "..", "output", "brand-audit", "upstream-svg");

const SIMPLE_ICONS_VERSION = "16.35.0";

/**
 * The audited allowlist: the only brands permitted to ship a bundled glyph.
 *
 * A brand earns a place here only if its owner publishes an affirmative grant of
 * referential logo use - permission to show the mark in order to identify the brand.
 * `grant` is the record of that permission: the owner's own words, plus the condition
 * attached to them, so this table on its own says why the brand qualifies. It is
 * deliberately not a summary - a paraphrase would be a claim we cannot show anyone.
 *
 * Absent on purpose:
 *  - brands that require prior written permission for logo use (GitHub, Microsoft,
 *    Apple, Amazon, Slack, Cloudflare, Notion, Vercel, Zoom, Netflix, Docker, GitLab,
 *    Discord, Anthropic, and the Chinese vendors Tencent/QQ/WeChat, Alibaba, Weibo,
 *    Zhihu, NetEase, JD, Feishu, Meituan, Baidu, Bilibili);
 *  - brands whose grant is conditioned on something a 35px sender avatar cannot do -
 *    Spotify and Steam both demand a trademark attribution notice, Epic Games' only
 *    permission is its non-commercial fan-content policy, and Stripe scopes its marks to
 *    "the portion of your website or application that directly relates to our services".
 *
 * Only OpenAI carries a version pin: simple-icons dropped that mark at its owner's
 * request, so the last release that still shipped it has to be named. Every other brand
 * tracks the current release, and adding one here is a legal judgement, not a coding
 * one - this set *is* the audit.
 */
const AUDITED_ALLOWLIST = {
  openai: {
    slug: "openai",
    // simple-icons removed this mark on a trademark request; the last release that
    // shipped it has to be named explicitly.
    version: "15.22.0",
    grant: '"Use the logo only when it directly relates to OpenAI services" - an avatar identifies the brand, which is the one relation the grant asks for.',
  },
  figma: {
    slug: "figma",
    grant: '"You may use the Figma marks to identify Figma or its products" - condition: the use must be truthful, fair and not misleading. Naming the sender\'s own brand is all three.',
  },
  paypal: {
    slug: "paypal",
    grant: '"You don\'t need permission to use these assets" - condition: the marks must follow PayPal\'s brand standards and stay out of marketing and advertising. A local avatar does both.',
  },
  telegram: {
    slug: "telegram",
    grant: '"Feel free to use them for article illustrations, graphs, \'forward to Telegram\' buttons" - condition: people must understand you are not representing Telegram officially. A branded avatar claims no representation.',
  },
};

async function fetchOnce(url) {
  return new Promise((resolve) => {
    const req = get(url, { headers: { "user-agent": "nami-mail-brand-sync" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(null));
    // A stalled socket would otherwise leave the refresh hanging until the process is
    // killed, so a timeout is treated like any other miss and retried.
    req.setTimeout(15_000, () => req.destroy());
  });
}

/** A non-200, a timeout and a dropped socket all look like a miss from here, so retry. */
async function fetchText(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const body = await fetchOnce(url);
    if (body !== null) return body;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}

/** SVG path syntax: a moveto followed by path commands. */
const SVG_PATH = /^[MmLlHhVvCcSsQqTtAaZz][MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;

/**
 * Pull the `d` attribute out of the first <path> element.
 *
 * Anchoring on the element matters: `id="..."` also contains `d="`, so searching for the
 * first bare `d="` would extract an id value from any element that carries one before its
 * path. Validating the result means a changed upstream file fails this run instead of
 * baking a malformed glyph into every user's avatar.
 */
function extractPath(svg) {
  const d = /<path[^>]*?\sd="([^"]*)"/.exec(svg)?.[1];
  return d && SVG_PATH.test(d) ? d : null;
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

fs.mkdirSync(SVG_CACHE, { recursive: true });

const indexCache = new Map();
async function indexFor(version) {
  if (!indexCache.has(version)) {
    // v15 moved the metadata from _data/ to data/.
    const dir = Number(version.split(".")[0]) >= 15 ? "data" : "_data";
    const raw = await fetchText(`https://cdn.jsdelivr.net/npm/simple-icons@${version}/${dir}/simple-icons.json`);
    const parsed = raw ? JSON.parse(raw) : [];
    // v16 ships a flat array; older releases wrapped the entries in { icons: [...] }.
    indexCache.set(version, Array.isArray(parsed) ? parsed : parsed.icons ?? []);
  }
  return indexCache.get(version);
}

const icons = {};
const failures = [];

for (const [id, entry] of Object.entries(AUDITED_ALLOWLIST)) {
  const version = entry.version ?? SIMPLE_ICONS_VERSION;
  const svg = await fetchText(`https://cdn.jsdelivr.net/npm/simple-icons@${version}/icons/${entry.slug}.svg`);
  const d = svg ? extractPath(svg) : null;

  const index = d ? await indexFor(version) : [];
  const meta = index.find((e) => slugify(e.title) === slugify(entry.slug));

  // Both halves of an entry are required, and a run that cannot resolve every allowlisted
  // brand writes nothing at all. The app imports this file, so a partial write would replace
  // committed glyphs with however many downloaded - and a glyph with no upstream color would
  // ship a tile wearing the registry's grey fallback as though that grey were the brand's.
  if (!d || !meta?.hex) {
    failures.push(`${id} (${entry.slug}@${version})${d ? " - no color in the simple-icons index" : ""}`);
    continue;
  }

  fs.writeFileSync(path.join(SVG_CACHE, `${id}.svg`), svg);
  icons[id] = {
    source: "simple-icons",
    slug: entry.slug,
    version,
    hex: `#${meta.hex.toUpperCase()}`,
    path: d,
  };
}

if (failures.length > 0) {
  console.error("FAILED to resolve:");
  for (const f of failures) console.error("  -", f);
  console.error(
    `left ${path.relative(WEB_ROOT, ICONS_JSON)} untouched - every allowlisted brand has to resolve in one run; re-run once the network is available`,
  );
  process.exitCode = 1;
} else {
  const ordered = {};
  for (const id of Object.keys(icons).sort()) ordered[id] = icons[id];

  const output = {
    _generated: {
      by: "apps/web/scripts/sync-brand-icons.mjs",
      source: "simple-icons",
      // Only the default: an icon records the release it actually came from in its own
      // `version`, which is why one brand being pinned does not make this wrong.
      defaultVersion: SIMPLE_ICONS_VERSION,
      license: "CC0-1.0",
      note: "Do not hand-edit `path` or `hex` - run `npm --workspace @nami/web run sync:brand-icons`. Only brands whose owner grants referential logo use are listed, and the script's AUDITED_ALLOWLIST is the record of that grant.",
    },
    icons: ordered,
  };

  fs.writeFileSync(ICONS_JSON, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`wrote ${path.relative(WEB_ROOT, ICONS_JSON)}`);
  console.log(`  brands:    ${Object.keys(ordered).length} of ${Object.keys(AUDITED_ALLOWLIST).length} allowed`);
  console.log(`  svg cache: ${path.relative(WEB_ROOT, SVG_CACHE)}`);
}
