import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, contentSecurityPolicyDirectives } from "../src/security/csp.js";

/**
 * The literal directive list that lived inline in `apps/server/src/app.ts`
 * before S0 extracted it into `src/security/csp.ts`. It is copied by hand from
 * the pre-extraction source rather than derived from the module under test, so
 * an edit made during the move ("tidying" a value) fails here even though the
 * app and its header tests would keep passing.
 */
const directivesBeforeExtraction = [
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

const policyBeforeExtraction = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; "
  + "connect-src 'self'; media-src 'self'; frame-src blob:; form-action 'none'; frame-ancestors 'none'";

describe("content security policy", () => {
  it("keeps the twelve directives byte-identical to the pre-extraction inline list", () => {
    expect(contentSecurityPolicyDirectives).toHaveLength(12);
    expect(contentSecurityPolicyDirectives).toEqual(directivesBeforeExtraction);
    for (const [index, directive] of directivesBeforeExtraction.entries()) {
      expect(contentSecurityPolicyDirectives[index]).toBe(directive);
    }
  });

  it("joins the directives with '; ' exactly as app.ts did", () => {
    expect(contentSecurityPolicy).toBe(directivesBeforeExtraction.join("; "));
    expect(contentSecurityPolicy).toBe(policyBeforeExtraction);
  });

  it("still ships the S0 values the app's behaviour depends on", () => {
    // The preview is still an iframe over a blob: URL at S0; the tightening to
    // frame-src 'none' happens together with deleting the iframe in S2.
    expect(contentSecurityPolicy).toContain("frame-src blob:");
    expect(contentSecurityPolicy).not.toContain("frame-src 'none'");
    expect(contentSecurityPolicy).toContain("img-src 'self' data: blob: https: http:");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
  });
});
