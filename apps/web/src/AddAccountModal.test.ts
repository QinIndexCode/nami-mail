import { describe, expect, it } from "vitest";
import { canonicalGmailEmail } from "./AddAccountModal";

describe("canonicalGmailEmail", () => {
  it("keeps a plain address unchanged", () => {
    expect(canonicalGmailEmail("user@gmail.com")).toBe("user@gmail.com");
  });

  it("drops the +tag on gmail.com", () => {
    expect(canonicalGmailEmail("user+tag@gmail.com")).toBe("user@gmail.com");
  });

  it("drops the +tag on googlemail.com", () => {
    expect(canonicalGmailEmail("user+shopping@googlemail.com")).toBe("user@googlemail.com");
  });

  it("keeps the tag when the domain is not Gmail", () => {
    expect(canonicalGmailEmail("user+tag@company.com")).toBe("user+tag@company.com");
  });

  it("handles case and whitespace", () => {
    expect(canonicalGmailEmail("  USER+Tag@Gmail.com ")).toBe("user@gmail.com");
  });

  it("keeps an address whose local part starts with a plus empty", () => {
    expect(canonicalGmailEmail("+tag@gmail.com")).toBe("+tag@gmail.com");
  });
});