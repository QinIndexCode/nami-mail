// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ResourceScope } from "../document";
import { documentWith, markup, zh } from "../testing/surfaceHarness";
import TextSurface from "./TextSurface";

const scope = new ResourceScope();
const onDownload = () => undefined;

describe("TextSurface", () => {
  it("renders the retained text as a text node, never as markup", () => {
    const document = documentWith({ surface: "text", text: "<script>alert(1)</script>", shown: 25, total: 25 });
    const html = markup(<TextSurface document={document} scope={scope} onDownload={onDownload} />);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("shows the truncation line only when the prefix is shorter than the file", () => {
    const truncated = markup(
      <TextSurface
        document={documentWith({ surface: "text", text: "abc", shown: 3, total: 9_000 })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(truncated).toContain(zh("mail.attachment.previewTruncated", { count: 3, total: 9_000 }));
    const whole = markup(
      <TextSurface
        document={documentWith({ surface: "text", text: "abc", shown: 3, total: 3 })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(whole).not.toContain(zh("mail.attachment.previewTruncated"));
  });

  it("accepts focus so the long text can be scrolled from the keyboard", () => {
    const html = markup(
      <TextSurface
        document={documentWith({ surface: "text", text: "abc", shown: 3, total: 3 })}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("attachment-preview-text");
  });

  it("renders markdown text through the same surface (S2 has no parser)", () => {
    const html = markup(
      <TextSurface
        document={documentWith(
          { surface: "markdown", text: "# Title", shown: 7, total: 7 },
          { kind: "markdown", filename: "notes.md", contentType: "text/markdown" },
        )}
        scope={scope}
        onDownload={onDownload}
      />,
    );
    expect(html).toContain("# Title");
  });

  it("copies the retained text", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container, unmount } = await import("../testing/surfaceHarness").then(({ mount }) =>
      mount(
        <TextSurface
          document={documentWith({ surface: "text", text: "copy me", shown: 7, total: 7 })}
          scope={scope}
          onDownload={onDownload}
        />,
      ),
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    button?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));
    await unmount();
  });
});
