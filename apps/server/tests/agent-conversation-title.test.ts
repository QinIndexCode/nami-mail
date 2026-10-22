import { describe, expect, it } from "vitest";
import {
  createConversationTitleProbe,
  deriveConversationTitle,
  feedConversationTitleProbe,
  finishConversationTitleProbe,
  maximumConversationTitleLength,
  maximumGeneratedTitleLength,
} from "../src/agent/conversation-title.js";

/**
 * The title protocol has two halves that must agree: the deterministic fallback
 * that is always available, and the marker probe that lifts a title out of the
 * model's own answer. These cases pin the edges where the probe could either
 * leak `TITLE:` into the reply or swallow a legitimate first line.
 */

describe("deriveConversationTitle", () => {
  it("prefers a command's arguments over everything else", () => {
    expect(deriveConversationTitle({
      content: "/draft please write the quarterly report",
      command: { name: "/draft", args: "quarterly report" },
      references: [{ subject: "An old unrelated message" }],
    })).toBe("/draft quarterly report");
  });

  it("uses the referenced mail subjects when there is no command", () => {
    expect(deriveConversationTitle({
      content: "Summarize these",
      references: [{ subject: "Q3 report" }, { subject: " Budget  " }, { subject: "Q3 report" }],
    })).toBe("Q3 report · Budget");
  });

  it("falls back from an argument-less command to its own name", () => {
    expect(deriveConversationTitle({
      content: "/summary",
      command: { name: "/summary", args: "" },
    })).toBe("/summary");
  });

  it("uses the first message text as the last resort", () => {
    expect(deriveConversationTitle({ content: "  Review   the quarterly report  " })).toBe("Review the quarterly report");
  });

  it("leaves a greeting-only message untitled", () => {
    for (const content of ["下午好！", "你好呀", "hello", "Hi there!", "谢谢", "好的", "👍", "..."]) {
      expect(deriveConversationTitle({ content }), content).toBe("");
    }
  });

  it("keeps a message that greets and then names a task", () => {
    expect(deriveConversationTitle({ content: "你好，帮我总结今天的未读邮件" }))
      .toBe("你好，帮我总结今天的未读邮件");
    expect(deriveConversationTitle({ content: "Hi, summarize this thread" }))
      .toBe("Hi, summarize this thread");
  });

  it("truncates to the stored-title limit with an ellipsis", () => {
    const title = deriveConversationTitle({ content: "x".repeat(maximumConversationTitleLength + 20) });
    expect(title).toHaveLength(maximumConversationTitleLength);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("conversation title probe", () => {
  it("releases ordinary text immediately instead of waiting for a newline", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "The review")).toEqual({ text: "The review" });
    // Once the prefix is disproved the rest of the answer is passthrough.
    expect(feedConversationTitleProbe(probe, " is Friday.")).toEqual({ text: " is Friday." });
    expect(finishConversationTitleProbe(probe)).toEqual({ text: "" });
  });

  it("holds only text that can still become a marker", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TIT")).toEqual({ text: "" });
    expect(feedConversationTitleProbe(probe, "LE: Q3 report\n\nBody")).toEqual({
      text: "Body",
      title: "Q3 report",
    });
  });

  it("accepts a bold marker and strips the quotes around the title", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, '**TITLE:** "Q3 report review"\nBody')).toEqual({
      text: "Body",
      title: "Q3 report review",
    });
  });

  it("consumes an over-long marker without accepting it", () => {
    const probe = createConversationTitleProbe();
    const tooLong = "x".repeat(maximumGeneratedTitleLength + 1);
    expect(feedConversationTitleProbe(probe, `TITLE: ${tooLong}\nBody`)).toEqual({ text: "Body" });
  });

  it("consumes an empty marker so the protocol never leaks", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE:\nBody")).toEqual({ text: "Body" });
  });

  it("consumes the explicit no-title marker without inventing a title", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE: NONE\n你好！有什么可以帮你？")).toEqual({
      text: "你好！有什么可以帮你？",
    });
  });

  it("rejects a generated title that only repeats the greeting", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE: 下午好\n你好！有什么可以帮你？")).toEqual({
      text: "你好！有什么可以帮你？",
    });
  });

  it("recognizes an unterminated no-title marker as protocol", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE: none")).toEqual({ text: "" });
    expect(finishConversationTitleProbe(probe)).toEqual({ text: "" });
  });

  it("leaves a non-marker first line untouched", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE not really\nBody")).toEqual({
      text: "TITLE not really\nBody",
    });
  });

  it("only inspects the first line of a round", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "Intro\nTITLE: not a title here")).toEqual({
      text: "Intro\nTITLE: not a title here",
    });
  });

  it("recognizes a valid marker that ends the round without a newline", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE: Final title")).toEqual({ text: "" });
    expect(finishConversationTitleProbe(probe)).toEqual({ text: "", title: "Final title" });
  });

  it("preserves every character when an unterminated line is not a valid marker", () => {
    const probe = createConversationTitleProbe();
    expect(feedConversationTitleProbe(probe, "TITLE: ")).toEqual({ text: "" });
    expect(finishConversationTitleProbe(probe)).toEqual({ text: "TITLE: " });
  });

  it("stops buffering a first line that is too long to be a title", () => {
    const probe = createConversationTitleProbe();
    const line = "T".repeat(201);
    expect(feedConversationTitleProbe(probe, line)).toEqual({ text: line });
    expect(finishConversationTitleProbe(probe)).toEqual({ text: "" });
  });
});
