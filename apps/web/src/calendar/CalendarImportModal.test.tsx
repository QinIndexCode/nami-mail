// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CalendarImportModal from "./CalendarImportModal";
import { I18nProvider } from "../i18n";

vi.mock("../api", () => ({
  api: {
    importCalendarEvents: vi.fn().mockResolvedValue({ ok: true, imported: 2, replaced: false }),
  },
}));

describe("CalendarImportModal", () => {
  let root: Root;
  let container: HTMLElement;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let onSuccess: ReturnType<typeof vi.fn<(count: number, replaced: boolean) => void>>;

  const sampleIcs = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "BEGIN:VEVENT",
    "UID:event-1@test",
    "SUMMARY:Team Sync",
    "LOCATION:Room 1",
    "DTSTART:20261010T090000Z",
    "DTEND:20261010T100000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:event-2@test",
    "SUMMARY:Release Review",
    "LOCATION:Online",
    "DTSTART:20261012T140000Z",
    "DTEND:20261012T150000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onClose = vi.fn();
    onSuccess = vi.fn();
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders with initial ICS content and displays preview and mode choices", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <CalendarImportModal
            open={true}
            onClose={onClose}
            onSuccess={onSuccess}
            initialIcsContent={sampleIcs}
            initialFileName="invite.ics"
            existingCount={5}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain("invite.ics");
    expect(container.textContent).toContain("Team Sync");
    expect(container.textContent).toContain("Release Review");

    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios.length).toBe(2);
    expect(radios[0]?.checked).toBe(true); // append mode is default
    expect(radios[1]?.checked).toBe(false);

    // Switch to replace mode
    act(() => {
      radios[1]?.click();
    });
    expect(radios[1]?.checked).toBe(true);

    // Verify warning appears
    expect(container.textContent).toContain("将清除现有 5 个日程");
  });
});
