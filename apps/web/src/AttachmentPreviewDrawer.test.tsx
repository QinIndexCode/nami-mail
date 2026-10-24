// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentPreviewDrawer from "./AttachmentPreviewDrawer";
import { setAttachmentResponseProvider } from "./attachments/ingress";
import { zh } from "./attachments/testing/surfaceHarness";
import { I18nProvider } from "./i18n";

type PreviewAttachment = {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
};

const pdf = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };
const text = { partId: "part-2", filename: "notes.txt", contentType: "text/plain", size: 1024 };

async function mountDrawer(
  attachment: PreviewAttachment | null,
  { onClose = () => undefined }: { onClose?: () => void } = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = (next: PreviewAttachment | null) =>
    act(async () => {
      root.render(
        <I18nProvider>
          <AttachmentPreviewDrawer messageId="message-1" attachment={next} onClose={onClose} />
        </I18nProvider>,
      );
    });
  await render(attachment);
  return { container, root, render };
}

const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let latestRoot: Root | null = null;
let latestContainer: HTMLElement | null = null;

beforeEach(() => {
  setAttachmentResponseProvider(null);
  latestRoot = null;
  latestContainer = null;
});

afterEach(async () => {
  const root = latestRoot;
  latestRoot = null;
  if (root) await act(async () => root.unmount());
  latestContainer?.remove();
  latestContainer = null;
  document.body.innerHTML = "";
  setAttachmentResponseProvider(null);
  vi.useRealTimers();
});

async function openDrawer(
  attachment: PreviewAttachment | null,
  options: { onClose?: () => void } = {},
) {
  const mounted = await mountDrawer(attachment, options);
  latestRoot = mounted.root;
  latestContainer = mounted.container;
  return mounted;
}

