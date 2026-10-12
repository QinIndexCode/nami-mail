import { describe, expect, it } from "vitest";
import { resolveReaderAiIntent } from "./readerAiActions";

describe("resolveReaderAiIntent", () => {
  it("resolves summary action with /summary and autoSend=true", () => {
    const intent = resolveReaderAiIntent("summary");
    expect(intent).toEqual({
      action: "summary",
      prompt: "/summary",
      autoSend: true,
    });
  });

  it("resolves draft action with /draft  and autoSend=false", () => {
    const intent = resolveReaderAiIntent("draft");
    expect(intent).toEqual({
      action: "draft",
      prompt: "/draft ",
      autoSend: false,
    });
  });
});
