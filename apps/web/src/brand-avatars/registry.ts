import { extractRootDomain } from "./domain";
import type { BrandAvatar, BrandIconRecord } from "./types";
import iconData from "./icons.json";

/**
 * Display names, keyed by the ids in icons.json.
 *
 * The ids come from the generated file while these names are hand-written, so the two can
 * disagree. The `?? id` in BRAND_DEFINITIONS is what makes that disagreement visible: an
 * unnamed brand would carry its raw id as its name, and that is exactly what the registry
 * test fails on. A fallback a test can catch earns its place; a default nothing asserts does
 * not. Nothing renders this name - the brand tile is `aria-hidden` - so it stands as a
 * curation guard first: bundling a brand has to come with a hand-written name.
 *
 * Every listed brand uses the color its owner publishes, so there are no color overrides.
 * The grant behind each one, in the owner's own words, is recorded in the allowlist in
 * apps/web/scripts/sync-brand-icons.mjs; that file is the audit.
 */
const BRAND_NAMES: Record<string, string> = {
  figma: "Figma",
  openai: "OpenAI",
  paypal: "PayPal",
  telegram: "Telegram",
};

const ICONS: Record<string, BrandIconRecord> = iconData.icons;

/**
 * Reachable only from a hand-edited icons.json - the sync script fails the run rather than
 * write a glyph whose upstream color it could not read - but `hex` is nullable in the file's
 * own type, so the compiler cannot rule the case out. The registry test asserts that no
 * shipped glyph wears this grey, which is what keeps "reachable" from meaning "rendered".
 */
const FALLBACK_COLOR = "#4B5563";

/**
 * Standard brand definitions.
 * All SVGs are normalized to a 24x24 viewBox.
 */
export const BRAND_DEFINITIONS: Record<string, BrandAvatar> = Object.fromEntries(
  Object.entries(ICONS).map(([id, icon]): [string, BrandAvatar] => [
    id,
    {
      id,
      name: BRAND_NAMES[id] ?? id,
      color: icon.hex ?? FALLBACK_COLOR,
      svgPath: icon.path,
    },
  ]),
);

/**
 * Domain-to-Brand ID mapping.
 *
 * Only brands whose owner grants referential logo use appear here; every other sender
 * falls through to BIMI, Gravatar or colored initials. Gmail, Outlook, QQ, 163 and the
 * rest are absent by decision, not by oversight: their owners require written permission
 * for logo use or publish no grant at all.
 */
export const DOMAIN_TO_BRAND: Record<string, string> = {
  // Figma
  "figma.com": "figma",

  // OpenAI
  "openai.com": "openai",

  // PayPal
  "paypal.com": "paypal",

  // Telegram
  "telegram.org": "telegram",
  "t.me": "telegram",
};

/**
 * Resolves a sender email or domain to a built-in official BrandAvatar, if recognized.
 *
 * @param addressOrDomain Email address (e.g. "service@paypal.com") or domain string.
 * @returns The matching BrandAvatar definition or undefined.
 */
export function getBrandAvatar(addressOrDomain: string): BrandAvatar | undefined {
  if (!addressOrDomain) return undefined;
  const rootDomain = extractRootDomain(addressOrDomain);
  if (!rootDomain) return undefined;

  const brandId = DOMAIN_TO_BRAND[rootDomain];
  if (!brandId) return undefined;

  return BRAND_DEFINITIONS[brandId];
}
