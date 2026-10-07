import { describe, expect, it } from "vitest";

/**
 * Contrast baseline for the two themes.
 *
 * This is the guard for the "colour" half of the design system: the palette is
 * deliberately muted, so it is easy to nudge a token for looks and drop small
 * text below the WCAG AA floor without noticing. Every value here is computed
 * from `styles.css` itself, so editing a token re-checks it.
 *
 * Floors follow WCAG 2.1 AA for normal-size text (4.5:1). Nothing in this app
 * is large enough to qualify for the 3:1 large-text allowance: the tokens this
 * test covers are used at 8–11px in chips, timestamps and metadata.
 *
 * Known boundary this test cannot cover: the shell panels are translucent and an
 * optional wallpaper sits underneath them, so a user who lowers the panel
 * opacity over a dark wallpaper can defeat these ratios. The default is opaque
 * (`--bg-panel-opacity:100%`); the numbers below assume the panels are composited
 * over the canvas, which is the darkest surface in the default configuration.
 */

import { loadAggregatedCss } from "./testUtils/loadStyles";

const stylesheet = loadAggregatedCss();

type Rgb = [number, number, number];

function readTokenBlock(theme: "light" | "dark"): Record<string, string> {
  const marker = theme === "light" ? ":root\n{" : ":root[data-theme=dark]\n{";
  const start = stylesheet.indexOf(marker);
  expect(start, `${theme} theme block must exist in styles.css`).toBeGreaterThanOrEqual(0);
  const end = stylesheet.indexOf("\n}", start);
  expect(end, `${theme} theme block must be closed`).toBeGreaterThan(start);
  const block = stylesheet.slice(start + marker.length, end);
  const tokens: Record<string, string> = {};
  for (const declaration of block.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const name = declaration.slice(0, separator).trim();
    if (!name.startsWith("--")) continue;
    tokens[name] = declaration.slice(separator + 1).trim();
  }
  return tokens;
}

