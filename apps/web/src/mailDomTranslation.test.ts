// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyMailTranslation, extractMailTextSegments } from "./mailDomTranslation";

function parse(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

describe("extractMailTextSegments", () => {
  it("collects visible text nodes in document order", () => {
    const root = parse("<h1>Title</h1><p>Hello <b>bold</b> world</p>");
    const segments = extractMailTextSegments(root);
    expect(segments.map((segment) => segment.text)).toEqual(["Title", "Hello ", "bold", " world"]);
  });

  it("skips script/style/textarea content", () => {
    const root = parse("<p>Visible</p><script>const x = 1;</script><style>p { color: red }</style><textarea>ignored</textarea>");
    const segments = extractMailTextSegments(root);
    expect(segments.map((segment) => segment.text)).toEqual(["Visible"]);
  });

  it("skips empty and whitespace-only nodes", () => {
    const root = parse("<p>  </p><p>A</p><div>   \n  </div><span>B</span>");
    const segments = extractMailTextSegments(root);
    expect(segments.map((segment) => segment.text)).toEqual(["A", "B"]);
  });

  it("returns empty for content-less documents", () => {
    const root = parse("<div></div>");
    expect(extractMailTextSegments(root)).toEqual([]);
  });
});

describe("applyMailTranslation", () => {
  it("writes the translation back into the correct node", () => {
    const root = parse("<h1>Title</h1><p>Hello <b>bold</b> world</p>");
    const segments = extractMailTextSegments(root);
    // Translate the "bold" node (path should point at it).
    const boldNode = root.querySelector("b")?.firstChild;
    const boldSegment = segments.find((segment) => segment.text === "bold");
    expect(boldSegment).toBeDefined();
    const applied = applyMailTranslation(root, boldSegment!.path, "加粗");
    expect(applied).toBe(boldNode);
    expect(root.querySelector("b")?.textContent).toBe("加粗");
    // Unchanged nodes are untouched.
    expect(root.querySelector("h1")?.textContent).toBe("Title");
  });

  it("returns null when the path no longer resolves", () => {
    const root = parse("<p>A</p>");
    const applied = applyMailTranslation(root, [999], "X");
    expect(applied).toBeNull();
  });

  it("round-trips: extract -> apply keeps the document structure", () => {
    const original = parse("<ul><li>One</li><li>Two</li></ul><a href=\"https://x.test\">Link</a>");
    const segments = extractMailTextSegments(original);
    const translations = segments.map((segment, index) => `T${index}`);
    for (let index = 0; index < segments.length; index++) {
      applyMailTranslation(original, segments[index]!.path, translations[index]!);
    }
    // Structure and attributes survive.
    expect(original.querySelector("a")?.getAttribute("href")).toBe("https://x.test");
    expect(original.querySelectorAll("li").length).toBe(2);
    expect(original.querySelector("li")?.textContent).toBe("T0");
  });
});
