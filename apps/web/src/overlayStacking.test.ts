import { describe, expect, it } from "vitest";

/**
 * Two guardrails for the global overlay layer, both read straight out of
 * styles.css so an edit re-checks itself.
 *
 * ── 1. Containing block ──────────────────────────────────────────────
 * A `transform`, `filter`, `backdrop-filter`, `perspective`, `contain:paint`
 * or `container-type` on an element makes that element the containing block
 * of every `position:fixed` descendant. App renders all of its overlays
 * INSIDE `.app-frame`, so one such property on `.app-frame` silently
 * re-anchors the entire overlay system. It did: `.app-frame` carried
 * `backdrop-filter:blur(28px)saturate(150%)`, and a `position:fixed`
 * backdrop measured 1677x902 at (15,15) in a 1707x932 window — exactly the
 * frame's padding box, not the viewport. Full-viewport scrims left the 14px
 * canvas gutter undimmed and every `event.clientX/clientY` popover (context
 * menus, toasts anchored to their own box) shifted up-left.
 *
 * The same trap has a quieter form: an animation with
 * `animation-fill-mode:both|forwards` leaves the animated property at its end
 * value FOREVER. `.settings-panel` runs `settings-panel-in`, whose keyframes
 * only declare a `0%` block — yet Chromium keeps reporting
 * `transform: matrix(1,0,0,1,0,0)` on it once the animation finishes, which is
 * enough to make the settings panel a containing block (the model dialogs
 * were measured against the panel at 787x522 @(592,201) until they were
 * portalled out). That is why this guard looks at "does the keyframes touch a
 * transform at all", not only at the `to`/`100%` block: an implicit end
 * keyframe still leaves a matrix behind.
 *
 * ── 2. Stacking ladder ───────────────────────────────────────────────────
 * Same z-index means DOM order decides, so a tie is only safe when the two
 * layers are provably never visible together. Three such ties shipped as
 * real bugs: `.update-background-status` (26) under `.agent-workspace` (30),
 * `.toast` (90) tied with `.update-prompt-backdrop` (90), and the
 * `.modal-backdrop` base (30) tied with `.agent-workspace` (30). The ladder
 * below is the explicit, ordered statement of who sits above whom; the
 * peer groups are the only sanctioned ties, each with the reason it cannot
 * be observed.
 */

import { loadAggregatedCss } from "./testUtils/loadStyles";

const css = loadAggregatedCss();

/* ------------------------------------------------------------------ parser */

type Declaration = { name: string; value: string; line: number };
type Rule = { selector: string; chain: string[]; declarations: Declaration[]; line: number };

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Flattens the stylesheet into rules, keeping the at-rule chain each lives under. */
function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  const stack: { selector: string; chain: string[]; declarations: Declaration[]; line: number }[] = [];
  let buffer = "";
  let depth = 0;
  let line = 1;
  let ruleLine = 1;
  let prelude = true;
  let index = 0;

  const pushDeclarations = (body: string, atLine: number) => {
    for (const part of body.split(";")) {
      const separator = part.indexOf(":");
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      if (!name || name.startsWith("@")) continue;
      stack[stack.length - 1].declarations.push({
        name,
        value: part.slice(separator + 1).trim().replace(/\s+/g, " "),
        line: atLine,
      });
    }
  };

  while (index < source.length) {
    const char = source[index];
    if (char === "\n") line += 1;
    if (char === "{") {
      depth += 1;
      const selector = buffer.replace(/\s+/g, " ").trim();
      buffer = "";
      if (selector.startsWith("@")) {
        stack.push({ selector, chain: stack.map((entry) => entry.selector), declarations: [], line: ruleLine });
      } else {
        stack.push({
          selector,
          chain: stack.filter((entry) => entry.selector.startsWith("@")).map((entry) => entry.selector),
          declarations: [],
          line: ruleLine,
        });
      }
      prelude = false;
      ruleLine = line;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (stack.length > 0 && !prelude) pushDeclarations(buffer, ruleLine);
      buffer = "";
      if (stack.length > 0) {
        const finished = stack.pop();
        if (finished && !finished.selector.startsWith("@")) {
          rules.push(finished);
        }
      }
      prelude = true;
      index += 1;
      continue;
    }
    if (char === ";" && depth > 0 && stack.length > 0 && !prelude) {
      pushDeclarations(buffer, ruleLine);
      buffer = "";
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  return rules;
}

const rules = parseRules(stripComments(css));

/** `@keyframes <name> { … }`, by name. */
const keyframes = new Map<string, string>();
for (const match of css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g)) {
  let depth = 1;
  let index = match.index + match[0].length;
  while (index < css.length && depth > 0) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    index += 1;
  }
  keyframes.set(match[1], css.slice(match.index + match[0].length, index - 1));
}

