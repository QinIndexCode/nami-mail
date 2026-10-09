import { describe, expect, it, vi } from "vitest";
import { resolveDraftBody } from "./draftBody";
import type { Message } from "../types";

const baseMessage = (overrides: Partial<Message> = {}): Message => ({
  id: "draft-1",
  accountId: "account-1",
  mailbox: "Drafts",
  subject: "Draft",
  from: { name: "", address: "me@example.com" },
  to: [],
  cc: [],
  snippet: "Preview text",
  textBody: "Preview text",
  hasAttachments: false,
  seen: true,
  flagged: false,
  attachments: [],
  sentAt: "2026-10-09T00:00:00.000Z",
  ...overrides,
} as Message);

describe("resolveDraftBody", () => {
  it("fetches the full draft when the list row carries no body", async () => {
    const full = baseMessage({ textBody: "Preview text and the rest of the draft body", htmlBody: "<p>full</p>" });
    const fetchMessage = vi.fn(async () => full);

    const resolution = await resolveDraftBody(baseMessage(), { isDemo: false, fetchMessage });

    expect(fetchMessage).toHaveBeenCalledWith("draft-1");
    expect(resolution).toEqual({ ok: true, draft: full });
  });

  it("fails instead of opening the editor on the preview when the fetch fails", async () => {
    const fetchMessage = vi.fn(async () => {
      throw new Error("network gone");
    });

    const resolution = await resolveDraftBody(baseMessage(), { isDemo: false, fetchMessage });

    expect(resolution).toEqual({ ok: false, error: expect.any(Error) });
  });

  it("passes a list row that already carries the body straight through", async () => {
    const inline = baseMessage({ htmlBody: "<p>already complete</p>" });
    const fetchMessage = vi.fn();

    const resolution = await resolveDraftBody(inline, { isDemo: false, fetchMessage });

    expect(fetchMessage).not.toHaveBeenCalled();
    expect(resolution).toEqual({ ok: true, draft: inline });
  });

  it("keeps demo-mode drafts client-side without any fetch", async () => {
    const demo = baseMessage();
    const fetchMessage = vi.fn();

    const resolution = await resolveDraftBody(demo, { isDemo: true, fetchMessage });

    expect(fetchMessage).not.toHaveBeenCalled();
    expect(resolution).toEqual({ ok: true, draft: demo });
  });
});
