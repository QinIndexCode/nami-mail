// @vitest-environment jsdom
/**
 * What a streamed frame costs the markdown parser, and what it puts on screen.
 *
 * The streaming branch used to hand the WHOLE in-flight reply to AgentMarkdown
 * on every frame, so a reply that revealed ~5 characters per frame paid a full
 * remark+rehype parse of everything revealed so far — N/5 parses of N/5 average
 * length, i.e. quadratic. It now cuts the reply in three: the settled prefix of
 * closed blocks, the committed prefix of the block being typed whose lines are
 * already safe to parse, and the unterminated last line as plain text. The two
 * parsed layers are memoised on strings that only move when a block or a line
 * completes, so inline formatting shows up as it is typed at no per-frame cost.
 *
 * The probe is react-markdown's default export: it counts how often the parser
 * is entered, which is exactly the work being eliminated. The control renders
 * the same frames the old way, so both numbers come from one measurement.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Original = actual.default as (props: Record<string, unknown>) => unknown;
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      parses.count += 1;
      return createElement(Original as never, props as never);
    },
  };
});

import { AgentMarkdown, splitStreamingMarkdown, streamingMarkdownContent } from "../AgentMarkdown";
import { AgentMessageContent } from "./AgentSmallComponents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** One frame of a reply: a finished block, then the block being typed. */
const frames = [
  "first block is done.\n\nand here comes th",
  "first block is done.\n\nand here comes the second",
  "first block is done.\n\nand here comes the second block.\n\nthi",
  "first block is done.\n\nand here comes the second block.\n\nthird blo",
  "first block is done.\n\nand here comes the second block.\n\nthird block of the answer\n",
];

const render = (content: string, streaming: boolean) =>
  act(() => {
    root.render(createElement(AgentMessageContent, { content, streaming }));
  });

/** The unterminated line, verbatim — the layer that must never be parsed. */
const liveText = (): string => container.querySelector(".agent-message-content-streaming")?.textContent ?? "";

/** Everything the two parsed layers put on screen, i.e. the whole reply minus
 *  the live line: no markdown syntax characters, no lost words. */
const frozenText = (): string => {
  const clone = container.querySelector(".agent-message-content")?.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".agent-message-content-streaming").forEach((node) => node.remove());
  return clone.textContent ?? "";
};

/** A frame's own layers, as the text a reader should end up seeing: the frozen
 *  markdown without the emphasis markers the parse consumed, then the live
 *  line character for character. */
const expectedVisible = (frame: string): string => {
  const { settled, committed, live } = splitStreamingMarkdown(frame);
  const frozen = `${settled}${committed}`.replaceAll("*", "");
  return `${frozen}${live}`.replace(/\s+/g, "");
};

