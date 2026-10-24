// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentPreviewDrawer from "./AttachmentPreviewDrawer";
import { failurePresentation, type FailureCode } from "./attachments/failure";
import { downloadOnlySurface, type PreviewDocument } from "./attachments/document";
import { zh } from "./attachments/testing/surfaceHarness";
import { I18nProvider } from "./i18n";

/**
 * Accessibility contract of the preview pane (plan §4.5 S4 / §12).
 *
 * The session seam is mocked here on purpose: this file is about what the view
 * announces, not about decoding. Every error state is driven by the same
 * `PreviewFailure` the real session throws, so the alert path is the path the
 * app takes.
 */

const session = vi.hoisted(() => ({
  plan: { type: "pending" } as
    | { type: "pending" }
    | { type: "error"; code: FailureCode | null }
    | { type: "document"; document: PreviewDocument },
}));

vi.mock("./attachments/session", async () => {
  const { PreviewFailure } = await import("./attachments/failure");
  return {
    runPreview: async () => {
      const plan = session.plan;
      if (plan.type === "pending") return await new Promise<never>(() => undefined);
      if (plan.type === "error") {
        throw plan.code ? new PreviewFailure(plan.code) : new Error("boom");
      }
      return plan.document;
    },
  };
});

const attachment = { partId: "part-1", filename: "report.pdf", contentType: "application/pdf", size: 1024 };

const documentFor = (surface: PreviewDocument["surface"], filename = attachment.filename): PreviewDocument => ({
  kind: "text",
  filename,
  contentType: attachment.contentType,
  size: attachment.size,
  surface,
});

const flush = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let root: Root | null = null;
let container: HTMLElement | null = null;

async function open(next: typeof attachment | null = attachment): Promise<HTMLElement> {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const mounted: Root = createRoot(host);
  root = mounted;
  container = host;
  await act(async () => {
    mounted.render(
      <I18nProvider>
        <AttachmentPreviewDrawer messageId="message-1" attachment={next} onClose={() => undefined} />
      </I18nProvider>,
    );
  });
  await flush();
  return host;
}

beforeEach(() => {
  session.plan = { type: "pending" };
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("attachment preview drawer accessibility", () => {
  it("is a non-modal dialog named by its own visible heading", async () => {
    const host = await open();
    const drawer = host.querySelector<HTMLElement>(".attachment-preview-drawer");
    expect(drawer?.getAttribute("role")).toBe("dialog");
    expect(drawer?.getAttribute("aria-modal")).toBe("false");

    const labelId = drawer?.getAttribute("aria-labelledby");
    expect(labelId).toBe("attachment-preview-title");
    const heading = host.querySelector<HTMLElement>(`#${labelId}`);
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent?.trim()).toBe(zh("mail.attachment.previewTitle"));

    // Focus lands on the pane itself so a screen reader starts reading here.
    expect(document.activeElement).toBe(drawer);
  });

  it("leaves the reader usable: focus is not trapped inside the pane", async () => {
    const host = await open();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    // A modal trap would pull focus back on focusin/out; a non-modal pane must
    // let it stay wherever the user put it.
    expect(document.activeElement).toBe(outside);
    expect(host.querySelector(".attachment-preview-drawer")).not.toBeNull();
  });

  it("announces loading politely and hides decorative icons from the reader", async () => {
    session.plan = { type: "pending" };
    const host = await open();
    const loading = host.querySelector(".attachment-preview-loading");
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.textContent).toContain(zh("mail.attachment.previewLoading"));
    expect(loading?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes the resize handle as a labelled separator with numeric values", async () => {
    const host = await open();
    const separator = host.querySelector("[role='separator']");
    expect(separator?.getAttribute("aria-orientation")).toBe("vertical");
    expect(separator?.getAttribute("aria-label")).toBe(zh("mail.attachment.previewResize"));

    const min = Number(separator?.getAttribute("aria-valuemin"));
    const max = Number(separator?.getAttribute("aria-valuemax"));
    const now = Number(separator?.getAttribute("aria-valuenow"));
    expect(Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(now)).toBe(true);
    expect(min).toBeLessThan(max);
    expect(now).toBeGreaterThanOrEqual(min);
    expect(now).toBeLessThanOrEqual(max);
  });

  it("shows each of the seven error states as an alert with real copy and a retry", async () => {
    const codes: FailureCode[] = [
      "too_large",
      "too_many_entries",
      "network",
      "corrupt",
      "encrypted",
      "timeout",
      "unsupported",
    ];
    const states = new Set<string>();
    for (const code of codes) {
      session.plan = { type: "error", code };
      const host = await open();
      const alert = host.querySelector("[role='alert']");
      states.add(failurePresentation(code).state);

      expect(alert, code).not.toBeNull();
      const text = alert?.textContent ?? "";
      expect(text.trim().length, code).toBeGreaterThan(0);
      // The drawer interpolates every number itself; a literal placeholder in
      // the alert is the one thing this test is here to catch.
      expect(text, code).not.toContain("{");
      expect(text, code).not.toContain("mail.attachment.");

      const retry = alert?.querySelector("button");
      expect(retry?.textContent, code).toContain(zh("mail.attachment.previewRetry"));
      expect(alert?.querySelector("svg")?.getAttribute("aria-hidden"), code).toBe("true");
    }
    // The seven codes above reach all seven error states; no error state is
    // left without a code that can produce it.
    expect([...states].sort()).toEqual([
      "error_corrupt",
      "error_encrypted",
      "error_network",
      "error_timeout",
      "error_too_large",
      "error_too_many_entries",
      "error_unsupported",
    ]);
  });

  it("announces a download card as status, not as an alert", async () => {
    session.plan = { type: "document", document: documentFor(downloadOnlySurface("unsupported")) };
    const host = await open();
    const card = host.querySelector(".attachment-preview-download-only");
    expect(card?.getAttribute("role")).toBe("status");
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(card?.textContent).toContain(zh("mail.attachment.previewDownloadOnly"));
    expect(card?.textContent).toContain(zh("mail.attachment.previewUnsupported"));
  });

  it("strips bidi controls from the filename it shows", async () => {
    session.plan = { type: "document", document: documentFor({ surface: "text", text: "hi", shown: 2, total: 2 }) };
    const host = await open({ ...attachment, filename: "report\u202Egnp.pdf" });
    const title = host.querySelector(".attachment-preview-heading .truncated-tooltip");
    expect(title?.textContent).toBe("reportgnp.pdf");
    expect(title?.getAttribute("data-tooltip")).toBe("reportgnp.pdf");
    expect(host.querySelector(".attachment-preview-drawer")?.textContent).not.toContain("\u202E");
  });
});
