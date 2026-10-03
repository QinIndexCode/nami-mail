import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown, sanitizeAgentMarkdownUrl, splitStreamingMarkdown, streamingMarkdownContent } from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  it("renders the GFM structures used in agent answers", () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdown content={`# Summary

- [x] Reconciled
- [ ] Follow up

~~Old~~ and **new**.

| Account | Status |
| --- | --- |
| Inbox | Ready |

\`inline\`

\`\`\`ts
const state = "ready";
\`\`\`

[Documentation](https://example.test/docs)`} />,
    );

    expect(markup).toContain("<h1>Summary</h1>");
    expect(markup).toContain('class="contains-task-list"');
    expect(markup).toContain('type="checkbox" disabled="" checked=""');
    expect(markup).toContain("<del>Old</del>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<code>inline</code>");
    expect(markup).toContain('class="language-ts"');
    expect(markup).toContain('href="https://example.test/docs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
  });

  it("keeps raw HTML escaped and prevents unsafe destinations from becoming links", () => {
    const markup = renderToStaticMarkup(
      <AgentMarkdown content={`<script>alert("xss")</script>

[Unsafe](javascript:alert(1))

![Remote preview](https://cdn.example.test/preview.png)`} />,
    );

    expect(markup).toContain("&lt;script&gt;alert");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('href="https://cdn.example.test/preview.png"');
    expect(markup).toContain(">Remote preview</a>");
  });

  it("allows only explicit external link and image protocols", () => {
    expect(sanitizeAgentMarkdownUrl("https://example.test/path", "href")).toBe("https://example.test/path");
    expect(sanitizeAgentMarkdownUrl("mailto:team@example.test", "href")).toBe("mailto:team@example.test");
    expect(sanitizeAgentMarkdownUrl("https://example.test/preview.png", "src")).toBe("https://example.test/preview.png");
    expect(sanitizeAgentMarkdownUrl("javascript:alert(1)", "href")).toBeUndefined();
    expect(sanitizeAgentMarkdownUrl("data:text/html,unsafe", "src")).toBeUndefined();
    expect(sanitizeAgentMarkdownUrl("/local-route", "href")).toBeUndefined();
  });
});

describe("AgentMarkdown streaming", () => {
  it("renders a fully-streamed table once streaming completes", () => {
    // A finished table (the state after streaming ends) must render as <table>.
    const full = "# Title\n\n| Account | Status |\n| --- | --- |\n| Inbox | Ready |\n";
    const markup = renderToStaticMarkup(<AgentMarkdown content={full} />);
    expect(markup).toContain("<table>");
    expect(markup).toContain("<h1>Title</h1>");
  });

  it("renders completed markdown live while an unfinished code fence stays visible as text", () => {
    // Simulates the production chain: AgentMessageContent feeds the
    // streaming-safe truncated content into AgentMarkdown. A finished bold
    // line, a closed js fence, then an open python fence with typed lines.
    const content = "**Done** and _live_.\n```js\nconst x = 1;\n```\nmid text\n```py\nprint(1)\n";
    const markup = renderToStaticMarkup(<AgentMarkdown content={streamingMarkdownContent(content)} />);
    expect(markup).toContain("<strong>Done</strong>");
    expect(markup).toContain("<em>live</em>");
    expect(markup).toContain("language-js");
    expect(markup).toContain("mid text");
    // The unfinished python block is visible as plain text, not swallowed.
    expect(markup).toContain("print(1)");
    expect(markup).not.toContain("language-py");
  });
});

describe("streamingMarkdownContent", () => {
  it("passes through content without code fences untouched", () => {
    expect(streamingMarkdownContent("**bold** and `inline`")).toBe("**bold** and `inline`");
  });

  it("passes through closed fences untouched", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    expect(streamingMarkdownContent(input)).toBe(input);
  });

  it("truncates at the last closed fence and neutralises an open fence tail", () => {
    const input = "before\n```js\nconst x = 1;\n```\nmid\n```py\nprint(1)\n";
    const result = streamingMarkdownContent(input);
    // Everything up to the closed fence is preserved verbatim.
    expect(result).toContain("const x = 1;");
    expect(result).toContain("mid");
    // The unfinished python tail is visible but its fence is neutralised so it
    // cannot open a new block that swallows later content.
    expect(result).toContain("print(1)");
    expect(result).not.toContain("```py");
  });

  it("keeps an open fence at the very start visible as text", () => {
    const input = "```\nconst x = 1;\n";
    const result = streamingMarkdownContent(input);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```\nconst");
  });

  it("leaves inline code fences alone (not block fences)", () => {
    const input = "text `code` more";
    expect(streamingMarkdownContent(input)).toBe(input);
  });
});

/** A fence is "open" when the block-fence markers in the text do not pair up.
 *  `streamingMarkdownContent` implements the same rule for backticks and is
 *  asserted alongside, so a prefix the splitter settles is provably safe to
 *  render as finished markdown. */
const hasOpenFence = (text: string): boolean => {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^[ \t]*((?:`{3,})|(?:~{3,}))/.exec(line)?.[1];
    if (!marker) continue;
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open !== null;
};

