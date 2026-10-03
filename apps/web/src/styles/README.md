# Nami Mail Styles Architecture Guide

This document describes the layered modular CSS architecture, cascade order rules, automated style measurement tooling, and development workflows for `apps/web/src/styles/`.

---

## 1. Architecture Overview & Design Principles

Historically, Nami Mail bundled all client styling into a single monolithic file (`apps/web/src/styles.css`, peaking at over 17,500 lines). As the client grew, this monolith presented severe maintenance friction, high merge conflict frequency, and selector obscurity.

The current codebase adopts a **Layered Modular CSS Architecture**:
- **Decoupled by Design Layer & Business Domain**: Partitioned into 5 top-level directories (`tokens/`, `base/`, `components/`, `overlays/`, `features/`) encompassing 29 focused module files.
- **Root Stylesheet as a Pure Catalog Entry**: [`apps/web/src/styles.css`](../styles.css) acts solely as an `@import` index table of contents ($\le 40$ lines).
- **Zero Runtime or Network Overhead**: Vite’s built-in `postcss-import` flattens all `@import` rules into a single minified bundle during production build without extra HTTP roundtrips.

---

## 2. Directory Structure & Layer Responsibilities

```
apps/web/src/styles/
├── tokens/              # Design tokens and custom property declarations
│   └── variables.css    # Core CSS variables (palette, semantic tokens, radius, shadows, typography)
├── base/                # Foundational rules: reset, window shell, animations, responsive breakpoints
│   ├── reset.css        # Box-sizing, margin resets, baseline elements
│   ├── layout.css       # Window header, multi-column shell frame, main workspace containers
│   ├── animations.css   # Global keyframe definitions (fade-in, modal-in, drawer squeezes, etc.)
│   ├── responsive.css   # Breakpoint queries (≤1050px, ≤820px, ≤620px) & prefers-reduced-motion
│   ├── transitions.css  # View transitions and content enter animations
│   └── print.css        # Print media styling for distraction-free hardcopy conversation views
├── components/          # Reusable, cross-feature UI controls
│   ├── buttons.css      # Standard button classes (primary, secondary, danger, icon)
│   ├── select.css       # Custom select component (ThemedSelect & ThemedSelectMenu)
│   ├── interactions.css # Micro-interactions (:active feedback, focus rings, sliders, checkbox pops)
│   └── error-boundary.css # Subtree crash fallback presentation
├── overlays/            # Modal and floating surface infrastructure
│   ├── modals.css       # Base modal scrims (.modal-backdrop) and centered card frames
│   ├── toasts.css       # Floating notification toasts (info, success, warning, danger)
│   └── popups.css       # Dropdown menus, date picker panels, and exit transitions (.closing)
└── features/            # Feature-specific styles
    ├── sidebar.css      # Left navigational sidebar, folder trees, account navigation
    ├── mail.css         # Message list, search toolbar, reading pane, thread strip, message bodies
    ├── composer.css     # Composer window, recipient chips, subject line, formatting bar
    ├── account-connection.css # Account setup wizard, IMAP/SMTP manual setup, OAuth cards
    ├── settings.css     # Settings modal shell, category tabs, model & MCP provider cards
    ├── settings-footer.css    # Settings sticky footer bar and action buttons
    ├── accounts.css     # Standalone account management modal, batch selections, health alerts
    ├── filter-rules.css # Mail filter rule list, condition editors, and modal dialog
    ├── contacts.css     # Contacts management dialog, contact editor dialog, avatar editor
    ├── templates.css    # Message templates dialog and template editor
    ├── agent.css        # AI Agent workspace, conversation rail, streaming bubbles, tool calls
    ├── calendar.css     # Calendar month view, grid cells, event markers, event editor dialog
    ├── agent-calendar-responsive.css # Mobile drawer adaptations for Agent & Calendar
    ├── auto-reply.css   # Auto-reply rule manager, execution history cards, interception banners
    └── attachments.css  # Attachment kind color badges (PDF, sheet, doc, code, media) & upload bars
```

