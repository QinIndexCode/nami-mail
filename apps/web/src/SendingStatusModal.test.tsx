// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nProvider, translate } from "./i18n";
import SendingStatusModal, { submissionNoticeMessage } from "./SendingStatusModal";
import type { Account, OutboundSubmission } from "./types";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

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

const submission: OutboundSubmission = {
  id: "submission-1",
  accountId: account.id,
  messageId: "<status-check-1234567890@example.com>",
  subject: "这是一封用于校验发送状态提示呈现的长主题",
  recipients: ["one@example.com", "two@example.com", "three@example.com", "four@example.com"],
  deliveryStatus: "unknown_delivery",
  sendAt: null,
  errorCode: "timeout",
  errorMessage: "服务端是否接收邮件暂时无法确认。",
  postSubmitWarning: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:01:00.000Z",
};

function renderStatusModal(submissions: OutboundSubmission[] = [submission]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SendingStatusModal
        accounts={[account]}
        submissions={submissions}
        loading={false}
        loadError={null}
        onClose={() => undefined}
        onRefresh={async () => undefined}
        onSyncAccount={async () => undefined}
        onCreateNewMessage={() => undefined}
        onCancelScheduled={async () => undefined}
      />
    </I18nProvider>,
  );
}

describe("sending status modal presentation (SSR)", () => {
  it("uses app-owned data-tooltip hints instead of browser title bubbles and keeps retry draft wording non-decisive", () => {
    const markup = renderStatusModal();

    expect(markup).toContain("data-tooltip");
    expect(markup).not.toContain(" title=");
    expect(markup).toContain(zh("sending.modal.createRetryDraft"));
    expect(markup).not.toContain("确认未送达并新建");
  });

  it("lets the status dot carry the colour signal so the list row does not repeat the full status label", () => {
    const markup = renderStatusModal();
    // A small, muted dot is the only status signal in each row.
    expect(markup).toContain("sending-status-dot tone-");
    // The repeated "已确认发送" badge inside each list row was the noisy
    // affordance; the badge is now reserved for the read-only details dialog
    // where the user has explicitly asked for the full status.
    const listItem = markup.match(/role="listitem"[^]*?<\/div><\/div><\/div>/);
    expect(listItem?.[0]).not.toContain("已确认发送");
    expect(listItem?.[0]).not.toContain("sending-status-badge");
  });

  it("renders a management-style row list whose full identifiers stay out of the list", () => {
    const markup = renderStatusModal();

    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).toContain("sending-status-row-main");
    expect(markup).toContain(zh("sending.modal.viewDetails", { title: "这是一封用于校验发送状态提示呈现的长主题" }));
    // The complete message id and every recipient belong to the read-only
    // details dialog; the list only carries truncated, human-readable copies.
    expect(markup).not.toContain("&lt;status-check-1234567890@example.com&gt;");
    expect(markup).toContain("one@example.com、two@example.com、three@example.com 等 4 位收件人");
  });

  it("maps persisted delivery details to user-facing recovery copy instead of rendering protocol text", () => {
    const protocolDetail = "ERR_MAIL_TRANSPORT_X7: opaque provider stack";
    const mapped = submissionNoticeMessage({
      ...submission,
      errorCode: null,
      errorMessage: protocolDetail,
    });

    expect(mapped).toContain(zh("sending.notice.unknownDelivery"));
    expect(mapped).not.toContain("socket hang up");

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SendingStatusModal
          accounts={[account]}
          submissions={[{ ...submission, errorCode: null, errorMessage: protocolDetail }]}
          loading={false}
          loadError={null}
          onClose={() => undefined}
          onRefresh={async () => undefined}
          onSyncAccount={async () => undefined}
          onCreateNewMessage={() => undefined}
          onCancelScheduled={async () => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain(zh("sending.notice.unknownDelivery"));
    expect(markup).not.toContain("socket hang up");
  });

  it("shows the scheduled send time, an overdue notice, and a cancel action only for pending scheduled sends", () => {
    const scheduledSubmission = {
      ...submission,
      deliveryStatus: "pending" as const,
      sendAt: "2026-07-22T12:00:00.000Z",
      errorCode: null,
      errorMessage: null,
    };
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SendingStatusModal
          accounts={[account]}
          submissions={[scheduledSubmission, { ...submission, id: "submission-plain", deliveryStatus: "pending" as const, sendAt: null, errorCode: null, errorMessage: null }]}
          loading={false}
          loadError={null}
          onClose={() => undefined}
          onRefresh={async () => undefined}
          onSyncAccount={async () => undefined}
          onCreateNewMessage={() => undefined}
          onCancelScheduled={async () => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("计划发送：");
    expect(markup).toContain(zh("sending.modal.overdueScheduled"));
    expect(markup).toContain(zh("sending.modal.cancelScheduled"));
    expect(markup.match(/sending-status-row-scheduled/g)).toHaveLength(1);
    expect(markup.match(/sending-status-row-overdue/g)).toHaveLength(1);
  });
});

describe("sending status modal read-only details dialog (client)", () => {
  let host: HTMLDivElement;
  let root: Root;

  function mount(submissions: OutboundSubmission[] = [submission]): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(
        <I18nProvider>
          <SendingStatusModal
            accounts={[account]}
            submissions={submissions}
            loading={false}
            loadError={null}
            onClose={() => undefined}
            onRefresh={async () => undefined}
            onSyncAccount={async () => undefined}
            onCreateNewMessage={() => undefined}
            onCancelScheduled={async () => undefined}
          />
        </I18nProvider>,
      );
    });
  }

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  it("opens a read-only dialog exposing the complete message id and every recipient", () => {
    mount();

    const viewButton = document.querySelector<HTMLButtonElement>('button[aria-label*="查看"]');
    expect(viewButton).not.toBeNull();
    act(() => viewButton?.click());

    const dialog = document.querySelector<HTMLElement>(".sending-status-details-modal");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("<status-check-1234567890@example.com>");
    expect(dialog?.textContent).toContain("one@example.com、two@example.com、three@example.com、four@example.com");
    expect(dialog?.textContent).toContain(zh("sending.modal.subject"));
    expect(dialog?.textContent).toContain("这是一封用于校验发送状态提示呈现的长主题");
  });

  it("closes the details dialog via its close button", async () => {
    mount();

    const viewButton = document.querySelector<HTMLButtonElement>('button[aria-label*="查看"]');
    act(() => viewButton?.click());
    expect(document.querySelector(".sending-status-details-modal")).not.toBeNull();

    const closeButton = document.querySelector<HTMLButtonElement>('.sending-status-details-head button[aria-label*="关闭"]');
    act(() => closeButton?.click());
    // The dialog plays its exit transition before unmounting.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    });
    expect(document.querySelector(".sending-status-details-modal")).toBeNull();
  });

  it("pins the list height and pages through records without reflowing the dialog", () => {
    // 12 confirmed rows exceed one page, so the pager appears and the viewport pins.
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...submission,
      id: `submission-${index}`,
      subject: `记录 ${index + 1}`,
      deliveryStatus: "confirmed" as const,
      errorCode: null,
      errorMessage: null,
    }));
    mount(many);

    const list = document.querySelector<HTMLDivElement>(".sending-status-list");
    expect(list?.style.height).not.toBe("");
    expect(list?.style.overflowY).toBe("auto");
    const pinned = list?.style.height;

    // A page holds 5 rows; the pager reports 3 pages.
    expect(document.querySelectorAll(".sending-status-row").length).toBe(5);
    expect(document.querySelector(".sending-status-pager")).not.toBeNull();
    expect(document.querySelector(".sending-status-pager-status")?.textContent).toContain("3");

    // Turning the page changes the rows but keeps the pinned viewport size.
    const nextButton = document.querySelector<HTMLButtonElement>('button[aria-label*="下一页"]');
    act(() => nextButton?.click());
    expect(document.querySelectorAll(".sending-status-row").length).toBe(5);
    expect(list?.style.height).toBe(pinned);
    expect(list?.style.overflowY).toBe("auto");

    // Switching to a filter with fewer rows (0 confirmed views) resets the page
    // and, when the filtered set no longer overflows, releases the lock.
    const activeButton = Array.from(document.querySelectorAll<HTMLButtonElement>(".sending-status-filter button"))
      .find((button) => button.textContent?.includes("正在核对"));
    act(() => activeButton?.click());
    expect(document.querySelectorAll(".sending-status-row").length).toBe(0);
    expect(document.querySelector(".sending-status-pager")).toBeNull();
    expect(list?.style.height).toBe("");
    expect(list?.style.overflowY).toBe("");
  });
});
