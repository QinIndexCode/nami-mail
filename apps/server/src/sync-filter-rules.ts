import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { listEnabledFilterRules, matchesFilterRuleConditions } from "./filter-rules.js";
import type { AccountAccessTokenProvider } from "./mail.js";
import { messagePayloadById } from "./message-storage.js";
import { moveMessage, moveMessageToFolder } from "./sync-moves.js";
import { updateMessageFlags } from "./sync.js";

/**
 * Applies enabled filter rules to newly arrived inbox messages after a sync
 * pass has finished. Runs after the per-account sync guard is released so the
 * reused flag/move operations can open their own IMAP session. Each message is
 * handled by at most the first matching rule (in rule position order); a failed
 * action stops that rule's remaining actions but never fails the sync itself.
 */
export async function applyFilterRulesToNewMessages(
  db: DatabaseHandle,
  masterKey: Buffer,
  accountId: string,
  newMessages: Array<{ id: string }>,
  accessTokenProvider?: AccountAccessTokenProvider,
  agentEvents?: AgentMailEventSink,
): Promise<{ matched: number; failed: number }> {
  const rules = listEnabledFilterRules(db, accountId);
  if (rules.length === 0 || newMessages.length === 0) return { matched: 0, failed: 0 };
  let matched = 0;
  let failed = 0;
  for (const message of newMessages) {
    const entry = messagePayloadById(db, masterKey, message.id);
    if (!entry) continue;
    const rule = rules.find((candidate) => matchesFilterRuleConditions(candidate.conditions, entry.payload));
    if (!rule) continue;
    try {
      for (const action of rule.actions) {
        switch (action.kind) {
          case "mark_seen":
            await updateMessageFlags(db, masterKey, message.id, { seen: true }, accessTokenProvider, agentEvents);
            break;
          case "add_flag":
            await updateMessageFlags(db, masterKey, message.id, { flagged: true }, accessTokenProvider, agentEvents);
            break;
          case "archive":
            await moveMessage(db, masterKey, message.id, "archive", accessTokenProvider, agentEvents);
            break;
          case "move_to_folder":
            await moveMessageToFolder(db, masterKey, message.id, action.folderPath, accessTokenProvider, agentEvents);
            break;
        }
      }
      matched += 1;
    } catch {
      failed += 1;
    }
  }
  return { matched, failed };
}
