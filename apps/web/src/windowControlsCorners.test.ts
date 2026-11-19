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
 * measured as little as ~1.8px of tray at the 45° apex instead of 6px. That is
 * why the two outward corners also reset to `superellipse(1)`, the curvature the
 * tray's own cap uses, while the inward corners keep the design system's
 * `--corner-shape`.
 *
 * The stylesheet expresses that relationship as a token chain on `.desktop-app`:
 * `--window-control-size` + `--window-control-tray-padding` → tray height →
 * cap radius → `--window-control-outer-radius` (= cap − padding). The tray and
 * the end buttons consume those tokens, so changing the padding or the button
 * size moves both the cap and the outward arc together. This file re-derives
 * the same chain from the stylesheet instead of hard-coding 16px, and it
 * requires the rules to reference the tokens (a copied literal fails even when
 * today's arithmetic happens to match). It catches:
 *   - the outward radius drifting off the concentric value when the tray
 *     padding, the pill cap or the button size changes underneath it;
 *   - a literal replacing the derived token, so the next dimension change
 *     silently leaves a gap at the apex;
 *   - the single-side cap curvature being dropped, applied to the wrong
 *     corners, or replaced by a four-corner shorthand;
 *   - the middle button (or any other `.window-control`) growing an override;
 *   - the inward corners no longer following `--corner-shape`.
 *
 * It cannot see pixels: squircle rasterisation, antialiasing and the hover /
 * focus colours only exist in a real render. The 45°-apex measurement
 * (1.8–2.7px before, 5.2–6.0px after, across 1024/1400/1920 at DPR 1 and 1.5)
 * and the screenshots that settled these numbers were taken in Chromium; this
 * file keeps the geometry honest between those runs, it does not replace them.
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

/**
 * Resolves a CSS length the way the stylesheet chains them: px literals,
 * unitless tokens, `var()`, and nested `calc()` / `min()` arithmetic.
 * The window-control geometry is a five-token calc chain, so a regex per form
 * would either drift or silently return NaN; this evaluates it and fails
 * closed (NaN) on anything it does not understand.
 */
function lengthPx(value: string | undefined): number {
  return evaluate(value ?? "", 0);
}

/**
 * `overrides` substitutes token values during evaluation. The guard uses it to
 * re-run the token chain with a different button size and padding: if the
 * outward radius were a copied literal, it would stay put while the cap moved.
 */
function evaluate(raw: string, depth: number, overrides: ReadonlyMap<string, string> = new Map()): number {
  if (depth > 24) return Number.NaN;
  const text = raw.trim();
  if (!text) return Number.NaN;

  const calc = unwrapFunction(text, "calc");
  if (calc !== undefined) return evaluate(calc, depth + 1, overrides);

  const min = unwrapFunction(text, "min");
  if (min !== undefined) {
    const args = splitTopLevel(min, ",").map((argument) => evaluate(argument, depth + 1, overrides));
    return args.every(Number.isFinite) ? Math.min(...args) : Number.NaN;
  }

  const reference = unwrapFunction(text, "var");
  if (reference !== undefined) {
    const name = splitTopLevel(reference, ",")[0]?.trim() ?? "";
    return evaluate(overrides.get(name) ?? token(name) ?? "", depth + 1, overrides);
  }

  const px = /^(-?\d+(?:\.\d+)?)px$/.exec(text);
  if (px) return Number.parseFloat(px[1] as string);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number.parseFloat(text);

  // Additive binds looser than multiplicative; split at the last top-level
  // operator so `a - b - c` evaluates as `(a - b) - c`.
  for (const operators of [["+", "-"], ["*", "/"]] as const) {
    const index = lastTopLevelOperator(text, operators);
    if (index < 0) continue;
    const left = evaluate(text.slice(0, index), depth + 1, overrides);
    const right = evaluate(text.slice(index + 1), depth + 1, overrides);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
    switch (text[index]) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      default:
        return right === 0 ? Number.NaN : left / right;
    }
  }
  return Number.NaN;
}

