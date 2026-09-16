// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { I18nProvider, translate, defaultLocale } from "../i18n";
import type { AgentToolActivity } from "../agentTypes";
import AgentToolCard, { AgentToolList } from "./AgentToolCard";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderTree(element: React.ReactElement): string {
  const nextContainer = document.createElement("div");
  document.body.append(nextContainer);
  const nextRoot = createRoot(nextContainer);
  container = nextContainer;
  root = nextRoot;
  act(() => { nextRoot.render(<I18nProvider>{element}</I18nProvider>); });
  return nextContainer.innerHTML;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container?.remove();
  container = null;
});

describe("AgentToolCard search detail", () => {
  it("shows the query while the search is running instead of the generic state text", () => {
    const activity: AgentToolActivity = { id: "t1", toolName: "web.search", title: "Search the web", state: "running", detail: "Trae" };
    const markup = renderTree(<AgentToolCard activity={activity} />);
    expect(markup).toContain("<small>Trae</small>");
    expect(markup).not.toContain(translate(defaultLocale, "agent.tool.running"));
  });

  it("shows the query with the result count once the search completed", () => {
    const activity: AgentToolActivity = { id: "t2", toolName: "web.search", title: "Search the web", state: "completed", detail: "Trae · 3" };
    const markup = renderTree(<AgentToolCard activity={activity} />);
    expect(markup).toContain("<small>Trae · 3</small>");
  });

  it("keeps the generic summary when the activity carries no detail", () => {
    const activity: AgentToolActivity = { id: "t3", toolName: "messages.list", title: "List mail messages", state: "completed", summary: "Operation completed." };
    const markup = renderTree(<AgentToolCard activity={activity} />);
    expect(markup).toContain("<small>Operation completed.</small>");
  });
});

describe("AgentToolList running search chip", () => {
  it("surfaces the running search query on the collapsed summary row", () => {
    const activities: AgentToolActivity[] = [
      { id: "t1", toolName: "rag.search", title: "Search local mail", state: "completed", summary: "done" },
      { id: "t2", toolName: "web.search", title: "Search the web", state: "running", detail: "Trae" },
    ];
    const markup = renderTree(<AgentToolList activities={activities} />);
    expect(markup).toContain("agent-tool-summary-searching");
    expect(markup).toContain("Trae");
    expect(markup).not.toContain(translate(defaultLocale, "agent.tool.runningCount", { count: 1 }));
  });

  it("falls back to the running count when nothing is searching", () => {
    const activities: AgentToolActivity[] = [
      { id: "t1", toolName: "messages.list", title: "List mail messages", state: "running" },
    ];
    const markup = renderTree(<AgentToolList activities={activities} />);
    expect(markup).not.toContain("agent-tool-summary-searching");
    expect(markup).toContain(translate(defaultLocale, "agent.tool.runningCount", { count: 1 }));
  });
});
