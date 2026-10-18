import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import type { OutboundSubmission } from "./types";
import {
  isStaleSubmissionSnapshot,
  mergeSubmissionSnapshots,
  newMessageDraftFromSubmission,
  pollSubmittingSubmission,
  recipientSummary,
  sortSubmissions,
  submissionInFlight,
  submissionMessageIdSuffix,
  submissionStatusNeedsRefresh,
  submissionStatusPresentation,
} from "./sendingStatus";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

const baseSubmission: OutboundSubmission = {
  id: "submission-1",
  accountId: "account-1",
  messageId: "<4d36290a-1af2-40d3-a0de-41b4218dbe1c@example.com>",
  // The server always serializes the display-only subject and recipients.
  subject: "状态更新",
  recipients: ["one@example.com", "two@example.com"],
  deliveryStatus: "unknown_delivery",
  sendAt: null,
  errorCode: "timeout",
  errorMessage: "连接超时。",
  postSubmitWarning: null,
  submittedAt: null,
  confirmedAt: null,
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:01:00.000Z",
};

describe("submission snapshot merging", () => {
  const current = { ...baseSubmission, deliveryStatus: "confirmed" as const, updatedAt: "2026-07-20T08:05:00.000Z" };

  it("keeps a newer status when a slower snapshot describes an earlier moment", () => {
    // The verification poll and an action finishing both refresh the list; the
    // older response must not un-confirm a send the user already saw succeed.
    const stale = { ...baseSubmission, deliveryStatus: "submitting" as const, updatedAt: "2026-07-20T08:02:00.000Z" };

    expect(isStaleSubmissionSnapshot(stale, current)).toBe(true);
    expect(mergeSubmissionSnapshots([stale], [current])).toEqual([current]);
  });

  it("falls back to the status progression when the timestamps are equal", () => {
    const sameMoment = { ...current, deliveryStatus: "submitted" as const };

    expect(isStaleSubmissionSnapshot(sameMoment, current)).toBe(true);
    expect(mergeSubmissionSnapshots([sameMoment], [current])).toEqual([current]);
  });

  it("accepts a later snapshot and rows it has never seen", () => {
    const advanced = { ...baseSubmission, deliveryStatus: "confirmed" as const, updatedAt: "2026-07-20T08:09:00.000Z" };
    const fresh = { ...baseSubmission, id: "submission-2", updatedAt: "2026-07-20T08:09:00.000Z" };

    expect(mergeSubmissionSnapshots([advanced, fresh], [current])).toEqual([advanced, fresh]);
  });

  it("drops rows the user cancelled even when the snapshot still reports them", () => {
    // The server list can lag a cancellation by a moment; re-adding the row is
    // exactly the "the cancelled mail came back" bug.
    expect(mergeSubmissionSnapshots([baseSubmission], [baseSubmission], { cancelledIds: new Set([baseSubmission.id]) }))
      .toEqual([]);
  });
});

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

  it("survives a submission whose recipients field never arrived", () => {
    // OutboundSubmission.recipients is a compile-time contract only — api.ts
    // hands the parsed body straight to the renderer as a bare assertion — so
    // a malformed payload reaches this as undefined/null. Throwing here took
    // the whole sending-status modal down with it; the modal's own
    // `?? "recipientsMissing"` guard only covers the empty case.
    expect(recipientSummary(undefined as unknown as string[])).toBeNull();
    expect(recipientSummary(null as unknown as string[])).toBeNull();
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

  it("polls a queued send, because the acceptance returns before any attempt exists", async () => {
    // The route now commits the ledger row and its dispatch task and answers
    // `pending`; the attempt happens afterwards. Leaving the loop keyed on
    // `submitting` alone would return on the first check and report a send that
    // had not been tried yet as finished.
    const queued = { ...baseSubmission, deliveryStatus: "pending" as const };
    let lookups = 0;
    const advanced = async () => {
      lookups += 1;
      return { ...queued, deliveryStatus: "submitted" as const };
    };

    await expect(pollSubmittingSubmission(queued, advanced, { wait: async () => undefined }))
      .resolves.toMatchObject({ deliveryStatus: "submitted" });
    expect(lookups).toBe(1);

    // And it still stops on `pending`: a task the scheduler has not claimed
    // leaves the record queued, and the caller says so rather than hanging.
    await expect(pollSubmittingSubmission(queued, async () => queued, {
      attempts: 2,
      wait: async () => undefined,
    })).resolves.toMatchObject({ deliveryStatus: "pending" });
  });

  it("treats exactly the two unsettled statuses as in flight", () => {
    expect(submissionInFlight("pending")).toBe(true);
    expect(submissionInFlight("submitting")).toBe(true);
    expect(submissionInFlight("submitted")).toBe(false);
    expect(submissionInFlight("confirmed")).toBe(false);
    expect(submissionInFlight("unknown_delivery")).toBe(false);
    expect(submissionInFlight("failed")).toBe(false);
  });

  it("keeps a bounded client refresh active while Sent-folder verification can still change the record", () => {
    expect(submissionStatusNeedsRefresh("submitting")).toBe(true);
    expect(submissionStatusNeedsRefresh("submitted")).toBe(true);
    expect(submissionStatusNeedsRefresh("unknown_delivery")).toBe(true);
    // `pending` is the value a send parked on a future sendAt holds for hours,
    // so refreshing on it would keep the view polling parked mail.
    expect(submissionStatusNeedsRefresh("pending")).toBe(false);
    expect(submissionStatusNeedsRefresh("confirmed")).toBe(false);
    expect(submissionStatusNeedsRefresh("failed")).toBe(false);
  });
});
