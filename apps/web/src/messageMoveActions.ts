import type { MoveTarget } from "./api";
import { isArchivedMessage } from "./mailListState";
import type { Account, Message } from "./types";

export type MessageFolderContext = "trash" | "junk" | "archive" | "drafts" | "sent" | "other";
export type MessageMoveAction = { target: MoveTarget; labelKey: string };

export function folderActionContext(specialUse?: string | null, archived = false): MessageFolderContext {
  if (specialUse === "\\Trash") return "trash";
  if (specialUse === "\\Junk") return "junk";
  if (specialUse === "\\Drafts") return "drafts";
  if (specialUse === "\\Sent") return "sent";
  return specialUse === "\\Archive" || archived ? "archive" : "other";
}

export function messageFolderContext(message: Message, accounts: readonly Account[]): MessageFolderContext {
  const folder = accounts.find((account) => account.id === message.accountId)?.folders.find((item) => item.path === message.mailbox);
  return folderActionContext(folder?.specialUse, isArchivedMessage(message, accounts));
}

const archive: MessageMoveAction = { target: "archive", labelKey: "mail.action.archive" };
const trash: MessageMoveAction = { target: "trash", labelKey: "mail.action.moveToTrash" };
const reportSpam: MessageMoveAction = { target: "junk", labelKey: "mail.action.reportSpam" };
const moves: Record<MessageFolderContext, readonly MessageMoveAction[]> = {
  trash: [{ target: "inbox", labelKey: "mail.action.restore" }],
  junk: [{ target: "inbox", labelKey: "mail.action.notSpam" }, trash],
  archive: [{ target: "inbox", labelKey: "mail.action.moveToInbox" }, trash],
  drafts: [trash],
  sent: [trash],
  other: [archive, trash],
};

/** Presentation only: every action reuses the existing move API and task layer. */
export function messageMoveActions(context: MessageFolderContext): readonly MessageMoveAction[] {
  return moves[context];
}

export function canReportSpam(context: MessageFolderContext): boolean {
  return context === "other" || context === "archive";
}

export function selectionMoveActions(context: MessageFolderContext): readonly MessageMoveAction[] {
  const actions = messageMoveActions(context);
  return canReportSpam(context) ? [...actions.filter((action) => action.target !== "trash"), reportSpam, trash] : actions;
}

export function selectionFolderContext(specialUse: string | null | undefined, archived: boolean, allMailSearch: boolean): MessageFolderContext {
  return allMailSearch ? "other" : folderActionContext(specialUse, archived);
}