describe("AttachmentPreviewDrawer", () => {
  it("renders nothing at all when the reader has no attachment open", async () => {
    const { container } = await openDrawer(null);
    expect(container.querySelector(".attachment-preview-drawer")).toBeNull();
  });

  it("shows the loading state, then the composed surface, with drawer semantics", async () => {
    let release: (response: Response) => void = () => undefined;
    setAttachmentResponseProvider(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const { container } = await openDrawer(text);
    expect(container.querySelector(".attachment-preview-drawer")?.getAttribute("role")).toBe("dialog");
    expect(container.querySelector(".attachment-preview-drawer")?.getAttribute("aria-modal")).toBe("false");
    expect(container.textContent).toContain(zh("mail.attachment.previewLoading"));

    await act(async () => release(new Response("hello drawer", { status: 200 })));
    await flush();
    expect(container.querySelector(".attachment-preview-loading")).toBeNull();
    expect(container.textContent).toContain("hello drawer");
    const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
    expect(drawer?.style.getPropertyValue("--attachment-preview-width")).toBe("480px");
    expect(container.querySelector("[role='separator']")?.getAttribute("aria-orientation")).toBe("vertical");
    expect(container.querySelector("[role='separator']")?.getAttribute("aria-valuemin")).toBe("320");
  });

  it("opens a download-only kind without requesting a single byte", async () => {
    const provider = vi.fn();
    setAttachmentResponseProvider(provider);
    // Deliberately not a verbatim migration of the old case, which used
    // `bundle.zip`: zip is a tier-B archive now (it renders a listing), so it
    // would fetch. `.psd` is `other` → fallback → tier C, which is the property
    // this case has always been about: zero network requests.
    const { container } = await openDrawer({
      partId: "part-3",
      filename: "art.psd",
      contentType: "application/octet-stream",
      size: 40 * 1024 * 1024,
    });
    await flush();
    expect(provider).not.toHaveBeenCalled();
    expect(container.textContent).toContain(zh("mail.attachment.previewDownloadOnly"));
    expect(container.textContent).toContain(zh("mail.attachment.previewUnsupported"));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("offers a retry after a transport failure, and the retry runs the attempt again", async () => {
    const provider = vi.fn(async () => new Response("nope", { status: 500 }));
    setAttachmentResponseProvider(provider);
    const { container } = await openDrawer(pdf);
    await flush();
    expect(container.querySelector("[role='alert']")?.textContent).toContain(zh("mail.attachment.previewFailed"));
    expect(provider).toHaveBeenCalledTimes(1);

    await act(async () => container.querySelector<HTMLButtonElement>(".attachment-preview-retry")?.click());
    await flush();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape once the dismiss transition has run, without closing the reader", async () => {
    const onClose = vi.fn();
    setAttachmentResponseProvider(async () => new Response("abc"));
    const { container } = await openDrawer(text, { onClose });
    await flush();
    const shellKeydown = vi.fn();
    window.addEventListener("keydown", shellKeydown);
    try {
      const drawer = container.querySelector(".attachment-preview-drawer");
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      await act(async () => {
        drawer?.dispatchEvent(event);
      });
      expect(shellKeydown).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", shellKeydown);
    }
  });

  it("aborts the superseded transfer when another attachment is opened, and the last one on unmount", async () => {
    const signals: AbortSignal[] = [];
    const hangUntilAborted = vi.fn((_messageId: string, _partId: string, options: { signal?: AbortSignal }) => {
      const signal = options.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    setAttachmentResponseProvider(hangUntilAborted);
    const { render } = await openDrawer(pdf);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    await render(text);
    expect(hangUntilAborted).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    await act(async () => latestRoot!.unmount());
    latestRoot = null;
    expect(signals[1].aborted).toBe(true);
  });

  it("resizes from the keyboard and remembers the width", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    });
    setAttachmentResponseProvider(async () => new Response("abc"));
    const { container } = await openDrawer(text);
    const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
    const separator = container.querySelector<HTMLElement>("[role='separator']");
    expect(separator?.getAttribute("aria-valuenow")).toBe("480");

    const press = (key: string) =>
      act(async () => {
        separator?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    await press("ArrowLeft");
    expect(drawer?.style.getPropertyValue("--attachment-preview-width")).toBe("504px");
    expect(storage.get("nami.attachment-preview-width")).toBe("504");
    await press("End");
    expect(separator?.getAttribute("aria-valuenow")).toBe(String(Math.round(window.innerWidth * 0.82)));
    await press("Home");
    expect(separator?.getAttribute("aria-valuenow")).toBe(separator?.getAttribute("aria-valuemin"));
    vi.unstubAllGlobals();
  });

  it("restores the default width on double click", async () => {
    setAttachmentResponseProvider(async () => new Response("abc"));
    const { container } = await openDrawer(text);
    const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
    const separator = container.querySelector<HTMLElement>("[role='separator']");
    await act(async () => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(drawer?.style.getPropertyValue("--attachment-preview-width")).toBe("504px");
    await act(async () => {
      separator?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(drawer?.style.getPropertyValue("--attachment-preview-width")).toBe("480px");
  });

  it("resizes by dragging the handle and persists the width when the drag ends", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    });
    setAttachmentResponseProvider(async () => new Response("abc"));
    const { container } = await openDrawer(text);
    const drawer = container.querySelector<HTMLElement>(".attachment-preview-drawer");
    const separator = container.querySelector<HTMLElement>("[role='separator']");
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 7 });
      return event;
    };

    await act(async () => {
      separator?.dispatchEvent(pointer("pointerdown", 600));
    });
    // The handle is the drawer's left edge, so dragging left widens it.
    await act(async () => {
      separator?.dispatchEvent(pointer("pointermove", 560));
    });
    expect(drawer?.style.getPropertyValue("--attachment-preview-width")).toBe("520px");
    expect(document.body.classList.contains("is-resizing-attachment-preview")).toBe(true);

    await act(async () => {
      separator?.dispatchEvent(pointer("pointerup", 560));
    });
    expect(storage.get("nami.attachment-preview-width")).toBe("520");
    expect(document.body.classList.contains("is-resizing-attachment-preview")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("marks the drawer as closing during the dismiss transition", async () => {
    const onClose = vi.fn();
    setAttachmentResponseProvider(async () => new Response("abc"));
    const { container } = await openDrawer(text, { onClose });
    await flush();
    const drawer = () => container.querySelector(".attachment-preview-drawer");
    expect(drawer()?.classList.contains("closing")).toBe(false);
    await act(async () => {
      drawer()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(drawer()?.classList.contains("closing")).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(drawer()?.classList.contains("closing")).toBe(false);
  });

  it("keeps the moved drawer rules, including the mobile entrance/exit animations", () => {
    // The old modal's CSS lived in two unrelated files and no test could see
    // the move; the drawer is a plain DOM node, so the mobile rules are CSS
    // animations rather than classes. Guard the move at the source.
    const css = readFileSync(resolve(process.cwd(), "src/styles/features/attachment-preview.css"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(css).toContain("animation:.3s cubic-bezier(.2,.8,.2,1) both drawer-squeeze-in");
    expect(css).toContain("drawer-squeeze-out");
    expect(css).toContain("drawer-mobile-in");
    expect(css).toContain("drawer-mobile-out");
    expect(css).toContain(".attachment-preview-scroll");
    expect(css).toMatch(/@media \(width<=760px\) \{\s*\.attachment-preview-drawer\s*\{/);
    expect(css).toContain(".attachment-preview-resizer\n{\ndisplay:none");
  });
});
