/**
 * Slash commands for the Nami Mail Agent. Each command is a short English
 * trigger plus two separately designed prompt layers:
 *
 * - `prompt`: the user-turn directive sent to the model (task semantics,
 *   `{args}` is substituted server-side). This is the "instruction" part.
 * - `constraint`: an optional system-level rule appended to the system prompt
 *   for that turn (e.g. read-only turns), keeping model behavior in bounds.
 *
 * The web UI only consumes the registry metadata (names, i18n keys) to render
 * the command menu; expansion and validation happen on the server so commands
 * form a controlled set and unknown commands cannot reach the model.
 */

export type AgentSlashCommandId = "help" | "briefing" | "unread" | "find" | "todo" | "summary" | "draft" | "memory";

export interface AgentSlashSubcommand {
  /** Short English trigger, displayed as "/{command.name} {name}". */
  name: string;
  /** Web i18n key for the sub-operation description. */
  descriptionKey: string;
  /** Web i18n key for the sub-operation usage hint. */
  usageKey?: string;
}

export interface AgentSlashCommand {
  /** Stable id used for i18n keys and server logic. */
  id: AgentSlashCommandId;
  /** Short English trigger, displayed as "/{name}". */
  name: string;
  /** Whether the command requires a free-text argument. */
  requiresParam: boolean;
  /** Whether the command needs the mail tools, i.e. Agent mode. */
  requiresTools: boolean;
  /** One-line English purpose, used by the /help expansion. */
  summary: string;
  /** Web i18n key for the command menu description. */
  descriptionKey: string;
  /** Web i18n key for the usage hint (only when requiresParam). */
  usageKey?: string;
  /** Sub-operations offered by the command menu while "/{name}" is typed. */
  subcommands?: readonly AgentSlashSubcommand[];
  /** User-turn directive sent to the model. "{args}" is substituted. */
  prompt: string;
  /** Optional system-level rule appended to the system prompt for this turn. */
  constraint?: string;
}

const readOnlyConstraint = "This turn is read-only: do not send, move, delete, or modify any mail. Use read-only tools only.";

export const AGENT_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  {
    id: "help",
    name: "help",
    requiresParam: false,
    requiresTools: false,
    summary: "List the available slash commands.",
    descriptionKey: "agent.commands.help.description",
    prompt: "", // /help is expanded by the server with the live command list.
  },
  {
    id: "briefing",
    name: "briefing",
    requiresParam: false,
    requiresTools: true,
    summary: "Give a daily mail briefing of what matters today.",
    descriptionKey: "agent.commands.briefing.description",
    prompt: [
      "The user requested a daily mail briefing.",
      "Start with messages.list using unread:true or flagged:true, and use messages.batch_get only where snippets are ambiguous.",
      "Cover: the most important messages (subject, sender, when), anything that needs a reply or decision, and any deadlines.",
      "Cite the email titles you reference.",
    ].join(" "),
    constraint: readOnlyConstraint,
  },
  {
    id: "unread",
    name: "unread",
    requiresParam: false,
    requiresTools: true,
    summary: "Show unread or important messages as a prioritized list.",
    descriptionKey: "agent.commands.unread.description",
    prompt: [
      "The user asked what is unread or important in the mailbox.",
      "Use messages.list with unread:true or flagged:true first, then present a short prioritized list: subject, sender, and the action each one needs.",
      "Do not read full bodies unless a snippet is ambiguous.",
    ].join(" "),
    constraint: readOnlyConstraint,
  },
  {
    id: "find",
    name: "find",
    requiresParam: true,
    requiresTools: true,
    summary: "Search mail by keyword, sender, or date.",
    descriptionKey: "agent.commands.find.description",
    usageKey: "agent.commands.find.usage",
    prompt: [
      "The user asked to find mail matching: \"{args}\".",
      "Use messages.list with keyword, sender:, after:, or before: filters, and messages.batch_get for details.",
      "Present matches concisely: subject, sender, date, and why each matches. If nothing matches, say so directly.",
    ].join(" "),
    constraint: readOnlyConstraint,
  },
  {
    id: "todo",
    name: "todo",
    requiresParam: false,
    requiresTools: true,
    summary: "Extract action items that need a reply or decision.",
    descriptionKey: "agent.commands.todo.description",
    prompt: [
      "The user wants an action list from the mailbox.",
      "Gather messages that need a reply, follow-up, or decision (unread, flagged, or recent), then present a numbered checklist: the action, the message it refers to (subject and sender), and urgency.",
    ].join(" "),
    constraint: readOnlyConstraint,
  },
  {
    id: "summary",
    name: "summary",
    requiresParam: false,
    requiresTools: true,
    summary: "Summarize the current thread or conversation.",
    descriptionKey: "agent.commands.summary.description",
    prompt: [
      "The user asked for a summary.",
      "If the conversation references a specific message or thread, use messages.get or threads.get to summarize that thread.",
      "Otherwise summarize the conversation so far: what was discussed, what was decided, and what is still open.",
    ].join(" "),
    constraint: readOnlyConstraint,
  },
  {
    id: "draft",
    name: "draft",
    requiresParam: true,
    requiresTools: true,
    summary: "Draft a message for review.",
    descriptionKey: "agent.commands.draft.description",
    usageKey: "agent.commands.draft.usage",
    prompt: [
      "The user requested a draft: \"{args}\".",
      "Determine the recipient and topic from the request, compose the draft in the user's language, and present it for review.",
    ].join(" "),
    constraint: "This turn produces a draft for review only. Do not call send tools unless the user explicitly confirms sending the draft.",
  },
  {
    id: "memory",
    name: "memory",
    requiresParam: true,
    requiresTools: true,
    summary: "Manage long-term memory notes (save, list, update, delete).",
    descriptionKey: "agent.commands.memory.description",
    usageKey: "agent.commands.memory.usage",
    subcommands: [
      { name: "save", descriptionKey: "agent.commands.memory.sub.save", usageKey: "agent.commands.memory.sub.save.usage" },
      { name: "list", descriptionKey: "agent.commands.memory.sub.list", usageKey: "agent.commands.memory.sub.list.usage" },
      { name: "update", descriptionKey: "agent.commands.memory.sub.update", usageKey: "agent.commands.memory.sub.update.usage" },
      { name: "delete", descriptionKey: "agent.commands.memory.sub.delete", usageKey: "agent.commands.memory.sub.delete.usage" },
    ],
    prompt: [
      "The user asked to save a note to long-term memory: \"{args}\".",
      "Store it with memory.save, keeping the summary concise and factual.",
      "If the user is correcting or refining an existing note, use memory.update with the id from memory.list instead.",
      "Do not read, modify, or delete other memory records.",
    ].join(" "),
    constraint: "This turn manages long-term memory only. Do not call mail tools.",
  },
];

