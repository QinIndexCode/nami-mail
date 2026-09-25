import { promises as dnsPromises } from "node:dns";
import https from "node:https";
import { isIP } from "node:net";

/**
 * BIMI (Brand Indicators for Message Identification) sender-logo resolution.
 *
 * Lookup path: `default._bimi.<domain>` TXT → `v=BIMI1; l=https://...; a=...`
 * → download the brand SVG from the sender's own infrastructure → return it
 * as a data URL so the renderer can put it inside an <img> (no script
 * execution surface).
 *
 * Trust model: the DNS TXT record is controlled by the domain owner, so a
 * published logo carries the same trust as mail from that domain. The `a=`
 * authority-evidence tag (VMC/CMC) is deliberately NOT verified: strict X.509
 * validation is heavy and would reject nearly every real deployment, and the
 * resulting risk profile matches loading remote mail imagery the user already
 * opted into.
 *
 * SSRF posture (this server runs on the user's machine): logo URLs must be
 * https on port 443, must not be IP literals or localhost variants, and must
 * resolve to public unicast addresses. The download connects to the
 * already-validated address directly (SNI and certificate verification stay
 * bound to the hostname), so a DNS-rebinding reply between lookup and fetch
 * cannot steer the connection into a private network.
 *
 * Resolutions also persist through optional hooks (`loadCachedLogo` /
 * `saveCachedLogo`) that the route layer wires to SQLite, so a restart does
 * not drop every brand logo until the TTL window lapses.
 */

export const BIMI_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
export const BIMI_NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
export const BIMI_MAX_SVG_BYTES = 64 * 1024;
export const BIMI_FETCH_TIMEOUT_MS = 5000;

/** One persisted resolution row: data URL, or null for a negative result. */
export type BimiCachedLogo = { logo: string | null; resolvedAtMs: number };

export type BimiDeps = {
  /** Mirrors dns.promises.resolveTxt: array of records, each an array of chunks. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  lookup?: (host: string) => Promise<{ address: string; family: number }>;
  /** Downloads the logo from the pre-validated `pinnedIp` within `timeoutMs`. */
  fetchImpl?: (url: URL, pinnedIp: string, timeoutMs: number) => Promise<Response>;
  now?: () => number;
  /** Cold cache consulted on an in-memory miss (wired to SQLite by the route). */
  loadCachedLogo?: (domain: string) => BimiCachedLogo | undefined;
  /** Write-through twin of `loadCachedLogo`; failures are swallowed. */
  saveCachedLogo?: (domain: string, cached: BimiCachedLogo) => void;
};

export type BimiResolution = { ok: true; logo: string } | { ok: false };

type CacheEntry = { value: string | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<BimiResolution>>();

const domainPattern = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/** Reject loopback, private, link-local, and otherwise non-routable targets. */
function isDisallowedIp(address: string): boolean {
  let value = address;
  // Normalize IPv4-mapped IPv6 (::ffff:10.0.0.1) before classification.
  const mapped = value.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) value = mapped[1]!;
  const family = isIP(value);
  if (family === 4) {
    const parts = value.split(".").map((part) => Number(part));
    const [o1, o2] = [parts[0]!, parts[1]!];
    if (o1 === 0 || o1 === 10 || o1 === 127) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    return false;
  }
  if (family === 6) {
    const lower = value.toLowerCase();
    const bare = lower.replace(/^\[[^\]]+\]$/, "");
    if (bare === "::" || bare === "::1") return true;
    if (bare.startsWith("fe80:")) return true; // link-local
    if (/^f[cd]/.test(bare)) return true; // unique local fc00::/7
    if (/^::ffff:/.test(bare)) return true; // any leftover mapping is suspect
    return false;
  }
  return true; // unparseable → treat as unsafe
}

/** Validates the `l=` logo URL: https, port 443, hostname not an IP literal. */
export function assertSafeLogoUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("BIMI logo URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("BIMI logo URL must use https.");
  if (url.port !== "" && url.port !== "443") throw new Error("BIMI logo URL must use port 443.");
  // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"); strip them so
  // isIP can classify the literal at all — otherwise an IPv6 target would
  // slip past the IP-literal ban.
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(hostname)) throw new Error("BIMI logo URL must not be an IP literal.");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new Error("BIMI logo URL must not point at a local host.");
  }
  return url;
}

/**
 * Parses the joined TXT payload of a BIMI record. Returns the logo URL, or
 * null when the record is absent/malformed (an invalid or http `l=` also
 * yields null — the domain simply gets no logo).
 */
