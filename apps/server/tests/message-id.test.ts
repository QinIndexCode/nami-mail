import { describe, expect, it } from "vitest";
import { messageIdSchema } from "../src/message-id.js";

/**
 * The schema exists because the three read routes answered 400 for every id sync
 * produces. These cases pin both real shapes and the strings that must stay out,
 * so a later "simplification" back to `z.string().uuid()` fails here instead of
 * silently locking the attachment path again.
 */
describe("message id schema", () => {
  it("accepts the 32-hex id sync and drafts derive", () => {
    expect(messageIdSchema.safeParse("2f1c6a3e4b7d4c8e9f101a2b3c4d5e6f").success).toBe(true);
  });

  it("accepts the uuid a pending-sent placeholder is minted with", () => {
    expect(messageIdSchema.safeParse("2f1c6a3e-4b7d-4c8e-9f10-1a2b3c4d5e6f").success).toBe(true);
    expect(messageIdSchema.safeParse("00000000-0000-4000-8000-000000000000").success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["a route-shaped label", "message-1"],
    ["31 hex characters", "2f1c6a3e4b7d4c8e9f101a2b3c4d5e6"],
    ["33 hex characters", "2f1c6a3e4b7d4c8e9f101a2b3c4d5e6f0"],
    ["a uuid with a path segment", "2f1c6a3e-4b7d-4c8e-9f10-1a2b3c4d5e6f/../x"],
    ["non-hex characters", "2f1c6a3e-4b7d-4c8e-9f10-1a2b3c4d5e6z"],
  ])("rejects %s", (_label, value) => {
    expect(messageIdSchema.safeParse(value).success).toBe(false);
  });
});
