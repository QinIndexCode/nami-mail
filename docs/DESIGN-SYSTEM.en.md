# Design System

This document defines the **visual baselines** the UI must follow. Until now the visual rules lived
only inside `apps/web/src/styles.css` (~17,000 lines), which is how the same layer ended up with
several different shadows and the same kind of text with several different sizes: each local pass
converged while the whole drifted. Read this before changing styles.

- Source of truth for styles: `apps/web/src/styles.css`
- Themes: `:root` (light) and `:root[data-theme=dark]`, with semantic tokens defined in pairs
- How to verify a visual change: `npm run test:e2e` (three specs), `npm run smoke:desktop`, and the tests that assert against the stylesheet

## 1. Prose measure

| token | value | used for |
|---|---|---|
| `--measure` | `960px` | **plain-text prose only** (`.mail-text`); the reading column itself fills the pane |

The reading pane (`.mail-title`, `.mail-content`, `.translation-panel`, `.verification-code-list`,
`.attachment-list`) is still **one column**, but that column no longer has a fixed width: it fills
the reading pane, the way Gmail does.

The reason is that provider-authored HTML carries its own layout. Capping the column squeezes a
600px-wide template table into a narrower box and, together with `overflow-wrap:anywhere` on
`.mail-html :is(td,th)`, breaks words in the middle (which is exactly how Apple's promo mail
displayed its broken line wraps). The width has to come from the pane, not from the body font.

Only **plain text** — which has no layout of its own — needs a line-length cap. It starts at the
column's left padding, so its edge still lines up with the subject above it.

**How the value is derived**: at 960px with the Georgia 16px body font and ~8px per character in
mixed prose, that is about **105 characters per line** — past the comfortable 45–75 range, but the
price of matching Gmail; on narrower windows the column width takes over and caps it anyway.

> If the body font or size changes (`.mail-text, .mail-html` `font-family` / `font-size`), **recompute
> `--measure`**. This is also why `ch` is not used here: `ch` resolves against the element that
> declares it, and the container (`.mail-content`) inherits the UI font, which would compute a far
> narrower column than intended.

## 2. Radius

| token | value | used for |
|---|---|---|
| `--radius-sm` | `8px` | most controls: buttons, inputs, list rows, tags, inner card blocks |
| `--radius-md` | `12px` | panel level: popovers, menus, dialogs, larger cards |
| `--radius-lg` | `20px` | large panels / outer surfaces (currently unreferenced, kept as the third tier) |
| `--radius-pill` | `999px` | pills: status badges, switches, avatars, dots |

**Never write a literal value.** The only exception is a deliberate asymmetric radius (for example
`border-radius:var(--radius-md) var(--radius-md) 4px` to round just the top corners) — and even then
each tier must still reference a token.

## 3. Shadows

| token | used for |
|---|---|
| `--shadow-sm` | small controls flush with content: drag thumbs, inset cards |
| `--shadow-raised` | layers lifted above content: menus, popovers, dropdowns, toolbars |
| `--shadow` | highest layer: modals, large overlays |
| `--shadow-drawer` | side drawers that slide in |

Decide by **how far the surface sits from the content plane**, not by how heavy it looks. Two
popovers on the same layer must use the same token.

**What does *not* belong to this system** (do not force a token onto it):

| category | form | why |
|---|---|---|
| hairline / inner highlight | `inset 0 1px 0 …` | a border and a texture, not elevation |
| focus ring | `0 0 0 3px var(--focus-ring…)` | see §7 |
| separator | `0 1px 0 var(--line)` | may ride along with another layer |
| state halo | `0 Npx Mpx color-mix(in srgb, var(--token) X%, transparent)` | a *tinted* lift for selection/hover/error/glow; must be mixed from a token, never a raw colour |
| native control detail | e.g. `::-webkit-slider-thumb` | platform rendering |
| `none` | — | — |

