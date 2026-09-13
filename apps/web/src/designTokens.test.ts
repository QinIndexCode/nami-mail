import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Design-token policy and debt ratchet.
 *
 * The design system (`docs/DESIGN-SYSTEM.zh-CN.md`) states the rules, but rules
 * only hold if something checks them. This test does two things:
 *
 * 1. **Policy** — catches new violations outright: a radius that is not one of
 *    the four tiers, a shadow that is not one of the four levels, a rogue font
 *    size, an unpaired `outline:none`.
 * 2. **Ratchet** — freezes the debt that predates the policy. Every number in
 *    `debtBudget` is a ceiling: it may only go DOWN. When you fix some, lower the
 *    number; the point is that it can never grow again.
 *
 * Convergence that would *change* pixels (one-off shadows, off-scale radii, the
 * spacing grid, desaturating `--cal-*`) is tracked in the design system's backlog
 * and deliberately not forced here.
 */

const stylesheet = readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

/** Ceilings for pre-existing debt. Lower these; never raise them. */
const debtBudget = {
  // Eight off-scale radii plus three asymmetric corners, all predating the
  // four-tier scale. New radii must use a tier or appear in ALLOWED_RADII.
  offScaleRadius: {
    "6px": 40,
    "10px": 27,
    "5px": 14,
    "14px": 9,
    "16px": 7,
    "3px": 7,
    "18px": 2,
    "24px": 1,
    "0 0 10px 10px": 1,
    "10px 10px 0 0": 1,
    "16px 16px 0 0": 1,
  },
  /**
   * State halos — a tinted lift that expresses selection, hover, error or glow,
   * using the documented `color-mix` recipe instead of an elevation token.
   * Twelve elevation literals were folded into the tokens on 2026-09-10, and
   * three panel-coloured sticky-header/status masks were restored after the
   * installed build showed they are masks, not elevation — leaving these 21
   * (counted per declaration; a selector repeats across state variants).
   * Consolidate them; do not add more without a reason.
   */
  stateHalo: 21,

  /**
   * Odd spacing values (≥5px) left from hand-tuning. The layout actually follows
   * a 2px sub-grid (6/10/14/18/22px dominate) with 1px/3px allowed for hairlines,
   * so these are the remaining exceptions rather than "everything must be 4px".
   * 7px/9px were snapped to 8px on 2026-09-10 and must stay at zero.
   */
  offGridSpacing: {
    "5px": 79,
    "11px": 49,
    "13px": 47,
    "17px": 13,
    "15px": 10,
    "21px": 3,
    "19px": 3,
    "29px": 2,
    "25px": 1,
    "41px": 1,
  },
  /**
   * `!important` declarations. The audit guessed "about six are redundant", but
   * checking each one showed the opposite: most are structurally required (they
   * override inline email styles, the global `user-select` rules,
   * reduced-motion, print, or a higher-specificity variant rule). One was
   * removed on 2026-09-10 by winning on specificity instead; the rest need a
   * browser-level cascade check per declaration. (The audit's own listing was
   * truncated, which is why its count did not add up.)
   */
  important: 53,
  /** Bare outlines; each must be paired with a focus ring (checked below). */
  bareOutline: 42,
} as const;

/**
 * Radii that are not a tier but are structurally meaningful: reset corners,
 * hairline rounding, and circles (avatars, dots, swatches).
 */
const ALLOWED_RADII = new Set(["0", "2px", "4px", "50%"]);

