import { describe, expect, it } from "vitest";
import enUS from "../locales/en-US.json";
import zhCN from "../locales/zh-CN.json";
import {
  PageFailure,
  PreviewCanceled,
  PreviewFailure,
  failureCodes,
  failureFromUnknown,
  failurePresentation,
  pageFailureCodes,
  previewFailurePresentations,
  previewStates,
} from "./failure";
import { MAX_IMAGES_PER_PAGE, MAX_PAGE_PIXELS, MAX_PAGES } from "./budget";

const messages = (pack: { messages: Record<string, string> }) => pack.messages;

describe("failure vocabulary", () => {
  it("carries exactly the 14 codes the drawer can show", () => {
    expect(failureCodes).toHaveLength(14);
    expect(new Set(failureCodes).size).toBe(14);
    // v6's asset-origin code was unreachable (the base is derived from
    // location.origin, not injected) and became an invariant in document.ts.
    for (const retired of ["unsafe_asset_origin", "asset_origin", "invalid_asset_origin"]) {
      expect(failureCodes).not.toContain(retired);
    }
  });

  it("pairs every code with a real error state and a resolvable key", () => {
    const errorStates = new Set(previewStates.filter((state) => state.startsWith("error_")));
    for (const code of failureCodes) {
      const presentation = failurePresentation(code);
      expect(presentation.state).toMatch(/^error_/);
      expect(errorStates.has(presentation.state)).toBe(true);
      for (const pack of [zhCN, enUS]) {
        const text = messages(pack)[presentation.messageKey];
        expect(typeof text).toBe("string");
        expect((text ?? "").trim().length).toBeGreaterThan(0);
      }
    }
    // The presentation is exhaustive over the code set: no extra entries.
    expect(Object.keys(previewFailurePresentations).sort()).toEqual([...failureCodes].sort());
  });

  it("reuses the page-level copy for the image budget instead of a 17th key", () => {
    expect(failurePresentation("image_budget_exceeded")).toEqual({
      state: "error_too_large",
      messageKey: "mail.attachment.previewPageTooLarge",
    });
    expect(failurePresentation("too_large").messageKey).toBe("mail.attachment.previewTooLarge");
    expect(failurePresentation("decoded_too_large").messageKey).toBe("mail.attachment.previewTooLarge");
    expect(failurePresentation("pixels_too_large").messageKey).toBe("mail.attachment.previewImageTooLarge");
    expect(failurePresentation("too_many_pages").messageKey).toBe("mail.attachment.previewTooManyPages");
    expect(failurePresentation("too_many_entries").messageKey).toBe("mail.attachment.previewTooManyEntries");
    expect(failurePresentation("zip_bomb").messageKey).toBe("mail.attachment.previewZipBomb");
    expect(failurePresentation("too_many_entries").state).toBe("error_too_many_entries");
    expect(failurePresentation("kind_mismatch").state).toBe("error_unsupported");
    expect(failurePresentation("empty").state).toBe("error_corrupt");
  });

  it("returns only the state and the key (no interpolation values)", () => {
    for (const code of failureCodes) {
      expect(Object.keys(failurePresentation(code)).sort()).toEqual(["messageKey", "state"]);
    }
  });

  it("classifies an AbortError as cancellation, never as a timeout", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    expect(failureFromUnknown(abort)).toBeInstanceOf(PreviewCanceled);
    expect(failureFromUnknown(new PreviewCanceled())).toBeInstanceOf(PreviewCanceled);
    expect(() => {
      throw failureFromUnknown(abort);
    }).not.toThrowError(PreviewFailure);
  });

  it("keeps a coded failure as-is and reports anything else as corrupt", () => {
    const encrypted = new PreviewFailure("encrypted");
    expect(failureFromUnknown(encrypted)).toBe(encrypted);
    const unknown = failureFromUnknown(new Error("boom"));
    expect(unknown).toBeInstanceOf(PreviewFailure);
    expect((unknown as PreviewFailure).code).toBe("corrupt");
    expect((unknown as PreviewFailure).cause).toBeInstanceOf(Error);
  });

  it("keeps page failures page-scoped", () => {
    expect(pageFailureCodes).toEqual(["pixels_too_large", "image_budget_exceeded", "corrupt", "timeout"]);
    const pageFailure = new PageFailure("timeout");
    expect(pageFailure.code).toBe("timeout");
    // The words overlap, but the type does not: a PageFailure is never a
    // PreviewFailure, so it cannot select a drawer state of its own.
    expect(pageFailure).not.toBeInstanceOf(PreviewFailure);
    expect(pageFailure.name).toBe("PageFailure");
    expect(pageFailureCodes.every((code) => failureCodes.includes(code))).toBe(true);
  });

  it("keeps the state ids and the numeric sources in agreement", () => {
    expect(previewStates).toHaveLength(13);
    expect(new Set(previewStates).size).toBe(13);
    expect(previewStates[0]).toBe("idle");
    expect(MAX_PAGES).toBe(200);
    expect(MAX_PAGE_PIXELS).toBe(8_388_608);
    expect(MAX_IMAGES_PER_PAGE).toBe(3);
  });
});