**Current state (converged 2026-09-10)**: of 105 literal `box-shadow` declarations, **80 are the
hairline/focus-ring cases** above and 25 were elevation candidates. **12 of those were folded into the
tokens** (6 menus/popovers → `--shadow-raised`, 6 card-level → `--shadow-sm`), which also let **two
redundant dark-theme override rules be deleted** — a token switches per theme, a literal needs an
override. **Elevation literals are now 0**; what remains is 18 state-halo declarations plus 2 native
slider details.

> Correcting an earlier figure: "~100 one-off shadows" had counted the 80 hairlines and focus rings.
> The real convergence set was 25 candidates, of which 12 needed work. The lesson: **count by category,
> not by keyword.**

## 4. Type scale

**Baseline principle: one step per semantic role; no blanket enlargement.**
This is a dense desktop mail client — the 8–11px sizes (counts, timestamps, metadata) are part of the
product, not a defect. What needs governing is that the *same kind of information* uses different
steps.

Current distribution (`styles.css`): `8px`(28) / `9px`(81) / `10px`(155+) / `11px`(144+) /
`11.5px`(2) / `12px`(52) / `12.5px`(3) / `13px`(11) / `13.5px`(1) / `14px`(9) / `15px`(10) /
`16px`(7) / `18px`(3) / `20px`(4) plus a few ≥26px.

**To converge**:
- Remove the five isolated fractional steps: `9.5px`(3) / `10.5px`(1) / `11.5px`(2) / `12.5px`(3) / `13.5px`(1) (snap to a neighbour).
- Decide between `9px` and `10px` for the same class of metadata (suggest `10px`).
- Reading-pane body text stays 16px (serif).

## 5. Line height

| context | value |
|---|---|
| reading-pane body (`.mail-text, .mail-html`) | `1.7` |
| title (`.mail-title h2`) | `1.24` |
| UI text | `1.3`–`1.45` |
| resets (icon rows etc.) | `0` / `1` |

The body used to be `1.85`, which is loose for 16px and makes long paragraphs look scattered.
**Unitless numbers are the default**; when `px`/`em` is genuinely needed (e.g. an icon row height),
explain why in a comment.

## 6. Colour

### Semantic colours: deliberately desaturated "ink" tones
`--danger` `--success` `--warning` `--info` are muted on purpose
(light `#b43838` / `#347a4a` / `#b67816` / `#4f7294`). The dark theme is **not a plain inversion** —
it brightens and re-tunes saturation (`#e47070` / `#75b98a` / `#d49233` / `#7ba1c4`). Keep it.

### Accent colours: must live in the same saturation band
`--cal-*` (the six calendar colours) are currently **undesaturated primaries**
(`#3b82f6` / `#a855f7` …, close to Tailwind 500). Side by side with the semantic colours this reads as
a seam between "sophisticated grey" and "harsh primary".

**To converge**: desaturate `--cal-*` (and the attachment icon colours) into the same band as the
semantic colours, with matching dark steps. New accents follow the same rule by default.

### Contrast floor (enforced by a test)
Type in this app is mostly 8–11px, so **nothing qualifies for the WCAG "large text" allowance** and
everything is held to the **4.5:1** normal-text floor. `apps/web/src/themeContrast.test.ts` reads the
tokens out of `styles.css` and checks them: the three text tiers (`--text` / `--text-soft` /
`--text-faint`) against `--panel-solid`, `--panel`, `--panel-muted` and `--canvas` (the background
preview renders faint text straight onto the canvas), and the four semantic colours
(`--danger` / `--success` / `--warning` / `--info`) against the three panel surfaces, where they are
actually used.

Two light-theme tokens were corrected when the baseline was established:
- `--text-faint`: `#727279` → `#66666c` (4.38 → 5.01 on `--panel-muted`, 4.49 → 4.82 on the canvas)
- `--warning`: `#b67816` → `#9a6510` (3.69 → 4.95 on the panels)

> Known boundary: the panels are translucent and an optional wallpaper sits under them, so lowering
> the panel opacity over a dark wallpaper breaks these ratios. The default is
> `--bg-panel-opacity:100%`, and the test assumes panels composited over the canvas.

