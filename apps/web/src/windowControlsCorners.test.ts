import { describe, expect, it } from "vitest";

import { loadAggregatedCss } from "./testUtils/loadStyles";

/**
 * Guard: the Windows caption band must stay a Windows caption band.
 *
 * The band is not a container. It is three 46x32 hit areas tiled edge to edge
 * against the window's right edge: no gap, no padding, no tint, no radius, and
 * the close button's right edge is the window's own right edge. Vertically the
 * band is centred in the header row, so it shares the icon centre line of the
 * buttons and search field to its left. The band width is derived from the hit
 * area (`--window-control-width` x `--window-control-count`), and the header
 * row's `margin-right` is that same token minus the 56px rail column, which is
 * what keeps the header flush with the band's left edge instead of overlapping
 * it or leaving a seam.
 *
 * This file used to guard the retired tray: a 6px-padded pill with a 22px cap
 * and two `superellipse(1)` outward corners derived as cap − padding. That
 * geometry no longer exists, but the guard does — repointed at the invariants
 * that replaced it, so a future edit cannot quietly bring the tray back or
 * drift the band off the window corner. It catches:
 *   - the hit area changing without the band width following (or a literal
 *     replacing the derived `--window-chrome-right`);
 *   - the bar or the group growing an inset, a tint, a radius or a gap;
 *   - a button keeping the design system's squircle instead of a square tile;
 *   - the close button losing its #C42B1C hover / darker pressed red, or the
 *     fill spilling onto the other two buttons;
 *   - the focus ring going back to a positive offset, where the window edge
 *     clips it;
 *   - any tray-era token or corner override coming back.
 *
 * It cannot see pixels: rasterisation, hover colour blending and the focus ring
 * against the actual header surface only exist in a real render, and those are
 * verified by the screenshots and geometry measurements in `output/`.
 */

interface Rule {
  selector: string;
  declarations: Map<string, string>;
}

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
 * Token lookup over the whole stylesheet, last definition wins. Used for the
 * hit-area tokens, which are defined exactly once.
 */
function token(name: string): string | undefined {
  const matches = [...stylesheet.matchAll(new RegExp(`^${name}:([^;\\n]+)`, "gm"))];
  return matches.at(-1)?.[1]?.trim();
}

/**
 * `--window-chrome-right` is published three times (browser 0, the desktop
 * band, macOS 0), so the global lookup would return the macOS zero. Read it
 * from the `.desktop-app` rule the band is actually published in.
 */
const desktopTokens = requireRule(".desktop-app").declarations;
const bandWidth = desktopTokens.get("--window-chrome-right") ?? "";
/** Makes `var(--window-chrome-right)` resolve to the desktop band, not macOS. */
const bandOverrides = new Map([["--window-chrome-right", bandWidth]]);

/**
 * Resolves a CSS length the way the stylesheet chains them: px literals,
 * unitless tokens, `var()`, and nested `calc()` / `min()` arithmetic.
 */
function lengthPx(value: string | undefined): number {
  return evaluate(value ?? "", 0, bandOverrides);
}

/**
 * `overrides` substitutes token values during evaluation, so the guard can
 * re-run the derivation with a different hit area: if the band width were a
 * copied literal, it would stay put while the hit area moved.
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

/** RGB channels of a `#rgb` / `#rrggbb` literal, or NaN channels. */
function hexChannels(value: string | undefined): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec((value ?? "").trim());
  if (!match) return [Number.NaN, Number.NaN, Number.NaN];
  const hex = match[1] as string;
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number];
}

const bar = requireRule(".desktop-app .window-bar");
const windowsBar = requireRule(".desktop-app:not([data-platform=darwin]) .window-bar");
const group = requireRule(".desktop-app .window-controls");
const control = requireRule(".window-controls .window-control");

