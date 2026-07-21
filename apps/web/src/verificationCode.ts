export type VerificationCodeCandidate = {
  code: string;
  score: number;
  source: "subject" | "body";
};

export type VerificationCodeInput = {
  subject?: string | null;
  body?: string | null;
  limit?: number;
};

type VerificationCodeSource = VerificationCodeCandidate["source"];

const MAX_SCAN_LENGTH = 120_000;

// Require an explicit verification or sign-in signal near a number. This keeps
// ordinary order, invoice, tracking, and reference numbers out of the UI.
const explicitVerificationContext = /(?:验证码|验证(?:码|代码)|校验(?:码|代码)|动态(?:码|密码)|一次性(?:密码|代码|口令)|登录(?:验证码|码)|认证(?:码|代码)|安全(?:码|代码)|授权(?:码|代码)|确认(?:码|代码)|otp|one[\s-]*time(?:\s+(?:pass(?:code|word)|code|pin))?|(?:verification|verify|authentication|security|login|access|confirmation|confirm)\s+(?:code|pin)|passcode|verification\s+pin|確認(?:コード|番号)|認証(?:コード|番号)|認證(?:碼|碼)|驗證(?:碼|碼)|인증\s*(?:코드|번호)|(?:c[oó]digo|code)\s+(?:de\s+)?(?:verificaci[oó]n|v[eé]rification)|(?:best[aä]tigungs|sicherheits)code)/i;
const directVerificationLabelBefore = /(?:验证码|验证(?:码|代码)|校验(?:码|代码)|动态(?:码|密码)|一次性(?:密码|代码|口令)|登录(?:验证码|码)|认证(?:码|代码)|安全(?:码|代码)|授权(?:码|代码)|确认(?:码|代码)|otp|one[\s-]*time(?:\s+(?:pass(?:code|word)|code|pin))?|(?:verification|authentication|security|login|access|confirmation|confirm)\s+(?:code|pin)|passcode|verification\s+pin|確認(?:コード|番号)|認証(?:コード|番号)|認證(?:碼|碼)|驗證(?:碼|碼)|인증\s*(?:코드|번호))\s*(?:(?:is|:|：|是|为)\s*)?$/i;
const directVerificationLabelAfter = /^\s*(?:(?:is|:|：|是|为|[,，—-])\s*)?(?:(?:your|the)\s+|(?:您的|你的))?(?:(?:[a-z]+\s+){0,3})(?:验证码|验证(?:码|代码)|校验(?:码|代码)|动态(?:码|密码)|一次性(?:密码|代码|口令)|登录(?:验证码|码)|认证(?:码|代码)|安全(?:码|代码)|授权(?:码|代码)|确认(?:码|代码)|otp|one[\s-]*time(?:\s+(?:pass(?:code|word)|code|pin))?|(?:verification|authentication|security|login|access|confirmation|confirm)\s+(?:code|pin)|passcode|verification\s+pin)/i;
const signInContext = /(?:登录|登入|登录验证|验证身份|身份验证|重置(?:密码|口令)|找回(?:密码|账户)|sign\s*in|log\s*in|login|authenticate|authentication|reset\s+(?:your\s+)?password|password\s+reset|verify\s+(?:your\s+)?(?:identity|account)|confirm\s+(?:your\s+)?(?:identity|account))/i;
const genericCodeContext = /\b(?:code|pin)\b/i;
const directGenericCodeLabel = /(?:\b(?:code|pin)\b|验证码|验证(?:码|代码)|校验(?:码|代码))\s*(?:(?:is|:|：|是|为)\s*)?$/i;
const expiryContext = /(?:有效期|有效时间|分钟内|失效|过期|expires?|expir(?:y|es)|valid\s+for|within\s+\d+\s*(?:minutes?|mins?))/i;
const nonVerificationContext = /(?:订单(?:号|编号)?|交易(?:号|编号)?|流水(?:号|编号)?|参考(?:号|编号)?|快递|物流|运单|发票(?:号|编号)?|账单|金额|价格|付款|收据|跟踪(?:号|编号)?|优惠(?:码|券)?|折扣(?:码|券)?|礼品(?:卡|码)?|项目(?:号|编号)?|产品(?:号|编号)?|错误(?:码|代码)?|订单|交易|tracking|shipment|delivery|invoice|receipt|reference(?:\s*(?:number|no\.?|id))?|order(?:\s*(?:number|no\.?|id|#))?|transaction|phone|telephone|mobile|account\s*(?:number|no\.?|id)|amount|total|price|postal|postcode|zip|date|passport|error\s*(?:code|number)?|promo(?:tional)?\s*code|coupon|discount|gift\s*(?:card|code)|project\s*(?:number|code)|product\s*(?:number|code))/i;

function truncateForScan(value: string | null | undefined): string {
  return value?.slice(0, MAX_SCAN_LENGTH) ?? "";
}

function isPartOfLongSeparatedNumber(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 16), start);
  const after = text.slice(end, end + 16);
  return /\d[\s\u00a0-]*$/.test(before) || /^[\s\u00a0-]*\d/.test(after);
}

function isDateLikeNumber(value: string): boolean {
  const match = value.match(/^(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function contextAround(text: string, start: number, end: number): { before: string; after: string; nearby: string } {
  const before = text.slice(Math.max(0, start - 90), start);
  const after = text.slice(end, end + 90);
  return { before, after, nearby: `${before} ${after}` };
}

function scoreCode({
  source,
  before,
  after,
  nearby,
}: {
  source: VerificationCodeSource;
  before: string;
  after: string;
  nearby: string;
}): number | null {
  const hasDirectVerificationLabel = directVerificationLabelBefore.test(before) || directVerificationLabelAfter.test(after);
  const hasNearbyVerificationContext = explicitVerificationContext.test(nearby);
  const hasSignInContext = signInContext.test(nearby);
  const hasGenericCodeContext = genericCodeContext.test(nearby);
  const hasDirectGenericCodeLabel = directGenericCodeLabel.test(before);
  const hasExpiryContext = expiryContext.test(nearby);
  const hasNonVerificationContext = nonVerificationContext.test(nearby);

  // A sign-in mention alone is deliberately not enough. Security notices often
  // contain unrelated session IDs, timestamps, or device identifiers close to
  // the sign-in copy. Require a code/verification label for body candidates so
  // the one-click action stays high precision.
  const eligible = hasDirectVerificationLabel
    || hasNearbyVerificationContext
    || hasDirectGenericCodeLabel
    || (source === "subject" && hasGenericCodeContext);
  if (!eligible || (hasNonVerificationContext && !hasDirectVerificationLabel)) return null;

  let score = 0;
  if (hasDirectVerificationLabel) score += 200;
  if (hasNearbyVerificationContext) score += 10;
  if (hasSignInContext) score += 85;
  if (hasDirectGenericCodeLabel) score += 45;
  if (hasExpiryContext) score += 30;
  if (source === "subject") score += 25;
  if (hasNonVerificationContext) score -= 85;
  return score;
}

function candidatesFromText(text: string, source: VerificationCodeSource): Array<VerificationCodeCandidate & { index: number }> {
  const candidates: Array<VerificationCodeCandidate & { index: number }> = [];
  const numericCode = /(?<!\d)(\d(?:[ \u00a0-]?\d){3,7})(?!\d)/g;

  for (const match of text.matchAll(numericCode)) {
    const rawCode = match[1];
    const start = match.index ?? 0;
    const end = start + rawCode.length;
    if (isPartOfLongSeparatedNumber(text, start, end) || isDateLikeNumber(rawCode)) continue;

    const code = rawCode.replace(/[^0-9]/g, "");
    if (code.length < 4 || code.length > 8) continue;

    const { before, after, nearby } = contextAround(text, start, end);
    const score = scoreCode({ source, before, after, nearby });
    if (score !== null) candidates.push({ code, score, source, index: start });
  }

  return candidates;
}

/**
 * Detect likely one-time verification codes without persisting or transmitting
 * message content. A code must have nearby verification/sign-in context; a
 * plain four-to-eight digit number alone is intentionally ignored.
 */
export function findVerificationCodes({ subject, body, limit = 3 }: VerificationCodeInput): VerificationCodeCandidate[] {
  const candidates = [
    ...candidatesFromText(truncateForScan(subject), "subject"),
    ...candidatesFromText(truncateForScan(body), "body"),
  ];
  const bestByCode = new Map<string, VerificationCodeCandidate & { index: number }>();

  for (const candidate of candidates) {
    const existing = bestByCode.get(candidate.code);
    if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidate.source === "subject" && existing.source !== "subject")) {
      bestByCode.set(candidate.code, candidate);
    }
  }

  const resolvedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 8) : 3;
  return [...bestByCode.values()]
    .sort((left, right) => right.score - left.score || Number(right.source === "subject") - Number(left.source === "subject") || left.index - right.index || left.code.localeCompare(right.code))
    .slice(0, resolvedLimit)
    .map(({ code, score, source }) => ({ code, score, source }));
}
