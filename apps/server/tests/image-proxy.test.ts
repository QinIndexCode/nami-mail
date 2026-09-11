import http from "node:http";
import { describe, expect, it } from "vitest";
import { guardedLookup, isAllowedUrl, isPrivateOrReservedHost, isPrivateOrReservedIp, nextRedirectUrl, proxyImage } from "../src/image-proxy.js";

const PUBLIC = "https://cdn.example.com/logo.png";

describe("isAllowedUrl", () => {
  it("accepts ordinary http(s) image URLs", () => {
    expect(isAllowedUrl(PUBLIC)).toBe(true);
    expect(isAllowedUrl("http://cdn.example.com:8080/a.png?x=1#y")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    for (const url of ["file:///c:/secret.png", "ftp://cdn.example.com/a.png", "data:image/png;base64,AAAA"]) {
      expect(isAllowedUrl(url)).toBe(false);
    }
  });

  it("rejects loopback, private, link-local and CGNAT hosts", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "printer.local",
      "metadata.google.internal",
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "2130706433", // decimal-encoded 127.0.0.1, normalized by the URL parser
    ]) {
      expect(isAllowedUrl(`http://${host}/a.png`), host).toBe(false);
    }
  });

  it("rejects reserved IPv6 literals, including the normalized mapped form", () => {
    for (const host of ["[::1]", "[::]", "[fc00::1]", "[fd00::abcd]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) {
      expect(isAllowedUrl(`http://${host}/a.png`), host).toBe(false);
    }
  });

  it("rejects credentials in the URL and oversized URLs", () => {
    expect(isAllowedUrl("https://user:pass@cdn.example.com/a.png")).toBe(false);
    expect(isAllowedUrl(`https://cdn.example.com/${"a".repeat(3000)}`)).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
  });
});

describe("isPrivateOrReservedHost", () => {
  it("does not treat ordinary domain names as reserved", () => {
    expect(isPrivateOrReservedHost("cdn.example.com")).toBe(false);
    expect(isPrivateOrReservedHost("EXAMPLE.CDN.COM")).toBe(false);
    expect(isPrivateOrReservedHost("[2606:4700::1111]")).toBe(false);
  });
});

describe("isPrivateOrReservedIp", () => {
  it("treats unparseable input as reserved (fail closed)", () => {
    expect(isPrivateOrReservedIp("example.com")).toBe(true);
    expect(isPrivateOrReservedIp("")).toBe(true);
    expect(isPrivateOrReservedIp("1.2.3")).toBe(true);
  });

  it("passes public addresses", () => {
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIp("2606:4700::1111")).toBe(false);
  });
});

describe("nextRedirectUrl", () => {
  it("resolves relative locations against the current URL", () => {
    expect(nextRedirectUrl(PUBLIC, "/other.png")).toBe("https://cdn.example.com/other.png");
  });

  it("refuses a redirect that leaves public address space", () => {
    expect(nextRedirectUrl(PUBLIC, "http://127.0.0.1/admin")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "http://[::1]/admin")).toBeNull();
    expect(nextRedirectUrl(PUBLIC, "file:///c:/secret.png")).toBeNull();
  });

  it("allows a redirect that stays public", () => {
    expect(nextRedirectUrl(PUBLIC, "https://cdn2.example.com/b.png")).toBe("https://cdn2.example.com/b.png");
  });
});

describe("guardedLookup", () => {
  it("refuses to hand out a loopback address", async () => {
    const result = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) => {
      guardedLookup("localhost", { all: true }, (error) => resolve({ error }));
    });
    expect(result.error).toBeTruthy();
  });
});

describe("proxyImage", () => {
  it("never opens a socket for a disallowed URL", async () => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(proxyImage(`http://127.0.0.1:${port}/a.png`)).resolves.toBeNull();
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