function declarationsOf(selector: string): Declaration[] {
  return rules
    .filter((rule) => rule.selector.split(",").some((entry) => entry.trim() === selector))
    .flatMap((rule) => rule.declarations);
}

/**
 * Declarations from the selector's own top-level rule only. Media-query and
 * print overrides are deliberately excluded: they are conditional refinements,
 * not the base the guard is reasoning about.
 */
function baseDeclarationsOf(selector: string): Declaration[] {
  return rules
    .filter((rule) => rule.chain.length === 0 && rule.selector.split(",").some((entry) => entry.trim() === selector))
    .flatMap((rule) => rule.declarations);
}

/** Last declaration wins, which is how the cascade resolves a repeated property. */
function effectiveValue(selector: string, property: string): string | undefined {
  const matches = declarationsOf(selector).filter((declaration) => declaration.name === property);
  return matches.length > 0 ? matches[matches.length - 1].value : undefined;
}

function effectiveZIndex(selector: string): number | undefined {
  const value = effectiveValue(selector, "z-index");
  if (value === undefined || value === "auto") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Every animation name a rule references, plus the fill mode it pins. */
function animationBinding(selector: string): { names: string[]; fill: string | undefined } {
  const shorthand = effectiveValue(selector, "animation");
  const names: string[] = [];
  let fill = effectiveValue(selector, "animation-fill-mode");
  if (shorthand) {
    for (const token of shorthand.split(/\s+/)) {
      if (["both", "forwards", "backwards", "none"].includes(token)) {
        fill = token;
        continue;
      }
      // Durations, delays, easings and iteration counts are numeric or keyword
      // timings; anything else that is not a global keyword is a name.
      if (/^[\d.]+m?s$/.test(token) || /\d/.test(token)) continue;
      if (["infinite", "normal", "reverse", "alternate", "both", "forwards", "backwards", "running", "paused"].includes(token)) continue;
      if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(token)) continue;
      if (/^steps\(/.test(token)) continue;
      names.push(token);
    }
  }
  return { names, fill };
}

/* ------------------------------------------------------- containing block */

/**
 * Properties that turn an element into the containing block of its
 * `position:fixed` descendants. `will-change` is included because naming any
 * of these promotes the element the same way.
 */
const CONTAINING_BLOCK_PROPERTIES = [
  "transform",
  "translate",
  "rotate",
  "scale",
  "filter",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "perspective",
  "offset-path",
  "offset",
  "container-type",
] as const;

/** `will-change` values that promote an element the same way. */
const PROMOTING_WILL_CHANGE = /transform|translate|rotate|scale|filter|perspective|contain|offset/;

type Hazard = { property: string; value: string; line: number };

/** True for the animation-derived hazard, as opposed to a declared property. */
function isPinnedAnimation(hazard: Hazard): boolean {
  return hazard.property.startsWith("animation(");
}

function containingBlockHazards(selector: string): Hazard[] {
  const hazards: Hazard[] = [];
  for (const declaration of declarationsOf(selector)) {
    if ((CONTAINING_BLOCK_PROPERTIES as readonly string[]).includes(declaration.name)) {
      if (declaration.value !== "none" && !declaration.value.startsWith("none")) {
        hazards.push({ property: declaration.name, value: declaration.value, line: declaration.line });
      }
      continue;
    }
    if (declaration.name === "contain" && /paint|layout|strict|content/.test(declaration.value)) {
      hazards.push({ property: "contain", value: declaration.value, line: declaration.line });
      continue;
    }
    if (declaration.name === "will-change" && PROMOTING_WILL_CHANGE.test(declaration.value)) {
      hazards.push({ property: "will-change", value: declaration.value, line: declaration.line });
      continue;
    }
    if (declaration.name === "animation") {
      const { names, fill } = animationBinding(selector);
      if (fill !== "both" && fill !== "forwards") continue;
      const pinned = names.some((name) => {
        const body = keyframes.get(name);
        if (body === undefined) return false;
        return /(^|[{;])\s*(?:transform|translate|rotate|scale)\s*:/.test(body);
      });
      if (pinned) hazards.push({ property: `animation(${names.join(",")}) fill:${fill}`, value: "pinned transform", line: declaration.line });
    }
  }
  return hazards;
}

/**
 * Selectors that hold `position:fixed` overlays in the live DOM. Each entry
 * names the component that proves it; adding a fixed overlay somewhere new
 * means adding its host here, and the hazard sweep below then covers it.
 */
const FIXED_OVERLAY_HOSTS: Record<string, string> = {
  ".app-frame": "App.tsx renders every modal, toast, menu and prompt between its <div className=\"app-frame\"> and its closing tag",
  ".workspace-canvas": "the canvas is the root stacking context both the frame and the wallpaper live in",
  ".mail-shell": "AgentWorkspace renders as a direct child of the shell",
};

/**
 * Selectors allowed to combine a containing-block hazard with a clipping
 * `overflow`. Both together is the `.app-frame` signature, so every exemption
 * has to say why no fixed overlay can land underneath it.
 */
const HAZARD_WITH_OVERFLOW_EXEMPTIONS: Record<string, string> = {
  ".account-modal-drawer": "the provider tutorial drawer; `transform:translateX(28px)` is its slide-in. Its subtree is static markup (AddAccountModal.tsx) with no portal and no overlay.",
  ".agent-popover": "the agent slash/mention popover shell; the transform positions the popover, and nothing inside it is fixed.",
};

/**
 * Every clipping overflow a selector declares, across every at-rule. A later
 * `@media print { overflow:visible }` must not hide the fact that the base
 * rule clips — the hazard only matters where the element actually clips.
 */
function clippingOverflows(selector: string): string[] {
  const values = declarationsOf(selector)
    .filter((declaration) => declaration.name === "overflow" || declaration.name === "overflow-y" || declaration.name === "overflow-x")
    .map((declaration) => declaration.value)
    .filter((value) => value !== "visible" && !value.startsWith("clip"));
  return Array.from(new Set(values));
}

describe("overlay containing blocks", () => {
  it("parses a non-trivial stylesheet", () => {
    expect(rules.length, "the rule parser found suspiciously few rules").toBeGreaterThan(1_000);
    expect(keyframes.size, "no @keyframes were parsed").toBeGreaterThan(20);
    expect(effectiveZIndex(".modal-backdrop"), ".modal-backdrop has no z-index").toBeTypeOf("number");
  });

  it("no overlay host turns into a containing block for its fixed descendants", () => {
    const offenders: string[] = [];
    for (const [selector, why] of Object.entries(FIXED_OVERLAY_HOSTS)) {
      expect(declarationsOf(selector), `${selector} must exist in styles.css`).not.toHaveLength(0);
      for (const hazard of containingBlockHazards(selector)) {
        offenders.push(`${selector} (${why}) sets ${hazard.property}:${hazard.value} at line ${hazard.line}`);
      }
    }
    expect(
      offenders,
      `these hosts hold position:fixed overlays but also carry a containing-block property:\n${offenders.join("\n")}\n`
        + "Move the effect to a ::before/::after layer (that is what .app-frame's glass does now) "
        + "or portal the overlay out of the host.",
    ).toEqual([]);
  });

  it("no rule combines a declared containing-block hazard with a clipping overflow", () => {
    // Animation-derived hazards are deliberately out of scope here: almost
    // every modal card pairs `overflow:auto` with a fill-mode-pinned `modal-in`,
    // and none of them hosts a fixed overlay. The registry check above is what
    // covers the animation case, where it actually matters.
    const offenders: string[] = [];
    for (const rule of rules) {
      if (rule.selector.startsWith("@")) continue;
      for (const selector of rule.selector.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        if (HAZARD_WITH_OVERFLOW_EXEMPTIONS[selector] !== undefined) continue;
        const overflows = clippingOverflows(selector);
        if (overflows.length === 0) continue;
        const hazards = containingBlockHazards(selector).filter((hazard) => !isPinnedAnimation(hazard));
        if (hazards.length === 0) continue;
        offenders.push(`${selector} — overflow:${overflows.join("/")} plus ${hazards.map((h) => `${h.property}:${h.value}`).join(", ")}`);
      }
    }
    expect(
      offenders,
      `these selectors clip AND re-anchor their fixed descendants:\n${offenders.join("\n")}\n`
        + "Either drop the overflow or move the transform/filter onto a pseudo-element. "
        + "If a case is genuinely safe, add it to HAZARD_WITH_OVERFLOW_EXEMPTIONS with the reason.",
    ).toEqual([]);
  });

  it("the hazard census still finds fill-mode-pinned transforms", () => {
    // Guards the detector itself: if the parser stopped seeing keyframes the
    // host check above would pass vacuously.
    const pinned = new Set<string>();
    for (const rule of rules) {
      if (rule.selector.startsWith("@")) continue;
      for (const selector of rule.selector.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        if (containingBlockHazards(selector).some(isPinnedAnimation)) pinned.add(selector);
      }
    }
    expect(pinned.size, "no fill-mode-pinned transform animation was found — the detector is broken").toBeGreaterThan(0);
    expect(
      Array.from(pinned).filter((selector) => selector in FIXED_OVERLAY_HOSTS),
      "a fill-mode-pinned transform animation is running on an overlay host",
    ).toEqual([]);
  });

  it("keeps the app frame glass on a pseudo-element, not on the frame", () => {
    // The regression this file exists for: the filter itself is legitimate and
    // must keep working, it just may not live on the element that holds the
    // overlays.
    const base = baseDeclarationsOf(".app-frame");
    const baseOverflow = base.filter((declaration) => declaration.name === "overflow").pop();
    expect(baseOverflow?.value, ".app-frame must keep clipping").toBe("hidden");
    expect(base.map((declaration) => declaration.name))
      .not.toContain("backdrop-filter");
    expect(base.map((declaration) => declaration.name))
      .not.toContain("filter");
    const glass = effectiveValue(".app-frame:not(.desktop-app)::before", "backdrop-filter");
    expect(glass, "the glass must survive on .app-frame:not(.desktop-app)::before").toBeTruthy();
    expect(effectiveValue(".app-frame:not(.desktop-app)::before", "z-index")).toBe("-1");
  });

  it("keeps the select menu wider than its narrow triggers", () => {
    // `.themed-select-menu` is stretched to the trigger by left:0/right:0.
    // The narrow triggers are .filter-rule-value-select (96px),
    // .filter-rule-kind-select / .filter-rule-action-kind-select (150px) and
    // .auto-reply-rule-select (132px), so without a min-width every option
    // ellipsised. Note the value has to be a bare `max-content`: Chromium's
    // CSS parser discards the whole declaration for `min(max-content, 90vw)`.
    expect(effectiveValue(".themed-select-menu", "min-width"), "the select menu must keep its min-width").toBe("max-content");
    for (const narrow of [".filter-rule-row-editor .filter-rule-value-select", ".filter-rule-row-editor .filter-rule-kind-select"]) {
      expect(effectiveValue(narrow, "width"), `${narrow} must stay narrow so this guard means something`).toBeTruthy();
    }
  });
});

/* -------------------------------------------------------- stacking ladder */

/**
 * The global overlay ladder, bottom to top. Every value is distinct; a rung
 * may hold several selectors only when they are listed in PEER_GROUPS.
 */
const LADDER: { value: number; note: string; selectors: string[] }[] = [
  { value: 0, note: "the wallpaper art, behind everything", selectors: [".workspace-background"] },
  { value: 1, note: "the app surface itself", selectors: [".workspace-canvas>.app-frame"] },
  { value: 20, note: "narrow-window scrim behind the drawer", selectors: [".mobile-scrim"] },
  { value: 25, note: "narrow-window drawer", selectors: [".sidebar"] },
  { value: 30, note: "the agent workspace band — a pane, never a scrim", selectors: [".agent-workspace", ".agent-workspace-loading"] },
  { value: 40, note: "the .modal-backdrop base: App-owned alertdialogs. Must not collide with anything (see the base-uniqueness test)", selectors: [".modal-backdrop"] },
  { value: 45, note: "first-level peer scrims: settings / management / sending status", selectors: [".settings-backdrop", ".management-backdrop", ".sending-status-backdrop"] },
  { value: 46, note: "the background-update progress toast; must clear the agent workspace", selectors: [".update-background-status"] },
  { value: 58, note: "menus that drop out of a panel they are nested in", selectors: [".themed-select-menu", ".compose-template-picker", ".compose-contact-suggestions"] },
  { value: 60, note: "second-level peers: nested editors, confirmations, point menus and the compose schedule popover", selectors: [".confirmation-backdrop", ".accounts-editor-backdrop", ".contact-editor-backdrop", ".calendar-editor-backdrop", ".auto-reply-backdrop", ".agent-memory-backdrop", ".sending-status-details-backdrop", ".context-menu-backdrop", ".compose-template-wrap .compose-template-picker", ".compose-schedule-popover"] },
  { value: 61, note: "the context menu itself, above its own scrim", selectors: [".context-menu"] },
  { value: 70, note: "third-level peers: alerts and the transient menus anchored to a point", selectors: [".settings-alert-backdrop", ".sending-status-confirmation-backdrop", ".agent-context-menu", ".date-picker-panel"] },
  { value: 80, note: "the first-run translation-terms gate", selectors: [".translation-terms-backdrop"] },
  { value: 90, note: "the desktop update prompt, plus the hover tooltip", selectors: [".update-prompt-backdrop", ".nami-tooltip"] },
  { value: 92, note: "shell toasts; deliberately above the update prompt instead of tied with it", selectors: [".toast"] },
  { value: 95, note: "desktop window controls, reachable over every dialog", selectors: [".desktop-app .window-controls"] },
  { value: 100, note: "the AutoReply toast stack, deliberately on top of everything", selectors: [".auto-reply-toast-stack"] },
];

/**
 * Selectors that intentionally share a rung, and why the tie is unobservable.
 * Adding a name here is a claim that the two layers can never be visible at
 * the same time — check useDialogRouting's MODAL_KEYS before believing it.
 */
const PEER_GROUPS: Record<string, string> = {
  "45": "useDialogRouting owns settingsOpen / contacts+templates+calendar / sendingStatusOpen as separate booleans and only one is ever rendered, so the three scrims never stack on each other.",
  "60": "Nested editors, the batch-delete confirmation and the compose/auto-reply popovers are each opened FROM a 45-rung dialog or from the shell; opening one closes or replaces its parent, so no two 60s are ever mounted together.",
  "70": "settings-alert and sending-status-confirmation are alertdialogs owned by an already-open parent, and the two point menus are transient hover surfaces. None of the four can be up alongside another.",
  "90": ".nami-tooltip only renders for a hovered [data-tooltip] element, and the update prompt's scrim swallows the pointer for the whole viewport, so no tooltip can be hovered while the prompt is up.",
};

/** Scrims and fixed elements: the population that shares the app-frame stacking context. */
function isScrimOrFixed(selector: string): boolean {
  if (/-backdrop$/.test(selector)) return true;
  return declarationsOf(selector).some((declaration) => declaration.name === "position" && declaration.value === "fixed");
}

describe("overlay stacking ladder", () => {
  it("has strictly increasing, unique rungs", () => {
    const values = LADDER.map((rung) => rung.value);
    expect(values, "two rungs share a z-index").toEqual(Array.from(new Set(values)));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index], `rung ${LADDER[index].selectors[0]} (${values[index]}) must sit above ${LADDER[index - 1].selectors[0]} (${values[index - 1]})`)
        .toBeGreaterThan(values[index - 1]);
    }
  });

  it("matches the z-index the stylesheet actually assigns", () => {
    const mismatches: string[] = [];
    for (const rung of LADDER) {
      for (const selector of rung.selectors) {
        const actual = effectiveZIndex(selector);
        if (actual !== rung.value) {
          mismatches.push(`${selector} is z-index ${actual ?? "(none)"}, the ladder says ${rung.value} (${rung.note})`);
        }
      }
    }
    expect(mismatches, `the ladder and styles.css disagree:\n${mismatches.join("\n")}`).toEqual([]);
  });

  it("ties every scrim and fixed element to a declared peer group", () => {
    const byValue = new Map<number, string[]>();
    const seen = new Set<string>();
    for (const rule of rules) {
      if (rule.selector.startsWith("@")) continue;
      for (const selector of rule.selector.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        if (seen.has(selector)) continue;
        const z = effectiveZIndex(selector);
        if (z === undefined || !isScrimOrFixed(selector)) continue;
        seen.add(selector);
        byValue.set(z, [...(byValue.get(z) ?? []), selector]);
      }
    }
    const ladderMembers = new Set(LADDER.flatMap((rung) => rung.selectors));
    const undeclared: string[] = [];
    for (const [value, selectors] of [...byValue.entries()].sort((a, b) => a[0] - b[0])) {
      const ladderHere = selectors.filter((selector) => ladderMembers.has(selector));
      if (ladderHere.length === selectors.length) continue;
      if (selectors.length === 1 && PEER_GROUPS[String(value)] === undefined) continue;
      if (PEER_GROUPS[String(value)] === undefined) {
        undeclared.push(`z-index ${value} is shared by ${selectors.join(", ")} but no peer group explains it`);
        continue;
      }
      const outside = selectors.filter((selector) => !ladderHere.includes(selector));
      if (outside.length > 0) {
        undeclared.push(`z-index ${value} peer group does not list ${outside.join(", ")}`);
      }
    }
    expect(undeclared, `undeclared stacking ties:\n${undeclared.join("\n")}`).toEqual([]);
  });

  it("keeps the .modal-backdrop base value unique in the whole sheet", () => {
    // The base class every `*-backdrop` overrides: at 30 it tied with
    // `.agent-workspace`, so the batch-delete alertdialog lost on DOM order.
    const base = effectiveZIndex(".modal-backdrop");
    expect(base).toBeTypeOf("number");
    const collisions: string[] = [];
    for (const rule of rules) {
      if (rule.selector.startsWith("@")) continue;
      for (const selector of rule.selector.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        if (selector === ".modal-backdrop") continue;
        if (effectiveZIndex(selector) === base) collisions.push(selector);
      }
    }
    expect(collisions, `.modal-backdrop is z-index ${base}, which ${collisions.join(", ")} also use`).toEqual([]);
  });

  it("keeps the three orderings the reported defects were about", () => {
    const z = (selector: string) => {
      const value = effectiveZIndex(selector);
      expect(value, `${selector} must declare a z-index`).toBeTypeOf("number");
      return value as number;
    };
    expect(z(".update-background-status"), "the update progress toast must clear the agent workspace")
      .toBeGreaterThan(z(".agent-workspace"));
    expect(z(".toast"), "a toast must paint above the update prompt, not tie with it")
      .toBeGreaterThan(z(".update-prompt-backdrop"));
    expect(z(".modal-backdrop"), "the scrim base must clear the in-app workspaces")
      .toBeGreaterThan(z(".agent-workspace"));
  });
});
