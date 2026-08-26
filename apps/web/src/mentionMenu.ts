/**
 * /@ mail-mention menu model. Kept as a pure module so the menu behavior
 * (prefix detection, query extraction, selection clamping) is unit-testable
 * without React; AgentWorkspace only wires it to the composer state.
 *
 * Mutual exclusion with the slash menu is structural: the slash trigger regex
 * only matches letters after "/" (slashMenu.ts), so "/@..." never opens both.
 */

export type MentionQueryOptions = {
  streaming?: boolean;
  dismissed?: boolean;
  demoMode?: boolean;
};

/**
 * The mail search term when the composer holds a "/@" prefix (possibly with a
 * query after it), or null when the mention menu must stay closed. A bare
 * "/@" opens the menu showing the latest mail across all accounts.
 */
export function mentionQuery(composer: string, options: MentionQueryOptions = {}): string | null {
  if (options.streaming || options.dismissed || options.demoMode) return null;
  if (!composer.startsWith("/@")) return null;
  return composer.slice(2).trim();
}

/** Clamps the keyboard selection to the visible items, resetting to 0 when the list is empty. */
export function mentionActiveIndex<T>(items: readonly T[], index: number): number {
  if (items.length === 0) return 0;
  if (index < 0) return 0;
  return Math.min(index, items.length - 1);
}