### Layers and rules
- Weak separators (list rows, lines inside a card) use `--line`.
- Strong boundaries (outer surfaces, modals, a border that must be noticed) use `--line-strong`.
- Do not stack both systems on one element (e.g. `--line-strong` mixed again with `--line`).

## 7. Interaction states

Controls should cover `hover` / `active` / `disabled` / `selected` (or `.active`) / `focus-visible`.

- **Focus ring**: the global rule already covers `button/input/textarea/select:focus-visible`, so
  custom controls do **not** need a second ring. When a custom look is required, drop the outline for
  pointer focus with `:focus:not(:focus-visible)` and add the ring in `:focus-visible` (see
  `.mail-title h2`).
- **`:disabled`**: if the code can render the control disabled, a style must exist. Add it with the
  control rather than in a later catch-up block.
- A bare `outline:none` is not allowed: it must be paired with a `:focus-visible` replacement.

### When `!important` is allowed

Most `!important` in this file is **required**, in four structural situations — do not delete it in the name
of cleanup:

| situation | why |
|---|---|
| overriding an email's inline styles (e.g. `.mail-html table` `max-width`) | inline styles outrank normal external rules; only `!important` wins |
| the global `user-select` policy (off on `.workspace-canvas *`, on for inputs, message content and previews) | it fights another `!important`, so it must be at the same level |
| `@media (prefers-reduced-motion)` and `print` | must beat every component's animation/transition |
| `.theme-transitioning` suppressing transitions during a theme swap | same |

**Otherwise do not reach for `!important`.** When the goal is to beat a *more specific* variant rule
(e.g. a combinator selector such as `.foo>div`), write a **more specific selector** instead. Example
(one site was converted this way on 2026-09-10):

```css
/* before: forced with !important */
.sidebar-footer-actions { gap:2px!important }
/* after: wins on specificity, with a note saying what it beats */
/* Beats `.sidebar-footer>div{gap:8px}` (0,1,1) on specificity. */
.sidebar-footer>.sidebar-footer-actions { gap:2px }
```

> Correction: the audit guessed "about six redundant `!important`". Checking them showed otherwise —
> the named ones are either the structural cases above or are winning against a higher-specificity rule
> (such as `.sidebar-footer>div`). Only one was provably redundant; it is gone. Removing the other 52
> needs **browser-level cascade verification** (computed-style comparisons) per declaration, which is not
> worth the risk, so they stay, held by a ratchet that stops the count growing. (The audit's listing was
truncated, which is why its count did not add up.)

## 8. Known convergence backlog

| item | size | prerequisite |
|---|---|---|
| ~~Unify one-off shadows onto the tiers~~ | ~~12 elevation shadows~~ | **done** (batch AC) |
| ~~Desaturate `--cal-*` / attachment colours~~ | ~~12 rules~~ | **done** (batch AD, which also fixed chip labels sitting at 2.18–3.25:1) |
| ~~Merge fractional type steps~~ | ~~10 sites~~ | **done** (batch AD); fractional sizes are now zero-tolerance |
| ~~Snap `7px`/`9px` spacing~~ | ~~217 lines~~ | **done** (batch AD). **The target was corrected** — see below |
| Redundant `!important` | guessed 6, actually 1 | **the provable one is done**; the other 52 need browser-level cascade verification |
| ~~Audit `outline:none` pairings~~ | ~~42 sites~~ | **done**: unpaired count is held at 0 by the test |

**Converged** (2026-09-10): accent colours (calendar + attachment kinds) tokenised and desaturated with
dark-theme coverage; radius tokenised (2 → ~179 references, no numeric change); reading pane unified on
`--measure`; body line-height 1.85 → 1.7; the orphan `.sync-progress-banner` class styled; every
elevation shadow folded into a token; every fractional type size snapped; all `7px`/`9px` spacing on 8px.

### Spacing target corrected: a 2px sub-grid, not 4px

