import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SLASH_COMMANDS,
  agentSlashUsage,
  buildAgentSlashHelpPrompt,
  expandAgentSlashCommand,
  filterAgentSlashCommands,
  matchAgentSlashCommand,
} from "../src/index.js";

test("registry: every command has a unique lower-case name and a prompt", () => {
  const names = new Set<string>();
  for (const command of AGENT_SLASH_COMMANDS) {
    assert.match(command.name, /^[a-z]+$/, `name should be a lower-case word: ${command.name}`);
    assert.ok(!names.has(command.name), `duplicate command name: ${command.name}`);
    names.add(command.name);
    if (!command.requiresParam) assert.equal(command.usageKey, undefined);
    if (command.id !== "help") assert.ok(command.prompt.length > 0);
    assert.ok(command.descriptionKey.startsWith("agent.commands."));
  }
  assert.deepEqual(
    AGENT_SLASH_COMMANDS.map((command) => command.name),
    ["help", "briefing", "unread", "find", "todo", "summary", "draft", "memory"],
  );
});

test("memory: is a parameterized tool command with a memory-only constraint", () => {
  const memory = AGENT_SLASH_COMMANDS.find((command) => command.id === "memory")!;
  assert.equal(memory.requiresParam, true);
  assert.equal(memory.requiresTools, true);
  assert.match(memory.constraint ?? "", /memory/);
  assert.match(memory.prompt, /memory\.save/);
});

test("memory: exposes save/list/update/delete sub-operations for the menu", () => {
  const memory = AGENT_SLASH_COMMANDS.find((command) => command.id === "memory")!;
  const names = memory.subcommands!.map((sub) => sub.name);
  assert.deepEqual(names, ["save", "list", "update", "delete"]);
  for (const sub of memory.subcommands!) {
    assert.match(sub.name, /^[a-z]+$/);
    assert.ok(sub.descriptionKey.startsWith("agent.commands.memory.sub."));
    assert.ok(sub.usageKey && sub.usageKey.startsWith("agent.commands.memory.sub."));
  }
});

test("expand: substitutes {args} for plain commands", () => {
  const find = AGENT_SLASH_COMMANDS.find((command) => command.id === "find")!;
  const expanded = expandAgentSlashCommand(find, "invoice from Acme");
  assert.match(expanded, /"invoice from Acme"/);
  assert.ok(!expanded.includes("{args}"));
});

test("expand: dispatches the memory sub-operations", () => {
  const memory = AGENT_SLASH_COMMANDS.find((command) => command.id === "memory")!;
  const save = expandAgentSlashCommand(memory, "prefers English replies");
  assert.match(save, /memory\.save/);
  assert.match(save, /"prefers English replies"/);
  const withSaveToken = expandAgentSlashCommand(memory, "save prefers English replies");
  assert.match(withSaveToken, /memory\.save/);
  assert.match(withSaveToken, /"prefers English replies"/);
  assert.ok(!withSaveToken.includes('"save prefers'));
  const list = expandAgentSlashCommand(memory, "list");
  assert.match(list, /memory\.list/);
  assert.ok(!list.includes("memory.save"));
  const update = expandAgentSlashCommand(memory, "update invoices");
  assert.match(update, /memory\.update/);
  assert.match(update, /"invoices"/);
  assert.match(update, /stale/);
  const deleteNote = expandAgentSlashCommand(memory, "delete invoices");
  assert.match(deleteNote, /memory\.delete/);
  assert.ok(!deleteNote.includes("memory.update"));
  const bare = expandAgentSlashCommand(memory, "Save English replies");
  assert.match(bare, /memory\.save/);
});

test("match: parses a bare command", () => {
  const match = matchAgentSlashCommand("/unread");
  assert.ok(match);
  assert.equal(match!.command.id, "unread");
  assert.equal(match!.args, "");
});

test("match: parses a command with arguments, keeping the rest of the line", () => {
  const match = matchAgentSlashCommand("  /find  发票 from:alice  ");
  assert.ok(match);
  assert.equal(match!.command.id, "find");
  assert.equal(match!.args, "发票 from:alice");
});

test("match: is case-insensitive on the command name only", () => {
  assert.equal(matchAgentSlashCommand("/UNREAD")?.command.id, "unread");
  assert.equal(matchAgentSlashCommand("/Find invoices")?.command.id, "find");
});

test("match: ignores non-command text, unknown commands, and pasted paths", () => {
  assert.equal(matchAgentSlashCommand("5/2 of a plan"), null);
  assert.equal(matchAgentSlashCommand("/unknown stuff"), null);
  assert.equal(matchAgentSlashCommand("/Users/me/notes.md"), null);
  assert.equal(matchAgentSlashCommand(""), null);
  assert.equal(matchAgentSlashCommand("   "), null);
  assert.equal(matchAgentSlashCommand("/"), null);
  assert.equal(matchAgentSlashCommand("read /unread please"), null);
});

test("filter: empty prefix returns every command, non-empty filters by prefix", () => {
  assert.equal(filterAgentSlashCommands(undefined).length, AGENT_SLASH_COMMANDS.length);
  assert.equal(filterAgentSlashCommands("").length, AGENT_SLASH_COMMANDS.length);
  assert.deepEqual(filterAgentSlashCommands("fi").map((command) => command.name), ["find"]);
  assert.deepEqual(filterAgentSlashCommands("U").map((command) => command.name), ["unread"]);
  assert.deepEqual(filterAgentSlashCommands("xyz"), []);
});

test("usage: bare commands show only the name, parameterized commands show a placeholder", () => {
  assert.equal(agentSlashUsage(AGENT_SLASH_COMMANDS.find((c) => c.id === "unread")!), "/unread");
  assert.equal(agentSlashUsage(AGENT_SLASH_COMMANDS.find((c) => c.id === "find")!), "/find <argument>");
  assert.equal(agentSlashUsage(AGENT_SLASH_COMMANDS.find((c) => c.id === "memory")!), "/memory <argument>");
});

test("help prompt: lists every command with syntax and purpose", () => {
  const prompt = buildAgentSlashHelpPrompt();
  for (const command of AGENT_SLASH_COMMANDS) {
    assert.ok(prompt.includes(agentSlashUsage(command)), `help prompt should mention ${command.name}`);
    assert.ok(prompt.includes(command.summary), `help prompt should summarize ${command.name}`);
  }
});

test("read-only commands carry a read-only constraint", () => {
  for (const id of ["briefing", "unread", "find", "todo", "summary"] as const) {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.id === id)!;
    assert.match(command.constraint ?? "", /read-only/);
  }
  const draft = AGENT_SLASH_COMMANDS.find((c) => c.id === "draft")!;
  assert.ok(draft.constraint && !/read-only/.test(draft.constraint));
});