export function parseBimiRecord(record: string): string | null {
  const tags = record.split(";").map((tag) => tag.trim()).filter(Boolean);
  if (tags[0] !== "v=BIMI1") return null;
  for (const tag of tags.slice(1)) {
    const equals = tag.indexOf("=");
    if (equals <= 0) continue;
    const key = tag.slice(0, equals).trim().toLowerCase();
    if (key !== "l") continue;
    const value = tag.slice(equals + 1).trim();
    if (!value.toLowerCase().startsWith("https://")) return null;
    try {
      assertSafeLogoUrl(value);
      return value;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * HTTPS download that connects to the pre-validated `pinnedIp` instead of
 * re-resolving the hostname, so a rebinding DNS answer cannot switch the
 * target to a private address after the lookup was approved. TLS identity
 * (SNI and certificate verification) stays bound to the real hostname via
 * `servername`; the request deliberately never follows redirects.
 */
function defaultPinnedFetch(url: URL, pinnedIp: string, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      host: pinnedIp,
      servername: url.hostname,
      method: "GET",
      headers: { accept: "image/svg+xml", host: url.hostname },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        // Equivalent of the old redirect: "error" posture.
        request.destroy(new Error(`BIMI logo download was redirected (HTTP ${status}).`));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > BIMI_MAX_SVG_BYTES) {
          request.destroy(new Error("BIMI logo size is out of bounds."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status,
          headers: { "content-type": contentType },
        }));
      });
      response.on("error", reject);
    });
    // A wall-clock deadline (unlike socket-level timeouts) caps the whole
    // download, header wait included.
    const timer = setTimeout(() => {
      request.destroy(new Error(`BIMI logo fetch timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    request.end();
  });
}

function defaultDeps(): Required<BimiDeps> {
  return {
    resolveTxt: (name) => dnsPromises.resolveTxt(name),
    lookup: (host) => dnsPromises.lookup(host),
    fetchImpl: defaultPinnedFetch,
    now: () => Date.now(),
    loadCachedLogo: () => undefined,
    saveCachedLogo: () => {},
  };
}

async function fetchLogoAsDataUrl(urlString: string, deps: Required<BimiDeps>): Promise<string> {
  const url = assertSafeLogoUrl(urlString);
  const resolved = await deps.lookup(url.hostname);
  if (isDisallowedIp(resolved.address)) {
    throw new Error("BIMI logo host resolved to a non-public address.");
  }
  const response = await deps.fetchImpl(url, resolved.address, BIMI_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`BIMI logo download failed with HTTP ${response.status}.`);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  // Servers often mislabel SVG as octet-stream or omit the header entirely,
  // so the .svg path extension is an accepted fallback — but an explicit
  // text/* label means the URL serves a document, not a logo, and is refused.
  const looksLikeSvg = contentType.includes("image/svg")
    || (url.pathname.toLowerCase().endsWith(".svg") && !contentType.startsWith("text/"));
  if (!looksLikeSvg) throw new Error("BIMI logo is not an SVG document.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > BIMI_MAX_SVG_BYTES) {
    throw new Error("BIMI logo size is out of bounds.");
  }
  return `data:image/svg+xml;base64,${Buffer.from(buffer).toString("base64")}`;
}

/**
 * Resolves the BIMI brand logo for a domain, with in-memory and persisted
 * (optional) positive/negative caches plus in-flight deduplication so a long
 * message list triggers at most one lookup per sender domain per TTL window.
 */
export async function resolveBimiLogo(domain: string, deps?: BimiDeps): Promise<BimiResolution> {
  const full = defaultDeps();
  const resolveTxt = deps?.resolveTxt ?? full.resolveTxt;
  const lookup = deps?.lookup ?? full.lookup;
  const fetchImpl = deps?.fetchImpl ?? full.fetchImpl;
  const now = deps?.now ?? full.now;
  const loadCachedLogo = deps?.loadCachedLogo ?? full.loadCachedLogo;
  const saveCachedLogo = deps?.saveCachedLogo ?? full.saveCachedLogo;

  const normalized = domain.trim().toLowerCase();
  if (!domainPattern.test(normalized)) return { ok: false };

  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > now()) {
    return cached.value ? { ok: true, logo: cached.value } : { ok: false };
  }

  const existing = inflight.get(normalized);
  if (existing) return existing;

  // Write-through to both cache layers; persistence stays best-effort.
  const remember = (value: string | null) => {
    const resolvedAtMs = now();
    cache.set(normalized, {
      value,
      expiresAt: resolvedAtMs + (value ? BIMI_POSITIVE_TTL_MS : BIMI_NEGATIVE_TTL_MS),
    });
    try {
      saveCachedLogo(normalized, { logo: value, resolvedAtMs });
    } catch {
      // A failing persistence store must never break resolution.
    }
  };

  const task = (async (): Promise<BimiResolution> => {
    // Cold cache (survives restarts): a fresh row short-circuits DNS entirely.
    try {
      const stored = loadCachedLogo(normalized);
      if (stored) {
        const freshPositive = stored.logo !== null
          && stored.resolvedAtMs + BIMI_POSITIVE_TTL_MS > now();
        const freshNegative = stored.logo === null
          && stored.resolvedAtMs + BIMI_NEGATIVE_TTL_MS > now();
        if (freshPositive || freshNegative) {
          cache.set(normalized, {
            value: stored.logo,
            expiresAt: stored.resolvedAtMs
              + (stored.logo ? BIMI_POSITIVE_TTL_MS : BIMI_NEGATIVE_TTL_MS),
          });
          return stored.logo ? { ok: true, logo: stored.logo } : { ok: false };
        }
      }
    } catch {
      // A broken persistence store degrades to the DNS path.
    }

    try {
      const records = await resolveTxt(`default._bimi.${normalized}`);
      for (const chunks of records) {
        const logoUrl = parseBimiRecord(chunks.join(""));
        if (!logoUrl) continue;
        const logo = await fetchLogoAsDataUrl(logoUrl, { resolveTxt, lookup, fetchImpl, now, loadCachedLogo, saveCachedLogo });
        remember(logo);
        return { ok: true, logo };
      }
      remember(null);
      return { ok: false };
    } catch {
      remember(null);
      return { ok: false };
    } finally {
      inflight.delete(normalized);
    }
  })();
  inflight.set(normalized, task);
  return task;
}

/** Test hook: drops all cached BIMI resolutions. */
export function resetBimiCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
