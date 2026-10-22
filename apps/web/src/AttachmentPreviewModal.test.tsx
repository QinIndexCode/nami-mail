// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";import type { BinaryRequestOptions } from "./api";
import AttachmentPreviewModal from "./AttachmentPreviewModal";
import { I18nProvider, translate } from "./i18n";

const zh = (key: string, values?: Record<string, string | number>) => translate("zh-CN", key, values);

function renderModal(attachment: { partId: string; filename: string; contentType: string; size: number } | null): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AttachmentPreviewModal messageId="message-1" attachment={attachment} onClose={() => undefined} />
    </I18nProvider>,
  );
}

describe("attachment preview modal", () => {
  it("renders nothing without an attachment", () => {
    expect(renderModal(null)).toBe("");
  });

  it("shows the title, filename and a loading state for a previewable file", () => {
    const markup = renderModal({ partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 });

    expect(markup).toContain('id="attachment-preview-title"');
    expect(markup).toContain(zh("mail.attachment.previewTitle"));
    expect(markup).toContain("report.pdf");
    expect(markup).toContain(zh("mail.attachment.previewLoading"));
    expect(markup).not.toContain(zh("mail.attachment.previewUnsupported"));
  });

  it("renders as an in-flow drawer keeping the dialog semantics", () => {
    const markup = renderModal({ partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 });

    expect(markup).toContain("attachment-preview-drawer");
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("aria-modal=\"false\"");
    // The pane sits next to the message; no backdrop overlay is rendered.
    expect(markup).not.toContain("backdrop");
  });

  it("declines unsupported file types without fetching", () => {
    const markup = renderModal({ partId: "part-2", filename: "bundle.zip", contentType: "application/zip", size: 1024 });

    expect(markup).toContain(zh("mail.attachment.previewUnsupported"));
    expect(markup).not.toContain(zh("mail.attachment.previewLoading"));
  });
});

/**
 * WEB-1, at the layer where the behavior actually lives: the drawer's Escape
 * handler is a capture-phase window listener, and the only thing that keeps
 * the reader behind it from closing in the same keypress is
 * stopImmediatePropagation. Asserting that in dialogRouting.test.tsx (which
 * never mounts the modal) can only reach the unreachable fallback branch, so
 * it stays green if the capture wiring is deleted outright.
 */
describe("attachment preview modal escape routing (WEB-1)", () => {
  const previewable = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };

  it("closes the drawer alone and never lets the Escape reach the shell chain", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    // Mirrors App's global listener: window, bubble phase, no capture.
    const shellKeydown = vi.fn();
    window.addEventListener("keydown", shellKeydown);

    // Control: the identical dispatch DOES reach a bubbling window listener
    // while nothing is mounted, so the negative assertion below cannot pass
    // for the trivial reason that the probe was never wired up.
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(shellKeydown).toHaveBeenCalledTimes(1);
    shellKeydown.mockClear();

    const onClose = vi.fn();
    const root: Root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <AttachmentPreviewModal
              messageId="message-1"
              attachment={previewable}
              onClose={onClose}
              fetchBlob={async () => new Blob(["pdf"], { type: "application/pdf" })}
            />
          </I18nProvider>,
        );
      });
      // Escape is pressed where a real user presses it: on the focused drawer,
      // so the event walks the capture path and meets the modal's window
      // listener before it can bubble back out to the shell.
      const drawer = container.querySelector(".attachment-preview-drawer");
      expect(drawer).not.toBeNull();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => {
        drawer!.dispatchEvent(event);
      });
      expect(shellKeydown).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      // The same requestClose → onClose path the X button uses; the dismiss
      // transition delays it by the CSS exit duration.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", shellKeydown);
      await act(async () => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = "";
    }
  });
});

/**
 * The drawer used to abandon a superseded preview with a local `active` flag:
 * the result was dropped, but the transfer kept streaming a blob that nobody
 * would ever read. It now hands a signal to the transport, so superseding the
 * preview actually stops the request.
 */
