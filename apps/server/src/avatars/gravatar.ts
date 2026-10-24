import { serverLog } from "../logging.js";

/**
 * Same-origin Gravatar proxy (plan §4.6 / §8.4).
 *
 * Why a proxy at all: with `img-src 'self'`, the renderer may not load
 * `https://www.gravatar.com/...` directly. More importantly, a direct request
 * tells Gravatar the sender's address hash for every message the user opens,
 * from the user's own IP. Here the only thing the renderer sends is the md5
 * hash the client already computed, and the server fetches a URL it built
 * itself from a constant base.
 *
 * The upstream response is never forwarded as-is: only the bytes and a
 * normalised image content type leave this module. `Set-Cookie`, `Location`
 * and every other header stay here.
 */

export const GRAVATAR_ORIGIN = "https://www.gravatar.com";
export const GRAVATAR_TIMEOUT_MS = 5_000;
export const GRAVATAR_MAX_BYTES = 1_048_576;
export const GRAVATAR_HASH_PATTERN = /^[a-f0-9]{32}$/;
/** A hit is immutable: the address hash cannot change what Gravatar returns. */
export const gravatarCacheControl = "public, max-age=604800, immutable";
/** A miss is re-checked after an hour so a newly uploaded photo appears. */
export const gravatarNotFoundCacheControl = "public, max-age=3600";

export type GravatarRejection =
  | "invalid_hash"
  | "ssrf_blocked"
  | "redirect"
  | "not_found"
  | "content_type"
  | "too_large"
  | "timeout"
  | "upstream";

export type GravatarResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; rejection: GravatarRejection; status: number };

export type FetchGravatarOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

/** `null` for anything that is not a 32-character lowercase hex digest. */
export function gravatarUrl(hash: string): string | null {
  if (!GRAVATAR_HASH_PATTERN.test(hash)) return null;
  return `${GRAVATAR_ORIGIN}/avatar/${hash}?d=404&s=96`;
}

/**
 * Defense in depth: the URL above is built from constants, so this can only
 * fail if that construction is ever changed. It logs the rejection itself so
 * the guard is exercised by tests rather than trusted by inspection; the log
 * carries the host name, never an address.
 */
export function isAllowedGravatarUrl(raw: string): boolean {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (url && url.protocol === "https:" && url.hostname === "www.gravatar.com" && url.port === "") return true;
  serverLog.warn({ host: url?.hostname ?? "unparsable", reason: "origin" }, "gravatar_ssrf_blocked");
  return false;
}

function reject(rejection: GravatarRejection, status: number, hash: string): GravatarResult {
  // Only the first eight characters of the digest: enough to correlate a log
  // line with a request, useless as an address (F1: no clear-text email ever
  // reaches a log line).
  serverLog.warn({ hash: hash.slice(0, 8), reason: rejection }, "gravatar_rejected");
  return { ok: false, rejection, status };
}

function isTimeout(error: unknown): boolean {
  return (
    (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError")
  );
}

function isImageContentType(value: string): boolean {
  const essence = value.split(";")[0]?.trim().toLowerCase() ?? "";
  // SVG is an image, but it is also a document that can carry script; this
  // endpoint is only ever asked for a raster avatar.
  return essence.startsWith("image/") && essence !== "image/svg+xml";
}

async function readBody(response: Response, contentType: string, maxBytes: number, hash: string): Promise<GravatarResult> {
  if (!response.body) return reject("upstream", 502, hash);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return reject("too_large", 413, hash);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    return reject(isTimeout(error) ? "timeout" : "upstream", isTimeout(error) ? 504 : 502, hash);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes, contentType };
}

/**
 * Fetches one avatar under a hard timeout, a one-megabyte ceiling and a strict
 * content-type check. Redirects are refused before they happen
 * (`redirect: "manual"`), so a 3xx is an answer rather than a hop to a host
 * this module never validated.
 */
export async function fetchGravatar(hash: string, options: FetchGravatarOptions = {}): Promise<GravatarResult> {
  const url = gravatarUrl(hash);
  if (!url) return { ok: false, rejection: "invalid_hash", status: 400 };
  if (!isAllowedGravatarUrl(url)) return { ok: false, rejection: "ssrf_blocked", status: 404 };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GRAVATAR_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? GRAVATAR_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "image/*" },
    });
  } catch (error) {
    return reject(isTimeout(error) ? "timeout" : "upstream", isTimeout(error) ? 504 : 502, hash);
  }

  if (response.status >= 300 && response.status < 400) return reject("redirect", 404, hash);
  // A 404 is Gravatar's documented "this address has no photo" answer, not a
  // refusal: the caller caches it for an hour and draws initials.
  if (response.status === 404) return { ok: false, rejection: "not_found", status: 404 };
  if (response.status !== 200) return reject("upstream", 502, hash);

  const contentType = response.headers.get("content-type") ?? "";
  if (!isImageContentType(contentType)) return reject("content_type", 415, hash);

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return reject("too_large", 413, hash);

  return readBody(response, contentType, maxBytes, hash);
}
