import { describe, expect, it } from "vitest";
import { updateBridgeErrorMessage } from "./desktop";

describe("desktop update bridge errors", () => {
  it("keeps TLS, network, and integrity recovery paths distinct", () => {
    expect(updateBridgeErrorMessage(new Error("CERT_HAS_EXPIRED"), "fallback")).toContain("安全连接");
    expect(updateBridgeErrorMessage(new Error("getaddrinfo ENOTFOUND github.com"), "fallback")).toContain("网络、代理或 DNS");
    expect(updateBridgeErrorMessage(new Error("manifest signature invalid"), "fallback")).toContain("完整性验证");
  });

  it("uses the caller fallback for an unclassified bridge failure", () => {
    expect(updateBridgeErrorMessage(new Error("renderer destroyed"), "请重新检查更新。"))
      .toBe("请重新检查更新。");
  });
});
