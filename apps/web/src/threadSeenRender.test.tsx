// @vitest-environment jsdom
/**
 * Rendering fixture for the reader's local read/unread change.
 *
 * The reader resolves the open message from three places in order — the loaded
 * list, the server thread snapshot (`threadExtras`), and the strip membership
 * map `threadStripMembersRef` — and only the first two are state. A member that
 * lives only in the ref therefore needs the revision bump to become visible.
 * App.tsx is too large to mount in a unit test, so this fixture mirrors that
 * resolution order and the patch call exactly (threads.ts applySeenToThread +
 * revision state) to pin the contract the reader relies on.
 */
import { act, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { applySeenToThread, type ThreadSnapshot } from "./threads";
import type { Message } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    accountId: "account-1",
    accountEmail: "me@example.com",
    providerName: "Example Mail",
    mailbox: "INBOX",
    uid: 1,
    subject: "Subject",
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    sentAt: "2026-07-20T00:00:00.000Z",
    snippet: "",
    textBody: "",
    htmlBody: "",
    flags: [],
    seen: false,
    flagged: false,
    hasAttachments: false,
    attachments: [],
    size: 1,
    ...overrides,
  };
}

type ReaderFixtureProps = {
  list: Message[];
  extras: ThreadSnapshot | null;
  initialStrip: ReadonlyMap<string, Message>;
  selectedId: string;
  /** Models the state bump App.tsx performs; false reproduces its absence. */
  bumpOnChange: boolean;
};

function ReaderFixture({ list, extras: initialExtras, initialStrip, selectedId, bumpOnChange }: ReaderFixtureProps): ReactElement {
  const [extras, setExtras] = useState(initialExtras);
  const stripRef = useRef(initialStrip);
  const [, setRevision] = useState(0);

  // Same order as App.tsx: loaded list, then extras, then the retained map.
  const selected = list.find((item) => item.id === selectedId)
    ?? extras?.members.find((item) => item.id === selectedId)
    ?? stripRef.current.get(selectedId)
    ?? null;

  const markSeen = (): void => {
    if (!selected) return;
    const patch = applySeenToThread(extras, stripRef.current, selected.id, true);
    stripRef.current = patch.strip;
    if (patch.extras !== extras) setExtras(patch.extras);
    if (patch.changed && bumpOnChange) setRevision((value) => value + 1);
  };

  return (
    <div>
      <span data-reader>{selected ? (selected.seen ? "read" : "unread") : "none"}</span>
      <button type="button" data-mark-seen onClick={markSeen}>mark seen</button>
    </div>
  );
}

function mount(props: ReaderFixtureProps): { container: HTMLDivElement; click: () => Promise<void>; unmount: () => void } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => { root.render(<ReaderFixture {...props} />); });
  return {
    container,
    click: async () => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-mark-seen]")?.click();
      });
    },
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

function readerText(container: HTMLElement): string {
  return container.querySelector("[data-reader]")?.textContent ?? "";
}

describe("reader snapshot seen rendering", () => {
  it("re-renders a member that only the strip ref holds after the revision bump", async () => {
    const mounted = mount({
      list: [],
      extras: null,
      initialStrip: new Map([["sent-only", message({ id: "sent-only" })]]),
      selectedId: "sent-only",
      bumpOnChange: true,
    });
    expect(readerText(mounted.container)).toBe("unread");
    await mounted.click();
    expect(readerText(mounted.container)).toBe("read");
    mounted.unmount();
  });

  it("shows why the bump exists: patching only the ref leaves the reader stale", async () => {
    const mounted = mount({
      list: [],
      extras: null,
      initialStrip: new Map([["sent-only", message({ id: "sent-only" })]]),
      selectedId: "sent-only",
      bumpOnChange: false,
    });
    await mounted.click();
    // The map now says seen, but no render happened, so the reader still
    // paints the old value — the exact defect the revision state fixes.
    expect(readerText(mounted.container)).toBe("unread");
    mounted.unmount();
  });

  it("re-renders through the extras state when the member lives there", async () => {
    const mounted = mount({
      list: [],
      extras: { anchorId: "sent-only", members: [message({ id: "sent-only" })] },
      initialStrip: new Map(),
      selectedId: "sent-only",
      bumpOnChange: true,
    });
    expect(readerText(mounted.container)).toBe("unread");
    await mounted.click();
    expect(readerText(mounted.container)).toBe("read");
    mounted.unmount();
  });
});
