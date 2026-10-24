// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { documentWith, markup, mount } from "../testing/surfaceHarness";
import MarkdownSurface from "./MarkdownSurface";

const onDownload = () => undefined;

const surface = (text: string) =>
  documentWith({ surface: "markdown", text, shown: text.length, total: text.length }, {
    kind: "markdown",
    filename: "notes.md",
    contentType: "text/markdown",
  });

describe("MarkdownSurface", () => {
  it("renders the Markdown subset it is given", () => {
    const html = markup(<MarkdownSurface document={surface("# Title\n\n**bold**")} onDownload={onDownload} />);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("intercepts an external link and hands it to the opener instead of navigating", async () => {
    const opener = vi.fn();
    const { container, unmount } = await mount(
      <MarkdownSurface document={surface("[docs](https://example.com/guide)")} onDownload={onDownload} openExternal={opener} />,
    );
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/guide");
    expect(anchor?.getAttribute("rel")).toBe("noreferrer noopener");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const notPrevented = anchor?.dispatchEvent(event) ?? true;
    expect(notPrevented).toBe(false);
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith("https://example.com/guide");
    await unmount();
  });

  it("leaves mailto to the app's own handler", async () => {
    const opener = vi.fn();
    const { container, unmount } = await mount(
      <MarkdownSurface document={surface("[mail](mailto:someone@example.com)")} onDownload={onDownload} openExternal={opener} />,
    );
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("mailto:someone@example.com");
    expect(anchor?.getAttribute("target")).toBeNull();
    // jsdom cannot navigate; swallowing the default keeps the click focused on
    // what the test is about: the component adds no handler of its own.
    const swallow = (event: Event) => event.preventDefault();
    document.addEventListener("click", swallow);
    try {
      anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener("click", swallow);
    }
    expect(opener).not.toHaveBeenCalled();
    await unmount();
  });

  it("turns any other scheme into text", () => {
    const html = markup(
      <MarkdownSurface document={surface("[run](javascript:alert(1)) [file](file:///etc/passwd)")} onDownload={onDownload} />,
    );
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("run");
    expect(html).toContain("file");
  });

  it("never loads a remote image", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = markup(<MarkdownSurface document={surface("![chart](https://evil.example/pixel.png)")} onDownload={onDownload} />);
    expect(html).not.toContain("<img");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).toContain('aria-label="chart"');
    fetchSpy.mockRestore();
  });

  it("drops raw HTML instead of injecting it", () => {
    const html = markup(
      <MarkdownSurface
        document={surface('<script>alert(1)</script><img src="x" onerror="alert(2)">')}
        onDownload={onDownload}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });
});