beforeEach(() => {
  parses.count = 0;
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

describe("AgentMessageContent streaming cost", () => {
  it("parses each frozen prefix once per finished block or line, not once per frame", () => {
    for (const frame of frames) render(frame, true);
    // Settled parses when frame 1 opens the block and frame 3 closes it; the
    // committed prefix parses once more when frame 5 finishes the block's only
    // line. Frames 2 and 4 moved characters inside the live line, which is text.
    expect(parses.count).toBe(3);
  });

  it("is the number of blocks the old whole-reply-per-frame path paid", () => {
    // One act per frame: React coalesces renders inside a single act into one
    // commit, and the frames have to be commits for the comparison to mean
    // anything.
    for (const frame of frames) {
      act(() => {
        root.render(createElement(AgentMarkdown, { content: streamingMarkdownContent(frame) }));
      });
    }
    expect(parses.count).toBe(frames.length);
  });

  it("does not re-parse the frozen layers while one paragraph is still being typed", () => {
    // Frames that only move characters inside the unterminated line must cost
    // nothing: both frozen strings are unchanged, so both memos hit. Without the
    // memo this is the quadratic path the split exists to remove.
    const paragraph = "intro.\n\n";
    for (const typed of ["**bo", "**bol", "**bold", "**bold**", "**bold** and", "**bold** and `co"]) {
      render(paragraph + typed, true);
    }
    expect(parses.count).toBe(1);
    // The line finally ends: now, and only now, the committed prefix is parsed.
    render(`${paragraph}**bold** and \`co\n`, true);
    expect(parses.count).toBe(2);
  });

  it("shows the finished prefix as markdown and the in-flight block as plain text", () => {
    render(frames[0], true);
    // The settled paragraph keeps its parsed DOM.
    expect(container.querySelector(".agent-message-content p")?.textContent).toBe("first block is done.");
    // The in-flight block is present but not yet parsed: raw characters, no
    // element of its own.
    expect(liveText()).toBe("and here comes th");
    expect(container.querySelectorAll(".agent-message-content")).toHaveLength(1);
  });

  it("never drops or reorders text, at any frame", () => {
    // Parsing the frozen prefixes and leaving the live line as text must not
    // lose a character: whitespace and markdown emphasis markers are the only
    // things a parse may consume. The frames carry no markdown, so the check is
    // exact.
    for (const frame of [...frames, `${frames[frames.length - 1]}\n\n\`\`\`ts\nconst x = 1;\n`]) {
      render(frame, true);
      expect(`${frozenText()}${liveText()}`.replace(/\s+/g, "")).toBe(frame.replace(/\s+/g, ""));
    }
  });

  it("promotes the tail into the parsed prefix once its block closes", () => {
    render(frames[0], true);
    expect(container.querySelector(".agent-message-content-streaming")).not.toBeNull();

    render(frames[2], true);
    // "third blo" opened a new block, so the second one is settled and the
    // remaining tail is the third block only.
    expect(container.querySelectorAll(".agent-message-content p")[1]?.textContent).toBe(
      "and here comes the second block.",
    );
    expect(liveText()).toBe("thi");
  });

  it("parses the whole reply once when the turn finishes", () => {
    const complete = `${frames[frames.length - 1]}\n`;
    render(complete, true);
    const streamingParses = parses.count;
    parses.count = 0;
    render(complete, false);
    expect(container.querySelector(".agent-message-content-streaming")).toBeNull();
    expect(container.textContent).toContain("third block of the answer");
    expect(parses.count).toBe(1);
    // The finished turn is a full render, so it costs more than the last
    // streaming frame — but it happens exactly once.
    expect(streamingParses).toBeLessThanOrEqual(3);
  });
});

describe("AgentMessageContent inline formatting while streaming", () => {
  it("renders a finished line's markdown while the next line is still typing", () => {
    // The whole point of the committed layer: bold, inline code and a link on a
    // line the model has already typed out, before the paragraph closes.
    render("intro.\n\n**bold** and `code`\n[docs](https://example.test/x)\nand this line is still typ", true);
    expect(container.querySelector(".agent-message-content strong")?.textContent).toBe("bold");
    expect(container.querySelector(".agent-message-content code")?.textContent).toBe("code");
    expect(container.querySelector(".agent-message-content a")?.getAttribute("href")).toBe(
      "https://example.test/x",
    );
    // The half-typed line stays literal, so a half-open `**` cannot flash.
    expect(liveText()).toBe("and this line is still typ");
    // All three layers are siblings in one container, which is what keeps the
    // `p:last-child` paragraph-gap rule working across the split.
    expect(container.querySelectorAll(".agent-message-content")).toHaveLength(1);
    expect(container.querySelector(".agent-message-content")?.children.length).toBe(3);
  });

  it("keeps a half-open emphasis literal until the line is finished", () => {
    render("intro.\n\n**bo", true);
    expect(container.querySelector(".agent-message-content strong")).toBeNull();
    expect(container.querySelector(".agent-message-content em")).toBeNull();
    expect(liveText()).toBe("**bo");

    render("intro.\n\n**bold**\n", true);
    expect(container.querySelector(".agent-message-content strong")?.textContent).toBe("bold");
    expect(liveText()).toBe("");
  });

  it("commits a bold paragraph once and ends showing the whole line", () => {
    // One realistic reveal: every frame is a prefix of the next, because the
    // model only ever appends.
    const reveal = [
      "intro.\n\n**bo",
      "intro.\n\n**bol",
      "intro.\n\n**bold",
      "intro.\n\n**bold**",
      "intro.\n\n**bold**\n",
      "intro.\n\n**bold** and ne",
      "intro.\n\n**bold** and next",
      "intro.\n\n**bold** and next\n",
      "intro.\n\n**bold** and next\nlast",
    ];
// The settled prefix parses once, on the frame it appears; everything after
    // that is the committed prefix's own work.
    render(reveal[0], true);
    const baseline = parses.count;
    for (const frame of reveal) {
      render(frame, true);
      // Nothing is lost or doubled as the emphasis crosses the cut: the parse
      // consumes the `**` on the frozen side and nothing else.
      expect(container.textContent?.replace(/\s+/g, ""), frame).toBe(expectedVisible(frame));
    }
    // The committed prefix appeared on the frame its line ended and grew once
    // more when the next line ended — two parses for the whole paragraph, not
    // one per frame.
    expect(parses.count - baseline).toBe(2);
  });

  it("costs nothing per frame once a line has been committed", () => {
    // The memo only pays off if the committed string is stable while the live
    // line grows, which is the state a paragraph spends most of its frames in.
    render("intro.\n\n**bold** and code\n", true);
    const afterCommit = parses.count;
    for (const typed of ["next", " line", " keeps", " typing", " away"]) {
      render(`intro.\n\n**bold** and code\n${typed}`, true);
    }
    expect(parses.count).toBe(afterCommit);
    expect(container.querySelector(".agent-message-content strong")?.textContent).toBe("bold");
  });

  it("keeps an unfinished code fence out of the parsed layers entirely", () => {
    // A `<pre>` beside a plain-text tail would disagree about line breaks and
    // typeface, so the fence and everything after it stays text.
    render("intro.\n\n```py\nprint(1)\n", true);
    expect(container.querySelector(".agent-message-content pre")).toBeNull();
    expect(liveText()).toBe("```py\nprint(1)\n");
    render("intro.\n\n```py\nprint(1)\n```\n\ndone", true);
    expect(container.querySelector(".agent-message-content pre code")?.textContent).toBe("print(1)\n");
    expect(liveText()).toBe("done");
  });

  it("never freezes a footnote definition, whose text remark-gfm would drop", () => {
    render("intro.\n\nbody line\n[^1]: the note\n", true);
    expect(container.querySelectorAll(".agent-message-content p")[1]?.textContent).toBe("body line");
    expect(liveText()).toBe("[^1]: the note\n");
    // Still there, character for character, once the answer is finished.
    render("intro.\n\nbody line\n[^1]: the note\n\nafter\n", true);
    expect(container.textContent).toContain("the note");
  });
});