---

## 3. Cascade Invariants & Ordering Rules

In CSS, **rules with equal specificity prioritize whichever comes later in source order**. Therefore, the `@import` sequence in [`apps/web/src/styles.css`](../styles.css) is strictly deterministic and must not be rearranged arbitrarily:

1. **Tokens First**: `tokens/variables.css` must load before all else to ensure variables resolve universally.
2. **Base Next**: Global resets and window framework precede components.
3. **Components & Overlays Precede Features**: Base controls must be declared prior to domain overrides.
4. **Features in Domain Order**: Individual features load their dedicated rulesets.
5. **Micro-Interactions & Popups Last**: `interactions.css`, `attachments.css`, and `popups.css` sit at the bottom so `:active`, `:hover`, and `.closing` state rules retain precedence over static base styles.

### ⚠️ Containing-Block Hazards on Overlays
The `overlayStacking.test.ts` test suite executes automated AST validation on all stylesheets:
- **Never** add properties that establish a new containing block to overlay hosts or backdrops (`.modal-backdrop`, `.settings-backdrop`, `.confirmation-backdrop`, `.app-frame`):
  - `transform` (other than `none`)
  - `filter` / `backdrop-filter`
  - `perspective`
  - `contain: paint`
  - `will-change` (with any of the above)
- Violating this invariant causes `position: fixed` modals to anchor to the local container rather than the viewport, breaking centering, containment, and z-index stacking.

---

## 4. Automated Style Measurement & Quality Guardrails

To prevent regressions, selector omission, or specificity shifts during refactoring, several automated checks are in place:

### 1) AST Style Metric Analyzer (`scripts/measure-styles.mjs`)
Uses PostCSS to parse the full AST and compare current aggregated styles against the baseline commit (`41a9e77`):
```bash
npm run styles:measure
```
It validates complete equivalence across:
- Total CSS rules
- Total CSS property declarations
- Total and unique selector signatures
- Keyframe animation names
- Media query counts and parameters
- Custom property (`--*`) definitions

### 2) Size Ratchet Test (`apps/web/src/styles-size.test.ts`)
- **Root Entry Budget**: Enforces that [`apps/web/src/styles.css`](../styles.css) contains only `@import` statements and blank lines, capped at $\le 40$ lines.
- **Aggregated Budget**: Limits the total lines across all aggregated partials using `FROZEN_AGGREGATED_MAX_LINES` to prevent accidental style bloat.

### 3) Test Environment Bundling (`apps/web/src/testUtils/loadStyles.ts`)
Vitest in jsdom environments cannot natively resolve `@import` chains. Unit tests requiring computed DOM styles should load the aggregated stylesheet via:
```typescript
import { loadAggregatedCss } from "./testUtils/loadStyles.js";
const fullCss = loadAggregatedCss();
```

---

## 5. Developer Workflow & Contribution Guidelines

### Adding a New Feature
1. Create `apps/web/src/styles/features/<feature-name>.css`.
2. Add `@import "./styles/features/<feature-name>.css";` inside the feature section of [`apps/web/src/styles.css`](../styles.css).
3. Run `npm run styles:measure` to verify parse validity.

### Adding a Reusable UI Component
1. Place modal/floating surfaces in `overlays/` and generic inline controls in `components/`.
2. Adhere to design tokens for heights ($32\text{px}$ / $34\text{px}$), focus rings (`var(--focus-ring-subtle)`), and text scales.

### Pre-Commit Checklist
Run the following verification pipeline before committing style modifications:
```bash
# 1. Verify AST equivalence and integrity
npm run styles:measure

# 2. Run style-dependent test suites
npm --workspace @nami/web test styles-size.test.ts overlayStacking.test.ts overlayCentering.test.ts designTokens.test.ts themeContrast.test.ts

# 3. Verify TypeScript types and production build
npm --workspace @nami/web run typecheck
npm --workspace @nami/web run build
```