export interface AgentSlashCommandMatch {
  command: AgentSlashCommand;
  /** Free-text argument after the command name, already trimmed. */
  args: string;
}

/** Expands to the canonical usage hint, e.g. "/find <argument>". */
export function agentSlashUsage(command: AgentSlashCommand): string {
  return command.requiresParam ? `/${command.name} <argument>` : `/${command.name}`;
}

/**
 * Parses a user message as a slash command. Only whole messages that start
 * with a known command name match; anything else (including unknown "/foo"
 * tokens, like a pasted path) is left untouched for the model.
 */
export function matchAgentSlashCommand(content: string): AgentSlashCommandMatch | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) return null;
  const parsed = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!parsed) return null;
  const command = AGENT_SLASH_COMMANDS.find((candidate) => candidate.name === parsed[1]!.toLowerCase());
  if (!command) return null;
  return { command, args: (parsed[2] ?? "").trim() };
}

/**
 * Filters the registry for the command menu while the user types "/<token>".
 * An empty or undefined token returns every command.
 */
export function filterAgentSlashCommands(token: string | undefined): readonly AgentSlashCommand[] {
  const prefix = (token ?? "").trim().toLowerCase();
  return prefix ? AGENT_SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix)) : AGENT_SLASH_COMMANDS;
}

/** The /help directive, expanded by the server with the live command list. */
export function buildAgentSlashHelpPrompt(): string {
  const list = AGENT_SLASH_COMMANDS.map((command) => `- ${agentSlashUsage(command)} — ${command.summary}`).join("\n");
  return [
    "The user invoked /help.",
    "Here are this assistant's slash commands:",
    list,
    "Show each command with its usage syntax and a one-line purpose. Keep the reply short and scannable, and respond in the user's language.",
  ].join("\n");
}

function expandMemoryCommand(args: string): string {
  const [operation, ...rest] = args.split(/\s+/);
  const content = rest.join(" ").trim();
  const subject = content ? `: "${content}"` : "";
  switch ((operation ?? "").toLowerCase()) {
    case "list":
      return [
        "The user asked to review their stored long-term memory notes.",
        "Use memory.list (optionally with a query from the user) and present the notes grouped by topic.",
        "Do not modify or delete any notes.",
      ].join(" ");
    case "update": {
      const base = [
        `The user asked to update an existing long-term memory note${subject}.`,
        "Find the note with memory.list (match by keyword when the user did not provide an id), then update it with memory.update using the corrected summary or detail.",
        "Do not create a duplicate note for a correction; replace the stale content.",
      ];
      return base.join(" ");
    }
    case "delete": {
      const base = [
        `The user asked to delete a stored long-term memory note${subject}.`,
        "Locate it with memory.list (match by keyword when the user did not provide an id), then delete it with memory.delete and confirm briefly.",
      ];
      return base.join(" ");
    }
    default: {
      const note = /^(save|add)\s+/i.test(args) ? args.replace(/^(save|add)\s+/i, "") : args;
      return [
        `The user asked to save a note to long-term memory${note ? `: "${note}"` : ""}.`,
        "Store it with memory.save, keeping the summary concise and factual.",
        "If the user is correcting an existing note, use memory.update instead.",
        "Do not read, modify, or delete other memory records.",
      ].join(" ");
    }
  }
}

/**
 * Expands a matched slash command into the user-turn directive. `{args}` is
 * substituted for plain commands; the memory command dispatches on its first
 * argument token (save|list|update|delete) so each operation gets its own
 * task semantics. /help is expanded by the server with the live command list.
 */
export function expandAgentSlashCommand(command: AgentSlashCommand, args: string): string {
  if (command.id === "memory") return expandMemoryCommand(args);
  return command.prompt.replace("{args}", args);
}