/** Returns the inside of `name(...)` when it wraps the whole string. */
function unwrapFunction(text: string, name: string): string | undefined {
  if (!text.startsWith(`${name}(`) || !text.endsWith(")")) return undefined;
  let depth = 0;
  for (let index = name.length; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return undefined;
    }
  }
  return depth === 0 ? text.slice(name.length + 1, -1) : undefined;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function lastTopLevelOperator(text: string, operators: readonly string[]): number {
  let depth = 0;
  let found = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && operators.includes(character)) {
      const previous = text.slice(0, index).trimEnd();
      // A leading sign (`-6px`) or one after another operator is unary.
      if (previous === "" || /[+\-*/,(]$/.test(previous)) continue;
      found = index;
    }
  }
  return found;
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
const control = requireRule(".window-controls .window-control");

const trayPadding = lengthPx(tray.declarations.get("padding"));
const pillRadius = lengthPx(tray.declarations.get("border-radius"));
const controlSize = lengthPx(control.declarations.get("height"));
/** The pill only ever reaches half the tray's height — the semicircular cap. */
const trayHeight = controlSize + trayPadding * 2;
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
    expect(Number.isFinite(controlSize), "the window control needs an explicit height").toBe(true);
    expect(tray.declarations.get("padding"), "the tray must consume the shared inset token").toBe(
      "var(--window-control-tray-padding)",
    );
    expect(control.declarations.get("width"), "the control must consume the shared size token").toBe(
      "var(--window-control-size)",
    );
    expect(control.declarations.get("height"), "the control must consume the shared size token").toBe(
      "var(--window-control-size)",
    );
    expect(
      lengthPx(token("--window-control-tray-height")),
      "the tray-height token must be size + 2 × padding",
    ).toBeCloseTo(trayHeight, 5);
    expect(capRadius, "the tray's end must be a semicircular cap, not a smaller radius").toBeCloseTo(trayHeight / 2, 5);
    expect(lengthPx(token("--window-control-cap-radius")), "the cap token must agree with the resolved cap").toBeCloseTo(capRadius, 5);
    expect(concentricRadius, "the padded button must still leave room inside the cap").toBeGreaterThan(0);
  });

  it("ships exactly the derived radius, wired through the token", () => {
    // 22 − 6 = 16 today; the rule references the token rather than copying the
    // number, so changing the padding or the button height moves the arc too.
    const outward = [
      ["minimize", minimize.radius["top-left"]],
      ["minimize", minimize.radius["bottom-left"]],
      ["close", close.radius["top-right"]],
      ["close", close.radius["bottom-right"]],
    ] as const;
    for (const [name, value] of outward) {
      expect(value, `${name} must reference the derived radius token`).toBe("var(--window-control-outer-radius)");
    }
    expect(
      lengthPx(token("--window-control-outer-radius")),
      "the outward token must resolve to cap − padding",
    ).toBeCloseTo(concentricRadius, 5);

    // Re-run the chain with a larger button and a wider inset. A copied
    // literal would not move; this asserts the relationship, not today's 16px.
    const perturbed = new Map([
      ["--window-control-size", "40px"],
      ["--window-control-tray-padding", "10px"],
    ]);
    const perturbedCap = evaluate(token("--window-control-cap-radius") ?? "", 0, perturbed);
    const perturbedOuter = evaluate(token("--window-control-outer-radius") ?? "", 0, perturbed);
    expect(perturbedCap - 10, "the cap must track the perturbed tray height").toBeCloseTo(perturbedOuter, 5);
    expect(perturbedOuter, "the outward radius must equal half the perturbed button").toBeCloseTo(20, 5);
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
    expect(token("--window-control-cap-corner-shape"), "the cap curvature token").toBe("superellipse(1)");
    expect(tray.declarations.get("corner-shape"), "the tray must paint that same curvature").toBe(
      "var(--window-control-cap-corner-shape)",
    );
    expect(minimize.shape["top-left"]).toBe("var(--window-control-cap-corner-shape)");
    expect(minimize.shape["bottom-left"]).toBe("var(--window-control-cap-corner-shape)");
    expect(close.shape["top-right"]).toBe("var(--window-control-cap-corner-shape)");
    expect(close.shape["bottom-right"]).toBe("var(--window-control-cap-corner-shape)");
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