/** A footnote definition start line: one that a frozen layer would silently
 *  delete, because remark-gfm drops a definition with no reference to attach. */
const FOOTNOTE_START = /^\[\^[^\]\s]+\]:/m;

describe("splitStreamingMarkdown", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["a single block with no blank line", "just one paragraph still being typed"],
    ["a completed paragraph", "first block.\n\nsecond block still being typed"],
    ["a fence that spans blank lines", "intro.\n\n```py\n\nprint(1)\n\n```\n\nafter the fence\n"],
    ["a fence that is never closed", "intro.\n\n```py\nprint(1)\n"],
    ["nothing but fences", "```js\nconst x = 1;\n"],
    ["a closed fence, still typing the next block", "intro.\n\n```js\nconst x = 1;\n```\nand then"],
    ["a loose list whose item continues after a blank line", "- first item\n\n  continued paragraph\n\n- second item\n"],
    ["a tight list", "- first item\n- second item\n\nafter the list\n"],
    ["a table still receiving a row", "| Account | Status |\n| --- | --- |\n| Inbox | Read"],
    ["a footnote definition that keeps absorbing paragraphs", "intro.\n\n[^1]: the note\n\nstill the note\n\nafter the note\n"],
    ["text that only looks like a fence", "use ``` for code\n\nand keep going\n"],
  ];

  it("splits every shape into layers that reassemble the reply, with no unfinished structure frozen", () => {
    for (const [label, content] of cases) {
      const { settled, committed, live } = splitStreamingMarkdown(content);
      expect(settled + committed + live, label).toBe(content);
      // The whole point: no frozen layer contains an open fence.
      expect(hasOpenFence(settled), `${label}: open fence in settled`).toBe(false);
      expect(hasOpenFence(committed), `${label}: open fence in committed`).toBe(false);
      expect(streamingMarkdownContent(settled), `${label}: backtick fence in settled`).toBe(settled);
      expect(streamingMarkdownContent(committed), `${label}: backtick fence in committed`).toBe(committed);
      expect(settled === "" || settled.endsWith("\n\n"), `${label}: not a block boundary`).toBe(true);
      // `committed` is a line prefix: it can only ever end on a newline.
      expect(committed === "" || committed.endsWith("\n"), `${label}: committed does not end on a line`).toBe(true);
      // Nothing newly frozen may hold a footnote definition: remark-gfm drops a
      // definition that has no reference in the document it parses, so freezing
      // one would delete its text. (`settled` has its own deferral rule for that,
      // and only reaches a definition once a block has closed after it.)
      expect(FOOTNOTE_START.test(committed), `${label}: footnote definition in committed`).toBe(false);
    }
  });

  it("settles a completed paragraph and leaves the in-flight block in the tail", () => {
    expect(splitStreamingMarkdown("first block.\n\nsecond bl")).toEqual({
      settled: "first block.\n\n",
      committed: "",
      live: "second bl",
    });
  });

  it("settles nothing until a blank line closes a block", () => {
    expect(splitStreamingMarkdown("still typing one line")).toEqual({
      settled: "",
      committed: "",
      live: "still typing one line",
    });
    // Two finished lines, no blank line: nothing settles, but both lines are
    // safe markdown and the reply reads formatted the whole way through.
    expect(splitStreamingMarkdown("line one\nline two\n")).toEqual({
      settled: "",
      committed: "line one\nline two\n",
      live: "",
    });
  });

  it("keeps a fence's blank lines inside the tail", () => {
    // The blank line inside the fence is code, not a block boundary: settling
    // there would drop an unterminated ``` into the parsed prefix.
    expect(splitStreamingMarkdown("intro.\n\n```py\n\nprint(1)\n\n")).toEqual({
      settled: "intro.\n\n",
      committed: "",
      live: "```py\n\nprint(1)\n\n",
    });
  });

  it("settles a fence once it closes and its block ends", () => {
    expect(splitStreamingMarkdown("intro.\n\n```js\nconst x = 1;\n```\n\nand then")).toEqual({
      settled: "intro.\n\n```js\nconst x = 1;\n```\n\n",
      committed: "",
      live: "and then",
    });
  });

  it("defers the boundary right after a footnote definition, which would flash a footnotes section", () => {
    // remark-gfm ends a footnote definition at the first blank line, but the
    // *rendered* result relocates the footnotes section to the very end of the
    // answer: settling it one block early would show the section above text
    // that is about to arrive above it. One block of deferral avoids that.
    const { settled, committed, live } = splitStreamingMarkdown("intro.\n\n[^1]: the note\n\nmore of the note\n");
    expect(settled).toBe("intro.\n\n");
    expect(committed).toBe("");
    expect(live).toBe("[^1]: the note\n\nmore of the note\n");
  });

  it("resumes settling at the block after the deferred footnote", () => {
    const { settled } = splitStreamingMarkdown("intro.\n\n[^1]: note\n\nmore\n\nafter the note\n\nlast\n");
    expect(settled).toBe("intro.\n\n[^1]: note\n\nmore\n\nafter the note\n\n");
  });

  it("does not let a shorter fence marker close a longer one", () => {
    const { settled } = splitStreamingMarkdown("intro.\n\n~~~~\n```\nstill code\n~~~~\n\nafter\n");
    expect(settled).toBe("intro.\n\n~~~~\n```\nstill code\n~~~~\n\n");
  });
});

