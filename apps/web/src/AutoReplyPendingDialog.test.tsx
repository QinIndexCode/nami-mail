import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "./i18n";
import AutoReplyPendingDialog, { AutoReplyPendingCard, autoReplySenderLabel } from "./AutoReplyPendingDialog";
import type { AutoReplyPendingSummary } from "./agentTypes";
import type { Account } from "./types";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const account: Account = {
  id: "account-1",
  email: "hello@example.com",
  provider: "gmail",
  providerName: "Gmail",
  status: "connected",
  lastError: null,
  lastSyncedAt: "2026-07-22T08:00:00.000Z",
  signature: "",
  createdAt: "2026-07-20T08:00:00.000Z",
  folders: [],
};

const pending: AutoReplyPendingSummary = {
  confirmationId: "confirm_auto_reply_1",
  requestId: "req_auto_reply_1",
  accountId: account.id,
  messageId: "msg-1",
  subject: "项目进度更新",
  fromAddress: "sender@example.com",
  fromName: "张三",
  sensitive: true,
  createdAt: "2026-07-22T08:00:00.000Z",
  expiresAt: "2026-07-22T08:30:00.000Z",
  preview: {
    title: "自动回复草稿",
    summary: "感谢你的来信，我会在明天中午前回复完整进展。",
    fields: [
      { label: "收件人", value: "sender@example.com" },
      { label: "主题", value: "Re: 项目进度更新" },
    ],
  },
};

function renderCard(canResolve: boolean, accountEmail?: string): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AutoReplyPendingCard item={pending} accountEmail={accountEmail} canResolve={canResolve} onResolve={() => undefined} />
    </I18nProvider>,
  );
}

describe("auto-reply pending review", () => {
  it("renders sender, subject, drafted reply and sensitive flag", () => {
    const markup = renderCard(true, account.email);

    expect(markup).toContain("张三 &lt;sender@example.com&gt;");
    expect(markup).toContain(pending.subject);
    expect(markup).toContain(pending.preview.summary);
    expect(markup).toContain(zh("autoReply.pending.sensitive"));
    expect(markup).toContain(account.email);
    expect(markup).toContain("失效");
  });

  it("falls back to the plain address when the sender has no display name", () => {
    expect(autoReplySenderLabel("", "noreply@example.com")).toBe("noreply@example.com");
    expect(autoReplySenderLabel("张三", "sender@example.com")).toBe("张三 <sender@example.com>");
  });

  it("routes decisions through the desktop confirmation attributes and the web resolve handler", () => {
    const resolve = vi.fn();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AutoReplyPendingCard item={pending} canResolve={true} onResolve={resolve} />
      </I18nProvider>,
    );
    expect(markup).toContain('data-nami-agent-confirmation-id="confirm_auto_reply_1"');
    expect(markup).toContain('data-nami-agent-confirmation-decision="approve"');
    expect(markup).toContain('data-nami-agent-confirmation-decision="reject"');
    expect(markup).not.toContain('disabled=""');

    const disabledMarkup = renderCard(false);
    expect(disabledMarkup).toContain('data-nami-agent-confirmation-decision="approve"');
    expect(disabledMarkup).toContain('data-nami-agent-confirmation-decision="reject"');
    expect(disabledMarkup).toContain('disabled=""');
  });

  it("keeps the dialog chrome accessible and resolves locally in a plain web session", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <AutoReplyPendingDialog accounts={[account]} onClose={() => undefined} />
      </I18nProvider>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain(zh("autoReply.pending.title"));
    // Without a desktop bridge the local web surface resolves decisions, so
    // the desktop-only warning must not appear.
    expect(markup).not.toContain(zh("autoReply.pending.desktopOnly"));
    expect(markup).toContain('role="list"');
  });
});
