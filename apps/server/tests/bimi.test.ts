import { beforeEach, describe, expect, it } from "vitest";
import {
  BIMI_FETCH_TIMEOUT_MS,
  BIMI_MAX_SVG_BYTES,
  assertSafeLogoUrl,
  parseBimiRecord,
  resolveBimiLogo,
  resetBimiCacheForTests,
  type BimiDeps,
} from "../src/avatars/bimi.js";

const SVG_BODY = "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'/>";

function fakeResponse(body: string | Uint8Array, contentType = "image/svg+xml", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

type DepsHarness = {
  deps: BimiDeps;
  resolveTxtCalls: () => number;
  fetchCalls: () => number;
  setNow: (value: number) => void;
  /** Swaps the fetch implementation while keeping the call counter wired. */
  setFetch: (impl: () => Response) => void;
  setResolveTxtError: () => void;
};

function makeDeps(records: string[][] | null, resolvedAddress = "93.184.216.34"): DepsHarness {
  let resolveTxtCalls = 0;
  let fetchCalls = 0;
  let currentNow = 1_000_000;
  const deps: BimiDeps = {
    resolveTxt: async () => {
      resolveTxtCalls += 1;
      return records ?? [];
    },
    lookup: async () => ({ address: resolvedAddress, family: resolvedAddress.includes(":") ? 6 : 4 }),
    fetchImpl: async () => {
      fetchCalls += 1;
      return fakeResponse(SVG_BODY);
    },
    now: () => currentNow,
  };
  return {
    deps,
    resolveTxtCalls: () => resolveTxtCalls,
    fetchCalls: () => fetchCalls,
    setNow: (value: number) => { currentNow = value; },
    setFetch: (impl: () => Response) => {
      deps.fetchImpl = async () => {
        fetchCalls += 1;
        return impl();
      };
    },
    setResolveTxtError: () => {
      deps.resolveTxt = async () => {
        resolveTxtCalls += 1;
        throw new Error("ENOTFOUND");
      };
    },
  };
}

beforeEach(() => {
  resetBimiCacheForTests();
});

describe("parseBimiRecord", () => {
  it("accepts a well-formed record and returns the logo URL", () => {
    expect(parseBimiRecord("v=BIMI1; l=https://brand.example/logo.svg")).toBe("https://brand.example/logo.svg");
  });

  it("rejoins TXT chunks split mid-tag", () => {
    expect(parseBimiRecord("v=BIMI1; l=https://bran" + "d.example/logo.svg")).toBe("https://brand.example/logo.svg");
  });

  it("rejects records without a leading v=BIMI1 tag", () => {
    expect(parseBimiRecord("l=https://brand.example/logo.svg; v=BIMI1")).toBeNull();
    expect(parseBimiRecord("v=BIMI2; l=https://brand.example/logo.svg")).toBeNull();
  });

  it("rejects non-https, non-standard-port, IP and local logo URLs", () => {
    expect(parseBimiRecord("v=BIMI1; l=http://brand.example/logo.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; l=https://brand.example:8443/logo.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; l=https://93.184.216.34/logo.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; l=https://localhost/logo.svg")).toBeNull();
    expect(parseBimiRecord("v=BIMI1; l=https://box.internal/logo.svg")).toBeNull();
  });

  it("returns null when no l= tag exists", () => {
    expect(parseBimiRecord("v=BIMI1; a=https://cert.example/vmc.pem")).toBeNull();
  });
});

describe("assertSafeLogoUrl", () => {
  it("accepts an https URL on the default port", () => {
    expect(assertSafeLogoUrl("https://brand.example/logo.svg").hostname).toBe("brand.example");
    expect(assertSafeLogoUrl("https://brand.example:443/logo.svg").hostname).toBe("brand.example");
  });

  it("rejects plain http and non-443 ports", () => {
    expect(() => assertSafeLogoUrl("http://brand.example/logo.svg")).toThrow(/https/);
    expect(() => assertSafeLogoUrl("https://brand.example:8080/logo.svg")).toThrow(/443/);
  });

  it("rejects IP literals and local hostnames", () => {
    expect(() => assertSafeLogoUrl("https://127.0.0.1/logo.svg")).toThrow(/IP literal/);
    expect(() => assertSafeLogoUrl("https://[::1]/logo.svg")).toThrow(/IP literal/);
    expect(() => assertSafeLogoUrl("https://service.local/logo.svg")).toThrow(/local host/);
    expect(() => assertSafeLogoUrl("https://host.home.arpa/logo.svg")).toThrow(/local host/);
  });
});

describe("resolveBimiLogo", () => {
  it("resolves a published record into a base64 SVG data URL", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    const resolution = await resolveBimiLogo("brand.example", harness.deps);
    expect(resolution).toEqual({ ok: true, logo: `data:image/svg+xml;base64,${Buffer.from(SVG_BODY).toString("base64")}` });
    expect(harness.fetchCalls()).toBe(1);
  });

  it("serves a second resolution for the same domain from the positive cache", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    await resolveBimiLogo("brand.example", harness.deps);
    await resolveBimiLogo("Brand.Example", harness.deps);
    expect(harness.resolveTxtCalls()).toBe(1);
    expect(harness.fetchCalls()).toBe(1);
  });

  it("expires the positive cache after the TTL window", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    await resolveBimiLogo("brand.example", harness.deps);
    harness.setNow(1_000_000 + 25 * 60 * 60 * 1000);
    await resolveBimiLogo("brand.example", harness.deps);
    expect(harness.resolveTxtCalls()).toBe(2);
  });

  it("negative-caches a domain without a usable record", async () => {
    const harness = makeDeps([["v=SPF1 -all"]]);
    await expect(resolveBimiLogo("plain.example", harness.deps)).resolves.toEqual({ ok: false });
    await expect(resolveBimiLogo("plain.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.resolveTxtCalls()).toBe(1);
    expect(harness.fetchCalls()).toBe(0);
  });

  it("negative-caches DNS lookup failures", async () => {
    const harness = makeDeps(null);
    harness.setResolveTxtError();
    await expect(resolveBimiLogo("broken.example", harness.deps)).resolves.toEqual({ ok: false });
    await expect(resolveBimiLogo("broken.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.fetchCalls()).toBe(0);
  });

  it("deduplicates concurrent lookups for one domain into a single fetch", async () => {
    let resolveTxtCalls = 0;
    const deps: BimiDeps = {
      resolveTxt: async () => {
        resolveTxtCalls += 1;
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        return [["v=BIMI1; l=https://brand.example/logo.svg"]];
      },
      lookup: async () => ({ address: "93.184.216.34", family: 4 }),
      fetchImpl: async () => fakeResponse(SVG_BODY),
    };
    const [first, second] = await Promise.all([
      resolveBimiLogo("brand.example", deps),
      resolveBimiLogo("brand.example", deps),
    ]);
    expect(first).toEqual(second);
    expect(resolveTxtCalls).toBe(1);
  });

  it("refuses to fetch when the logo host resolves to a private address", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]], "192.168.1.10");
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.fetchCalls()).toBe(0);
  });

  it("refuses to fetch when the logo host resolves to loopback via IPv4-mapped IPv6", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]], "::ffff:127.0.0.1");
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.fetchCalls()).toBe(0);
  });

  it("rejects oversized SVG documents", async () => {
    const oversized = new Uint8Array(BIMI_MAX_SVG_BYTES + 1);
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.setFetch(() => fakeResponse(oversized));
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
  });

  it("rejects non-SVG content types", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.setFetch(() => fakeResponse("<html/>", "text/html"));
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
  });

  it("accepts an .svg path mislabeled as octet-stream", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.setFetch(() => fakeResponse(SVG_BODY, "application/octet-stream"));
    const resolution = await resolveBimiLogo("brand.example", harness.deps);
    expect(resolution.ok).toBe(true);
  });

  it("rejects failed downloads and keeps the negative cache", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.setFetch(() => fakeResponse(SVG_BODY, "image/svg+xml", 404));
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.fetchCalls()).toBe(1);
    await resolveBimiLogo("brand.example", harness.deps);
    expect(harness.fetchCalls()).toBe(1);
  });

  it("short-circuits syntactically invalid domains without a DNS query", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    await expect(resolveBimiLogo("not_a_domain", harness.deps)).resolves.toEqual({ ok: false });
    expect(harness.resolveTxtCalls()).toBe(0);
  });
});

