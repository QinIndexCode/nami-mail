import { describe, expect, it } from "vitest";
import { mailListScopeKey, type MailListScope } from "./mailListScope";

const base: MailListScope = {
  accountId: "account-1",
  folder: "INBOX",
  search: "",
  messageView: "inbox",
  scope: "view",
  attachmentKind: undefined,
  after: undefined,
  before: undefined,
};

describe("mailListScopeKey", () => {
  it("is stable for the same predicate", () => {
    expect(mailListScopeKey({ ...base })).toBe(mailListScopeKey({ ...base }));
  });

  it("treats an absent and an empty date bound as the same list", () => {
    expect(mailListScopeKey({ ...base, after: "", before: "" })).toBe(mailListScopeKey(base));
  });

  it.each<[string, Partial<MailListScope>]>([
    ["account", { accountId: "account-2" }],
    ["folder", { folder: "Archive" }],
    ["search", { search: "invoice" }],
    ["view", { messageView: "starred" }],
    ["scope", { scope: "all" }],
    ["attachment kind", { attachmentKind: "pdf" }],
    ["after bound", { after: "2026-01-01T00:00:00.000Z" }],
    ["before bound", { before: "2026-02-01T00:00:00.000Z" }],
  ])("changes when the %s changes", (_label, change) => {
    expect(mailListScopeKey({ ...base, ...change })).not.toBe(mailListScopeKey(base));
  });

  it("does not let a field value forge another field's slot", () => {
    // A delimiter-joined key would collide here: "a|b" + "" and "a" + "|b".
    expect(mailListScopeKey({ ...base, accountId: "a|b", folder: "" }))
      .not.toBe(mailListScopeKey({ ...base, accountId: "a", folder: "|b" }));
  });
});
