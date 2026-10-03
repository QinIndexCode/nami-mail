import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const linkProtocols = new Set(["http:", "https:", "mailto:"]);
const imageProtocols = new Set(["http:", "https:"]);

/**
 * Keep model-provided destinations within an explicit protocol allowlist.
 * Relative URLs are intentionally rejected so an answer cannot navigate the
 * local application to an unexpected route.
 */
export function sanitizeAgentMarkdownUrl(value: string, key: string): string | undefined {
  const transformed = defaultUrlTransform(value.trim());
  if (!transformed) return undefined;

  try {
    const url = new URL(transformed);
    const allowedProtocols = key === "href" ? linkProtocols : key === "src" ? imageProtocols : undefined;
    if (!allowedProtocols?.has(url.protocol.toLowerCase()) || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export const transformAgentMarkdownUrl: UrlTransform = (value, key) => sanitizeAgentMarkdownUrl(value, key);

const markdownComponents: Components = {
  a: ({ node: _node, href, children, className, ...props }) => {
    if (!href) return <span className="agent-markdown-blocked-link">{children}</span>;
    const opensExternal = href.startsWith("http:") || href.startsWith("https:");
    return (
      <a
        {...props}
        className={["agent-markdown-link", className].filter(Boolean).join(" ")}
        href={href}
        target={opensExternal ? "_blank" : undefined}
        rel={opensExternal ? "noreferrer noopener" : undefined}
      >
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, alt, title }) => {
    if (!src) return <span className="agent-markdown-image-blocked">{alt}</span>;
    return (
      <a
        className="agent-markdown-image-link"
        href={src}
        target="_blank"
        rel="noreferrer noopener"
        title={title || alt || undefined}
      >
        {alt || src}
      </a>
    );
  },
};

/**
 * Streaming-safe markdown: while tokens are still arriving, a code fence that
 * has not been closed yet would make react-markdown treat everything after it
 * as code. We render only up to the last *closed* fence, appending whatever
 * follows as plain text (fence neutralised), so an unfinished ``` block never
 * swallows the tail.
 *
 * Superseded on the streaming path by `splitStreamingMarkdown`, which no longer
 * re-parses the finished prefix every frame and therefore no longer needs the
 * unfinished fence neutralised — it lands in a plain-text tail. Kept as the
 * whole-content fence guard, and as the reference encoding of the fence rule
 * that the splitter mirrors.
 */
export function streamingMarkdownContent(content: string): string {
  if (!content.includes("```")) return content;
  // Track the LAST unclosed block fence. Walking the content, a ``` that sits
  // on its own line toggles an open/close pair; anything after a still-open
  // fence is code and must be rendered as plain text (fence neutralised).
  let openFence = -1;
  let index = 0;
  while (index < content.length) {
    const fence = content.indexOf("```", index);
    if (fence === -1) break;
    // Inline code (``` inside a line) does not toggle block state; only a
    // fence at the start of a line (or the very start of the content) does.
    const lineStart = content.lastIndexOf("\n", fence - 1) + 1;
    const isBlockFence = fence === 0 || /^\s*$/.test(content.slice(lineStart, fence));
    if (isBlockFence) {
      if (openFence === -1) {
        openFence = fence;
      } else {
        openFence = -1; // closed the pair; next block fence re-opens
      }
    }
    index = fence + 3;
  }
  // No fence is left open: the markdown is complete, render it verbatim.
  if (openFence === -1) return content;
  // A fence is still open. Everything before it is safe markdown (the plain
  // text between closed blocks stays intact); the unfinished code from the
  // open fence onward is appended as plain text so what the model has typed
  // stays visible. The opening ``` and any nested ``` are neutralised with
  // zero-width spaces so react-markdown cannot open a fresh block that
  // swallows later content.
  const head = content.slice(0, openFence);
  const tail = content.slice(openFence);
  const neutralised = tail.replaceAll("```", "`\u200b`\u200b`");
  if (head.endsWith("\n") || neutralised.startsWith("\n")) return `${head}${neutralised}`;
  return `${head}\n${neutralised}`;
}

/** The finished blocks of an in-flight reply, the finished lines of the block
 *  still being typed, and the unterminated line at its end. */
export type StreamingMarkdownSplit = { settled: string; committed: string; live: string };

/** A run of >=3 backticks/tildes alone at the start of a line: a block fence. */
const blockFenceMarker = (line: string): string | null => /^[ \t]*((?:`{3,})|(?:~{3,}))/.exec(line)?.[1] ?? null;

/** A footnote definition renders as a section pinned to the END of the answer,
 *  so settling it one block early would show that section above text that is
 *  about to arrive above it. */
const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:/;

/**
 * Split a partially revealed reply into three layers: the longest prefix that is
 * safe to render as finished markdown (`settled`), the longest prefix of the
 * block still being typed that can already be frozen as markdown (`committed`),
 * and the unterminated last line of that block (`live`).
 *
 * The boundary is the last blank line, the only place markdown guarantees a
 * block is closed: a paragraph, list or table that ends there cannot change
 * shape when more characters arrive, so the finished prefix can be parsed once
 * and then left alone. Two structures make that promise false, and they keep
 * their following text in the tail:
 *  - an open code fence — its blank lines are code, not block boundaries;
 *  - a footnote definition — the footnotes section is pinned to the end of the
 *    answer, so settling it early would make already-placed text jump above it.
 *
 * Everything else is deliberately permissive: an appended sibling list item is
 * an append into a container that already exists, which is exactly what the
 * split is for. The one visible consequence is that an indented continuation
 * paragraph (`- item`, blank line, two-space-indented text) is still plain text
 * in the tail and joins its list item once the block closes — a reflow at block
 * granularity instead of per frame.
 */
export function splitStreamingMarkdown(content: string): StreamingMarkdownSplit {
  let settledEnd = 0;
  let openFence: string | null = null;
  let blockIsFootnote = false;
  let cursor = 0;
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const line = content.slice(cursor, newline === -1 ? content.length : newline);
    const nextLine = newline === -1 ? content.length : newline + 1;
    const marker = blockFenceMarker(line);
    if (marker) {
      // Only a marker of the same character, at least as long, closes the
      // fence — so a ``` inside a ~~~ block cannot end it early.
      if (openFence === null) openFence = marker;
      else if (marker[0] === openFence[0] && marker.length >= openFence.length) openFence = null;
    } else if (openFence === null) {
      if (line.trim() === "") {
        if (!blockIsFootnote) settledEnd = nextLine;
        blockIsFootnote = false;
      } else if (FOOTNOTE_DEFINITION.test(line)) {
        blockIsFootnote = true;
      }
    }
    cursor = nextLine;
  }
  const tail = content.slice(settledEnd);
  const committedEnd = safeCommitEnd(tail);
  return {
    settled: content.slice(0, settledEnd),
    committed: tail.slice(0, committedEnd),
    live: tail.slice(committedEnd),
  };
}

/** A trailing bare URL whose host carries no dot yet: the domain is still being
 *  typed, so the line is a different string the moment the rest of it arrives. */
const endsWithHalfTypedUrl = (line: string): boolean => {
  const token = line.trimEnd().split(/\s+/).pop() ?? "";
  const scheme = /^(?:https?:\/\/|www\.)/.exec(token)?.[0];
  if (!scheme) return false;
  return !(token.slice(scheme.length).split(/[/?#]/)[0] ?? "").includes(".");
};

/** Whether a completed line still has markdown open past its own end, which a
 *  frozen prefix could never close: `[text](https://exa` and a bare `https://exa`
 *  both render as the literal characters they are until the rest of them lands. */
const lineEndsUnfinished = (line: string): boolean => {
  const openLink = line.lastIndexOf("](");
  if (openLink !== -1 && !line.includes(")", openLink + 2)) return true;
  return endsWithHalfTypedUrl(line);
};

/**
 * How far into the block still being typed the markdown may be frozen: the end
 * of the newest line that later characters cannot change the reading of.
 *
 * A newline only closes a line, not a block, but a line that has been typed out
 * in full almost never changes meaning when the next one arrives — enough to let
 * `**bold**`, inline code and links render while the paragraph is still being
 * written instead of one paragraph later. Because this cut only ever moves
 * forward, the memoised prefix is parsed once per finished line rather than once
 * per frame.
 *
 * Two structures are excluded by offset rather than by inspecting the candidate
 * line, because a line carrying one of them reads as ordinary text on its own:
 *  - an unfinished code fence — a cut through it leaves a `<pre>` and a plain
 *    text tail disagreeing about line breaks and typeface, so the fence and
 *    everything after it stay text until the fence closes and settles;
 *  - a footnote definition — remark-gfm discards a definition that has no
 *    reference in the document it is parsing (verified: `[^1]: a note` on its
 *    own renders to nothing), so freezing one would delete its text outright.
 *    Bounding the cut at the definition's start also keeps the definition's own
 *    line out, because that line ends after it starts.
 *
 * A line that ends inside an unterminated `](` link or a half-typed bare URL is
 * rejected on its own. The scan runs newest-first, so such a line only holds the
 * cut back when nothing after it can be committed either.
 */
function safeCommitEnd(tail: string): number {
  const lineStarts: number[] = [];
  const lineEnds: number[] = [];
  let openFence: string | null = null;
  /** Where the open fence's own line starts; -1 while no fence is open. */
  let fenceStart = -1;
  /** Where the first footnote definition starts; -1 when there is none. */
  let footnoteStart = -1;
  let cursor = 0;
  while (cursor < tail.length) {
    const newline = tail.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? tail.length : newline;
    const line = tail.slice(cursor, lineEnd);
    const marker = blockFenceMarker(line);
    if (marker) {
      if (openFence === null) {
        openFence = marker;
        fenceStart = cursor;
      } else if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = null;
      }
    } else if (openFence === null && footnoteStart === -1 && FOOTNOTE_DEFINITION.test(line)) {
      footnoteStart = cursor;
    }
    // The unterminated last line is never a cut point: nothing has ended.
    if (newline === -1) break;
    lineStarts.push(cursor);
    lineEnds.push(newline + 1);
    cursor = newline + 1;
  }
  const fenceLimit = fenceStart === -1 ? tail.length : fenceStart;
  const footnoteLimit = footnoteStart === -1 ? tail.length : footnoteStart;
  for (let i = lineEnds.length - 1; i >= 0; i -= 1) {
    const end = lineEnds[i];
    if (end > fenceLimit || end > footnoteLimit) continue;
    if (lineEndsUnfinished(tail.slice(lineStarts[i], end - 1))) continue;
    return end;
  }
  return 0;
}

/**
 * The actual parser renderer, memoized so a parent re-render with the same
 * content (e.g. tool activity updates in the same row) does not re-parse.
 */
const AgentMarkdownBody = memo(function AgentMarkdownBodyInner({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={markdownComponents}
      remarkPlugins={[remarkGfm]}
      skipHtml={false}
      urlTransform={transformAgentMarkdownUrl}
    >
      {content}
    </ReactMarkdown>
  );
});

/**
 * Renders LLM output without enabling raw HTML. React Markdown keeps raw HTML
 * as escaped text, while GFM covers tables, task lists, strikethrough, and
 * autolink literals. Remote images remain opt-in links to avoid background
 * requests from model-provided content.
 *
 * The content is parsed directly on every render. Streaming is kept cheap by
 * the row-level memo in AgentWorkspace (only the in-flight message re-renders).
 * Unlike a deferred value — whose low-priority re-render can be starved so a
 * completed table never appears until the conversation is reopened — the
 * finished turn renders the full content immediately.
 */
export function AgentMarkdown({ content }: { content: string }) {
  return (
    <div className="agent-message-content">
      <AgentMarkdownBody content={content} />
    </div>
  );
}

/**
 * The settled prefix of a streaming reply, without the `.agent-message-content`
 * wrapper: the streaming branch owns that wrapper so the in-flight tail sits
 * beside the finished blocks inside it. Same memo, but keyed on a string that
 * only moves when a block completes.
 */
export function AgentMarkdownSettled({ content }: { content: string }) {
  return <AgentMarkdownBody content={content} />;
}
