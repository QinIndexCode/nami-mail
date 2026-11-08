import { beforeEach, describe, expect, it, vi } from "vitest";
const { events } = vi.hoisted(() => ({ events: vi.fn() }));
vi.mock("./api", () => ({ api: { calendarEvents: events } }));
import { loadCalendarEvents } from "./dialogPrefetch";

describe("complete calendar loading", () => {
  beforeEach(() => events.mockReset());
  it("loads every page and retains the requested reminder range", async () => {
    events.mockResolvedValueOnce({ items: [{ id: "past" }], nextCursor: "next" }).mockResolvedValueOnce({ items: [{ id: "current" }] });
    const range = { after: "2026-11-01T00:00:00Z", before: "2026-12-01T00:00:00Z" };
    expect((await loadCalendarEvents(range)).map((item) => item.id)).toEqual(["past", "current"]);
    expect(events).toHaveBeenNthCalledWith(2, range, 1000, "next");
  });
  it("rejects a repeated cursor instead of looping or presenting a partial calendar", async () => {
    events.mockResolvedValue({ items: [], nextCursor: "repeat" });
    await expect(loadCalendarEvents()).rejects.toThrow("did not advance");
    expect(events).toHaveBeenCalledTimes(2);
  });
});
