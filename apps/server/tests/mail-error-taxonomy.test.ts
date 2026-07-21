import { describe, expect, it } from "vitest";
import { mailErrorCode, mailErrorHttpStatus, safeMailError, type MailErrorCode } from "../src/mail.js";

function transportError(message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), details);
}

describe("mail transport error taxonomy", () => {
  const cases: Array<{ error: Error; code: MailErrorCode; status: number }> = [
    { error: transportError("Stored account credential could not be authenticated.", { code: "local_data_invalid" }), code: "local_data_invalid", status: 422 },
    { error: transportError("getaddrinfo ENOTFOUND imap.example.invalid", { code: "ENOTFOUND" }), code: "server_not_found", status: 503 },
    { error: transportError("getaddrinfo EAI_AGAIN", { code: "EAI_AGAIN" }), code: "network_unavailable", status: 503 },
    { error: transportError("connect ENETUNREACH", { code: "ENETUNREACH" }), code: "network_unavailable", status: 503 },
    { error: transportError("connect ECONNREFUSED", { code: "ECONNREFUSED" }), code: "connection_refused", status: 503 },
    { error: transportError("socket timed out", { code: "ETIMEDOUT" }), code: "timeout", status: 504 },
    { error: transportError("certificate has expired", { code: "CERT_HAS_EXPIRED" }), code: "tls_certificate_failed", status: 422 },
    { error: transportError("write EPROTO", { code: "EPROTO" }), code: "tls_handshake_failed", status: 422 },
    { error: transportError("TLS upgrade timed out", { code: "UPGRADE_TIMEOUT", tlsFailed: true }), code: "tls_handshake_failed", status: 422 },
    { error: transportError("IMAP is disabled by administrator"), code: "imap_disabled", status: 422 },
    { error: transportError("Login is disabled", { authenticationFailed: true }), code: "imap_disabled", status: 422 },
    { error: transportError("SMTP AUTH is disabled for this tenant"), code: "provider_configuration", status: 422 },
    { error: transportError("535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant."), code: "provider_configuration", status: 422 },
    { error: transportError("Command failed", { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), code: "imap_auth_failed", status: 422 },
    { error: transportError("Invalid login", { code: "EAUTH" }), code: "smtp_auth_failed", status: 422 },
  ];

  it.each(cases)("maps $code without relying on raw text", ({ error, code, status }) => {
    expect(mailErrorCode(error)).toBe(code);
    expect(mailErrorHttpStatus(code)).toBe(status);
  });

  it("uses a nested cause and keeps its response safe", () => {
    const secret = "do-not-expose-this-secret";
    const error = transportError("connect failed", {
      cause: transportError(`getaddrinfo ENOTFOUND password=${secret}`, { code: "ENOTFOUND" }),
    });

    const result = safeMailError(error);

    expect(result.code).toBe("server_not_found");
    expect(result.message).not.toContain(secret);
    expect(result.message).not.toContain("ENOTFOUND");
  });

  it("reports local credential integrity failure without implying a server login attempt", () => {
    const result = safeMailError(transportError("Stored account credential could not be authenticated.", {
      code: "local_data_invalid",
    }));

    expect(result).toMatchObject({ code: "local_data_invalid" });
    expect(result.message).toContain("本地账户数据与已保存的连接配置不匹配");
    expect(result.message).toContain("未连接邮件服务器");
    expect(result.message).not.toContain("服务器拒绝");
  });

  it("does not label an unrecognized provider response as a network outage", () => {
    const secret = "do-not-expose-this-secret";
    const result = safeMailError(transportError(`provider replied: ${secret}`));

    expect(result.code).toBe("unknown");
    expect(result.message).not.toContain(secret);
    expect(mailErrorHttpStatus(result.code)).toBe(422);
  });
});
