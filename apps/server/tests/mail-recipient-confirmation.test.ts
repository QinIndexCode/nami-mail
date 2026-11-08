import { describe, expect, it } from "vitest";
import { externalSendMailInputSchema, externalDraftUpdateInputSchema } from "@nami/agent-contracts";
import { sendMailConfirmationPreview, draftConfirmationPreview, replyMailConfirmationPreview } from "../src/agent/confirmation-preview.js";
import { mailRecipientFields } from "../src/agent/mail-write-recipients.js";

describe("BCC contracts and confirmation", () => {
  const input = { accountId: "account-1", to: [{ address: "visible@example.test" }], cc: [{ address: "copy@example.test" }], bcc: [{ address: "hidden@example.test" }], subject: "Subject", text: "Synthetic" };
  it("accepts BCC separately, including an explicit removal from a draft", () => {
    expect(externalSendMailInputSchema.parse({ ...input, bcc: "hidden@example.test" }).bcc).toEqual(input.bcc);
    const update = externalDraftUpdateInputSchema.parse({ ...input, draftId: "draft-1", bcc: [] });
    expect(mailRecipientFields(update).bcc).toEqual([]);
  });
  it("shows the approving user BCC separately in send, draft and reply previews", () => {
    const previews = [sendMailConfirmationPreview("zh-CN", input), draftConfirmationPreview("zh-CN", input), replyMailConfirmationPreview("zh-CN", { ...input, messageId: "message-1" })];
    for (const preview of previews) {
      expect(preview.fields.find((field) => field.label === "密送")?.value).toBe("hidden@example.test");
      expect(preview.fields.find((field) => field.label === "抄送")?.value).toBe("copy@example.test");
    }
  });
});
