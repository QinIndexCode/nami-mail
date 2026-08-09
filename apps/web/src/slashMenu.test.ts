import { describe, expect, it } from "vitest";
import { AGENT_SLASH_COMMANDS } from "@nami/agent-contracts";
import zhCN from "./locales/zh-CN.json";
import {
  buildSlashMenu,
  slashCompletionText,
  slashKeepsMenuOpen,
  slashMenuActiveIndex,
} from "./slashMenu";

const byId = new Map(AGENT_SLASH_COMMANDS.map((command) => [command.id, command]));
const memory = byId.get("memory")!;
const find = byId.get("find")!;
const unread = byId.get("unread")!;
const sub = { name: "update", descriptionKey: "agent.commands.memory.sub.update", usageKey: "agent.commands.memory.sub.update.usage" };

describe("buildSlashMenu", () => {
  it("opens with a bare slash and lists every command without sub-operations", () => {
    const menu = buildSlashMenu("/");
    expect(menu?.map((item) => item.kind === "command" ? `/${item.command.name}` : "")).toEqual(
      AGENT_SLASH_COMMANDS.map((command) => `/${command.name}`),
    );
    expect(menu?.every((item) => item.kind === "command")).toBe(true);
  });

  it("ignores trailing whitespace and stays closed for plain text", () => {
    expect(buildSlashMenu("/ ")).toEqual(buildSlashMenu("/"));
    expect(buildSlashMenu("hello")).toBeNull();
    expect(buildSlashMenu("")).toBeNull();
    expect(buildSlashMenu("/Users/me/path")).toBeNull();
    expect(buildSlashMenu("/unknown")).toEqual([]);
    // An argument with a space is not a bare trigger anymore.
    expect(buildSlashMenu("/memory save this")).toBeNull();
  });

  it("expands sub-operations under a typed command prefix", () => {
    const names = (menu: ReturnType<typeof buildSlashMenu>) => menu?.map((item) => item.kind === "command" ? `/${item.command.name}` : `/${item.command.name} ${item.sub.name}`);
    expect(names(buildSlashMenu("/memory"))).toEqual([
      "/memory",
      "/memory save",
      "/memory list",
      "/memory update",
      "/memory delete",
    ]);
    // A prefix of the trigger shows the same expansion.
    expect(buildSlashMenu("/mem")).toEqual(buildSlashMenu("/memory"));
    // Commands without sub-operations show a single item.
    expect(names(buildSlashMenu("/find"))).toEqual(["/find"]);
  });

  it("is suppressed while streaming or dismissed", () => {
    expect(buildSlashMenu("/memory", { streaming: true })).toBeNull();
    expect(buildSlashMenu("/memory", { dismissed: true })).toBeNull();
  });
});

describe("slashCompletionText / slashKeepsMenuOpen", () => {
  it("completes parameterized parents with a trailing space and parameterless ones bare", () => {
    expect(slashCompletionText(find)).toBe("/find ");
    expect(slashCompletionText(unread)).toBe("/unread");
    expect(slashCompletionText(memory, sub)).toBe("/memory update ");
  });

  it("keeps the menu open only for commands with sub-operations", () => {
    expect(slashKeepsMenuOpen(memory)).toBe(true);
    expect(slashKeepsMenuOpen(find)).toBe(false);
    expect(slashKeepsMenuOpen(memory, sub)).toBe(true);
  });
});

describe("slashMenuActiveIndex", () => {
  it("clamps to the visible items and resets when the menu is closed", () => {
    const menu = buildSlashMenu("/memory");
    expect(slashMenuActiveIndex(menu, 99)).toBe(menu!.length - 1);
    expect(slashMenuActiveIndex(menu, -3)).toBe(0);
    expect(slashMenuActiveIndex(null, 2)).toBe(0);
  });
});

describe("slash menu locale coverage", () => {
  it("resolves every registry description and usage key in the baseline pack", () => {
    const missing: string[] = [];
    for (const command of AGENT_SLASH_COMMANDS) {
      const keys = [
        command.descriptionKey,
        command.usageKey,
        ...(command.subcommands ?? []).flatMap((item) => [item.descriptionKey, item.usageKey]),
      ];
      for (const key of keys) {
        if (key && !(key in zhCN.messages)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});
