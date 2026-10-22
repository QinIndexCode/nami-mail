/**
 * The document policy served with every app response.
 *
 * S0 of the attachment-preview rework moved the list out of `app.ts` (where it
 * lived as an inline array) so the values can be asserted directly instead of
 * only through a header string. The directives below are the pre-extraction
 * list with no value changes; `apps/server/tests/csp.test.ts` pins them
 * byte-for-byte.
 *
 * `frame-src blob:` rather than `'none'`: the attachment preview renders a PDF
 * from an object URL inside an iframe (`AttachmentPreviewModal`), and a blob:
 * URL inherits the creating origin, so the framed document stays same-origin
 * and gains no privileges. `frame-ancestors 'none'` is the direction that
 * protects this app from being framed. Without this exception the preview works
 * under Vite (which serves the document with no CSP) and silently fails in every
 * packaged build, where this header is the document's policy.
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
  "media-src 'self'",
  "frame-src blob:",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

export const contentSecurityPolicy = contentSecurityPolicyDirectives.join("; ");
