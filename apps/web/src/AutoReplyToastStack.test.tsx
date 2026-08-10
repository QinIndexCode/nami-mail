import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import { AutoReplyToastStack, autoReplyNoticeKey } from "./AutoReplyToastStack";
import type { DesktopAutoReplyNotice } from "./desktop";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const pending: DesktopAutoReplyNotice = {
  kind: "pending",
  confirmationId: "confirm_auto_reply_1",
  requestId: "req_auto_reply_1",
  accountId: "account-1",
  messageId: "msg-1",
  subject: "项目进度更新",
  fromName: "张三",
  fromAddress: "sender@example.com",
  sensitive: true,
  createdAt: "2026-07-22T08:00:00.000Z",
  expiresAt: "2026-07-22T08:30:00.000Z",
  replyPreview: "感谢你的来信，我会在明天中午前回复完整进展。",
};

const sent: DesktopAutoReplyNotice = {
  kind: "sent",
  messageId: "msg-2",
  accountId: "account-1",
  subject: "会议安排",
  toName: "李四",
  toAddress: "lisi@example.com",
  replyPreview: "好的，明天上午见。",
};

function renderStack(notices: readonly DesktopAutoReplyNotice[]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AutoReplyToastStack notices={notices} onDismiss={() => undefined} />
    </I18nProvider>,
  );
}

describe("auto-reply toast stack", () => {
  it("renders a pending draft with subject, preview and sensitive flag", () => {
    const markup = renderStack([pending]);

    expect(markup).toContain(zh("autoReply.notice.pendingEyebrow"));
    expect(markup).toContain(zh("autoReply.notice.pendingTitle"));
    expect(markup).toContain(pending.subject);
    expect(markup).toContain(pending.replyPreview);
    expect(markup).toContain(zh("autoReply.pending.sensitive"));
    expect(markup).toContain("张三 &lt;sender@example.com&gt;");
  });

  it("routes cancellation through the desktop confirmation attributes", () => {
    const markup = renderStack([pending]);

    expect(markup).toContain('data-nami-agent-confirmation-card=""');
    expect(markup).toContain('data-nami-agent-confirmation-id="confirm_auto_reply_1"');
    expect(markup).toContain('data-nami-agent-confirmation-decision="reject"');
  });

  it("renders a sent notice without a cancel action", () => {
    const markup = renderStack([sent]);

    expect(markup).toContain(zh("autoReply.notice.sentEyebrow"));
    expect(markup).toContain(zh("autoReply.notice.sentTitle"));
    expect(markup).toContain(sent.subject);
    expect(markup).toContain(sent.replyPreview);
    expect(markup).toContain("李四 &lt;lisi@example.com&gt;");
    expect(markup).not.toContain(zh("autoReply.notice.cancel"));
    expect(markup).not.toContain('data-nami-agent-confirmation-decision="reject"');
  });

  it("always offers a close button and announces itself as a live region", () => {
    const markup = renderStack([pending, sent]);

    expect(markup).toContain(zh("common.closeNotification"));
    expect(markup.match(/auto-reply-toast-dismiss/g)).toHaveLength(2);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("keys pending drafts by confirmation id and sent replies by message id", () => {
    expect(autoReplyNoticeKey(pending)).toBe("pending:confirm_auto_reply_1");
    expect(autoReplyNoticeKey(sent)).toBe("sent:msg-2");
  });
});