function parseHex(value: string, name: string): { rgb: Rgb; alpha: number } {
  const hex = value.trim().replace("#", "");
  expect([3, 4, 6, 8], `${name} must be a hex colour, got "${value}"`).toContain(hex.length);
  const expand = (part: string) => (part.length === 1 ? part + part : part);
  const pairs = hex.length <= 4
    ? hex.split("").map(expand)
    : hex.match(/.{2}/g) ?? [];
  const [r, g, b, a] = pairs.map((pair) => Number.parseInt(pair, 16));
  return {
    rgb: [(r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255],
    alpha: a === undefined ? 1 : a / 255,
  };
}

/** Composites a (possibly translucent) colour over an opaque backdrop. */
function flatten(foreground: { rgb: Rgb; alpha: number }, background: Rgb): Rgb {
  return foreground.rgb.map((channel, index) => channel * foreground.alpha + (background[index] ?? 0) * (1 - foreground.alpha)) as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function token(tokens: Record<string, string>, name: string): { rgb: Rgb; alpha: number } {
  const value = tokens[name];
  expect(value, `${name} must be defined`).toBeTruthy();
  return parseHex(value as string, name);
}

const AA_NORMAL = 4.5;

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme contrast`, () => {
    const tokens = readTokenBlock(theme);
    const canvas = token(tokens, "--canvas").rgb;
    // The darkest surfaces text actually lands on, with the panels composited
    // over the canvas rather than assumed opaque.
    const surfaces = {
      "--panel-solid": token(tokens, "--panel-solid").rgb,
      "--panel": flatten(token(tokens, "--panel"), canvas),
      "--panel-muted": flatten(token(tokens, "--panel-muted"), canvas),
      "--canvas": canvas,
    };

    it("keeps every text tier readable on every surface", () => {
      // The raw canvas is included because `.background-preview` renders
      // `--text-faint` directly on it (the "no background" label in Settings).
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        for (const name of ["--text", "--text-soft", "--text-faint"]) {
          const ratio = contrast(token(tokens, name).rgb, surface);
          expect(ratio, `${name} on ${surfaceName} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
      }
    });

    it("keeps the semantic colours readable when used as text", () => {
      // Scoped to the panels: the semantic colours appear in badges, status
      // text and inline messages, all of which sit inside a panel. The raw
      // canvas is deliberately excluded — nothing renders them there today.
      for (const surfaceName of ["--panel-solid", "--panel", "--panel-muted"]) {
        const surface = surfaces[surfaceName as keyof typeof surfaces];
        for (const name of ["--danger", "--success", "--warning", "--info"]) {
          const ratio = contrast(token(tokens, name).rgb, surface);
          expect(ratio, `${name} on ${surfaceName} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
        }
      }
    });

    it("keeps the button label readable on the button fill", () => {
      const ratio = contrast(token(tokens, "--button-text").rgb, token(tokens, "--button").rgb);
      expect(ratio, `--button-text on --button is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it("step ordering survives the floor: text is the strongest tier", () => {
      // The faint tier now sits close to soft because both must clear AA at
      // 8–11px; they must still be distinguishable and ordered.
      const onSolid = surfaces["--panel-solid"];
      const text = contrast(token(tokens, "--text").rgb, onSolid);
      const soft = contrast(token(tokens, "--text-soft").rgb, onSolid);
      const faint = contrast(token(tokens, "--text-faint").rgb, onSolid);
      expect(text).toBeGreaterThan(soft);
      expect(soft).toBeGreaterThan(faint);
    });
  });
}

/**
 * Tinted backgrounds — the gap this file used to have.
 *
 * Everything above measures a token against a *panel* surface. But the badge /
 * status-chip / inline-box recipe (`background:color-mix(in srgb, var(--token)
 * N%, transparent)` under a `color:var(--token)` label) puts the text on a
 * surface derived from its own colour, and a tint only ever moves that surface
 * *towards* the text — so the ratio is always ≤ the panel figure the other tests
 * check. That is why 27 green cases coexisted with badges sitting at 3.6:1.
 *
 * Two consequences worth stating, because they invert the obvious "just add more
 * tint" instinct:
 *   - Raising N makes the ratio WORSE, not better (measured: --success on
 *     --panel-muted is 4.80 at 0%, 3.96 at 15%, 3.46 at 25%).
 *   - Lowering N to clear 4.5:1 would drive N to ~0-2% for --warning, erasing
 *     the tint that carries the state at all.
 * So the fix has to be in the foreground token, and this test is what forces
 * that conclusion rather than letting each badge be nudged one at a time.
 *
 * The tint alpha is read from the stylesheet per selector (including
 * `[data-theme="dark"]` overrides), so editing a rule re-checks it here.
 */
type Rgb3 = [number, number, number];

const TINT_BACKGROUND = /background:\s*color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%,\s*transparent\)/;
const LABEL_COLOR = /(?:^|[;{])\s*color:\s*var\((--[\w-]+)\)/;

/**
 * Splits the stylesheet into selector/body pairs. Most rules in this codebase
 * are written on a single line (`.foo { … }`), so the selector is matched as
 * "everything up to the brace" rather than "a whole line" — a line-anchored
 * pattern silently sees only the ~300 multi-line rules and misses the rest.
 */
function cssRules(): Array<{ selector: string; body: string }> {
  return [...stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? "").trim().replace(/\s+/g, " "),
    body: match[2] ?? "",
  }));
}

/** One self-tinted site: a label colour and the tint it sits on. */
type TintSite = { token: string; alpha: number };
type TintSiteEntry = { selector: string; light: TintSite; dark?: TintSite };

/**
 * Every rule whose label colour matches the token its background is tinted
 * with, keyed by selector without the dark-theme prefix. A dark override wins
 * for the dark theme; otherwise the unprefixed rule applies to both.
 */
function selfTintSites(): Map<string, TintSiteEntry> {
  const sites = new Map<string, TintSiteEntry>();
  for (const rule of cssRules()) {
    const background = rule.body.match(TINT_BACKGROUND);
    const label = rule.body.match(LABEL_COLOR);
    // Only the same-token recipe is a "tint of its own text"; a background
    // tinted with a *different* token is an ordinary surface, already covered.
    if (!background || !label || background[1] !== label[1]) continue;
    const isDark = /^\[data-theme="dark"\]\s*/.test(rule.selector);
    const selector = rule.selector.replace(/^\[data-theme="dark"\]\s*/, "");
    const site: TintSite = { token: background[1] as string, alpha: Number(background[2]) / 100 };
    const entry = sites.get(selector);
    if (isDark) {
      if (entry) entry.dark = site;
      else sites.set(selector, { selector, light: site, dark: site });
    } else {
      sites.set(selector, { selector, light: site, ...(entry?.dark ? { dark: entry.dark } : {}) });
    }
  }
  return sites;
}

