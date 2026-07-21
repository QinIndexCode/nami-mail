import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SendingStatusModal, { submissionNoticeMessage } from "./SendingStatusModal";
import type { Account, OutboundSubmission } from "./types";

const account: Account = {
  id: "account-1",
  email: "hello@example.com",
  provider: "gmail",
  providerName: "Gmail",
  status: "connected",
  lastError: null,
  lastSyncedAt: "2026-07-22T08:00:00.000Z",
  createdAt: "2026-07-20T08:00:00.000Z",
  folders: [],
};

const submission: OutboundSubmission = {
  id: "submission-1",
  accountId: account.id,
  messageId: "<status-check-1234567890@example.com>",
  subject: "这是一封用于校验发送状态提示呈现的长主题",
  recipients: ["one@example.com", "two@example.com", "three@example.com", "four@example.com"],
  deliveryStatus: "unknown_delivery",
  errorCode: "timeout",
  errorMessage: "服务端是否接收邮件暂时无法确认。",
  postSubmitWarning: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:01:00.000Z",
};

function renderStatusModal(): string {
  return renderToStaticMarkup(
    <SendingStatusModal
      accounts={[account]}
      submissions={[submission]}
      loading={false}
      loadError={null}
      onClose={() => undefined}
      onRefresh={async () => undefined}
      onSyncAccount={async () => undefined}
      onCreateNewMessage={() => undefined}
    />,
  );
}

describe("sending status modal presentation", () => {
  it("uses app-owned tooltips instead of browser title bubbles and keeps retry draft wording non-decisive", () => {
    const markup = renderStatusModal();

    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain("aria-describedby");
    expect(markup).toContain("新建重试草稿");
    expect(markup).not.toContain("确认未送达并新建");
    expect(markup).not.toContain(" title=");
  });

  it("keeps complete delivery identifiers in an accessible disclosure instead of relying on a clipped hover hint", () => {
    const markup = renderStatusModal();

    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("查看邮件详情");
    expect(markup).toContain('role="region"');
    expect(markup).toContain("one@example.com、two@example.com、three@example.com、four@example.com");
    expect(markup).toContain("&lt;status-check-1234567890@example.com&gt;");
    expect(markup).not.toContain('class="sending-status-title app-tooltip"');
    expect(markup).not.toContain('class="sending-status-message-id app-tooltip"');
  });

  it("maps persisted delivery details to user-facing recovery copy instead of rendering protocol text", () => {
    const protocolDetail = "ERR_MAIL_TRANSPORT_X7: opaque provider stack";
    const mapped = submissionNoticeMessage({
      ...submission,
      errorCode: null,
      errorMessage: protocolDetail,
    });

    expect(mapped).toContain("邮件状态仍待核对");
    expect(mapped).not.toContain("socket hang up");

    const markup = renderToStaticMarkup(
      <SendingStatusModal
        accounts={[account]}
        submissions={[{ ...submission, errorCode: null, errorMessage: protocolDetail }]}
        loading={false}
        loadError={null}
        onClose={() => undefined}
        onRefresh={async () => undefined}
        onSyncAccount={async () => undefined}
        onCreateNewMessage={() => undefined}
      />,
    );

    expect(markup).toContain("邮件状态仍待核对");
    expect(markup).not.toContain("socket hang up");
  });
});
