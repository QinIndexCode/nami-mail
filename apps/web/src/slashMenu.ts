import { filterAgentSlashCommands, type AgentSlashCommand, type AgentSlashSubcommand } from "@nami/agent-contracts";

/**
 * Slash command menu model. Kept as a pure module so the menu behavior
 * (filtering, sub-operation expansion, completion text) is unit-testable
 * without React; AgentWorkspace only wires it to the composer state.
 */

export type SlashMenuItem =
  | { kind: "command"; command: AgentSlashCommand }
  | { kind: "sub"; command: AgentSlashCommand; sub: AgentSlashSubcommand };

export type SlashMenuOptions = {
  streaming?: boolean;
  dismissed?: boolean;
};

export function buildSlashMenu(composer: string, options: SlashMenuOptions = {}): SlashMenuItem[] | null {
  if (options.streaming || options.dismissed) return null;
  const trimmed = composer.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = /^\/([A-Za-z]*)$/.exec(trimmed);
  if (!token) return null;
  const typed = token[1].toLowerCase();
  const commands = filterAgentSlashCommands(typed);
  // While "/{name}" is being typed, sub-operations of that command (e.g.
  // /memory save|list|update|delete) are offered right below their parent.
  return commands.flatMap((command): SlashMenuItem[] => {
    const parent: SlashMenuItem[] = [{ kind: "command", command }];
    if (!typed) return parent;
    return [...parent, ...(command.subcommands ?? []).map((sub): SlashMenuItem => ({ kind: "sub", command, sub }))];
  });
}

/** The composer text produced by selecting a menu item. */
export function slashCompletionText(command: AgentSlashCommand, sub?: AgentSlashSubcommand): string {
  if (sub) return `/${command.name} ${sub.name} `;
  return `/${command.name}${command.requiresParam ? " " : ""}`;
}

/**
 * Commands with sub-operations keep the menu open after the parent trigger is
 * completed so the sub-operation hints stay visible; the bare-token check in
 * buildSlashMenu naturally closes it once "/memory save " is formed.
 */
export function slashKeepsMenuOpen(command: AgentSlashCommand, sub?: AgentSlashSubcommand): boolean {
  return sub !== undefined || (command.subcommands?.length ?? 0) > 0;
}

/** Clamps the keyboard selection to the visible menu, resetting to 0 when closed. */
export function slashMenuActiveIndex(menu: SlashMenuItem[] | null, index: number): number {
  if (!menu) return 0;
  if (index < 0) return 0;
  return Math.min(index, menu.length - 1);
}
