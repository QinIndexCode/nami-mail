import { describe, expect, it, vi } from "vitest";
import { PreviewFailure } from "./failure";
import { assertSameOriginAssetUrl, asDownloadOnly, downloadOnlySurface, ownObjectUrl, ResourceScope } from "./document";

describe("ResourceScope", () => {
  it("disposes in LIFO order", () => {
    const scope = new ResourceScope();
    const order: string[] = [];
    scope.own("first", undefined, () => order.push("first"));
    scope.own("second", undefined, () => order.push("second"));
    scope.own("third", undefined, () => order.push("third"));
    scope.dispose();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("is idempotent and revokes one object URL exactly once", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-1");
    const scope = new ResourceScope();
    const url = scope.own("object-url", create(new Blob(["x"])), (value) => URL.revokeObjectURL(value));
    scope.dispose();
    scope.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(url);
    expect(scope.disposed).toBe(true);
    create.mockRestore();
    revoke.mockRestore();
  });

  it("mints an object URL already owned by the scope", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const scope = new ResourceScope();
    expect(ownObjectUrl(scope, new Blob(["x"]))).toBe("blob:owned");
    expect(create).toHaveBeenCalledTimes(1);
    scope.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:owned");
    create.mockRestore();
    revoke.mockRestore();
  });

  it("releases a late registration immediately instead of stranding it", () => {
    const dispose = vi.fn();
    const scope = new ResourceScope();
    scope.dispose();
    scope.own("late", "value", dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith("value");
  });

  it("keeps going when one disposer throws", () => {
    const scope = new ResourceScope();
    const after = vi.fn();
    scope.own("broken", undefined, () => {
      throw new Error("dispose failed");
    });
    scope.own("healthy", undefined, after);
    expect(() => scope.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("pdf.js asset invariant", () => {
  it("accepts a same-origin /pdfjs/ asset URL", () => {
    expect(() => assertSameOriginAssetUrl("/pdfjs/cmaps/")).not.toThrow();
    expect(() => assertSameOriginAssetUrl("http://localhost/pdfjs/standard_fonts/")).not.toThrow();
  });

  it("throws a plain Error (no failure code) for a foreign origin", () => {
    let caught: unknown;
    try {
      assertSameOriginAssetUrl("https://evil.example/pdfjs/cmaps/");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(PreviewFailure);
    expect((caught as { code?: string }).code).toBeUndefined();
    expect((caught as Error).message).toContain("same-origin");
  });

  it("throws for a same-origin path outside /pdfjs/", () => {
    expect(() => assertSameOriginAssetUrl("/api/messages/1/attachments/2")).toThrow(Error);
  });
});

describe("download-only surfaces", () => {
  it("uses one primary key for all four reasons", () => {
    for (const reason of ["unsupported", "mime", "encrypted", "size"] as const) {
      expect(downloadOnlySurface(reason)).toEqual({
        surface: "download_only",
        reason,
        messageKey: "mail.attachment.previewDownloadOnly",
      });
    }
  });

  it("re-wraps a decoded document without losing its identity", () => {
    const document = {
      kind: "markdown" as const,
      filename: "notes.md",
      contentType: "text/markdown",
      size: 12,
      surface: { surface: "text" as const, text: "hi", shown: 2, total: 2 },
    };
    const wrapped = asDownloadOnly(document, "size");
    expect(wrapped.surface).toEqual(downloadOnlySurface("size"));
    expect(wrapped.filename).toBe("notes.md");
    expect(wrapped.kind).toBe("markdown");
  });
});
