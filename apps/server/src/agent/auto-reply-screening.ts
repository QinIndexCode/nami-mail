/**
 * Offline (zero-LLM) screening for the Agent auto-reply pipeline. Pure
 * functions: they never touch the database or the network, so the rules are
 * unit-testable and cheap to run for every synced message.
 */

export const autoReplyIgnoreReasons = [
  "junk-folder",
  "auto-submitted",
  "marketing-list",
  "marketing-precedence",
  "gmail-category",
  "bounce",
  "no-sender",
] as const;

export type AutoReplyIgnoreReason = (typeof autoReplyIgnoreReasons)[number];

export type AutoReplyScreeningInput = {
  /** Folder path the message was synced from (e.g. "INBOX"). */
  mailbox: string;
  /** IMAP special-use of the folder when known (e.g. "\Junk"). */
  folderSpecialUse?: string | null;
  subject: string;
  /** Sender address. */
  fromAddress: string;
  /** Captured headers; empty string when absent. */
  autoSubmitted: string;
  listUnsubscribe: string;
  precedence: string;
  returnPath: string;
  /** IMAP labels reported by the server (Gmail CATEGORY_* etc.). */
  labels: readonly string[];
  /** \Seen-style IMAP flags. */
  flags: readonly string[];
  inReplyTo: string | null;
  references: readonly string[] | null;
};

export type AutoReplyScreeningResult =
  | { keep: true; threadKey: string | null }
  | { keep: false; reason: AutoReplyIgnoreReason };

function isJunkMailbox(mailbox: string, specialUse?: string | null): boolean {
  if (specialUse === "\\Junk" || specialUse === "\\Spam") return true;
  const folded = mailbox.toUpperCase();
  return folded === "JUNK" || folded === "SPAM" || folded.includes("/JUNK") || folded.includes("/SPAM") || folded.includes("垃圾邮件");
}

const gmailCategoryLabels = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"]);

/**
 * Applies the offline rules in priority order:
 * junk/垃圾 folder -> Auto-Submitted -> marketing (List-Unsubscribe /
 * Precedence) -> Gmail category labels -> missing sender / bounce.
 */
export function screenAutoReply(input: AutoReplyScreeningInput): AutoReplyScreeningResult {
  if (isJunkMailbox(input.mailbox, input.folderSpecialUse)) {
    return { keep: false, reason: "junk-folder" };
  }
  if (input.autoSubmitted.trim().length > 0) {
    return { keep: false, reason: "auto-submitted" };
  }
  if (input.listUnsubscribe.trim().length > 0) {
    return { keep: false, reason: "marketing-list" };
  }
  const precedence = input.precedence.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return { keep: false, reason: "marketing-precedence" };
  }
  if (input.labels.some((label) => gmailCategoryLabels.has(label.toUpperCase()))) {
    return { keep: false, reason: "gmail-category" };
  }
  if (input.fromAddress.trim().length === 0) {
    return { keep: false, reason: "no-sender" };
  }
  // Bounced mail reports the empty reverse path; never reply to delivery failures.
  if (input.returnPath.trim() === "<>") {
    return { keep: false, reason: "bounce" };
  }
  return { keep: true, threadKey: autoReplyThreadKey(input.inReplyTo, input.references, input.subject) };
}

/**
 * Anchors conversation de-duplication to the root message of the thread when
 * identifiable through References / In-Reply-To; fresh messages without a
 * thread anchor fall back to a normalized subject so identical follow-ups are
 * not answered twice within the de-duplication window.
 */
export function autoReplyThreadKey(
  inReplyTo: string | null,
  references: readonly string[] | null,
  subject: string,
): string | null {
  const chain = [...(references ?? []), ...(inReplyTo ? [inReplyTo] : [])];
  const anchor = chain.find((value) => value.length > 0);
  if (anchor) return `thread:${anchor}`;
  const foldedSubject = subject.replace(/\s+/g, " ").trim();
  if (foldedSubject.length > 0) return `subject:${foldedSubject}`;
  return null;
}

/**
 * Keyword scan that flags a candidate message before the Agent review. The
 * Agent must still re-confirm sensitivity; this first pass exists so the UI
 * can route those messages to the highest-priority confirmation surface.
 */
const SENSITIVE_KEYWORDS = [
  "password",
  "passcode",
  "密码",
  "verification code",
  "one-time code",
  "otp",
  "验证码",
  "一次性口令",
  "登录验证",
  "找回密码",
  "恢复账户",
  "account recovery",
  "凭证",
  "密钥",
  "api key",
  "token",
  "payment",
  "invoice",
  "付款",
  "账单",
  "退款",
  "refund",
  "card",
  "银行卡",
  "信用卡",
  "借记卡",
  "银行",
  "资金",
  "账户",
  "account",
  "security alert",
  "安全提醒",
  "锁定",
  "冻结",
  "挂失",
] as const;

