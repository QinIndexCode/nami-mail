// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import AttachmentPreviewModal from "./AttachmentPreviewModal";
import { I18nProvider } from "./i18n";

const previewAttachment = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };

function flushFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe("attachment preview modal focus restoration", () => {
  let root: Root;
  let container: HTMLElement;
  let trigger: HTMLButtonElement;
  let attachment: typeof previewAttachment | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    trigger = document.createElement("button");
    document.body.appendChild(trigger);
    attachment = null;
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    trigger.remove();
    document.body.innerHTML = "";
  });

  function mount() {
    return act(async () => {
      root.render(
        <I18nProvider>
          <AttachmentPreviewModal
            messageId="message-1"
            attachment={attachment}
            onClose={() => undefined}
            fetchBlob={async () => new Blob(["pdf"], { type: "application/pdf" })}
          />
        </I18nProvider>,
      );
    });
  }

  it("moves focus into the drawer on open and restores it to the trigger on close", async () => {
    trigger.focus();
    await mount();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      attachment = previewAttachment;
    });
    await mount();
    expect(document.activeElement).toBe(container.querySelector(".attachment-preview-drawer"));

    await act(async () => {
      attachment = null;
    });
    await mount();
    await flushFrame();
    expect(document.activeElement).toBe(trigger);
  });

  it("remembers the trigger across attachment switches, not the drawer", async () => {
    trigger.focus();
    await act(async () => {
      attachment = previewAttachment;
    });
    await mount();

    // Switch to a second attachment while the drawer stays open: the focus
    // target is not re-captured, so closing still restores the trigger.
    await act(async () => {
      attachment = { ...previewAttachment, partId: "part-2", filename: "notes.txt", contentType: "text/plain" };
    });
    await mount();
    expect(document.activeElement).toBe(container.querySelector(".attachment-preview-drawer"));

    await act(async () => {
      attachment = null;
    });
    await mount();
    await flushFrame();
    expect(document.activeElement).toBe(trigger);
  });
});