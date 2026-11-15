import { describe, expect, it } from "vitest";

import { loadAggregatedCss } from "./testUtils/loadStyles";

/**
 * Guard: the two end window controls must stay nested inside the tray's cap.
 *
 * The tray (`.desktop-app .window-controls`) is a 6px-padded pill. With 32px
 * buttons it is 44px tall, so `--radius-pill` resolves to a 22px semicircular
 * cap. A 32px hover block 6px inside that cap only keeps the straight sides'
 * 6px of tray if its outward arc is concentric with the cap — i.e. 22 − 6 = 16px,
 * which for this geometry is also exactly half the button height. Concentric
 * circles are not sufficient on their own: the buttons are squircles
 * (`superellipse(2)`), and a 16px squircle still bulges into the corner —
 * measured 2.75px of tray at the 45° apex instead of 6px. That is why the two
 * outward corners also reset to `superellipse(1)`, the curvature the tray's own
 * cap uses, while the inward corners keep the design system's `--corner-shape`.
 *
 * This is the static half of the guarantee, because the stylesheet is where the
 * regression would be introduced. It resolves the tokens and asserts the
 * *geometry* — which corners are special, by how much, and in which direction —
 * rather than looking for a literal. It catches:
 *   - the outward radius drifting off the concentric value when the tray
 *     padding, the pill cap or the button size changes underneath it;
 *   - the single-side `superellipse(1)` being dropped, applied to the wrong
 *     corners, or replaced by a four-corner shorthand;
 *   - the middle button (or any other `.window-control`) growing an override;
 *   - the inward corners no longer following `--corner-shape`.
 *
 * It cannot see pixels: squircle rasterisation, antialiasing and the hover /
 * focus colours only exist in a real render. The 45°-apex measurement
 * (2.25–2.50px before, 6.00px after) and the 8x/12x screenshots that settled
 * these numbers were taken in Chromium; this file keeps the geometry honest
 * between those runs, it does not replace them.
 */

interface Rule {
  selector: string;
  declarations: Map<string, string>;
}

type Corner = "top-left" | "top-right" | "bottom-right" | "bottom-left";

/** `corner-shape` and `border-radius` share the CSS 1–4 value expansion order. */
const CORNER_ORDER: readonly Corner[] = ["top-left", "top-right", "bottom-right", "bottom-left"];

const stylesheet = loadAggregatedCss();

function parseRules(css: string): Rule[] {
  return [...css.matchAll(/(?:^|\n)([^\n{}]+)\n\{\n([^}]*)\}/g)].map((match) => {
    const declarations = new Map<string, string>();
    for (const chunk of (match[2] ?? "").split(/[;\n]/)) {
      const declaration = chunk.trim();
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      declarations.set(declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim());
    }
    return { selector: (match[1] ?? "").trim(), declarations };
  });
}

const rules = parseRules(stylesheet);

function requireRule(selector: string): Rule {
  const rule = rules.find((candidate) => candidate.selector === selector);
  if (!rule) throw new Error(`missing rule: ${selector}`);
  return rule;
}

/**
 * Token lookup over the whole stylesheet, last definition wins. The squircle
 * scale is redefined inside `@supports (corner-shape:squircle)` further down,
 * and that later value is the one supporting engines (the ones that can render
 * these corners at all) actually use.
 */
function token(name: string): string | undefined {
  const matches = [...stylesheet.matchAll(new RegExp(`^${name}:([^;\\n]+)`, "gm"))];
  return matches.at(-1)?.[1]?.trim();
}

/** A unitless token (`--squircle-scale: 1.72`) or anything `lengthPx` can read. */
function numberValue(value: string | undefined): number {
  if (!value) return Number.NaN;
  const text = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number.parseFloat(text);
  return lengthPx(text);
}

/** Resolves the length forms this stylesheet uses for radii, in px. */
function lengthPx(value: string | undefined): number {
  if (!value) return Number.NaN;
  const text = value.trim();
  const literal = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
  if (literal) return Number.parseFloat(literal[1] as string);
  const scaled = /^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\((--[\w-]+)\)\s*\)$/.exec(text);
  if (scaled) return Number.parseFloat(scaled[1] as string) * numberValue(token(scaled[2] as string));
  const reference = /^var\((--[\w-]+)\)$/.exec(text);
  if (reference) return lengthPx(token(reference[1] as string));
  return Number.NaN;
}

function expandValues(value: string): string[] {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return [parts[0] as string, parts[0] as string, parts[0] as string, parts[0] as string];
  if (parts.length === 2) return [parts[0] as string, parts[1] as string, parts[0] as string, parts[1] as string];
  if (parts.length === 3) return [parts[0] as string, parts[1] as string, parts[2] as string, parts[1] as string];
  return parts;
}

interface Corners {
  radius: Record<Corner, string>;
  shape: Record<Corner, string>;
}

