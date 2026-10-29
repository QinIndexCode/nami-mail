// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MailCalendarInviteBanner, { clearIcsParseCache } from "./MailCalendarInviteBanner";
import { api } from "../api";
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
    clearIcsParseCache();
    // vi.mock is module-scoped, so call history leaks across tests without this.
    vi.mocked(api.downloadAttachment).mockClear();
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

  it("serves repeated selections of the same attachment from the cache without re-downloading", async () => {
    const attachmentsWithIcs: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];
    const downloadMock = vi.mocked(api.downloadAttachment);

    const renderInto = (target: Root) => {
      act(() => {
        target.render(
          <I18nProvider>
            <MailCalendarInviteBanner
              messageId="msg-cache"
              attachments={attachmentsWithIcs}
              onImportClick={onImportClick}
              onViewCalendar={onViewCalendar}
            />
          </I18nProvider>,
        );
      });
    };

    renderInto(root);
    await act(async () => {});
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Product Strategy Sync");

    // A fresh mount forces the effect to re-run; the parse cache must serve
    // the second visit without another network round-trip.
    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    renderInto(secondRoot);
    await act(async () => {});
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(secondContainer.textContent).toContain("Product Strategy Sync");

    act(() => secondRoot.unmount());
    secondContainer.remove();
  });

  it("evicts the least recently used entry once the entry cap is exceeded", async () => {
    // The cache is bounded (see the LRU note in the component). The entry cap
    // is the reachable one in a test: 64MB of real ICS text would have to be
    // downloaded to trip the byte cap, so filling 512 tiny entries exercises
    // the same eviction loop.
    const entryCap = 512;
    const attachmentsWithIcs: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];
    const downloadMock = vi.mocked(api.downloadAttachment);

    const select = async (messageId: string) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <MailCalendarInviteBanner
              messageId={messageId}
              attachments={attachmentsWithIcs}
              onImportClick={onImportClick}
              onViewCalendar={onViewCalendar}
            />
          </I18nProvider>,
        );
      });
    };

    // Fill the cache to exactly the cap; every visit is a distinct
    // "messageId:partId" key, so each one downloads once.
    for (let index = 0; index < entryCap; index += 1) {
      await select(`msg-lru-${index}`);
    }
    expect(downloadMock).toHaveBeenCalledTimes(entryCap);
    expect(container.textContent).toContain("Product Strategy Sync");

    // Touch the oldest entry so it is no longer the eviction candidate, then
    // overflow the cap by one. A pure FIFO would evict "msg-lru-0" here; LRU
    // must evict "msg-lru-1" instead.
    await select("msg-lru-0");
    expect(downloadMock).toHaveBeenCalledTimes(entryCap);
    await select("msg-lru-overflow");
    expect(downloadMock).toHaveBeenCalledTimes(entryCap + 1);

    // The refreshed entry survived the overflow...
    await select("msg-lru-0");
    expect(downloadMock).toHaveBeenCalledTimes(entryCap + 1);
    expect(container.textContent).toContain("Product Strategy Sync");
    // ...while the genuinely least recently used one was dropped and has to be
    // fetched again. Without eviction this assertion cannot distinguish a
    // working cache from a leaked one.
    await select("msg-lru-1");
    expect(downloadMock).toHaveBeenCalledTimes(entryCap + 2);
  }, 45_000);

  it("rejects oversized attachments before downloading", async () => {
    const oversized: MessageAttachment[] = [
      { partId: "9", filename: "huge.ics", contentType: "text/calendar", size: 10_000_001, related: false, disposition: "attachment" },
    ];

    await act(async () => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-2"
            attachments={oversized}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    expect(api.downloadAttachment).not.toHaveBeenCalled();
    expect(container.querySelector(".mail-calendar-invite-error")).not.toBeNull();
    expect(container.textContent).toContain("10MB");
  });

  it("does not re-download when attachments reference changes while download is in flight or completed", async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const downloadPromise = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    vi.mocked(api.downloadAttachment).mockImplementationOnce(() => downloadPromise);

    const attachments1: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];

    // Initial render kicks off download #1
    act(() => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-race"
            attachments={attachments1}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);

    // Simulated message body load update: fresh array and object reference
    const attachments2: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];

    act(() => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-race"
            attachments={attachments2}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    // Should NOT have triggered a second download
    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);

    // Now resolve the in-flight download
    await act(async () => {
      resolveDownload(new Blob([mockSampleIcs], { type: "text/calendar" }));
    });

    expect(container.textContent).toContain("Product Strategy Sync");
    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("shares in-flight download promise across concurrent banner instances", async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const downloadPromise = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    vi.mocked(api.downloadAttachment).mockImplementationOnce(() => downloadPromise);

    const attachments: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];

    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);

    act(() => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-concurrent"
            attachments={attachments}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
      secondRoot.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-concurrent"
            attachments={attachments}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    // Only one network download initiated
    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDownload(new Blob([mockSampleIcs], { type: "text/calendar" }));
    });

    expect(container.textContent).toContain("Product Strategy Sync");
    expect(secondContainer.textContent).toContain("Product Strategy Sync");

    act(() => secondRoot.unmount());
    secondContainer.remove();
  });

  it("caches in-flight download result even if component unmounts before resolution", async () => {
    let resolveDownload: (blob: Blob) => void = () => {};
    const downloadPromise = new Promise<Blob>((resolve) => {
      resolveDownload = resolve;
    });
    vi.mocked(api.downloadAttachment).mockImplementationOnce(() => downloadPromise);

    const attachments: MessageAttachment[] = [
      { partId: "1", filename: "invite.ics", contentType: "text/calendar", size: 512, related: false, disposition: "attachment" },
    ];

    act(() => {
      root.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-unmount-cache"
            attachments={attachments}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);

    // Unmount before download finishes
    act(() => {
      root.unmount();
    });

    // Download completes in background
    await act(async () => {
      resolveDownload(new Blob([mockSampleIcs], { type: "text/calendar" }));
    });

    // Re-mount a new instance: should hit cache without calling downloadAttachment again
    const newContainer = document.createElement("div");
    document.body.appendChild(newContainer);
    const newRoot = createRoot(newContainer);

    await act(async () => {
      newRoot.render(
        <I18nProvider>
          <MailCalendarInviteBanner
            messageId="msg-unmount-cache"
            attachments={attachments}
            onImportClick={onImportClick}
            onViewCalendar={onViewCalendar}
          />
        </I18nProvider>,
      );
    });

    expect(api.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(newContainer.textContent).toContain("Product Strategy Sync");

    act(() => newRoot.unmount());
    newContainer.remove();
    root = createRoot(container);
  });
});
