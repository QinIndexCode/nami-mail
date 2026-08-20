// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AccountHealthBanner, accountHealthFingerprint, accountShowsFreshness, accountStatusDotClass, useAccountHealth, type AccountHealthState } from "./accountHealth";
import { I18nProvider, translate, type Translate } from "./i18n";
import type { Account } from "./types";

const zh: Translate = (key, values) => translate("zh-CN", key, values);

describe("accountStatusDotClass", () => {
  const presentation = (severity: "error" | "warning") =>
    ({ kind: "sync", severity, title: "t", message: "m", guidance: "g", retryable: false }) as const;

  it("keeps the raw status when there is no issue", () => {
    expect(accountStatusDotClass(undefined, "connected")).toBe("connected");
    expect(accountStatusDotClass(undefined, "degraded")).toBe("degraded");
  });

  it("uses the warning state for sync-cap warnings", () => {
    expect(accountStatusDotClass(presentation("warning"), "connected")).toBe("warning");
  });

  it("forces the error state for real issues regardless of status", () => {
    expect(accountStatusDotClass(presentation("error"), "connected")).toBe("error");
    expect(accountStatusDotClass(presentation("error"), "degraded")).toBe("error");
  });
});

describe("accountShowsFreshness", () => {
  const presentation = (severity: "error" | "warning") =>
    ({ kind: "sync", severity, title: "t", message: "m", guidance: "g", retryable: false }) as const;

  it("keeps the freshness line for healthy accounts and warnings", () => {
    expect(accountShowsFreshness(undefined)).toBe(true);
    expect(accountShowsFreshness(presentation("warning"))).toBe(true);
  });

  it("hands the subtitle to real issues only", () => {
    expect(accountShowsFreshness(presentation("error"))).toBe(false);
  });
});

describe("accountHealthFingerprint", () => {
  const makeAccount = (id: string): Account => ({
    id,
    email: `${id}@example.com`,
    provider: "imap",
    providerName: "IMAP",
    status: "error",
    lastError: null,
    lastErrorCode: null,
    lastSyncWarningCode: null,
    lastSyncedAt: null,
    signature: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    folders: [],
  });
  const issue = (title: string) => ({ kind: "connection" as const, severity: "error" as const, title, message: "m", guidance: "g", retryable: true });

  it("is empty when every account is healthy", () => {
    expect(accountHealthFingerprint([], new Map())).toBe("");
  });

  it("pairs account id with the issue title in list order", () => {
    const issues = new Map([["a", issue("错误A")], ["b", issue("错误B")]]);
    expect(accountHealthFingerprint([makeAccount("a"), makeAccount("b")], issues)).toBe("a:错误A|b:错误B");
  });

  it("keeps the order stable so a persistent set does not re-fire", () => {
    const issues = new Map([["a", issue("错误A")], ["b", issue("错误B")]]);
    const first = accountHealthFingerprint([makeAccount("a"), makeAccount("b")], issues);
    const sameSet = accountHealthFingerprint([makeAccount("a"), makeAccount("b")], issues);
    expect(first).toBe(sameSet);
  });
});

const makeAccount = (overrides: Partial<Account> = {}): Account => ({
  id: "a1",
  email: "a1@example.com",
  provider: "imap",
  providerName: "IMAP",
  status: "connected",
  lastError: null,
  lastErrorCode: null,
  lastSyncWarningCode: null,
  lastSyncedAt: "2026-08-21T00:00:00.000Z",
  signature: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  folders: [],
  ...overrides,
});
const brokenAccount = (id: string, email: string) =>
  makeAccount({ id, email, status: "error", lastError: "连接失败", lastErrorCode: "connection_failed" });

let latest: AccountHealthState;
function HealthHarness({ accounts }: { accounts: Account[] }) {
  latest = useAccountHealth(accounts, zh);
  return null;
}

function mountHealth(accounts: Account[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const rerender = (next: Account[]) => {
    act(() => { root.render(<HealthHarness accounts={next} />); });
  };
  act(() => { root.render(<HealthHarness accounts={accounts} />); });
  return { root, rerender, container };
}

describe("useAccountHealth", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("stays quiet while every account is healthy", () => {
    mountHealth([makeAccount(), makeAccount({ id: "a2", email: "a2@example.com" })]);
    expect(latest.issues.size).toBe(0);
    expect(latest.accountsNeedingAttention).toHaveLength(0);
    expect(latest.healthAlert).toBeNull();
  });

  it("arms the banner once when an account starts failing", () => {
    mountHealth([brokenAccount("a1", "a1@example.com")]);
    expect(latest.issues.size).toBe(1);
    expect(latest.accountsNeedingAttention.map((account) => account.id)).toEqual(["a1"]);
    expect(latest.primaryAccountNeedingAttention?.id).toBe("a1");
    expect(latest.primaryAccountIssue?.title).toBeTruthy();
    expect(latest.healthAlert).not.toBeNull();
    expect(latest.healthAlert!.until).toBeGreaterThan(Date.now());
  });

  it("does not re-arm while the issue set is unchanged", () => {
    vi.useFakeTimers();
    const { rerender } = mountHealth([brokenAccount("a1", "a1@example.com")]);
    const firstUntil = latest.healthAlert!.until;
    vi.advanceTimersByTime(1_000);
    rerender([brokenAccount("a1", "a1@example.com")]);
    expect(latest.healthAlert!.until).toBe(firstUntil);
  });

  it("re-arms when the issue set grows or changes", () => {
    vi.useFakeTimers();
    const { rerender } = mountHealth([brokenAccount("a1", "a1@example.com")]);
    const firstUntil = latest.healthAlert!.until;
    vi.advanceTimersByTime(1_000);
    rerender([brokenAccount("a1", "a1@example.com"), brokenAccount("a2", "a2@example.com")]);
    expect(latest.accountsNeedingAttention).toHaveLength(2);
    expect(latest.healthAlert!.until).toBeGreaterThan(firstUntil);
  });

  it("clears the alert when the account heals", () => {
    const { rerender } = mountHealth([brokenAccount("a1", "a1@example.com")]);
    expect(latest.healthAlert).not.toBeNull();
    rerender([makeAccount()]);
    expect(latest.issues.size).toBe(0);
    expect(latest.healthAlert).toBeNull();
  });

  it("dismisses the alert on demand", () => {
    mountHealth([brokenAccount("a1", "a1@example.com")]);
    act(() => { latest.dismissHealthAlert(); });
    expect(latest.healthAlert).toBeNull();
  });
});

function renderBanner(until: number, onExpire: () => void, onShowReasons: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <AccountHealthBanner until={until} issueCount={1} problemTitle="测试问题" onShowReasons={onShowReasons} onExpire={onExpire} />
      </I18nProvider>,
    );
  });
  return { root, container };
}

describe("AccountHealthBanner", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("expires exactly once after the deadline passes", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn<() => void>();
    const { root } = renderBanner(Date.now() + 3_000, onExpire, vi.fn<() => void>());
    vi.advanceTimersByTime(3_500);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => { root.unmount(); });
  });

  it("shows a live countdown and reports the reason button", () => {
    vi.useFakeTimers();
    const onShowReasons = vi.fn<() => void>();
    const { container, root } = renderBanner(Date.now() + 4_000, vi.fn<() => void>(), onShowReasons);
    expect(container.textContent).toContain(zh("mail.accountAttention", { count: 1 }));
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(container.textContent).toContain(zh("mail.accountAttentionCountdown", { seconds: 2 }));
    act(() => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    expect(onShowReasons).toHaveBeenCalledTimes(1);
    act(() => { root.unmount(); });
  });
});