function declarationsOf(property: string): string[] {
  const matches = stylesheet.match(new RegExp(`^${property}:(.+)$`, "gm")) ?? [];
  // Values may or may not carry the block's closing semicolon (it is only
  // mandatory when another property follows), so normalise it away.
  return matches.map((line) => line.slice(property.length + 1).replace(/;\s*$/, "").trim());
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

describe("radius policy", () => {
  it("has no radius outside the documented budget", () => {
    const counts = countBy(declarationsOf("border-radius"));
    for (const [value, count] of Object.entries(counts)) {
      if (value.startsWith("var(--radius-")) continue;
      if (ALLOWED_RADII.has(value)) continue;
      const budget = (debtBudget.offScaleRadius as Record<string, number>)[value];
      expect(budget, `border-radius:${value} is not one of the four tiers; use --radius-sm/md/lg/pill`).toBeDefined();
      expect(count, `border-radius:${value} went over its budget`).toBeLessThanOrEqual(budget as number);
    }
  });

  it("defines every tier it references", () => {
    for (const token of ["--radius-sm", "--radius-md", "--radius-lg", "--radius-pill"]) {
      expect(stylesheet).toContain(`${token}:`);
    }
  });
});

describe("shadow policy", () => {
  /**
   * Native-control internals: the range thumb carries a platform shadow that is
   * a rendering detail, not elevation. Matched by suffix so state variants
   * (`:active:not(:disabled)`) are covered too.
   */
  const isPlatformDetail = (selector: string): boolean =>
    selector.includes(".setting-range input[type=range]")
    && (selector.endsWith("::-webkit-slider-thumb") || selector.endsWith("::-moz-range-thumb"));
  /** The documented state-halo recipe: a tinted lift built from a token. */
  const stateHalo = /^0 -?\d+px \d+px(?: -?\d+px)? color-mix\(in srgb, var\(--/;
  /** Hairline separators ride along with an elevation token. */
  const hairline = /^0 1px 0 var\(--line(?:-strong)?\)$/;

  /** Splits a shadow declaration into layers, respecting nested parentheses. */
  function splitLayers(value: string): string[] {
    const layers: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        layers.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim()) layers.push(current.trim());
    return layers;
  }

  function shadowDeclarations(): Array<{ selector: string; layer: string }> {
    const found: Array<{ selector: string; layer: string }> = [];
    for (const match of stylesheet.matchAll(/(?:^|\n)([^\n{}]+)\n\{\n([^}]*)\}/g)) {
      const selector = (match[1] ?? "").trim();
      for (const line of (match[2] ?? "").split("\n")) {
        if (!line.startsWith("box-shadow:")) continue;
        for (const layer of splitLayers(line.slice("box-shadow:".length).replace(/;\s*$/, "").trim())) {
          if (layer !== "none") found.push({ selector, layer });
        }
      }
    }
    return found;
  }

  it("routes every floating surface through an elevation token", () => {
    const layers = shadowDeclarations();
    const offenders = layers.filter(({ selector, layer }) => {
      if (layer.startsWith("var(--shadow")) return false;
      if (hairline.test(layer)) return false;
      if (/^inset /.test(layer)) return false; // inset hairline / highlight
      if (/^0 0 0 /.test(layer)) return false; // focus ring
      if (stateHalo.test(layer)) return false;
      return !isPlatformDetail(selector);
    });
    expect(
      offenders.map(({ selector, layer }) => `${selector} :: ${layer}`),
      "floating surfaces must use --shadow-sm/-raised/--shadow/--shadow-drawer; a tinted state lift must use the color-mix recipe",
    ).toEqual([]);
  });

  it("keeps the state-halo count from growing", () => {
    const halos = shadowDeclarations().filter(({ layer }) => stateHalo.test(layer));
    expect(halos.length, "state halos may only be consolidated").toBeLessThanOrEqual(debtBudget.stateHalo);
  });
});

describe("spacing policy", () => {
  const SPACING_PROPERTY = /^(gap|row-gap|column-gap|margin|padding)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;
  /** Values that may legally be odd: hairlines and optical nudges. */
  const HAIRLINE_VALUES = new Set(["1px", "3px", "-1px"]);

  function spacingValues(): string[] {
    const values: string[] = [];
    for (const line of stylesheet.split("\n")) {
      const declaration = line.match(/^([a-z-]+):(.+?);?$/);
      if (!declaration) continue;
      const [, property, rawValue] = declaration;
      if (!SPACING_PROPERTY.test(property ?? "")) continue;
      for (const token of (rawValue ?? "").replace(/!important/g, "").trim().split(/\s+/)) {
        if (/^-?\d+px$/.test(token)) values.push(token);
      }
    }
    return values;
  }

  it("keeps the 7px/9px one-pixel nudges gone", () => {
    // These were the outliers the audit flagged: one pixel away from the 8px
    // step they belonged to (217 lines were snapped on 2026-09-10).
    const offenders = spacingValues().filter((value) => value === "7px" || value === "9px");
    expect(offenders, "7px/9px are hand-nudges; use the neighbouring even step").toEqual([]);
  });

  it("does not add new odd rhythm values", () => {
    // Reality check that corrected the original "everything on a 4px grid" goal:
    // the layout is hand-tuned on a *2px* sub-grid (even values dominate), with
    // 1px/3px for hairlines. Forcing a strict 4px grid would be a visual remodel,
    // not debt cleanup — so the enforceable rule is "no new odd rhythm value".
    const counts = countBy(spacingValues().filter((value) => !HAIRLINE_VALUES.has(value)));
    for (const [value, count] of Object.entries(counts)) {
      const size = Math.abs(Number.parseInt(value, 10));
      if (size % 2 === 0) continue;
      const budget = (debtBudget.offGridSpacing as Record<string, number>)[value];
      expect(budget, `spacing value ${value} is odd and not in the budget; use an even step`).toBeDefined();
      expect(count, `spacing value ${value} went over its budget`).toBeLessThanOrEqual(budget as number);
    }
  });
});

describe("type policy", () => {
  it("uses whole-pixel type steps only", () => {
    // All ten fractional steps (9.5/10.5/11.5/12.5/13.5px) were snapped to a
    // documented step on 2026-09-10; a fractional size is a half-decision that
    // makes two near-identical sizes coexist, so none may come back.
    const fractional = Object.keys(countBy(declarationsOf("font-size"))).filter((value) => /^\d+\.\d+px$/.test(value));
    expect(fractional, "fractional type steps must snap to a documented step").toEqual([]);
  });
});

describe("outline policy", () => {
  it("keeps the !important count from growing", () => {
    const count = (stylesheet.match(/!important/g) ?? []).length;
    expect(count, "!important count may only go down").toBeLessThanOrEqual(debtBudget.important);
  });

  it("pairs every bare outline with a focus ring", () => {
    const rules = [...stylesheet.matchAll(/(?:^|\n)([^\n{}]+)\n\{\n([^}]*)\}/g)].map((match) => ({
      selector: (match[1] ?? "").trim(),
      body: match[2] ?? "",
    }));
    // The global rule already gives native controls a ring, so a bare
    // `outline:none` on one of them is fine as long as that rule still exists.
    const globalRing = rules.some((rule) => rule.selector.includes("button") && rule.selector.includes(":focus-visible") && /outline:\s*2px/.test(rule.body));
    expect(globalRing, "the global :focus-visible ring must exist").toBe(true);

    const bare = rules.filter((rule) => /outline:\s*(none|0)\b/.test(rule.body) && rule.selector.includes(":focus"));
    expect(bare.length, "bare outline count may only go down").toBeLessThanOrEqual(debtBudget.bareOutline);

    // Menus and list rows indicate focus with a background change instead of a
    // ring, by putting `:focus-visible` in the same selector as `:hover`. Those
    // rules are their own replacement — but they must actually change something.
    // `:focus:not(:focus-visible)` is the opposite pattern — the pointer-focus
    // rule that *relies* on a sibling `:focus-visible` rule — so it is excluded
    // here and checked for a pair below.
    const selfHandled = bare.filter((rule) => rule.selector.includes(":focus-visible") && !rule.selector.includes(":not(:focus-visible)"));
    const silent = selfHandled.filter((rule) => !/(background|filter|color|box-shadow|outline:\s*2px)/.test(rule.body));
    expect(silent.map((rule) => rule.selector), "these drop the outline on focus without showing anything instead").toEqual([]);

    const unpaired: string[] = [];
    for (const rule of bare.filter((candidate) => !candidate.selector.includes(":focus-visible"))) {
      const base = rule.selector.split(":")[0]?.trim() ?? "";
      if (/^(button|input|textarea|select)$/.test(base)) continue;
      const ring = rules.find((candidate) => candidate.selector.includes(`${base}:focus-visible`) && /(outline:\s*2px|box-shadow:)/.test(candidate.body));
      if (!ring) unpaired.push(rule.selector);
    }
    expect(unpaired, "these selectors drop the outline without a keyboard replacement").toEqual([]);
  });
});

