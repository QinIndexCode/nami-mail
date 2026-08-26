import { describe, expect, it } from "vitest";
import { parseMailtoUrl } from "./mailtoLink";

describe("parseMailtoUrl", () => {
  it("returns undefined for anything that is not a mailto link", () => {
    expect(parseMailtoUrl("https://example.com/send?to=a@b.c")).toBeUndefined();
    expect(parseMailtoUrl("")).toBeUndefined();
    expect(parseMailtoUrl("mailto")).toBeUndefined();
  });

  it("parses a plain address", () => {
    expect(parseMailtoUrl("mailto:user@example.com")).toEqual({ to: "user@example.com" });
  });

  it("accepts a scheme in any case", () => {
    expect(parseMailtoUrl("MAILTO:user@example.com")).toEqual({ to: "user@example.com" });
  });

  it("parses subject and body parameters", () => {
    expect(parseMailtoUrl("mailto:user@example.com?subject=Hello&body=Hi%20there"))
      .toEqual({ to: "user@example.com", subject: "Hello", text: "Hi there" });
  });

  it("decodes plus signs as spaces inside query parameters", () => {
    expect(parseMailtoUrl("mailto:user@example.com?subject=hello+world"))
      .toEqual({ to: "user@example.com", subject: "hello world" });
  });

  it("decodes a percent-encoded display name form", () => {
    expect(parseMailtoUrl("mailto:Jane%20Doe%20%3Cjane%40example.com%3E"))
      .toEqual({ to: "Jane Doe <jane@example.com>" });
  });

  it("merges multiple to, cc, and bcc addresses, folding bcc into cc", () => {
    expect(parseMailtoUrl("mailto:?to=a@x.com&to=b@x.com&cc=c@x.com&bcc=d@x.com"))
      .toEqual({ to: "a@x.com, b@x.com", cc: "c@x.com, d@x.com" });
  });

  it("supports the RFC 6068 to-parameter when the path is empty", () => {
    expect(parseMailtoUrl("mailto:?to=user@example.com&subject=Surprise"))
      .toEqual({ to: "user@example.com", subject: "Surprise" });
  });

  it("keeps a malformed percent sequence instead of throwing", () => {
    expect(parseMailtoUrl("mailto:user@example.com?subject=%zz")).toEqual({ to: "user@example.com", subject: "%zz" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseMailtoUrl("  mailto:user@example.com  ")).toEqual({ to: "user@example.com" });
  });

  it("omits empty fields from the draft", () => {
    expect(parseMailtoUrl("mailto:user@example.com?body=")).toEqual({ to: "user@example.com" });
  });
});