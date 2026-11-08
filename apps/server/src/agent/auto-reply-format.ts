import type { AutoReplyScopeReason } from "./auto-reply-screening.js";

export function parsedFlags(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : [];
  } catch {
    return [];
  }
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return trimmed.length > 0 ? `Re: ${trimmed}` : "(无主题)";
}

const SCOPE_REASON_TEXT: Record<AutoReplyScopeReason, string> = {
  "outside-date-range": "不在回复日期范围内",
  "not-contact": "发件人不在联系人中",
  "ignore-rule": "命中忽略规则",
  "not-in-whitelist": "不在回复白名单中",
};

export function scopeReasonText(reason: AutoReplyScopeReason): string {
  return SCOPE_REASON_TEXT[reason] ?? reason;
}