describe("theme parity", () => {
  const block = (theme: "light" | "dark"): string => {
    const marker = theme === "light" ? ":root\n{" : ":root[data-theme=dark]\n{";
    const start = stylesheet.indexOf(marker);
    return stylesheet.slice(start, stylesheet.indexOf("\n}", start));
  };

  it("defines the calendar palette in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const name of ["--cal-blue", "--cal-green", "--cal-amber", "--cal-red", "--cal-purple", "--cal-teal"]) {
        expect(block(theme), `${name} must be defined in the ${theme} theme`).toContain(`${name}:`);
      }
    }
  });

  it("gives both themes a distinct calendar value rather than inheriting", () => {
    // The whole point of tokenising these was that the dark theme had no
    // override and the vivid light values leaked into dark mode.
    const lightCal = block("light").match(/--cal-blue:(#[0-9a-f]{6})/)?.[1];
    const darkCal = block("dark").match(/--cal-blue:(#[0-9a-f]{6})/)?.[1];
    expect(lightCal).toBeTruthy();
    expect(darkCal).toBeTruthy();
    expect(darkCal).not.toBe(lightCal);
  });
});

describe("documented baselines", () => {
  it("ships the design system in both languages", () => {
    const docs = path.join(process.cwd(), "..", "..", "docs");
    for (const name of ["DESIGN-SYSTEM.zh-CN.md", "DESIGN-SYSTEM.en.md"]) {
      expect(existsSync(path.join(docs, name)), `${name} is the written baseline and must exist`).toBe(true);
    }
  });

  it("keeps the reading measure aligned with the body font", () => {
    // The measure now caps plain-text prose only — the reading column itself is
    // fluid, because provider-authored HTML has its own layout — and it is
    // derived from the 16px Georgia body text, so it must be recomputed if that
    // changes (documented in the design system).
    expect(stylesheet).toMatch(/--measure:\s*960px/);
    expect(stylesheet).toMatch(/\.mail-text,\.mail-html\n\{[^}]*font-size:16px/s);
  });
});