function cornersOf(rule: Rule, base: Corners): Corners {
  const radius = { ...base.radius };
  const shape = { ...base.shape };
  for (const corner of CORNER_ORDER) {
    const longhand = rule.declarations.get(`border-${corner}-radius`);
    if (longhand) radius[corner] = longhand;
  }
  const shapeValue = rule.declarations.get("corner-shape");
  if (shapeValue) {
    const values = expandValues(shapeValue);
    CORNER_ORDER.forEach((corner, index) => {
      shape[corner] = values[index] as string;
    });
  }
  return { radius, shape };
}

const tray = requireRule(".desktop-app .window-controls");
const button = requireRule(".icon-button");

const trayPadding = lengthPx(tray.declarations.get("padding"));
const pillRadius = lengthPx(tray.declarations.get("border-radius"));
const buttonHeight = lengthPx(button.declarations.get("height"));
/** The pill only ever reaches half the tray's height — the semicircular cap. */
const trayHeight = buttonHeight + trayPadding * 2;
const capRadius = Math.min(pillRadius, trayHeight / 2);
/** What a concentric inner arc has to be, given the padding above. */
const concentricRadius = capRadius - trayPadding;

const baseCorners: Corners = {
  radius: Object.fromEntries(CORNER_ORDER.map((corner) => [corner, button.declarations.get("border-radius") as string])) as Record<Corner, string>,
  shape: Object.fromEntries(CORNER_ORDER.map((corner) => [corner, button.declarations.get("corner-shape") as string])) as Record<Corner, string>,
};

const minimize = cornersOf(requireRule(".window-controls .window-control:nth-child(1)"), baseCorners);
const close = cornersOf(requireRule(".window-controls .window-control:nth-child(3)"), baseCorners);

/** Every rule that targets one window-control button itself (not the tray). */
const buttonRules = rules.filter((rule) => /(^|[\s,>])\.window-control(:[^\s,{]*)?$/.test(rule.selector));
const overridingRules = buttonRules.filter((rule) =>
  [...rule.declarations.keys()].some(
    (property) => /^border-(top|bottom)-(left|right)-radius$/.test(property) || property === "corner-shape" || property === "border-radius",
  ),
);

describe("window control tray corners", () => {
  it("derives a cap that can host a concentric inner arc", () => {
    expect(Number.isFinite(trayPadding), "the tray needs a uniform padding").toBe(true);
    expect(Number.isFinite(buttonHeight), "the button needs an explicit height").toBe(true);
    expect(capRadius, "the tray's end must be a semicircular cap, not a smaller radius").toBeCloseTo(trayHeight / 2, 5);
    expect(concentricRadius, "the padded button must still leave room inside the cap").toBeGreaterThan(0);
  });

  it("ships exactly the radius that is concentric with that cap", () => {
    // 22 − 6 = 16 today; derived, so changing the padding or the button height
    // shows up here instead of silently leaving a 3px gap at the apex.
    expect(lengthPx(minimize.radius["top-left"])).toBeCloseTo(concentricRadius, 5);
    expect(lengthPx(minimize.radius["bottom-left"])).toBeCloseTo(concentricRadius, 5);
    expect(lengthPx(close.radius["top-right"])).toBeCloseTo(concentricRadius, 5);
    expect(lengthPx(close.radius["bottom-right"])).toBeCloseTo(concentricRadius, 5);
  });

  it("keeps the inward corners on the design system's squircle", () => {
    expect(token("--corner-shape"), "the design system's default corner shape").toBe("squircle");
    const baseRadius = lengthPx(baseCorners.radius["top-left"]);
    expect(baseRadius, "the base button radius must resolve to the squircle-compensated tier").toBeGreaterThan(0);

    for (const corner of ["top-right", "bottom-right"] as const) {
      expect(lengthPx(minimize.radius[corner]), `minimize/${corner} must stay at the base radius`).toBeCloseTo(baseRadius, 5);
      expect(minimize.shape[corner], `minimize/${corner} must keep --corner-shape`).toBe("var(--corner-shape)");
    }
    for (const corner of ["top-left", "bottom-left"] as const) {
      expect(lengthPx(close.radius[corner]), `close/${corner} must stay at the base radius`).toBeCloseTo(baseRadius, 5);
      expect(close.shape[corner], `close/${corner} must keep --corner-shape`).toBe("var(--corner-shape)");
    }
    // The inward arc is visibly rounder than the outward one it faces; if these
    // ever meet, the compensation has been undone.
    expect(baseRadius).toBeLessThan(concentricRadius);
  });

  it("gives the outward corners the tray's own curvature, on the outward side only", () => {
    expect(minimize.shape["top-left"]).toBe("superellipse(1)");
    expect(minimize.shape["bottom-left"]).toBe("superellipse(1)");
    expect(close.shape["top-right"]).toBe("superellipse(1)");
    expect(close.shape["bottom-right"]).toBe("superellipse(1)");
  });

  it("leaves every other window control alone", () => {
    expect(
      overridingRules.map((rule) => rule.selector).sort(),
      "only the first and last buttons may override radius or corner shape",
    ).toEqual([".window-controls .window-control:nth-child(1)", ".window-controls .window-control:nth-child(3)"]);

    for (const rule of overridingRules) {
      expect(
        [...rule.declarations.keys()],
        `${rule.selector} must change single corners, not the whole box`,
      ).not.toContain("border-radius");
    }
  });
});