describe("splitStreamingMarkdown — the committed line prefix", () => {
  it("renders a finished line as markdown while the next line is still typing", () => {
    // The point of the third layer: a line the model has already typed out in
    // full can be parsed, so its inline formatting is not held back until the
    // paragraph closes.
    const { settled, committed, live } = splitStreamingMarkdown(
      "intro.\n\n**bold** and `code`\n[docs](https://example.test/x)\nand this line is still typ",
    );
    expect(settled).toBe("intro.\n\n");
    expect(committed).toBe("**bold** and `code`\n[docs](https://example.test/x)\n");
    expect(live).toBe("and this line is still typ");
  });

  it("keeps the whole block as text until one of its lines has finished", () => {
    // Half-open syntax must not be parsed: `**bo` would render as literal
    // asterisks in one frame and as <em>bo</em> in the next.
    expect(splitStreamingMarkdown("intro.\n\n**bo")).toEqual({
      settled: "intro.\n\n",
      committed: "",
      live: "**bo",
    });
  });

  it("never freezes across the line that opens an unfinished code fence", () => {
    // A cut through a fence would leave a <pre> and a plain-text tail
    // disagreeing about line breaks and typeface, so the fence line and
    // everything after it stay text until the fence closes and settles.
    expect(splitStreamingMarkdown("intro.\n\ntext line\n```py\nprint(1)\n")).toEqual({
      settled: "intro.\n\n",
      committed: "text line\n",
      live: "```py\nprint(1)\n",
    });
  });

  it("keeps a block that is nothing but an unfinished fence as text", () => {
    expect(splitStreamingMarkdown("```js\nconst x = 1;\n")).toEqual({
      settled: "",
      committed: "",
      live: "```js\nconst x = 1;\n",
    });
  });

  it("never freezes a footnote definition, nor anything after it", () => {
    // A frozen definition renders to nothing at all, because the committed
    // prefix holds no `[^1]` reference for remark-gfm to attach it to.
    expect(splitStreamingMarkdown("intro.\n\nbody line\n[^1]: the note\n")).toEqual({
      settled: "intro.\n\n",
      committed: "body line\n",
      live: "[^1]: the note\n",
    });
    expect(splitStreamingMarkdown("intro.\n\nbody line\n[^1]: the note\n\nmore\n")).toEqual({
      settled: "intro.\n\n",
      committed: "body line\n",
      live: "[^1]: the note\n\nmore\n",
    });
  });

  it("never freezes a line that ends inside an unterminated link", () => {
    expect(splitStreamingMarkdown("intro.\n\nsee the [report](https://exa\n")).toEqual({
      settled: "intro.\n\n",
      committed: "",
      live: "see the [report](https://exa\n",
    });
    expect(splitStreamingMarkdown("intro.\n\nsee the [report](https://exa")).toEqual({
      settled: "intro.\n\n",
      committed: "",
      live: "see the [report](https://exa",
    });
  });

  it("never freezes a line that ends on a half-typed bare URL", () => {
    // `https://exa` is already a GFM autolink literal, so freezing it would
    // bake a link that the next frame turns into a different domain.
    expect(splitStreamingMarkdown("intro.\n\nthe source is https://exa\n")).toEqual({
      settled: "intro.\n\n",
      committed: "",
      live: "the source is https://exa\n",
    });
    // A domain that is finished is not held back: the line is already final.
    expect(splitStreamingMarkdown("intro.\n\nthe source is https://exa.test\nmore\n").committed).toBe(
      "the source is https://exa.test\nmore\n",
    );
  });

  it("only moves forward, so frozen text is never handed back as plain text", () => {
    // The memo hits only because the frozen prefix is append-only: a cut that
    // retreated would re-parse and visibly un-format text that was already
    // showing as markdown. The prefix is `settled + committed` because settling a
    // block restarts the committed cut inside the new tail.
    const reply = [
      "intro line\n\n",
      "**bold** and `code`\n",
      "[docs](https://example.test/x)\n",
      "- [x] done\n- [ ] open\n\n",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      "\ntail line one\ntail line two\n",
      "last line typ",
    ].join("");
    let previousFrozen = "";
    let previousSettled = "";
    for (let end = 1; end <= reply.length; end += 1) {
      const frame = reply.slice(0, end);
      const { settled, committed } = splitStreamingMarkdown(frame);
      expect(settled, `settled retreated at "${frame}"`).toContain(previousSettled);
      expect(`${settled}${committed}`, `frozen text retreated at "${frame}"`).toContain(previousFrozen);
      previousFrozen = `${settled}${committed}`;
      previousSettled = settled;
    }
  });
});

