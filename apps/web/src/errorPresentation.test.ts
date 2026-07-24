import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { accountHealthIssue, mailErrorToastMessage, presentMailError } from "./errorPresentation";
import { translate, type Translate } from "./i18n";

const zh: Translate = (key, values) => translate("zh-CN", key, values);
const en: Translate = (key, values) => translate("en-US", key, values);

describe("presentMailError", () => {
  it("keeps TLS failures separate from network reachability", () => {
    const issue = presentMailError(new ApiError("无法建立已验证的 TLS/STARTTLS 连接", "tls_failed", 422));

    expect(issue).toMatchObject({ kind: "tls", title: zh("error.tlsFailed.title"), retryable: false });
    expect(issue.guidance).toBe(zh("error.tlsFailed.guidance"));
  });

  it("explains timeouts as a network or server reachability issue", () => {
    const issue = presentMailError(new ApiError("连接邮箱服务器超时", "timeout", 422));

    expect(issue).toMatchObject({ kind: "connection", title: zh("error.timeout.title"), retryable: true });
    expect(issue.guidance).toBe(zh("error.timeout.guidance"));
  });

  it("presents local credential integrity failure before ordinary credential errors", () => {
    const issue = presentMailError(new ApiError(
      "本地账户数据与已保存的连接配置不匹配，Nami Mail 未连接邮件服务器。",
      "local_data_invalid",
      422,
    ));

    expect(issue).toMatchObject({
      kind: "local-data",
      title: zh("error.localDataInvalid.title"),
      retryable: false,
    });
    expect(issue.message).toBe(zh("error.localDataInvalid.message"));
    expect(issue.guidance).toBe(zh("error.localDataInvalid.guidance"));
    expect(issue.title).not.toBe(zh("error.invalidCredential.title"));
  });

  it.each([
    ["network_unavailable", "error.networkUnavailable.title"],
    ["connection_refused", "error.connectionRefused.title"],
    ["tls_certificate_failed", "error.tlsCertificateFailed.title"],
    ["tls_handshake_failed", "error.tlsHandshakeFailed.title"],
    ["provider_configuration", "error.providerConfiguration.title"],
  ])("maps the stable %s code without leaking transport detail", (code, titleKey) => {
    const issue = presentMailError(new ApiError("underlying transport detail", code, 422));
    expect(issue).toMatchObject({ title: zh(titleKey) });
    expect(issue.message).not.toContain("underlying transport detail");
  });

  it("treats saved technical DNS text as a server address problem", () => {
    const issue = presentMailError("getaddrinfo ENOTFOUND imap.example.com");

    expect(issue).toMatchObject({ kind: "dns", title: zh("error.serverNotFound.title") });
    expect(issue.message).not.toContain("ENOTFOUND");
  });

  it("does not present browser fetch failures as an email password error", () => {
    const issue = presentMailError(new TypeError("Failed to fetch"));

    expect(issue).toMatchObject({ kind: "local-service", title: zh("error.localServiceUnavailable.title") });
  });

  it("recognizes the normalized local-service code from every API path", () => {
    const issue = presentMailError(new ApiError("无法连接到 Nami Mail 本地服务。", "local_service_unavailable"));

    expect(issue).toMatchObject({ kind: "local-service", title: zh("error.localServiceUnavailable.title") });
  });

  it("keeps transient notices short while retaining the recovery category", () => {
    expect(mailErrorToastMessage(new ApiError("连接邮箱服务器超时", "timeout", 504)))
      .toBe(zh("error.toastRetryable", { title: zh("error.timeout.title") }));
  });

  it("gives a safe recovery path for expired account OAuth", () => {
    const issue = accountHealthIssue({ status: "reauth_required", lastError: "授权已失效，请重新登录。" });

    expect(issue).toMatchObject({ kind: "oauth", title: zh("error.reauthRequired.title"), retryable: false });
    expect(issue?.guidance).toBe(zh("error.reauthRequired.guidance"));
  });

  it("classifies a persisted provider configuration message before its TLS keyword", () => {
    const issue = accountHealthIssue({
      status: "error",
      lastError: "邮件服务商拒绝了当前协议或服务器配置。请核对 IMAP/SMTP 地址、端口与 TLS/STARTTLS 设置。",
    });

    expect(issue).toMatchObject({ kind: "protocol", title: zh("error.providerConfiguration.title"), retryable: false });
  });

  it("uses the persisted server code before falling back to saved error text", () => {
    const issue = accountHealthIssue({
      status: "error",
      lastErrorCode: "tls_certificate_failed",
      lastError: "连接未完成。",
    });

    expect(issue).toMatchObject({ kind: "tls", title: zh("error.tlsCertificateFailed.title"), retryable: false });
  });

  it("keeps a partial mailbox sync visible as a retryable account health issue", () => {
    const issue = accountHealthIssue({
      status: "degraded",
      lastErrorCode: "partial_sync",
      lastError: "1 个文件夹未完成同步，其他文件夹的邮件仍可使用。",
    });

    expect(issue).toMatchObject({ kind: "sync", title: zh("error.partialSync.title"), retryable: true });
    expect(issue?.guidance).toBe(zh("error.partialSync.guidance"));
  });

  it("uses the selected language without exposing Chinese recovery text", () => {
    const issue = presentMailError(new ApiError("socket hang up", "timeout", 504), en);

    expect(issue).toMatchObject({ kind: "connection", title: en("error.timeout.title"), retryable: true });
    expect(`${issue.message} ${issue.guidance}`).not.toMatch(/[\u4E00-\u9FFF]/);
  });
});
