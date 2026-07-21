import { describe, expect, it } from "vitest";
import { summarizeComposeAttachments } from "./attachmentWorkflow";

describe("compose attachment summary", () => {
  it("keeps rejected local files out of the visible and reserved attachment totals", () => {
    const summary = summarizeComposeAttachments(
      [{ size: 2_048 }],
      [
        { file: { size: 1_024 }, phase: "uploading", retryable: true },
        { file: { size: 10 * 1024 * 1024 + 1 }, phase: "error", retryable: false },
        { file: { size: 4_096 }, phase: "error", retryable: true },
      ],
    );

    expect(summary).toEqual({
      attachedCount: 1,
      attachedBytes: 2_048,
      uploadingCount: 1,
      failedCount: 2,
      reservedCount: 3,
      reservedBytes: 7_168,
    });
  });
});
