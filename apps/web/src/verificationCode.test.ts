import { describe, expect, it } from "vitest";
import { findVerificationCodes } from "./verificationCode";

describe("findVerificationCodes", () => {
  it("finds a Chinese verification code and normalizes spaced digits", () => {
    expect(findVerificationCodes({
      subject: "登录验证码",
      body: "你的验证码是 123 456，10 分钟内有效。",
    })).toMatchObject([{ code: "123456", source: "body" }]);
  });

  it("ranks explicit verification context ahead of a weaker subject candidate", () => {
    expect(findVerificationCodes({
      subject: "Use code 654321 to continue",
      body: "Your verification code is 123456. Do not share it.",
    })).toMatchObject([{ code: "123456" }, { code: "654321" }]);
  });

  it("finds a direct generic code label in a message body", () => {
    expect(findVerificationCodes({
      subject: "Continue your sign-in",
      body: "Your code is 654321.",
    })).toMatchObject([{ code: "654321", source: "body" }]);
  });

  it("finds a verification label that follows the numeric code", () => {
    expect(findVerificationCodes({
      subject: "Account confirmation",
      body: "Use 654321 as your verification code to continue.",
    })).toMatchObject([{ code: "654321", source: "body" }]);
  });

  it("does not surface an unrelated session number from a sign-in notice", () => {
    expect(findVerificationCodes({
      subject: "A new sign-in was detected",
      body: "We recorded session 20216706 on your account. Review the activity if this was not you.",
    })).toEqual([]);
  });

  it("does not surface ordinary order, tracking, and invoice numbers", () => {
    expect(findVerificationCodes({
      subject: "Order confirmation # 12345678",
      body: "订单号：2024071801。物流单号：98765432。发票号码：12345678。",
    })).toEqual([]);
  });

  it("does not use a longer phone-like number as a verification code", () => {
    expect(findVerificationCodes({
      subject: "客服联系",
      body: "客服电话是 86 138 0013 8000。",
    })).toEqual([]);
  });

  it("does not mistake an expiry date for a verification code", () => {
    expect(findVerificationCodes({
      subject: "Verification code expired",
      body: "Your verification code expired on 2024-12-31.",
    })).toEqual([]);
  });

  it("allows an explicit verification code even when an email also mentions an order", () => {
    expect(findVerificationCodes({
      subject: "确认订单",
      body: "为确认本次订单，请使用验证码：248901。",
    })).toMatchObject([{ code: "248901" }]);
  });
});
