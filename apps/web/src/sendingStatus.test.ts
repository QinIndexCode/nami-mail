import { describe, expect, it, vi } from "vitest";
import { translate } from "./i18n";
import type { OutboundSubmission } from "./types";
import {
  newMessageDraftFromSubmission,
  pollSubmittingSubmission,
  recipientSummary,
  sortSubmissions,
  submissionMessageIdSuffix,
  submissionStatusPresentation,
} from "./sendingStatus";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const baseSubmission: OutboundSubmission = {
  id: "submission-1",
  accountId: "account-1",
  messageId: "<4d36290a-1af2-40d3-a0de-41b4218dbe1c@example.com>",
  deliveryStatus: "unknown_delivery",
  errorCode: "timeout",
  errorMessage: "连接超时。",
  postSubmitWarning: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:01:00.000Z",
};

describe("sending status presentation", () => {
  it("keeps every durable state distinct and warns against retrying unknown delivery", () => {
    expect(submissionStatusPresentation("submitting")).toMatchObject({ label: zh("sending.submitting.label"), tone: "progress" });
    expect(submissionStatusPresentation("submitted")).toMatchObject({ label: zh("sending.submitted.label"), tone: "progress" });
    expect(submissionStatusPresentation("confirmed")).toMatchObject({ label: zh("sending.confirmed.label"), tone: "success" });
    expect(submissionStatusPresentation("unknown_delivery")).toMatchObject({ label: zh("sending.unknownDelivery.label"), tone: "warning" });
    expect(submissionStatusPresentation("failed")).toMatchObject({ label: zh("sending.failed.label"), tone: "danger" });
    expect(submissionStatusPresentation("unknown_delivery").detail).toBe(zh("sending.unknownDelivery.detail"));
    expect(submissionStatusPresentation("submitted").detail).toBe(zh("sending.submitted.detail"));
    expect(submissionStatusPresentation("confirmed").detail).toBe(zh("sending.confirmed.detail"));
  });

  it("limits the visible recipient summary to three while retaining the total", () => {
    expect(recipientSummary(["a@example.com", "b@example.com", "c@example.com", "d@example.com"]))
      .toBe(zh("sending.recipientsMore", { recipients: "a@example.com、b@example.com、c@example.com", count: 4 }));
    expect(recipientSummary([])).toBeNull();
  });

  it("creates a fresh compose draft from summary fields without exposing or replaying a body", () => {
    const draft = newMessageDraftFromSubmission({
      ...baseSubmission,
      subject: "状态更新",
      recipients: ["one@example.com", "two@example.com"],
    });
    expect(draft).toEqual({
      accountId: "account-1",
      to: "one@example.com, two@example.com",
      subject: "状态更新",
    });
    expect(draft).not.toHaveProperty("text");
    expect(draft).not.toHaveProperty("messageId");
  });

  it("sorts newest records first and uses a short non-sensitive Message-ID suffix", () => {
    const older = { ...baseSubmission, id: "older", updatedAt: "2026-07-20T07:00:00.000Z" };
    const newer = { ...baseSubmission, id: "newer", updatedAt: "2026-07-20T09:00:00.000Z" };
    expect(sortSubmissions([older, newer]).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(submissionMessageIdSuffix(baseSubmission.messageId)).toBe("b4218dbe1c");
  });

  it("short-polls submitting records without converting them to unknown delivery", async () => {
    const submitting = { ...baseSubmission, deliveryStatus: "submitting" as const };
    const lookup = async () => ({ ...submitting, deliveryStatus: "submitted" as const });
    await expect(pollSubmittingSubmission(submitting, lookup, { wait: async () => undefined }))
      .resolves.toMatchObject({ deliveryStatus: "submitted" });

    await expect(pollSubmittingSubmission(submitting, async () => submitting, {
      attempts: 2,
      wait: async () => undefined,
    })).resolves.toMatchObject({ deliveryStatus: "submitting" });
  });

  it("keeps a bounded client refresh active while Sent-folder verification can still change the record", async () => {
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("__NAMI_APP_VERSION__", "0.1.0");
    const { submissionStatusNeedsRefresh } = await import("./App");

    expect(submissionStatusNeedsRefresh("submitting")).toBe(true);
    expect(submissionStatusNeedsRefresh("submitted")).toBe(true);
    expect(submissionStatusNeedsRefresh("unknown_delivery")).toBe(true);
    expect(submissionStatusNeedsRefresh("confirmed")).toBe(false);
    expect(submissionStatusNeedsRefresh("failed")).toBe(false);

    vi.unstubAllGlobals();
  });
});
