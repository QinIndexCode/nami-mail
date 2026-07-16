import { describe, expect, it } from "vitest";
import { createImapClient, friendlyMailError } from "../src/mail.js";

describe("IMAP client error isolation", () => {
  it("absorbs a late error event instead of terminating the server", () => {
    const client = createImapClient("hello@example.com", "not-used", {
      imap: { host: "127.0.0.1", port: 1993, secure: true },
      usernameMode: "email",
    });

    expect(client.listenerCount("error")).toBeGreaterThan(0);
    expect(() => client.emit("error", new Error("late socket failure"))).not.toThrow();
  });

  it("recognizes ImapFlow authentication metadata when the message is generic", () => {
    const error = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
    });

    expect(friendlyMailError(error, "请使用应用专用密码")).toBe(
      "邮箱拒绝了登录凭据。 请使用应用专用密码",
    );
  });

  it("recognizes transport codes when the message is generic", () => {
    const error = Object.assign(new Error("Connection failed"), { code: "ETIMEDOUT" });
    expect(friendlyMailError(error)).toBe("连接邮箱服务器超时，请检查网络或稍后重试。");
  });
});
