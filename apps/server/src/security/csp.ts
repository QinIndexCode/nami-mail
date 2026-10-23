/**
 * The document policy served with every app response.
 *
 * S0 moved the list out of `app.ts` (where it lived as an inline array) so the
 * values can be asserted directly instead of only through a header string. S2
 * replaces the iframe preview with a composed drawer, which changes exactly
 * three directives:
 *
 * - `frame-src 'none'` — nothing is framed any more, so the blob: exception the
 *   iframe needed is gone.
 * - `media-src 'self' blob:` — audio/video elements play from object URLs.
 * - `worker-src 'self'` — pdf.js keeps its worker on a same-origin asset
 *   (`pdf.worker.min.mjs?url`); no blob: worker is needed or allowed.
 *
 * `style-src 'unsafe-inline'` is not touched: `apps/web/index.html` still ships
 * the inline splash `<style>` block, and this header is its only support in a
 * packaged build. `frame-ancestors 'none'` remains the directive that protects
 * this app from being framed.
 */
export const contentSecurityPolicyDirectives = [
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

export const contentSecurityPolicy = contentSecurityPolicyDirectives.join("; ");
