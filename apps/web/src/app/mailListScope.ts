import type { AttachmentKind } from "../attachmentPresentation";
import type { MessageListView } from "../mailListState";

/**
 * The fields that define *which list* a load is showing.
 *
 * The batch selection survives a refresh of the same list and is cleared when
 * the list changes; `mailListScopeKey` is how "same list" is decided. It is a
 * separate module because the distinction is easy to get subtly wrong (a
 * missing field makes two different lists look alike) and because
 * `App.tsx` is where the value is only *recorded*, not defined.
 */
export type MailListScope = {
  accountId: string;
  folder: string;
  search: string;
  messageView: MessageListView;
  scope: "view" | "all";
  attachmentKind: AttachmentKind | undefined;
  after?: string;
  before?: string;
};

/**
 * One string that is equal only for the same list predicate.
 *
 * `JSON.stringify` of an array rather than a joined string: a delimiter would
 * have to be escaped out of every field, and a folder or search containing it
 * would make two predicates share a key. The date bounds collapse `undefined`
 * and `""`, because both mean "no bound".
 */
export function mailListScopeKey(scope: MailListScope): string {
  return JSON.stringify([
    scope.accountId,
    scope.folder,
    scope.search,
    scope.messageView,
    scope.scope,
    scope.attachmentKind,
    scope.after ?? "",
    scope.before ?? "",
  ]);
}
