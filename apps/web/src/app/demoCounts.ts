import type { Account, Message, Stats } from "../types";
import { isInboxMessage, isSnoozedMessage } from "../mailListState";

/**
 * Derives the demo mailbox's counters from the rows on screen.
 *
 * Demo mode has no server to answer `/api/stats` and `/api/accounts`, so the
 * fixture takes that role: after a local move or read the store re-derives both
 * from the same target state the list shows. This mirrors the server's contract
 * (counts are a query over `messages`, never a locally nudged number) instead of
 * keeping the demo on a second, incremental counting path.
 *
 * It lives outside `demo.ts` on purpose: the demo dataset is lazy-loaded, and
 * importing it here would pull it into the initial bundle just to pass the
 * fixture through a pure function.
 */
export function deriveDemoCounts(
  messages: readonly Message[],
  accounts: readonly Account[],
): { accounts: Account[]; stats: Stats } {
  const nextAccounts = accounts.map((account) => ({
    ...account,
    folders: account.folders.map((folder) => {
      const rows = messages.filter((message) => message.accountId === account.id && message.mailbox === folder.path);
      return { ...folder, total: rows.length, unseen: rows.filter((message) => !message.seen).length };
    }),
  }));
  const inbox = messages.filter((message) => isInboxMessage(message, nextAccounts));
  return {
    accounts: nextAccounts,
    stats: {
      accounts: nextAccounts.length,
      messages: inbox.length,
      unread: inbox.filter((message) => !message.seen).length,
      starred: inbox.filter((message) => message.flagged).length,
      snoozed: inbox.filter((message) => isSnoozedMessage(message)).length,
      attachments: inbox.filter((message) => message.hasAttachments).length,
    },
  };
}