describe("resolveBimiLogo persistence", () => {
  it("serves a fresh persisted positive row without DNS or download", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    let saved: unknown;
    harness.deps.loadCachedLogo = () => ({ logo: "data:image/svg+xml;base64,cached", resolvedAtMs: 999_999 });
    harness.deps.saveCachedLogo = (domain, cached) => { saved = { domain, ...cached }; };
    const resolution = await resolveBimiLogo("brand.example", harness.deps);
    expect(resolution).toEqual({ ok: true, logo: "data:image/svg+xml;base64,cached" });
    expect(harness.resolveTxtCalls()).toBe(0);
    expect(harness.fetchCalls()).toBe(0);
    // Served from the cold cache: nothing is written back.
    expect(saved).toBeUndefined();
  });

  it("serves a fresh persisted negative row without DNS", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.deps.loadCachedLogo = () => ({ logo: null, resolvedAtMs: 1_000_000 - 60 * 60 * 1000 });
    const resolution = await resolveBimiLogo("plain.example", harness.deps);
    expect(resolution).toEqual({ ok: false });
    expect(harness.resolveTxtCalls()).toBe(0);
  });

  it("re-resolves a stale persisted row and writes the fresh result back", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    const writes: Array<{ domain: string; logo: string | null; resolvedAtMs: number }> = [];
    harness.deps.loadCachedLogo = () => ({ logo: "data:image/svg+xml;base64,stale", resolvedAtMs: 1_000_000 - 25 * 60 * 60 * 1000 });
    harness.deps.saveCachedLogo = (domain, cached) => writes.push({ domain, ...cached });
    const resolution = await resolveBimiLogo("brand.example", harness.deps);
    expect(resolution.ok).toBe(true);
    expect(harness.resolveTxtCalls()).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.domain).toBe("brand.example");
    expect(writes[0]?.logo).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG_BODY).toString("base64")}`);
  });

  it("writes negative resolutions through to persistence", async () => {
    const harness = makeDeps([["v=SPF1 -all"]]);
    const writes: Array<{ domain: string; logo: string | null }> = [];
    harness.deps.saveCachedLogo = (domain, cached) => writes.push({ domain, logo: cached.logo });
    await resolveBimiLogo("plain.example", harness.deps);
    expect(writes).toEqual([{ domain: "plain.example", logo: null }]);
  });

  it("tolerates persistence failures on both sides", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]]);
    harness.deps.loadCachedLogo = () => { throw new Error("disk gone"); };
    harness.deps.saveCachedLogo = () => { throw new Error("disk gone"); };
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toMatchObject({ ok: true });
  });
});

describe("pinned fetch contract", () => {
  it("passes the validated address and timeout to the fetch", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]], "93.184.216.34");
    const calls: Array<{ pinnedIp: string; timeoutMs: number }> = [];
    const base = harness.deps.fetchImpl!;
    harness.deps.fetchImpl = async (url, pinnedIp, timeoutMs) => {
      calls.push({ pinnedIp, timeoutMs });
      return base(url, pinnedIp, timeoutMs);
    };
    await resolveBimiLogo("brand.example", harness.deps);
    expect(calls).toEqual([{ pinnedIp: "93.184.216.34", timeoutMs: BIMI_FETCH_TIMEOUT_MS }]);
  });

  it("never fetches when the lookup result is refused, keeping the pin path unused", async () => {
    const harness = makeDeps([["v=BIMI1; l=https://brand.example/logo.svg"]], "10.0.0.5");
    const calls: Array<{ pinnedIp: string }> = [];
    const base = harness.deps.fetchImpl!;
    harness.deps.fetchImpl = async (url, pinnedIp, timeoutMs) => {
      calls.push({ pinnedIp });
      return base(url, pinnedIp, timeoutMs);
    };
    await expect(resolveBimiLogo("brand.example", harness.deps)).resolves.toEqual({ ok: false });
    expect(calls).toEqual([]);
  });
});
