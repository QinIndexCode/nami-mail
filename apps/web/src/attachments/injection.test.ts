// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryLease } from "./budget";
import { decodeImage, decodeMarkdown, decodeOffice } from "./decode";
import { ResourceScope, type DecodeContext, type PreviewInput, type PreviewDocument } from "./document";
import { surfaceComponentFor } from "./render/registry";
import { encodeFixtureText, makeDocx } from "./testing/fixtures";
import { mount } from "./testing/surfaceHarness";

/**
 * The four injection classes the plan calls out (`<script>`, `<img onerror>`,
 * `javascript:` URLs, SVG `onload`) across the three paths that can carry
 * attacker-authored markup: Markdown, OOXML text, and SVG.
 *
 * "0 execution" is checked against a global the payloads try to write, because
 * an assertion about markup alone would miss a payload that is silently
 * evaluated. "0 network" is a `fetch` spy plus the absence of `<img>` elements:
 * the only URL in the DOM is the preview's own `blob:`.
 */

type Probe = { __previewXss?: string };

const probe = (): Probe => window as unknown as Probe;

const context = (): DecodeContext => ({
  scope: new ResourceScope(),
  lease: new MemoryLease(),
  signal: new AbortController().signal,
  now: () => Date.now(),
  deadlineMs: 15_000,
});

const input = (bytes: Uint8Array, kind: PreviewInput["kind"], filename: string, contentType: string): PreviewInput => ({
  kind,
  filename,
  contentType,
  size: bytes.byteLength,
  bytes: bytes as Uint8Array<ArrayBuffer>,
  blob: new Blob([bytes.slice()]),
});

const MARKDOWN_HOSTILE = [
  '<script>window.__previewXss = "script"</script>',
  '<img src="https://evil.example/pixel.png" onerror="window.__previewXss = \'img\'">',
  "[click](javascript:window.__previewXss='link')",
  '<svg onload="window.__previewXss = \'svg\'"></svg>',
].join("\n\n");

const OFFICE_HOSTILE = '<script>window.__previewXss = "docx"</script><img src=x onerror="window.__previewXss = \'docx-img\'">';

const SVG_HOSTILE = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="window.__previewXss = 'onload'">
<script>window.__previewXss = "svg-script"</script>
<image href="https://evil.example/pixel.png" width="10" height="10"/>
<text x="1" y="10">safe text</text>
</svg>`;

async function renderDocument(document: PreviewDocument, name: Parameters<typeof surfaceComponentFor>[0]) {
  const Surface = surfaceComponentFor(name);
  const scope = new ResourceScope();
  // `createElement` rather than JSX so the file keeps the planned `.ts` path.
  const mounted = await mount(createElement(Surface, { document, scope, onDownload: () => undefined }));
  return { ...mounted, scope };
}

beforeEach(() => {
  delete probe().__previewXss;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("injection", () => {
  it("Markdown: drops raw HTML, defuses links, and loads nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const document = decodeMarkdown(
      input(encodeFixtureText(MARKDOWN_HOSTILE), "markdown", "hostile.md", "text/markdown"),
      context(),
    );
    const { container, unmount, scope } = await renderDocument(document, "markdown");

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(probe().__previewXss).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    await unmount();
    scope.dispose();
  });

  it("Office: renders attacker text as text nodes, never as markup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fixture = await makeDocx({ text: OFFICE_HOSTILE });
    const document = await decodeOffice(
      input(fixture.bytes, "office-word", "hostile.docx", "application/vnd.openxmlformats-officedocument"),
      context(),
    );
    const { container, unmount, scope } = await renderDocument(document, "blocks");

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(OFFICE_HOSTILE);
    expect(probe().__previewXss).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    await unmount();
    scope.dispose();
  });

  it("SVG: sanitizes script and onload before the blob URL is minted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg-under-test");
    const document = decodeImage(
      input(encodeFixtureText(SVG_HOSTILE), "image-vector", "hostile.svg", "image/svg+xml"),
      context(),
    );

    const minted = create.mock.calls[0]?.[0] as Blob | undefined;
    expect(minted).toBeInstanceOf(Blob);
    const sanitized = await minted!.text();
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("javascript:");

    const { container, unmount, scope } = await renderDocument(document, "vector");
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:svg-under-test");
    expect(container.querySelector("script")).toBeNull();
    expect(probe().__previewXss).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();

    await unmount();
    scope.dispose();
  });
});
