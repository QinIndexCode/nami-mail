import type { AgentMailEventSink } from "./agent/mail-state-events.js";
import type { DatabaseHandle } from "./db.js";
import { listEnabledFilterRules, matchesFilterRuleConditions } from "./filter-rules.js";
import { serverLog } from "./logging.js";
import type { AccountAccessTokenProvider } from "./mail.js";
import { messagePayloadById } from "./message-storage.js";
import { moveMessage, moveMessageToFolder } from "./sync-moves.js";
import { updateMessageFlags } from "./sync-flags.js";

/**
 * Applies enabled filter rules to newly arrived inbox messages after a sync
 * pass has finished. Runs after the per-account sync guard is released so the
 * reused flag/move operations can open their own IMAP session. Each message is
 * handled by at most the first matching rule (in rule position order); a failed
 * action stops that rule's remaining actions but never fails the sync itself,
 * and is logged with the account, message, rule and action: a rule that did not
 * take effect on a new message is a user-visible miss, so it must not be a
 * silent one.
 *
 * These writes stay synchronous, and the exemption covers moves as well as flags
 * (contract §4.7 B1, v41). A rule is a sequence of actions performed in order on
 * one message; routing some through `commitTask` and leaving others inline would
 * let `archive` land after a later `mark_seen` targets the pre-move row, so the
 * rule would act on a copy that no longer holds it. The pass is also server-driven
 * maintenance inside sync, with no user waiting on any one message, so a task per
 * action would be a task storm for no observable immediacy.
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
    let failedAction: string | undefined;
    try {
      for (const action of rule.actions) {
        failedAction = action.kind;
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
    } catch (error) {
      failed += 1;
      // This message is new only in this pass and is not retried later, so the
      // log line is the only trace that the rule did not take effect.
      serverLog.warn(
        { accountId, messageId: message.id, ruleId: rule.id, action: failedAction },
        "Nami Mail could not apply a filter rule to a new message",
        error,
      );
    }
  }
  // The per-message lines above say which rule failed on which message; this
  // one line is what makes the count visible without reading the whole log.
  if (failed > 0) serverLog.warn({ accountId, matched, failed }, "Nami Mail applied filter rules with failures");
  return { matched, failed };
}
