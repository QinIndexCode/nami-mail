import { describe, expect, it } from "vitest";
import { extractRootDomain } from "./domain";

describe("extractRootDomain", () => {
  it("extracts root domain from standard standard emails", () => {
    expect(extractRootDomain("support@github.com")).toBe("github.com");
    expect(extractRootDomain("noreply@stripe.com")).toBe("stripe.com");
    expect(extractRootDomain("info@apple.com")).toBe("apple.com");
  });

  it("normalizes deep subdomains to root domain", () => {
    expect(extractRootDomain("news@insideapple.apple.com")).toBe("apple.com");
    expect(extractRootDomain("service@mail.notice.aliyun.com")).toBe("aliyun.com");
    expect(extractRootDomain("pay@service.alipay.com")).toBe("alipay.com");
    expect(extractRootDomain("a.b.c.d.e.qq.com")).toBe("qq.com");
  });

  it("handles two-part public suffixes correctly", () => {
    expect(extractRootDomain("orders@amazon.co.uk")).toBe("amazon.co.uk");
    expect(extractRootDomain("support@sub.amazon.co.uk")).toBe("amazon.co.uk");
    expect(extractRootDomain("service@store.jd.com.cn")).toBe("jd.com.cn");
    expect(extractRootDomain("news@sub.gov.cn")).toBe("sub.gov.cn");
    expect(extractRootDomain("info@service.co.jp")).toBe("service.co.jp");
    expect(extractRootDomain("test@sub.com.au")).toBe("sub.com.au");
  });

  it("accepts domain strings without @ prefix", () => {
    expect(extractRootDomain("insideapple.apple.com")).toBe("apple.com");
    expect(extractRootDomain("github.com")).toBe("github.com");
    expect(extractRootDomain("order.amazon.co.uk")).toBe("amazon.co.uk");
  });

  it("strips the trailing root dot senders sometimes emit", () => {
    expect(extractRootDomain("service@figma.com.")).toBe("figma.com");
    expect(extractRootDomain("orders@amazon.co.uk.")).toBe("amazon.co.uk");
  });

  it("handles case insensitivity, whitespace, ports, and invalid strings gracefully", () => {
    expect(extractRootDomain("  News@InsideApple.Apple.COM  ")).toBe("apple.com");
    expect(extractRootDomain("user@localhost:8080")).toBe("localhost");
    expect(extractRootDomain("")).toBe("");
    expect(extractRootDomain("invalid domain with spaces")).toBe("");
  });
});
