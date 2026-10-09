// @vitest-environment jsdom
/**
 * The agent transcript's onOpenMessage prop is the one callback that reaches
 * every memoised AgentMessageRow. A parent that hands it a fresh arrow per
 * render defeats that memo, and the cost is not the row: it is a markdown
 * re-parse of every historic message on every mailbox refresh (a tool event
 * calls onMailStateChanged -> requestRefresh -> a new render).
 *
 * Two halves, because the bug has two ends:
 *  - the row: a re-render that keeps every prop identity must not re-render
 *    the row at all (counted here through AgentMessageContent, the markdown
 *    renderer that does the re-parsing);
 *  - the parent: App must hand AgentWorkspace a handler whose identity does not
 *    move. It is asserted against the source because App cannot be mounted
 *    without the whole desktop bridge + API surface, and the invariant that
 *    matters is exactly its shape: a useCallback whose dependency list excludes
 *    openMessage (whose own identity every refresh re-creates) and which reads
 *    it through a ref.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMessageRow, type AgentMessageRowProps } from "./AgentMessageRow";
import type * as AgentSmallComponentsModule from "./AgentSmallComponents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Counts AgentMessageContent renders — one per row re-render, i.e. per
 *  markdown re-parse. The real component is kept so the assertion is about
 *  renders, not about a stub. */
const contentRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./AgentSmallComponents", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSmallComponentsModule>();
  return {
    ...actual,
    // Memoised upstream, so it arrives as an element type rather than a plain
    // function: render it as one and count every render on the way through.
    AgentMessageContent: (props: { content: string; streaming: boolean }) => {
      contentRenders.count += 1;
      return createElement(actual.AgentMessageContent as React.ComponentType<typeof props>, props);
    },
  };
});

const message = (id: string, content: string) => ({
  id,
  role: "user" as const,
  content,
  createdAt: "2026-08-10T00:00:00.000Z",
  state: "complete" as const,
  citations: [],
  toolActivities: [],
  references: [{ id: "mail-1", subject: "Referenced subject" }],
});

const translate = ((key: string) => key) as unknown as AgentMessageRowProps["t"];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  contentRenders.count = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/** A parent that owns the only state the test touches: clicking refresh
 *  re-renders it and everything below it, exactly like an App mailbox refresh
 *  reaching the agent transcript. The rows and every other prop are rebuilt
 *  identically, so only the handler identity can differ between the two cases. */
function Transcript({ onOpenMessage }: { onOpenMessage: AgentMessageRowProps["onOpenMessage"] }) {
  const [, setTick] = useState(0);
  const rows = [message("user-1", "first question"), message("user-2", "second question")];
  return (
    <div>
      {rows.map((row) => (
        <AgentMessageRow
          key={row.id}
          message={row}
          superseded={false}
          locale="en"
          t={translate}
          onOpenAttachment={() => undefined}
          onOpenMessage={onOpenMessage}
          onRevoke={() => undefined}
          onRetry={() => undefined}
          onUserMessageRef={() => undefined}
        />
      ))}
      <button type="button" onClick={() => setTick((value) => value + 1)}>refresh</button>
    </div>
  );
}

const clickRefresh = () => {
  const button = container.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("refresh button not found");
  act(() => {
    button.click();
  });
};

describe("AgentMessageRow memo vs the transcript's onOpenMessage prop", () => {
  it("re-renders nothing when the handler keeps its identity", () => {
    const onOpenMessage = vi.fn();
    act(() => {
      root.render(<Transcript onOpenMessage={onOpenMessage} />);
    });
    expect(contentRenders.count).toBe(2);

    clickRefresh();
    clickRefresh();
    // Two rows, two parent re-renders, zero re-parses.
    expect(contentRenders.count).toBe(2);
  });

  it("re-parses every row when the handler is a fresh arrow per render", () => {
    const wrapper = (tick: number) => (
      <div data-tick={tick}>
        {[message("user-1", "first question"), message("user-2", "second question")].map((row) => (
          <AgentMessageRow
            key={row.id}
            message={row}
            superseded={false}
            locale="en"
            t={translate}
            onOpenAttachment={() => undefined}
            onOpenMessage={(messageId) => {
              void messageId;
            }}
            onRevoke={() => undefined}
            onRetry={() => undefined}
            onUserMessageRef={() => undefined}
          />
        ))}
      </div>
    );
    act(() => {
      root.render(wrapper(0));
    });
    expect(contentRenders.count).toBe(2);
    act(() => {
      root.render(wrapper(1));
    });
    // The regression this guards: same DOM, same message objects, only the
    // callback identity moved — and every historic message is re-parsed.
    expect(contentRenders.count).toBe(4);
  });
});

describe("App hands the agent transcript a stable open-referenced-message handler", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "App.tsx"), "utf8");

  it("passes the extracted handler, not an inline arrow", () => {
    expect(source).toMatch(/onOpenMessage=\{handleAgentOpenMessage\}/);
    expect(source).toMatch(/const handleAgentOpenMessage = useCallback\(\(messageId: string\) => \{/);
  });

  it("keeps openMessage out of its dependencies by reading it through a ref", () => {
    const block = source.match(/const handleAgentOpenMessage = useCallback\([\s\S]*?\n {2}\}, \[[^\]]*\]\);/);
    expect(block).not.toBeNull();
    const deps = block![0].match(/\}, \[([^\]]*)\]\);/)![1]!;
    // openMessage's own identity is re-created by every mailbox refresh
    // (silentRefresh replaces the accounts array it closes over), so listing it
    // would re-create this handler on every refresh and defeat AgentMessageRow.
    // Locale changes rebuild sample source copy; mailbox refreshes still do not.
    expect(deps.split(",").map((dep) => dep.trim())).toEqual(["closeAgentWorkspace", "locale", "showToast", "t"]);
    expect(source).toMatch(/const openMessageRef = useRef\(openMessage\);\r?\n {2}openMessageRef\.current = openMessage;/);
    expect(block![0]).toContain("openMessageRef.current(");
  });
});