export function scanSensitiveKeywords(...texts: readonly string[]): string[] {
  const haystack = texts.join("\n").replace(/\s+/g, " ");
  const lowered = haystack.toLowerCase();
  const hits: string[] = [];
  for (const keyword of SENSITIVE_KEYWORDS) {
    if (lowered.includes(keyword)) {
      hits.push(keyword);
      if (hits.length >= 8) break;
    }
  }
  return hits;
}

const IGNORE_REASON_TEXT: Record<AutoReplyIgnoreReason, string> = {
  "junk-folder": "垃圾邮件文件夹",
  "auto-submitted": "自动生成消息",
  "marketing-list": "订阅/营销列表",
  "marketing-precedence": "批量营销",
  "gmail-category": "Gmail 分类标签",
  "bounce": "退信",
  "no-sender": "无发件人",
};

export function screeningIgnoreReasonText(reason: AutoReplyIgnoreReason): string {
  return IGNORE_REASON_TEXT[reason] ?? reason;
}

// ── User scope ────────────────────────────────────────────────────────────

export const autoReplyScopeReasons = [
  "outside-date-range",
  "not-contact",
  "ignore-rule",
  "not-in-whitelist",
] as const;

export type AutoReplyScopeReason = (typeof autoReplyScopeReasons)[number];

export type AutoReplyScopeInput = {
  /** Sender address (bare, without display name). */
  fromAddress: string;
  /** Sender domain, lowercased. */
  fromDomain: string;
  subject: string;
  /** Current date in YYYY-MM-DD form (UTC, consistent with the daily cap). */
  today: string;
  /** Lowercased addresses present in the local address book. */
  contacts: ReadonlySet<string>;
};

export type AutoReplyScopeRule = {
  id: string;
  field: "from" | "domain" | "subject";
  op: "contains" | "not-contains" | "equals";
  value: string;
  action: "reply" | "ignore";
  enabled: boolean;
};

export type AutoReplyScopeResult =
  | { keep: true }
  | { keep: false; reason: AutoReplyScopeReason; ruleId?: string };

export function senderDomain(fromAddress: string): string {
  const trimmed = fromAddress.trim();
  let address = trimmed;
  const angleStart = trimmed.lastIndexOf("<");
  const angleEnd = trimmed.lastIndexOf(">");
  if (angleStart >= 0 && angleEnd > angleStart) {
    address = trimmed.slice(angleStart + 1, angleEnd);
  }
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address.slice(at + 1).toLowerCase();
}

function ruleMatches(rule: AutoReplyScopeRule, input: AutoReplyScopeInput): boolean {
  const raw = rule.field === "from"
    ? input.fromAddress.trim().toLowerCase()
    : rule.field === "domain"
      ? input.fromDomain
      : input.subject.replace(/\s+/g, " ").trim();
  const needle = rule.value.trim().toLowerCase();
  const haystack = raw.toLowerCase();
  switch (rule.op) {
    case "contains":
      return haystack.includes(needle);
    case "not-contains":
      return !haystack.includes(needle);
    case "equals":
      return haystack === needle;
  }
}

/**
 * Applies the user-configured eligibility scope. Order matters:
 * 1. date window, 2. contacts-only, 3. "ignore" rules (first match wins),
 * 4. implicit whitelist: if any "reply" rule exists, a non-matching message
 * is declined. Enabled "ignore" rules short-circuit even a whitelist match.
 */
export function applyAutoReplyScope(
  input: AutoReplyScopeInput,
  scope: {
    contactsOnly?: boolean;
    startDate?: string | null;
    endDate?: string | null;
    rules?: readonly AutoReplyScopeRule[];
  },
): AutoReplyScopeResult {
  if (scope.startDate && input.today < scope.startDate) {
    return { keep: false, reason: "outside-date-range" };
  }
  if (scope.endDate && input.today > scope.endDate) {
    return { keep: false, reason: "outside-date-range" };
  }
  if (scope.contactsOnly && !input.contacts.has(input.fromAddress.trim().toLowerCase())) {
    return { keep: false, reason: "not-contact" };
  }
  const rules = scope.rules ?? [];
  const replyRules = rules.filter((rule) => rule.enabled && rule.action === "reply");
  const ignoreRules = rules.filter((rule) => rule.enabled && rule.action === "ignore");
  for (const rule of ignoreRules) {
    if (ruleMatches(rule, input)) return { keep: false, reason: "ignore-rule", ruleId: rule.id };
  }
  if (replyRules.length > 0 && !replyRules.some((rule) => ruleMatches(rule, input))) {
    return { keep: false, reason: "not-in-whitelist" };
  }
  return { keep: true };
}

const TEMPLATE_PLACEHOLDERS: Record<string, (vars: AutoReplyTemplateVars) => string> = {
  "{{senderName}}": (vars) => vars.senderName,
  "{{senderAddress}}": (vars) => vars.senderAddress,
  "{{senderDomain}}": (vars) => vars.senderDomain,
  "{{subject}}": (vars) => vars.subject,
};

export type AutoReplyTemplateVars = {
  senderName: string;
  senderAddress: string;
  senderDomain: string;
  subject: string;
};

