import { describe, expect, it } from "vitest";
import { newMessageDraftFromSubmission } from "./sendingStatus";
import { submissionNoticeMessage } from "./SendingStatusModal";
import type { OutboundSubmission } from "./types";

describe("partial recipient recovery", () => {
  const submission = { accountId: "account", subject: "Subject", recipients: ["accepted@example.test", "copy@example.test", "hidden@example.test"], toRecipients: ["accepted@example.test"], ccRecipients: ["copy@example.test"], bccRecipients: ["hidden@example.test"], deliveryStatus: "confirmed", recipientDelivery: { accepted: ["accepted@example.test", "copy@example.test"], rejected: [{ address: "hidden@example.test", responseCode: 550 }] } } as OutboundSubmission;
  it("creates a retry for rejected addresses only, retaining BCC visibility", () => {
    expect(newMessageDraftFromSubmission(submission)).toEqual({ accountId: "account", subject: "Subject", bcc: "hidden@example.test" });
  });
  it("shows rejection even after the provider Sent copy has been confirmed", () => {
    expect(submissionNoticeMessage(submission)).toContain("hidden@example.test");
  });
});
