import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, X } from "lucide-react";
import { accountHealthIssue, type MailErrorPresentation } from "./errorPresentation";
import { type Translate, useI18n } from "./i18n";
import type { Account } from "./types";

// Account-health banner lifetime; it shows a visible auto-dismiss countdown.
export const ACCOUNT_HEALTH_ALERT_MS = 8_000;

// Sidebar account row: a sync-cap warning keeps the third (amber) dot state;
// real issues force the error dot regardless of the account status field.
export function accountStatusDotClass(issue: MailErrorPresentation | undefined, status: Account["status"]): "warning" | "error" | Account["status"] {
  return issue ? (issue.severity === "warning" ? "warning" : "error") : status;
}

// A warning does not take over the subtitle — sync still ran, only the
// freshness line stays; real issues replace it with their title.
export function accountShowsFreshness(issue: MailErrorPresentation | undefined): boolean {
  return !issue || issue.severity === "warning";
}

// The unhealthy-account set's change detector: id:title pairs joined in
// order. A persistent issue keeps the same fingerprint, so the banner fires
// once per change instead of nagging on every poll tick.
export function accountHealthFingerprint(
  accountsNeedingAttention: Account[],
  issues: ReadonlyMap<string, MailErrorPresentation>,
): string {
  return accountsNeedingAttention
    .map((account) => `${account.id}:${issues.get(account.id)?.title ?? ""}`)
    .join("|");
}

export type AccountHealthState = {
  issues: Map<string, MailErrorPresentation>;
  accountsNeedingAttention: Account[];
  primaryAccountNeedingAttention: Account | undefined;
  primaryAccountIssue: MailErrorPresentation | undefined;
  healthAlert: { until: number } | null;
  dismissHealthAlert: () => void;
};

export function useAccountHealth(accounts: Account[], t: Translate): AccountHealthState {
  // Account-health banner is transient: it appears when the unhealthy-account
  // set changes and auto-dismisses after a few seconds with a visible
  // countdown. The sidebar status dot stays red/green until the account heals.
  const [healthAlert, setHealthAlert] = useState<{ until: number } | null>(null);
  const prevHealthFingerprintRef = useRef("");
  const issues = useMemo(() => {
    const issues = new Map<string, MailErrorPresentation>();
    for (const account of accounts) {
      const issue = accountHealthIssue(account, t);
      if (issue) issues.set(account.id, issue);
    }
    return issues;
  }, [accounts, t]);
  const accountsNeedingAttention = accounts.filter((account) => issues.has(account.id));
  const primaryAccountNeedingAttention = accountsNeedingAttention[0];
  const primaryAccountIssue = primaryAccountNeedingAttention ? issues.get(primaryAccountNeedingAttention.id) : undefined;
  // A banner is raised only when the unhealthy-account set actually changes;
  // a persistent issue fires once, then the countdown closes it without the
  // banner nagging on every poll tick.
  const fingerprint = accountHealthFingerprint(accountsNeedingAttention, issues);
  useEffect(() => {
    if (fingerprint === prevHealthFingerprintRef.current) return;
    prevHealthFingerprintRef.current = fingerprint;
    if (!fingerprint) {
      setHealthAlert(null);
      return;
    }
    // The banner owns its ticking countdown; this only (re)arms the deadline
    // so a persistent problem does not nag again until its alert window ends.
    setHealthAlert({ until: Date.now() + ACCOUNT_HEALTH_ALERT_MS });
  }, [fingerprint]);
  const dismissHealthAlert = useCallback(() => setHealthAlert(null), []);
  return { issues, accountsNeedingAttention, primaryAccountNeedingAttention, primaryAccountIssue, healthAlert, dismissHealthAlert };
}

// Owns its own 500 ms tick and expiry so a live countdown does not re-render
// the whole mailbox (list, reader, dialogs) while an account alert is up.
export function AccountHealthBanner({
  until,
  issueCount,
  problemTitle,
  onShowReasons,
  onExpire,
}: {
  until: number;
  issueCount: number;
  problemTitle: string;
  onShowReasons: () => void;
  onExpire: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (!expiredRef.current && current >= until) {
        expiredRef.current = true;
        onExpire();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [until, onExpire]);
  return (
    <div className="account-health-banner" role="status">
      <CircleAlert size={17} />
      <span><strong>{t("mail.accountAttention", { count: issueCount })}</strong><small>{problemTitle}</small><em className="account-health-countdown">{t("mail.accountAttentionCountdown", { seconds: Math.max(1, Math.ceil((until - now) / 1000)) })}</em></span>
      <button type="button" onClick={onShowReasons}>{t("mail.viewReason")}</button>
      <button type="button" className="account-health-dismiss" aria-label={t("mail.accountHealthDismiss")} onClick={onExpire}><X size={14} /></button>
    </div>
  );
}