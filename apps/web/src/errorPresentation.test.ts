import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { accountHealthIssue, mailErrorToastMessage, presentMailError } from "./errorPresentation";

describe("presentMailError", () => {
  it("keeps TLS failures separate from network reachability", () => {
    const issue = presentMailError(new ApiError("无法建立已验证的 TLS/STARTTLS 连接", "tls_failed", 422));

    expect(issue).toMatchObject({ kind: "tls", title: "TLS 安全连接未通过", retryable: false });
    expect(issue.guidance).toContain("不要关闭证书验证");
  });

  it("explains timeouts as a network or server reachability issue", () => {
    const issue = presentMailError(new ApiError("连接邮箱服务器超时", "timeout", 422));

    expect(issue).toMatchObject({ kind: "connection", title: "连接邮箱服务器超时", retryable: true });
    expect(issue.guidance).toContain("网络");
  });

  it("presents local credential integrity failure before ordinary credential errors", () => {
    const issue = presentMailError(new ApiError(
      "本地账户数据与已保存的连接配置不匹配，Nami Mail 未连接邮件服务器。",
      "local_data_invalid",
      422,
    ));

    expect(issue).toMatchObject({
      kind: "local-data",
      title: "本地账户数据无法验证",
      retryable: false,
    });
    expect(issue.message).toContain("未连接邮件服务器");
    expect(issue.guidance).toContain("可信备份");
    expect(issue.guidance).toContain("重新添加");
    expect(issue.title).not.toContain("登录凭据");
  });

  it.each([
    ["network_unavailable", "本机网络不可用"],
    ["connection_refused", "邮箱服务器拒绝了连接"],
    ["tls_certificate_failed", "TLS 证书验证未通过"],
    ["tls_handshake_failed", "TLS 加密协商失败"],
    ["provider_configuration", "邮箱服务器配置不匹配"],
  ])("maps the stable %s code without leaking transport detail", (code, title) => {
    expect(presentMailError(new ApiError("underlying transport detail", code, 422))).toMatchObject({ title });
  });

  it("treats saved technical DNS text as a server address problem", () => {
    const issue = presentMailError("getaddrinfo ENOTFOUND imap.example.com");

    expect(issue).toMatchObject({ kind: "dns", title: "找不到邮箱服务器" });
    expect(issue.message).not.toContain("ENOTFOUND");
  });

  it("does not present browser fetch failures as an email password error", () => {
    const issue = presentMailError(new TypeError("Failed to fetch"));

    expect(issue).toMatchObject({ kind: "local-service", title: "Nami Mail 本地邮件服务不可用" });
  });

  it("recognizes the normalized local-service code from every API path", () => {
    const issue = presentMailError(new ApiError("无法连接到 Nami Mail 本地服务。", "local_service_unavailable"));

    expect(issue).toMatchObject({ kind: "local-service", title: "Nami Mail 本地邮件服务不可用" });
  });

  it("keeps transient notices short while retaining the recovery category", () => {
    expect(mailErrorToastMessage(new ApiError("连接邮箱服务器超时", "timeout", 504))).toBe("连接邮箱服务器超时。检查后重试。");
  });

  it("gives a safe recovery path for expired account OAuth", () => {
    const issue = accountHealthIssue({ status: "reauth_required", lastError: "授权已失效，请重新登录。" });

    expect(issue).toMatchObject({ kind: "oauth", title: "需要重新登录", retryable: false });
    expect(issue?.guidance).toContain("移除");
  });

  it("classifies a persisted provider configuration message before its TLS keyword", () => {
    const issue = accountHealthIssue({
      status: "error",
      lastError: "邮件服务商拒绝了当前协议或服务器配置。请核对 IMAP/SMTP 地址、端口与 TLS/STARTTLS 设置。",
    });

    expect(issue).toMatchObject({ kind: "protocol", title: "邮箱服务器配置不匹配", retryable: false });
  });

  it("uses the persisted server code before falling back to saved error text", () => {
    const issue = accountHealthIssue({
      status: "error",
      lastErrorCode: "tls_certificate_failed",
      lastError: "连接未完成。",
    });

    expect(issue).toMatchObject({ kind: "tls", title: "TLS 证书验证未通过", retryable: false });
  });

  it("keeps a partial mailbox sync visible as a retryable account health issue", () => {
    const issue = accountHealthIssue({
      status: "degraded",
      lastErrorCode: "partial_sync",
      lastError: "1 个文件夹未完成同步，其他文件夹的邮件仍可使用。",
    });

    expect(issue).toMatchObject({ kind: "sync", title: "部分文件夹未完成同步", retryable: true });
    expect(issue?.guidance).toContain("不会因此被删除");
  });
});