The audit listed "snap spacing to the **4px** grid" as debt. Measuring first showed **that target does not
hold**: of the 887 gap/padding/margin values that are not 4px multiples, the overwhelming majority are
**multiples of 2** (`6px` 153, `10px` 168, `14px` 62, `18px` 35, `22px` 18 …), with `1px`/`3px` used for
hairlines and optical nudges.

In other words the layout is hand-tuned on a **2px sub-grid**; forcing 4px would shift spacing throughout —
that is a **visual remodel, not debt cleanup**. The rules actually applied are:

- the "off by one pixel from its own step" values (`7px`/`9px`) all snapped to `8px` (done; they must not
  come back);
- the remaining **odd rhythm values** (`5px`/`11px`/`13px`/`17px`/`15px`/`19px`/`21px`/`25px`/`29px`/`41px`,
  205 sites) are held by a ratchet budget that may only go down and rejects new ones;
- `1px`/`3px` count as borders/nudges and are exempt for good.

## 9. Change process

1. Check this document before touching styles; if a new step is needed, **update this document too**.
2. Visual changes run `npm run test:e2e` (sidebar, list, update footer) plus `npm run smoke:desktop`.
3. For multi-pixel convergence (the backlog above), build the visual baseline first.

## 10. Automated baseline (the two tests in `apps/web`)

Rules only hold if something watches them, so the baseline is **executable** and runs with `npm test`:

| file | what it does |
|---|---|
| `src/themeContrast.test.ts` | reads the tokens from `styles.css`, computes WCAG contrast per theme, holds the 4.5:1 floor (§6) |
| `src/designTokens.test.ts` | radius / shadow / type / `!important` / `outline` policy + **debt ratchet** + theme parity + doc existence |
| `e2e/geometry.spec.ts` | **geometry baseline**: sidebar / row height / reading column / prose width at four breakpoints, plus "no horizontal overflow anywhere"; also asserts a theme switch does not move the measure and that dark prose really is light |

### Geometry baseline (`e2e/geometry.spec.ts`)

| breakpoint | sidebar | reading column (the content block fills it) | plain-text prose | row height |
|---|---|---|---|---|
| 1440px | 238px | 1116px | 960 (`--measure` applies) | 105px |
| 1000px | 220px | 694px | 634 (limited by the column) | 105px |
| 800px | drawer (280px, off-canvas) | 744px | 684 (limited by the column) | 105px |
| 600px | drawer (off-canvas) | 600px (fullscreen) | 528 (limited by the column) | 105px |

(Prose width = `min(--measure, reading column − side padding)`; the padding is `clamp(20px, 6vw, 48px)`, or 30px at the ≤1050px breakpoint.)

The assertions are **tight (±2px)**: if a change moves one of these numbers it is a *deliberate* edit to the
constant here, with a reason — that is the review step this file exists to force. Use it to judge whether a
convergence pass (shadows, type, spacing) improved things or quietly broke a layout.

> One interaction-ordering rule came out of building this baseline: **the first-run terms gate must come
> before the update prompt**. Toasts and the update prompt used to cover that dialog, leaving "agree and
> continue" unclickable at narrow widths. The gate now counts as an open modal
> (`anyModalOpen` in `dialogRouting`) and prompts step behind it.

**What the ratchet means**: `debtBudget` at the top of `designTokens.test.ts` records the *ceiling*
for the debt that predates the policy — off-scale radii, state halos, fractional type steps,
`!important`, bare outlines. It may only go **down**:

- Fix some → **lower the number in the budget** (that is the progress record).
- Never raise it; a new violation fails immediately (writing `border-radius:7px` fails because `7px`
  is not in the budget table).
- Besides the four tiers, only structural values are allowed: `0 / 2px / 4px / 50%`.
- Shadows are a **per-layer contract**, not a count: every layer is either one of the four elevation
  tokens or one of the exempt categories in §3 — so a new raw-colour shadow fails outright, while a
  state halo only has to follow the recipe (and has its own count ratchet).

This ratchet does **not** replace the visual baseline: it stops *new* violations, it does not converge
the *existing* ones — that changes pixels and still needs the prerequisites in §8.
