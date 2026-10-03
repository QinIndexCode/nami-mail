import type { AgentService } from "../agent-service.js";
import type { AutoReplyConfig } from "@nami/agent-contracts";
import {
  applyAutoReplyScope,
  sanitizeLinksForScreening,
  sanitizeLinksWithStats,
  scanSensitiveKeywords,
  screenAutoReply,
  screeningIgnoreReasonText,
  senderDomain,
  type AutoReplyIgnoreReason,
  type AutoReplyScopeReason,
} from "./auto-reply-screening.js";

export type AutoReplySimulateInput = {
  accountEmail?: string;
  fromName?: string;
  fromAddress: string;
  subject: string;
  textBody: string;
  snippet?: string;
  mailbox?: string;
  folderSpecialUse?: string;
  autoSubmitted?: string;
  listUnsubscribe?: string;
  precedence?: string;
  simulateAsContact?: boolean;
  forceLlm?: boolean;
};

export type AutoReplySimulateResult = {
  linkStats: {
    originalLength: number;
    sanitizedLength: number;
    replacedCount: number;
    estimatedTokensSaved: number;
    sanitizedSnippet: string;
  };
  screening: {
    passed: boolean;
    reason?: AutoReplyIgnoreReason;
    details?: string;
  };
  scope: {
    passed: boolean;
    reason?: AutoReplyScopeReason;
    details?: string;
  };
  sensitiveKeywords: string[];
  decision?: {
    evaluated: boolean;
    replyValue?: "high" | "low";
    sensitive?: boolean;
    reply?: string;
    error?: string;
  };
  finalAction:
    | "would_reply"
    | "ignored_offline_rule"
    | "ignored_scope"
    | "ignored_low_value"
    | "sensitive_requires_confirmation";
};

const DEFAULT_SIMULATE_CONFIG: AutoReplyConfig = {
  enabled: true,
  accountIds: [],
  mode: "llm",
  decisionProviderId: null,
  draftProviderId: null,
  template: { text: "", skipConfirmation: false },
  scope: { contactsOnly: false, threadOnce: true, rules: [] },
  requireConfirmation: true,
  dailyLimitPerAccount: 30,
};

export async function simulateAutoReply(
  agentService: AgentService,
  input: AutoReplySimulateInput,
  configOverride?: AutoReplyConfig,
  knownContacts?: Set<string>,
): Promise<AutoReplySimulateResult> {
  const config = configOverride ?? DEFAULT_SIMULATE_CONFIG;

  // 1. Link sanitization & token preservation stats
  const stats = sanitizeLinksWithStats(input.textBody || "");
  const sanitizedSnippet = sanitizeLinksForScreening(input.snippet || stats.sanitized.slice(0, 200));

  // 2. Offline screening
  const screeningInput = {
    mailbox: input.mailbox || "INBOX",
    folderSpecialUse: input.folderSpecialUse,
    subject: input.subject || "",
    fromAddress: input.fromAddress || "",
    autoSubmitted: input.autoSubmitted || "",
    listUnsubscribe: input.listUnsubscribe || "",
    precedence: input.precedence || "",
    returnPath: input.fromAddress || "",
    labels: [],
    flags: [],
    inReplyTo: null,
    references: null,
  };
  const screeningVerdict = screenAutoReply(screeningInput);
  const screening = screeningVerdict.keep
    ? { passed: true }
    : {
        passed: false,
        reason: screeningVerdict.reason,
        details: screeningIgnoreReasonText(screeningVerdict.reason),
      };

  // 3. Sender scope check
  const contacts = new Set<string>(knownContacts ?? []);
  if (input.simulateAsContact && input.fromAddress) {
    contacts.add(input.fromAddress.toLowerCase().trim());
  }
  const scopeInput = {
    fromAddress: input.fromAddress || "",
    fromName: input.fromName || "",
    fromDomain: senderDomain(input.fromAddress || ""),
    subject: input.subject || "",
    today: new Date().toISOString().slice(0, 10),
    contacts,
  };
  const scopeVerdict = applyAutoReplyScope(scopeInput, config.scope ?? {});
  const scope = scopeVerdict.keep
    ? { passed: true }
    : {
        passed: false,
        reason: scopeVerdict.reason,
        details: scopeVerdict.reason === "not-contact"
          ? "非通讯录联系人"
          : scopeVerdict.reason === "outside-date-range"
            ? "不在生效日期范围内"
            : "匹配自定义忽略规则",
        ruleId: (scopeVerdict as { ruleId?: string }).ruleId,
      };

  // 4. Sensitive keywords scan
  const sensitiveKeywords = scanSensitiveKeywords(stats.sanitized);

  // 5. LLM Evaluation (dry-run)
  const shouldEvaluateLlm = (screening.passed && scope.passed) || Boolean(input.forceLlm);
  let decision: AutoReplySimulateResult["decision"] = undefined;

  if (shouldEvaluateLlm) {
    try {
      const evaluation = await agentService.evaluateAutoReply({
        accountEmail: input.accountEmail || "",
        fromName: input.fromName || "",
        fromAddress: input.fromAddress || "",
        subject: input.subject || "",
        textBody: stats.sanitized,
        snippet: sanitizedSnippet,
        sensitiveKeywords,
        memoryContext: "",
        decisionProviderId: config.decisionProviderId,
        draftProviderId: config.draftProviderId,
      });

      decision = {
        evaluated: true,
        replyValue: evaluation.replyValue,
        sensitive: evaluation.sensitive,
        reply: evaluation.replyText,
      };
    } catch (error) {
      decision = {
        evaluated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // 6. Compute final projected action
  let finalAction: AutoReplySimulateResult["finalAction"] = "would_reply";
  if (input.forceLlm && decision?.evaluated) {
    if (decision.sensitive) {
      finalAction = "sensitive_requires_confirmation";
    } else if (decision.replyValue === "low") {
      finalAction = "ignored_low_value";
    } else {
      finalAction = "would_reply";
    }
  } else if (!screening.passed) {
    finalAction = "ignored_offline_rule";
  } else if (!scope.passed) {
    finalAction = "ignored_scope";
  } else if (decision?.replyValue === "low") {
    finalAction = "ignored_low_value";
  } else if (decision?.sensitive) {
    finalAction = "sensitive_requires_confirmation";
  }

  return {
    linkStats: {
      originalLength: stats.originalLength,
      sanitizedLength: stats.sanitizedLength,
      replacedCount: stats.replacedCount,
      estimatedTokensSaved: stats.estimatedTokensSaved,
      sanitizedSnippet,
    },
    screening,
    scope,
    sensitiveKeywords,
    ...(decision ? { decision } : {}),
    finalAction,
  };
}
