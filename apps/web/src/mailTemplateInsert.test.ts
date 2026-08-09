import { describe, expect, it } from "vitest";
import { applyTemplateToDraft } from "./mailTemplateInsert";
import type { MailTemplate } from "./types";

function template(overrides: Partial<MailTemplate> = {}): MailTemplate {
  return {
    id: "template-1",
    name: "回复模板",
    subject: "会议确认",
    body: "确认收到，届时准时参加。",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("applyTemplateToDraft", () => {
  it("fills an empty subject from the template and leaves the body empty for an empty draft", () => {
    const result = applyTemplateToDraft({ subject: "", body: "" }, template());

    expect(result.filledSubject).toBe(true);
    expect(result.appendedBody).toBe(false);
    expect(result.subject).toBe("会议确认");
    expect(result.body).toBe("确认收到，届时准时参加。");
  });

  it("never overwrites an existing subject", () => {
    const result = applyTemplateToDraft({ subject: "已有主题", body: "" }, template());

    expect(result.filledSubject).toBe(false);
    expect(result.subject).toBe("已有主题");
    expect(result.body).toBe("确认收到，届时准时参加。");
  });

  it("replaces an empty body and does not mark the append", () => {
    const result = applyTemplateToDraft({ subject: "", body: "   " }, template());

    expect(result.appendedBody).toBe(false);
    expect(result.body).toBe("确认收到，届时准时参加。");
  });

  it("appends the template body below existing text with a blank line", () => {
    const result = applyTemplateToDraft({ subject: "", body: "已看到。" }, template());

    expect(result.appendedBody).toBe(true);
    expect(result.body).toBe("已看到。\n\n确认收到，届时准时参加。");
    expect(result.filledSubject).toBe(true);
  });

  it("keeps the subject untouched when the template has no subject", () => {
    const result = applyTemplateToDraft({ subject: "保留此主题", body: "" }, template({ subject: "  " }));

    expect(result.filledSubject).toBe(false);
    expect(result.subject).toBe("保留此主题");
    expect(result.appendedBody).toBe(false);
    expect(result.body).toBe("确认收到，届时准时参加。");
  });
});
