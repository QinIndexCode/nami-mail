import { describe, expect, it } from "vitest";
import { folderActionContext, messageFolderContext, messageMoveActions, selectionMoveActions } from "./messageMoveActions";
import type { Account, Message } from "./types";

describe("folder-specific mail moves", () => {
  it.each([
    ["\\Trash", "trash", ["inbox"]],
    ["\\Junk", "junk", ["inbox", "trash"]],
    ["\\Archive", "archive", ["inbox", "trash"]],
    ["\\Drafts", "drafts", ["trash"]],
    ["\\Sent", "sent", ["trash"]],
    ["\\Inbox", "other", ["archive", "trash"]],
  ] as const)("uses %s semantics for rows and bulk actions", (specialUse, context, targets) => {
    expect(folderActionContext(specialUse)).toBe(context);
    expect(messageMoveActions(context).map((action) => action.target)).toEqual(targets);
    const bulk = selectionMoveActions(context).map((action) => action.target);
    if (context === "trash") expect(bulk).toEqual(["inbox"]);
    if (context === "junk") expect(bulk).not.toContain("junk");
  });

  it("resolves a localized provider folder from metadata rather than its display name", () => {
    const accounts = [{ id: "a1", folders: [{ path: "已删除邮件", specialUse: "\\Trash" }] }] as Account[];
    const message = { accountId: "a1", mailbox: "已删除邮件" } as Message;
    expect(messageFolderContext(message, accounts)).toBe("trash");
    expect(messageMoveActions("trash")[0]?.labelKey).toBe("mail.action.restore");
  });

  it("restores only archived All Mail rows, leaving Inbox copies eligible for archive", () => {
    const accounts = [{ id: "a1", folders: [{ path: "[Gmail]/All Mail", specialUse: "\\All" }] }] as Account[];
    const message = { accountId: "a1", mailbox: "[Gmail]/All Mail", archived: false } as Message;
    expect(messageFolderContext(message, accounts)).toBe("other");
    expect(messageFolderContext({ ...message, archived: true }, accounts)).toBe("archive");
  });
});