/** What a markdown layer puts on screen: tags dropped, whitespace collapsed. */
const visible = (content: string): string =>
  renderToStaticMarkup(<AgentMarkdown content={content} />)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("streaming render equals the finished render", () => {
  // The split must not change what a reply looks like once it is complete: a
  // reveal that ends on a block boundary settles in full, so the streaming DOM
  // and the terminal DOM are the same markup.
  const finished = [
    "# Summary\n\n- [x] Reconciled\n- [ ] Follow up\n\n~~Old~~ and **new**.\n\n| Account | Status |\n| --- | --- |\n| Inbox | Ready |\n\n`inline`\n\n```ts\nconst state = \"ready\";\n```\n\n[Documentation](https://example.test/docs)\n\n",
    "Loose list:\n\n- first item\n\n  continued paragraph\n\n- second item\n\n",
    "```ts\nconst state = \"ready\";\n```\n\ndone.\n\n",
  ];

  it("renders the same markup as AgentMarkdown does for the whole reply", () => {
    for (const content of finished) {
      const { settled, committed, live } = splitStreamingMarkdown(content);
      expect(committed, "expected the whole reply to settle").toBe("");
      expect(live, "expected the whole reply to settle").toBe("");
      expect(renderToStaticMarkup(<AgentMarkdown content={settled} />)).toBe(
        renderToStaticMarkup(<AgentMarkdown content={content} />),
      );
    }
  });

  it("reads the same when each frozen layer is parsed as its own document", () => {
    // `committed` is parsed as a document of its own, and `settled` as another,
    // so freezing a line must not change what any of the frozen text reads as.
    const reply = [
      "intro line\n\n",
      "**bold** and `code`\n",
      "- [x] done\n- [ ] open\n\n",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      "\ntail line one\ntail line two\n",
      "last line typ",
    ].join("");
    for (let end = 1; end <= reply.length; end += 1) {
      const frame = reply.slice(0, end);
      const { settled, committed, live } = splitStreamingMarkdown(frame);
      const frozen = `${settled}${committed}`;
      // The live layer is the untouched remainder, never a re-typed copy.
      expect(live, `frame ${end}`).toBe(frame.slice(frozen.length));
      // Parsing the two frozen layers apart yields the same text as parsing them
      // together — a footnote definition, which would parse to nothing on its
      // own, is exactly what that catches.
      const apart = [visible(settled), visible(committed)].filter(Boolean).join(" ");
      expect(apart, `frame ${end}`).toBe(visible(frozen));
    }
  });
});
