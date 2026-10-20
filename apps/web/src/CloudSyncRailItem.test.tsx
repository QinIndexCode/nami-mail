// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CloudSyncRailItem } from "./CloudSyncRailItem";
import type { CloudSyncTasks } from "./app/useCloudSyncTasks";
import type { DeliveryTask, DeliveryTaskKind } from "./batchJobTypes";
import { translate, type Translate } from "./i18n";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const t: Translate = (key, values) => translate("zh-CN", key, values);

function task(overrides: Partial<DeliveryTask> = {}): DeliveryTask {
  return {
    id: "task-1",
    accountId: "acc-1",
    accountEmail: "me@example.com",
    kind: "move",
    scope: "batch",
    status: "running",
    total: 5,
    updated: 0,
    failed: 0,
    createdAt: 1,
    completedAt: null,
    dueAt: null,
    ...overrides,
  };
}

function tasks(overrides: Partial<CloudSyncTasks> = {}): CloudSyncTasks {
  return {
    syncing: [],
    attention: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
    applyProgress: vi.fn(),
    applySettled: vi.fn(),
    ...overrides,
  };
}

describe("CloudSyncRailItem", () => {
  let host: HTMLDivElement;
  let root: Root;

  function mount(overrides: Partial<CloudSyncTasks> = {}): CloudSyncTasks {
    const value = tasks(overrides);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<CloudSyncRailItem tasks={value} t={t} locale="zh-CN" />);
    });
    return value;
  }

  /** The panel is unmounted until the trigger is pressed, and its exit
   *  transition keeps it mounted for another 140ms after a close. */
  async function waitForExit(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
    });
  }

  const trigger = () => document.querySelector<HTMLButtonElement>(".rail-item .icon-button")!;
  const panel = () => document.querySelector<HTMLElement>(".cloud-sync-panel");
  const openPanel = () => { act(() => trigger().click()); };

  afterEach(() => {
    act(() => root.unmount());
    host?.remove();
  });

  it("counts everything outstanding on the trigger, not just the failures", () => {
    mount({ syncing: [task({ id: "a" }), task({ id: "b" })], attention: [task({ id: "c", completedAt: 9, failed: 1 })] });

    expect(trigger().querySelector(".rail-badge")?.textContent).toBe("3");
    // The badge is a count, so it must not be the only thing a screen reader
    // gets: it is hidden and the button's own label carries the meaning.
    expect(trigger().querySelector(".rail-badge")?.getAttribute("aria-hidden")).toBe("true");
    expect(trigger().getAttribute("aria-label")).toBe(t("cloudSync.open"));
    // `attention` is what colours the rail item: work that stopped short is the
    // one state worth interrupting the quiet of the rail for.
    expect(trigger().classList.contains("attention")).toBe(true);
  });

  it("stays unmarked and uncounted when nothing is outstanding", () => {
    mount();
    expect(trigger().querySelector(".rail-badge")).toBeNull();
    expect(trigger().classList.contains("attention")).toBe(false);
  });

  it("hangs a named, non-modal panel off the button and labels both sections", () => {
    mount({ syncing: [task({ id: "a", total: 5, updated: 0 })], attention: [task({ id: "b", completedAt: 9, failed: 2 })] });
    openPanel();

    const surface = panel()!;
    expect(surface).not.toBeNull();
    expect(surface.getAttribute("role")).toBe("dialog");
    expect(surface.getAttribute("aria-label")).toBe(t("cloudSync.title"));
    // Non-modal: no scrim, no aria-modal, and nothing behind it is disabled.
    expect(surface.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector(".scrim")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // Each list names itself, so a screen reader announces "正在同步, list"
    // rather than a list of unknown rows.
    const lists = [...surface.querySelectorAll("ul")];
    expect(lists).toHaveLength(2);
    const headings = lists.map((list) => document.getElementById(list.getAttribute("aria-labelledby")!)?.textContent);
    expect(headings).toEqual([t("cloudSync.syncingSection"), t("cloudSync.attentionSection")]);
  });

  it("renders a row as the action, the account and what the numbers support", () => {
    mount({ syncing: [task({ id: "a", kind: "flags", total: 7, updated: 3 })] });
    openPanel();

    const row = panel()!.querySelector(".cloud-sync-row")!;
    expect(row.querySelector(".cloud-sync-kind")?.textContent).toBe(t("cloudSync.kind.flags"));
    expect(row.querySelector(".cloud-sync-account")?.textContent).toBe("me@example.com");
    // The full address is the tooltip: the row truncates it rather than wrapping.
    expect(row.querySelector(".cloud-sync-account")?.getAttribute("data-tooltip")).toBe("me@example.com");
    expect(row.querySelector(".cloud-sync-detail")?.textContent).toBe(t("cloudSync.progress", { updated: 3, total: 7 }));
    // A task still being written to is the normal state, so it gets no alarm
    // background; `problem` is for rows that have already ended badly.
    expect(row.classList.contains("problem")).toBe(false);
  });

  it("names a kind this build does not know instead of hiding the task", () => {
    mount({ syncing: [task({ id: "a", kind: "vacuum" as DeliveryTaskKind })] });
    openPanel();

    expect(panel()!.querySelector(".cloud-sync-kind")?.textContent).toBe(t("cloudSync.kind.other"));
  });

  it("shows a failed row's own message and marks it as a problem", () => {
    mount({ attention: [task({ id: "a", completedAt: 9, failed: 2, error: { code: "E", message: "mailbox full" } })] });
    openPanel();

    const row = panel()!.querySelector(".cloud-sync-row")!;
    expect(row.classList.contains("problem")).toBe(true);
    expect(row.querySelector(".cloud-sync-detail")?.textContent).toBe(t("cloudSync.failedDetail", { failed: 2, total: 5 }));
    expect(row.querySelector(".cloud-sync-message")?.textContent).toBe("mailbox full");
  });

  it("separates the first read from an empty list", () => {
    mount({ loading: true });
    openPanel();
    expect(panel()!.querySelector(".cloud-sync-note")?.textContent).toBe(t("cloudSync.loading"));

    act(() => root.unmount());
    host.remove();
    mount();
    openPanel();
    expect(panel()!.querySelector(".cloud-sync-note")?.textContent).toBe(t("cloudSync.allClear"));
  });

  it("keeps a failed read's news visible and lets the user retry it", () => {
    const value = mount({ failed: true });
    openPanel();

    const note = panel()!.querySelector(".cloud-sync-note-error")!;
    expect(note.textContent).toContain(t("cloudSync.loadFailed"));
    // A failed read with nothing to show must not also claim all-clear.
    expect(panel()!.textContent).not.toContain(t("cloudSync.allClear"));

    expect(value.refresh, "opening asks the server once").toHaveBeenCalledTimes(1);
    act(() => note.querySelector<HTMLButtonElement>(".cloud-sync-retry")!.click());
    expect(value.refresh).toHaveBeenCalledTimes(2);
  });

  it("re-reads on open and keeps reading while it stays open", async () => {
    vi.useFakeTimers();
    try {
      const value = mount();
      openPanel();
      // Opening is a read, not a guess: the panel can be opened long after the
      // last frame, and a session with the stream down has had no frame at all.
      expect(value.refresh).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(value.refresh, "the open panel polls").toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(value.refresh).toHaveBeenCalledTimes(3);

      // A closed panel costs nothing: the poll dies with the open state. The
      // exit transition keeps the panel mounted for a moment, so let it finish
      // before measuring what the closed state does.
      act(() => { trigger().click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      const afterClose = vi.mocked(value.refresh).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(value.refresh, "a closed panel stops polling").toHaveBeenCalledTimes(afterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes on Escape, keeping the press from anything behind it", async () => {
    mount({ syncing: [task()] });
    openPanel();

    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    window.removeEventListener("keydown", outside);

    expect(outside, "the press must not also reach the host dialog").not.toHaveBeenCalled();
    // Closing is an exit transition: the surface is still in the DOM, marked.
    expect(panel()!.classList.contains("closing")).toBe(true);
    await waitForExit();
    expect(panel()).toBeNull();
  });

  it("ignores every key that is not Escape", () => {
    mount({ syncing: [task()] });
    openPanel();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    });
    expect(panel()!.classList.contains("closing")).toBe(false);
  });

  it("does not operate the mail the same press was aimed at", async () => {
    mount({ syncing: [task()] });
    openPanel();

    // A press outside is dismissed on `pointerdown`, before the control under
    // the cursor acts — otherwise one press would close the panel and click
    // whatever it was covering.
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()!.classList.contains("closing")).toBe(true);
    await waitForExit();
    expect(panel()).toBeNull();
  });

  it("stays open while the press is inside it", () => {
    mount({ syncing: [task()] });
    openPanel();
    act(() => {
      panel()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(panel()!.classList.contains("closing")).toBe(false);
  });

  it("toggles closed on a second press of the trigger", async () => {
    mount({ syncing: [task()] });
    openPanel();
    expect(panel()).not.toBeNull();

    act(() => trigger().click());
    await waitForExit();
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves focus into the panel and hands it back to the trigger", async () => {
    mount({ syncing: [task()] });
    openPanel();
    expect(document.activeElement).toBe(panel());

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    // Back on the trigger before the surface is gone: the panel is leaving
    // either way, and focus inside it would land on the document body.
    expect(document.activeElement).toBe(trigger());
    await waitForExit();
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus where a click outside put it", async () => {
    mount({ syncing: [task()] });
    openPanel();
    expect(document.activeElement).toBe(panel());

    // The click has already chosen where focus belongs; the panel must not pull
    // it back to a trigger the user did not press.
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await waitForExit();
    expect(document.activeElement).not.toBe(trigger());
  });
});
