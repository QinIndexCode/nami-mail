import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard for the overlay-centring trap that shipped the misplaced key eye icon.
 *
 * An absolutely positioned control that sits on top of an input centres itself
 * with `top:50%` plus a `-50%` translate. Written as `transform:translateY(-50%)`
 * that translate is only correct while nothing else writes `transform` — and
 * plenty of things do: the shared press rule `.icon-button:active:not(:disabled)
 * {transform:scale(.88)}` is (0,3,0) and so beats a (0,2,0) positioning rule.
 * A later declaration REPLACES the matrix rather than composing with it, so the
 * control loses its centring and drops out of the field by half its height for
 * as long as it is held down. Measured in Chromium: the model-config key eye
 * sat 14.5px low, the translation key eye 15px.
 *
 * The fix is the independent `translate` property, which the cascade applies
 * BEFORE `transform` and which a state-level `transform` therefore composes
 * with. This test reads styles.css directly and fails if any absolutely
 * positioned rule goes back to centring itself through `transform` while its
 * own selector is also driven by a state rule that writes `transform`.
 */

type Rule = { selectors: string[]; body: string };

/** Selector fragments that mean "this rule only applies in some state". */
const STATE_MARKERS = [
  ":active",
  ":hover",
  ":focus",
  ":checked",
  ".open",
  ".visible",
  ".loading",
  ".checked",
  ".dismissed",
  ".closing",
  ".leaving",
  ".selected",
  ".active",
  ".is-",
  ".has-",
  ".drop-in",
  ".pop",
  ".show",
];

/** `-50%` translates are the centring idiom; a scale-only transform is not. */
const CENTRES_WITHIN = /transform:[^;}]*translate[^;}]*-50%/;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Flat rule list. At-rules are transparent here: an overlay rule inside a
 * `@media` is still an overlay rule, and a state rule outside a `@media` still
 * applies inside one.
 */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  let buffer = "";
  let depth = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === "{") {
      depth += 1;
      buffer += char;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const [selectorPart, ...declarations] = buffer.split("{");
        const body = declarations.join("{").replace(/}$/, "");
        // A nested at-rule's own selector is noise; keep only the innermost rule.
        if (!selectorPart.trim().startsWith("@")) {
          rules.push({
            selectors: selectorPart.split(",").map((entry) => entry.trim()).filter(Boolean),
            body,
          });
        }
        buffer = "";
        index += 1;
        continue;
      }
      buffer += char;
      index += 1;
      continue;
    }
    if (char === ";" && depth > 0) buffer += char;
    else buffer += char;
    index += 1;
  }
  return rules;
}

/** The classes a selector names, minus anything that only marks a state. */
function baseClasses(selector: string): string[] {
  const withoutPseudo = selector.replace(/:+[a-z-]+(\([^)]*\))?/gi, " ");
  return Array.from(new Set(Array.from(withoutPseudo.matchAll(/\.([a-z0-9_-]+)/gi)).map((match) => match[1])));
}

function isStateSelector(selector: string): boolean {
  return STATE_MARKERS.some((marker) => selector.includes(marker));
}

import { loadAggregatedCss } from "./testUtils/loadStyles";

describe("absolutely positioned overlay centring", () => {
  const css = stripComments(loadAggregatedCss());
  const rules = parseRules(css);

  /** Selectors that are absolutely positioned AND centre themselves via transform. */
  const transformCentred = rules.filter((rule) => /position:(absolute|fixed)/.test(rule.body) && CENTRES_WITHIN.test(rule.body));

  /** Selectors that assign a `transform` from a state. */
  const stateTransforms = rules.filter((rule) => rule.selectors.some(isStateSelector) && /(^|;)\s*transform:/.test(rule.body));

  /**
   * Of those, the ones that actually DROP the centring: a state rule that
   * rewrites the transform without re-stating the `-50%` translate replaces the
   * matrix instead of composing with it. A state rule that does restate the
   * translate (`.select-control-icon.open{transform:translateY(-50%)rotate(180deg)}`)
   * is composing correctly and is not a hazard.
   */
  const centringClobbers = stateTransforms.filter((rule) => {
    const declaration = /transform:([^;}]*)/.exec(rule.body)?.[1] ?? "";
    return !/translate[^;}]*-50%/.test(declaration);
  });

  it("parses a non-trivial stylesheet", () => {
    expect(rules.length, "the rule parser found suspiciously few rules").toBeGreaterThan(1_000);
    expect(transformCentred.length, "no absolutely positioned rule centres itself with transform").toBeGreaterThan(0);
    expect(stateTransforms.length, "no state rule assigns a transform").toBeGreaterThan(0);
    expect(centringClobbers.length, "no state rule drops a centring translate").toBeGreaterThan(0);
  });

  it("no centred overlay is also driven by a state rule that rewrites transform", () => {
    const offenders: string[] = [];
    for (const rule of transformCentred) {
      for (const selector of rule.selectors) {
        const classes = baseClasses(selector);
        if (classes.length === 0) continue;
        const clobbered = centringClobbers.filter((state) => state.selectors.some((candidate) => (
          candidate !== selector
          && isStateSelector(candidate)
          && classes.some((name) => baseClasses(candidate).includes(name))
        )));
        for (const state of clobbered) {
          offenders.push(`${selector}  <--  ${state.selectors.join(", ")}`);
        }      }
    }
    expect(
      offenders,
      `these absolutely positioned rules centre with transform, and a state rule replaces that transform:\n${offenders.join("\n")}\n`
        + "Centre them with the independent `translate` property instead so the state transform composes.",
    ).toEqual([]);
  });

  it("keeps the settings key-field eye in flow rather than absolutely positioned", () => {
    const rule = rules.find((entry) => entry.selectors.includes(".settings-secret-input>.icon-button"));
    expect(rule, ".settings-secret-input>.icon-button should exist").toBeDefined();
    expect(rule?.body).not.toMatch(/position:absolute/);
  });

  it("the two key-field overlay eyes centre with the composable property", () => {
    // The reported one, its translation twin, and the account field's peek —
    // all three are buttons, so all three are exposed to the shared press rule.
    // The provider key eye used to overlay an absolutely positioned dialog
    // input; inside the settings panel it is an in-flow flex child, so the
    // guard below covers the two eyes that really are overlays.
    for (const selector of [".translation-key-visibility", ".account-password-toggle-btn"]) {
      const rule = rules.find((entry) => entry.selectors.includes(selector)
        || entry.selectors.includes(`${selector},.account-input-clear-btn`));
      expect(rule, `${selector} has no rule in styles.css`).toBeDefined();
      expect(rule?.body, `${selector} must centre with translate`).toMatch(/(^|;)\s*translate:[^;}]*-50%/);
      expect(rule?.body, `${selector} must not centre with transform`).not.toMatch(CENTRES_WITHIN);
    }
  });
});
