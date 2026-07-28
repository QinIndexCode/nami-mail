import { describe, expect, it } from "vitest";
import { cleanMailContent, htmlToMailText } from "../src/agent/cleaning.js";
import { chunkMailContent, estimateMailTokens } from "../src/agent/chunking.js";

describe("Agent mail cleaning", () => {
  it("removes executable, hidden, tracking, quoted, and disclaimer content while preserving semantic text", () => {
    const cleaned = cleanMailContent({
      subject: "  Project update  ",
      htmlBody: `
        <p>Hello <strong>team</strong>,</p>
        <ul><li>Ship the report</li><li>Book the review</li></ul>
        <table><tr><th>Owner</th><th>Due</th></tr><tr><td>Ada</td><td>Friday</td></tr></table>
        <img src="https://tracker.example/pixel.gif?utm_source=mail" width="1" height="1">
        <script>window.location = 'https://bad.example'</script>
        <div style="display: none">Do not expose me</div>
        <p>See https://example.test/path?utm_source=newsletter&keep=yes</p>
        <p>On Tue, Ada wrote:</p><blockquote>Older confidential thread</blockquote>
        <p>This email and any attachments are confidential.</p>
      `,
    });

    expect(cleaned.normalizedSubject).toBe("Project update");
    expect(cleaned.text).toContain("Hello team");
    expect(cleaned.text).toContain("- Ship the report");
    expect(cleaned.text).toContain("Owner | Due");
    expect(cleaned.text).toContain("https://example.test/path?keep=yes");
    expect(cleaned.text).not.toContain("window.location");
    expect(cleaned.text).not.toContain("Do not expose me");
    expect(cleaned.text).not.toContain("Older confidential thread");
    expect(cleaned.text).not.toContain("confidential");
    expect(cleaned.removedQuotedContent).toBe(true);
    expect(cleaned.removedSignatureOrDisclaimer).toBe(false);
  });

  it("prefers an actual plain-text body and maintains a deterministic clean content hash", () => {
    const input = {
      textBody: "Plain body\n\n-- \nSignature",
      htmlBody: "<p>HTML fallback</p>",
    };
    const first = cleanMailContent(input);
    const second = cleanMailContent(input);
    expect(first.source).toBe("text");
    expect(first.text).toBe("Plain body");
    expect(first.removedSignatureOrDisclaimer).toBe(true);
    expect(first.contentHash).toBe(second.contentHash);
    expect(htmlToMailText("<p>A&nbsp;B</p><script>alert(1)</script>")).toContain("A B");
  });
});

describe("Agent semantic mail chunking", () => {
  it("keeps subject, list, and table boundaries while respecting a token budget", () => {
    const chunks = chunkMailContent({
      messageId: "message-1",
      sourceRevision: "revision-1",
      subject: "Quarterly project status",
      text: `Opening paragraph with the key project status and action owner.\n\n- Prepare report\n- Schedule review\n- Confirm budget\n\nOwner | Due\nAda | Friday\nBob | Monday\n\nFinal paragraph includes a separate decision and context for stakeholders.`,
      targetTokens: 32,
      maximumTokens: 48,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.startsWith("Subject: Quarterly project status"))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("- Prepare report"))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("Owner | Due"))).toBe(true);
    expect(chunks.every((chunk) => chunk.tokenEstimate <= 48)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(chunks.length);
    expect(estimateMailTokens("中文邮件 token 预算")).toBeGreaterThan(0);
  });

  it("splits a long paragraph at language boundaries instead of a raw character cut", () => {
    const chunks = chunkMailContent({
      messageId: "message-2",
      sourceRevision: "revision-2",
      text: "First sentence carries a complete thought with substantial context. Second sentence carries another complete thought with distinct project details. Third sentence remains independently meaningful for readers. Fourth sentence adds a final independent decision and owner.",
      targetTokens: 32,
      maximumTokens: 40,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.content).join(" ")).toContain("Third sentence remains independently meaningful for readers.");
  });
});