/**
 * Substitutes {{placeholders}} in a user-authored reply template. Unknown
 * placeholders are left untouched so typos surface in the review dialog
 * instead of silently vanishing from the sent mail.
 */
export function renderAutoReplyTemplate(template: string, vars: AutoReplyTemplateVars): string {
  let rendered = template;
  for (const [placeholder, resolve] of Object.entries(TEMPLATE_PLACEHOLDERS)) {
    rendered = rendered.split(placeholder).join(resolve(vars));
  }
  return rendered.trim();
}

/**
 * Result of link sanitization with token economy metrics.
 */
export type LinkSanitizationStats = {
  sanitized: string;
  replacedCount: number;
  originalLength: number;
  sanitizedLength: number;
  estimatedTokensSaved: number;
};

/**
 * Extracts a concise domain string (e.g. "github.com") from a URL string,
 * ignoring common subdomains like "www.", "click.", "mail.", "tracking.".
 */
export function extractCompactDomain(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    // IP addresses or bare names
    if (/^[\d.]+$|^localhost$/i.test(host)) return host;
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return host;
    const isSpecialTld = parts.length >= 3 && /^(?:co|com|net|org|edu|gov)\.[a-z]{2}$/i.test(parts.slice(-2).join("."));
    if (isSpecialTld) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
}

/**
 * Strips or replaces heavy, redundant URLs, marketing redirects, and tracking links
 * from email bodies before passing them to the LLM for screening/reply-value judgment.
 * This preserves token budget, avoids wasting prompt space on tracking strings,
 * and improves LLM classification accuracy.
 */
export function sanitizeLinksForScreening(text: string): string {
  return sanitizeLinksWithStats(text).sanitized;
}

export function sanitizeLinksWithStats(text: string): LinkSanitizationStats {
  if (!text || typeof text !== "string") {
    return {
      sanitized: "",
      replacedCount: 0,
      originalLength: 0,
      sanitizedLength: 0,
      estimatedTokensSaved: 0,
    };
  }

  const originalLength = text.length;
  let replacedCount = 0;
  let result = text;

  // 1. Replace data URIs (e.g. data:image/png;base64,...)
  result = result.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, () => {
    replacedCount++;
    return "[内联图片]";
  });

  // 2. Replace HTML links: <a ... href="url" ...>anchorText</a>
  result = result.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, anchorText) => {
    replacedCount++;
    const cleanAnchor = anchorText.replace(/<[^>]+>/g, "").trim();
    const isUnsub = /unsubscribe|optout|opt-out|退订/i.test(href) || /unsubscribe|退订/i.test(cleanAnchor);
    if (isUnsub) return "[退订链接]";
    if (cleanAnchor && cleanAnchor.length > 1 && !/^https?:\/\//i.test(cleanAnchor) && !/^(?:click here|here|链接|详情|link)$/i.test(cleanAnchor)) {
      return `[${cleanAnchor}]`;
    }
    const domain = extractCompactDomain(href);
    return domain ? `[链接: ${domain}]` : "[链接]";
  });

  // 3. Replace Markdown links: [anchor](url)
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/gi, (_match, anchorText, url) => {
    replacedCount++;
    const cleanAnchor = anchorText.trim();
    const isUnsub = /unsubscribe|optout|opt-out|退订/i.test(url) || /unsubscribe|退订/i.test(cleanAnchor);
    if (isUnsub) return "[退订链接]";
    if (cleanAnchor && cleanAnchor.length > 1 && !/^https?:\/\//i.test(cleanAnchor) && !/^(?:click here|here|链接|详情|link)$/i.test(cleanAnchor)) {
      return `[${cleanAnchor}]`;
    }
    const domain = extractCompactDomain(url);
    return domain ? `[链接: ${domain}]` : "[链接]";
  });

  // 4. Replace raw URLs (http:// or https://...)
  result = result.replace(/https?:\/\/[^\s<>"'()[\]]+/gi, (rawUrl) => {
    replacedCount++;
    const isUnsub = /unsubscribe|optout|opt-out|退订/i.test(rawUrl);
    if (isUnsub) return "[退订链接]";
    const domain = extractCompactDomain(rawUrl);
    return domain ? `[链接: ${domain}]` : "[链接]";
  });

  // 5. Collapse duplicate consecutive links (e.g. "[链接] [链接] [链接]" -> "[链接]")
  result = result.replace(/(\[(?:链接(?::\s*[^\]]+)?|退订链接|内联图片)\](?:\s*,?\s*|\s+)){2,}/g, (match) => {
    const firstTag = match.match(/\[[^\]]+\]/);
    return firstTag ? `${firstTag[0]} ` : match;
  });

  result = result.replace(/[ \t]{2,}/g, " ").trim();
  const sanitizedLength = result.length;
  const charsSaved = Math.max(0, originalLength - sanitizedLength);
  const estimatedTokensSaved = Math.round(charsSaved / 3.5);

  return {
    sanitized: result,
    replacedCount,
    originalLength,
    sanitizedLength,
    estimatedTokensSaved,
  };
}