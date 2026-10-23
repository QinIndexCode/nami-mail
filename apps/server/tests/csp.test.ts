import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, contentSecurityPolicyDirectives } from "../src/security/csp.js";

/**
 * The directive list as it stood at the end of S0 (an iframe over a blob: URL).
 * It is copied by hand rather than derived from the module under test, so every
 * S2 edit below is visible as a diff against a fixed point and a silently
 * "tidied" value fails here even though the app and its header tests pass.
 */
const directivesAtS0 = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self'",
  "frame-src blob:",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

/** Exactly the three S2 changes; everything else must stay byte-identical. */
const directivesAtS2 = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "worker-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

/** S5 narrows `img-src`; nothing else moves. */
const directivesAtS5 = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'none'",
  "worker-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

describe("content security policy", () => {
  it("narrows img-src at S5 and leaves every other directive as S2 left it", () => {
    expect(contentSecurityPolicyDirectives).toHaveLength(13);
    expect(contentSecurityPolicyDirectives).toEqual(directivesAtS5);
    for (const [index, directive] of directivesAtS2.entries()) {
      if (directive.startsWith("img-src ")) {
        expect(contentSecurityPolicyDirectives[index]).toBe("img-src 'self' data: blob:");
        continue;
      }
      expect(contentSecurityPolicyDirectives[index]).toBe(directive);
    }
  });

  it("only frame-src, media-src, worker-src and img-src differ from the S0 baseline", () => {
    const added = directivesAtS5.filter((directive) => !(directivesAtS0 as readonly string[]).includes(directive));
    const removed = directivesAtS0.filter((directive) => !(directivesAtS5 as readonly string[]).includes(directive));
    expect(added).toEqual(["img-src 'self' data: blob:", "media-src 'self' blob:", "frame-src 'none'", "worker-src 'self'"]);
    expect(removed).toEqual(["img-src 'self' data: blob: https: http:", "media-src 'self'", "frame-src blob:"]);
  });

  it("joins the directives with '; ' in order", () => {
    expect(contentSecurityPolicy).toBe(directivesAtS5.join("; "));
  });

  it("no longer lets the renderer fetch images from arbitrary hosts", () => {
    // Both remote image paths (message bodies and sender avatars) are
    // same-origin routes now; keeping https:/http: would leave a hole for any
    // <img> that escaped the sanitizer.
    expect(contentSecurityPolicy).toContain("img-src 'self' data: blob:");
    expect(contentSecurityPolicy).not.toContain("https:");
    expect(contentSecurityPolicy).not.toContain("http:");
  });

  it("keeps the inline splash style working and deletes the iframe exception", () => {
    // `apps/web/index.html` ships an inline <style> splash block; without
    // 'unsafe-inline' here the first paint is lost in a packaged build.
    expect(contentSecurityPolicy).toContain("style-src 'self' 'unsafe-inline'");
    expect(contentSecurityPolicy).toContain("frame-src 'none'");
    expect(contentSecurityPolicy).not.toContain("frame-src blob:");
    expect(contentSecurityPolicy).toContain("media-src 'self' blob:");
    // The pdf.js worker is fetched from a same-origin asset; a blob: worker
    // would let renderer script mint its own, so it is not allowed.
    expect(contentSecurityPolicy).toContain("worker-src 'self'");
    expect(contentSecurityPolicy).not.toContain("worker-src 'self' blob:");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain("object-src 'none'");
  });
});