describe("attachment preview transfer cancellation", () => {
  const pdf = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };
  const doc = { partId: "part-2", filename: "notes.txt", contentType: "text/plain", size: 1024 };

  it("aborts the superseded transfer when another attachment is opened", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const signals: AbortSignal[] = [];
    // Never settles, like a wedged local service: the drawer's state machine
    // must not depend on the transfer finishing to stay correct.
    const fetchBlob = vi.fn((_messageId: string, _partId: string, options?: BinaryRequestOptions) => {
      signals.push(options!.signal!);
      return new Promise<Blob>(() => undefined);
    });
    const root: Root = createRoot(container);
    const render = (attachment: typeof pdf) => root.render(
      <I18nProvider>
        <AttachmentPreviewModal messageId="message-1" attachment={attachment} onClose={() => undefined} fetchBlob={fetchBlob} />
      </I18nProvider>,
    );
    try {
      await act(async () => { render(pdf); });
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      // The reader opens a different attachment in the same drawer.
      await act(async () => { render(doc); });
      expect(fetchBlob).toHaveBeenCalledTimes(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
    } finally {
      await act(async () => { root.unmount(); });
      // Closing the drawer stops the last transfer too.
      expect(signals[1].aborted).toBe(true);
      container.remove();
      document.body.innerHTML = "";
    }
  });
});

/**
 * The drawer width is a real splitter, not a fixed CSS breakpoint: it must be
 * operable without a pointer (WCAG 2.1.1) and must survive reopening, which is
 * why the value is written to storage on every committed change.
 */
describe("attachment preview resizing", () => {
  const pdf = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    // jsdom's localStorage is an opaque-origin stub without the Storage API in
    // this setup, so the drawer would silently fall back to its default width.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() { return storage.size; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mountDrawer() {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider>
          <AttachmentPreviewModal
            messageId="message-1"
            attachment={pdf}
            onClose={() => undefined}
            fetchBlob={async () => new Blob(["pdf"], { type: "application/pdf" })}
          />
        </I18nProvider>,
      );
    });
    return { container, root };
  }

  async function press(target: HTMLElement, key: string) {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  it("resizes from the keyboard and remembers the width", async () => {
    const { container, root } = await mountDrawer();
    try {
      const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
      const separator = container.querySelector<HTMLElement>("[role='separator']");
      expect(drawer).not.toBeNull();
      expect(separator).not.toBeNull();
      expect(separator!.getAttribute("aria-orientation")).toBe("vertical");
      expect(separator!.getAttribute("aria-valuenow")).toBe("480");

      await press(separator!, "ArrowLeft");
      expect(drawer!.style.getPropertyValue("--attachment-preview-width")).toBe("504px");
      expect(separator!.getAttribute("aria-valuenow")).toBe("504");
      expect(storage.get("nami.attachment-preview-width")).toBe("504");

      await press(separator!, "ArrowRight");
      expect(drawer!.style.getPropertyValue("--attachment-preview-width")).toBe("480px");

      // Home/End jump to the same bounds advertised to assistive technology.
      await press(separator!, "End");
      expect(separator!.getAttribute("aria-valuenow")).toBe(String(Math.round(window.innerWidth * 0.82)));
      await press(separator!, "Home");
      expect(separator!.getAttribute("aria-valuenow")).toBe(separator!.getAttribute("aria-valuemin"));
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      document.body.innerHTML = "";
    }
  });

  it("restores the default width on double click", async () => {
    const { container, root } = await mountDrawer();
    try {
      const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
      const separator = container.querySelector<HTMLElement>("[role='separator']");
      await press(separator!, "ArrowLeft");
      expect(drawer!.style.getPropertyValue("--attachment-preview-width")).toBe("504px");

      await act(async () => {
        separator!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
      expect(drawer!.style.getPropertyValue("--attachment-preview-width")).toBe("480px");
      expect(storage.get("nami.attachment-preview-width")).toBe("480");
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      document.body.innerHTML = "";
    }
  });
});
