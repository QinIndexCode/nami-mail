// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MailCalendarInviteBanner from "./MailCalendarInviteBanner";
import { I18nProvider } from "../i18n";
import type { MessageAttachment } from "../types";

const mockSampleIcs = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VEVENT",
  "UID:invite-1@test",
  "SUMMARY:Product Strategy Sync",
  "LOCATION:Conference Room B",
  "DTSTART:20261020T140000Z",
  "DTEND:20261020T153000Z",
  "DESCRIPTION:Q4 planning and review",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

vi.mock("../api", () => ({
  api: {
    downloadAttachment: vi.fn().mockImplementation(async () => {
      return new Blob([mockSampleIcs], { type: "text/calendar" });
    }),
  },
}));

describe("MailCalendarInviteBanner", () => {
  let root: Root;
  let container: HTMLElement;
  let onImportClick: ReturnType<typeof vi.fn<(content: string, filename: string) => void>>;
  let onViewCalendar: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onImportClick = vi.fn();
    onViewCalendar = vi.fn();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders null when there are no ics attachments", () => {
    const regularAttachments: MessageAttachment[] = [
      { partId: "1", filename: "notes.pdf", contentType: "application/pdf", size: 1024, related: false, disposition: "attachment" },
    ];

    act(() => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-1"
            attachments={regularAttachments}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    expect(container.querySelector(".mail-calendar-invite-banner")).toBeNull();
  });

  it("detects ics attachment, loads and parses event, and calls onImportClick on button click", async () => {
    const attachmentsWithIcs: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];

    await act(async () => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-1"
            attachments={attachmentsWithIcs}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    // Verify banner rendered
    const banner = container.querySelector(".mail-calendar-invite-banner");
    expect(banner).not.toBeNull();

    // Verify title and location displayed
    expect(container.textContent).toContain("Product Strategy Sync");
    expect(container.textContent).toContain("Conference Room B");

    // Click "添加到日历"
    const importBtn = container.querySelector<HTMLButtonElement>(".mail-calendar-import-btn");
    expect(importBtn).not.toBeNull();
    act(() => {
      importBtn?.click();
    });

    expect(onImportClick).toHaveBeenCalledTimes(1);
    expect(onImportClick).toHaveBeenCalledWith(mockSampleIcs, "invite.ics");

    // Click "在日历中查看"
    const viewBtn = container.querySelector<HTMLButtonElement>(".mail-calendar-view-btn");
    expect(viewBtn).not.toBeNull();
    act(() => {
      viewBtn?.click();
    });

    expect(onViewCalendar).toHaveBeenCalledTimes(1);
  });
});