/** Resolves a token to concrete sRGB, following `var()` aliases one level. */
function resolveColor(tokens: Record<string, string>, name: string): Rgb3 | null {
  const value = tokens[name];
  if (!value) return null;
  if (value.startsWith("#")) return parseHex(value, name).rgb as Rgb3;
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolveColor(tokens, alias[1] as string) : null;
}

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme tinted badges`, () => {
    const tokens = readTokenBlock(theme);
    const canvas = token(tokens, "--canvas").rgb;
    const surfaces: Array<[string, Rgb3]> = [
      ["--panel-solid", token(tokens, "--panel-solid").rgb as Rgb3],
      ["--panel", flatten(token(tokens, "--panel"), canvas) as Rgb3],
      ["--panel-muted", flatten(token(tokens, "--panel-muted"), canvas) as Rgb3],
    ];

    it("keeps every self-tinted label readable on its own tint", () => {
      const offenders: string[] = [];
      let checked = 0;
      for (const site of selfTintSites().values()) {
        const { token: name, alpha } = theme === "light" ? site.light : site.dark ?? site.light;
        const foreground = resolveColor(tokens, name);
        // A tint of a non-colour token (e.g. --focus-ring: var(--text)) is
        // covered by the surface tests above via its resolved alias.
        if (!foreground) continue;
        checked += 1;
        for (const [surfaceName, surface] of surfaces) {
          const tint = foreground.map((channel, index) => channel * alpha + (surface[index] ?? 0) * (1 - alpha)) as Rgb3;
          const ratio = contrast(foreground, tint);
          if (ratio < AA_NORMAL) {
            offenders.push(`${site.selector}: ${name} at ${(alpha * 100).toFixed(0)}% on ${surfaceName} is ${ratio.toFixed(2)}:1`);
            break;
          }
        }
      }
      expect(checked, "the self-tint scan must actually find sites").toBeGreaterThan(0);
      expect(offenders, "a label must clear 4.5:1 on the tint it sits on; darken the token rather than raising the tint").toEqual([]);
    });
  });
}

/**
 * The accent palette (calendar colours, attachment-kind icons).
 *
 * These are the *only* saturated colours in the UI, which makes them the easiest
 * place to drift out of the muted family the semantic tokens establish — they
 * arrived from a Tailwind-ish scale at ~2× the semantic saturation, and their
 * small-chip text sat as low as 2.18:1 against its own tint.
 */
const ACCENT_TOKENS = [
  "--cal-blue", "--cal-green", "--cal-amber", "--cal-red", "--cal-purple", "--cal-teal",
  "--kind-code", "--kind-media",
] as const;
/** Saturation ceiling that keeps an accent in the same family as --danger etc. */
const MAX_ACCENT_SATURATION = 65;
/** How much of the accent a chip mixes into the panel behind its label. */
const CHIP_TINT_ALPHA = 0.16;
/** WCAG 1.4.11 floor for a non-text UI component (the colour swatch). */
const NON_TEXT_MINIMUM = 3;

function saturationOf(rgb: Rgb): number {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const lightness = (max + min) / 2;
  if (max === min) return 0;
  return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} accents`, () => {
    const tokens = readTokenBlock(theme);
    const surface = token(tokens, "--panel-solid").rgb;

    it("keeps every accent inside the muted saturation band", () => {
      for (const name of ACCENT_TOKENS) {
        const saturation = saturationOf(token(tokens, name).rgb) * 100;
        expect(saturation, `${name} saturation is ${saturation.toFixed(0)}%`).toBeLessThanOrEqual(MAX_ACCENT_SATURATION);
      }
    });

    it("keeps chip labels legible on their own tint", () => {
      for (const name of ACCENT_TOKENS) {
        const accent = token(tokens, name).rgb;
        const tint = accent.map((channel, index) => channel * CHIP_TINT_ALPHA + (surface[index] ?? 0) * (1 - CHIP_TINT_ALPHA)) as Rgb;
        const ratio = contrast(accent, tint);
        expect(ratio, `${name} label on its ${CHIP_TINT_ALPHA * 100}% tint is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });

    it("keeps swatches distinguishable from the panel", () => {
      for (const name of ACCENT_TOKENS) {
        const ratio = contrast(token(tokens, name).rgb, surface);
        expect(ratio, `${name} swatch against the panel is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM);
      }
    });
  });
}