describe("window control band", () => {
  it("tiles three 46x32 hit areas into the band", () => {
    expect(token("--window-control-width")).toBe("46px");
    expect(token("--window-control-height")).toBe("32px");
    expect(token("--window-control-count")).toBe("3");
    expect(control.declarations.get("width"), "the control must consume the hit-area width token").toBe(
      "var(--window-control-width)",
    );
    expect(control.declarations.get("height"), "the control must consume the hit-area height token").toBe(
      "var(--window-control-height)",
    );
    expect(lengthPx(control.declarations.get("width"))).toBe(46);
    expect(lengthPx(control.declarations.get("height"))).toBe(32);
  });

  it("derives the band width from the hit area instead of a literal", () => {
    expect(bandWidth, "the band width must be the hit area times the button count").toBe(
      "calc(var(--window-control-width) * var(--window-control-count))",
    );
    expect(lengthPx(bandWidth), "3 x 46 today").toBe(138);

    // Re-run with a 40px hit area: a copied 138 would not move.
    const perturbed = new Map([["--window-control-width", "40px"]]);
    expect(evaluate(bandWidth, 0, perturbed)).toBeCloseTo(120, 5);
  });

  it("hugs the window's right edge and shares the header's icon centre line", () => {
    expect(bar.declarations.get("width"), "the bar must own exactly the band's footprint").toBe(
      "var(--window-chrome-right)",
    );
    expect(bar.declarations.get("height"), "the band rides the header row's height").toBe("var(--window-chrome-top)");
    expect(bar.declarations.get("justify-content"), "the band is right-aligned").toBe("flex-end");
    expect(
      bar.declarations.get("align-items"),
      "centered in the 66px row, so the tiles line up with the header icons on the left",
    ).toBe("center");
    expect(windowsBar.declarations.has("align-items"), "the Windows bar must not override the centre line").toBe(false);
    expect(lengthPx(bar.declarations.get("padding-right") ?? "0"), "no trailing inset").toBe(0);
    expect(windowsBar.declarations.get("padding-right"), "the Windows bar must not inset the band").toBe("0");
  });

  it("draws no container and no gap between the buttons", () => {
    expect(lengthPx(group.declarations.get("gap")), "the hit areas must touch").toBe(0);
    expect(lengthPx(group.declarations.get("padding")), "the band has no inset").toBe(0);
    expect(group.declarations.get("background"), "at rest the band paints nothing").toBe("none");
    expect(lengthPx(group.declarations.get("border-radius")), "a container corner would read as a stray slab").toBe(0);
    expect(group.declarations.has("corner-shape"), "no container, so no container curvature").toBe(false);
  });

  it("keeps every caption button a square tile", () => {
    expect(lengthPx(control.declarations.get("border-radius")), "Windows caption buttons are square").toBe(0);

    // No rule may put a per-corner radius or a corner-shape back on a control.
    const overrides = rules
      .filter((rule) => /(^|[\s,>])\.window-control(:[^\s,{]*)?$/.test(rule.selector))
      .filter((rule) =>
        [...rule.declarations.keys()].some(
          (property) => /^border-(top|bottom)-(left|right)-radius$/.test(property) || property === "corner-shape",
        ),
      );
    expect(overrides.map((rule) => rule.selector), "no control may override radius or corner shape").toEqual([]);
  });

  it("keeps the header row flush with the band's left edge", () => {
    for (const selector of [".desktop-app .column-header", ".desktop-app .reader-toolbar", ".desktop-app .agent-workspace-header"]) {
      const rule = requireRule(selector);
      const margin = rule.declarations.get("margin-right");
      expect(margin, `${selector} must derive its clearance from the band`).toBe(
        "calc(var(--window-chrome-right) - 56px)",
      );
      // Header right edge = window right − 56px rail − margin = band's left edge.
      expect(lengthPx(margin), `${selector} must land on the band's left edge`).toBe(82);
    }
  });

  it("fills the close button with Windows red on hover and a darker red on press", () => {
    const closeHover = requireRule(".window-bar .window-control-close:hover:not(:disabled)");
    const closeActive = requireRule(".window-bar .window-control-close:active:not(:disabled)");
    const neutralHover = requireRule(".window-bar .window-control:hover:not(:disabled)");

    expect(closeHover.declarations.get("background")).toBe("#c42b1c");
    expect(closeHover.declarations.get("color"), "the glyph must invert on the red fill").toBe("#fff");
    expect(closeHover.declarations.get("border-color"), "no border box around the fill").toBe("#0000");
    expect(closeActive.declarations.get("background")).toBe("#a32415");
    expect(closeActive.declarations.get("color")).toBe("#fff");

    const hover = hexChannels(closeHover.declarations.get("background"));
    const active = hexChannels(closeActive.declarations.get("background"));
    expect(active.every(Number.isFinite), "the pressed fill must be a hex literal").toBe(true);
    expect(active[0] + active[1] + active[2], "pressed must be darker than hover").toBeLessThan(
      hover[0] + hover[1] + hover[2],
    );

    // The neutral pair stays neutral: red means one thing only.
    expect(neutralHover.declarations.get("background")).toBe("var(--hover)");
    expect(neutralHover.declarations.get("color")).toBe("var(--text)");
  });

  it("keeps a pressed caption button at full size", () => {
    const hover = requireRule(".window-bar .window-control:hover:not(:disabled)");
    const active = requireRule(".window-bar .window-control:active:not(:disabled)");
    expect(hover.declarations.get("transform"), "a hover must not shift the tile").toBe("none");
    expect(active.declarations.get("transform"), "the base icon button shrinks to .88 under the pointer").toBe("none");
  });

  it("pulls the focus ring inside the button so the window edge cannot clip it", () => {
    const focus = requireRule(".window-bar .window-control:focus-visible");
    expect(focus.declarations.get("outline-offset"), "an inset ring is the whole point here").toBe("-2px");
    expect(lengthPx(focus.declarations.get("outline-offset"))).toBeLessThan(0);

    const closeFocus = requireRule(".window-bar .window-control-close:focus-visible");
    expect(closeFocus.declarations.get("outline-color")).toBe("var(--danger)");
    const closeHoverFocus = requireRule(".window-bar .window-control-close:hover:focus-visible");
    expect(closeHoverFocus.declarations.get("outline-color"), "danger red would vanish on the red fill").toBe("#fff");
  });

  it("leaves no trace of the retired tray", () => {
    for (const retired of [
      "--window-control-size",
      "--window-control-tray-padding",
      "--window-control-tray-height",
      "--window-control-cap-radius",
      "--window-control-outer-radius",
      "--window-control-cap-corner-shape",
      "--chrome-tray",
    ]) {
      expect(token(retired), `${retired} belonged to the retired tray and must not come back`).toBeUndefined();
    }
  });
});
