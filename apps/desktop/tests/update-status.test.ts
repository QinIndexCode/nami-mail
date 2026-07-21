import assert from "node:assert/strict";
import test from "node:test";
import { createUpdateSnapshot, describeUpdateError } from "../src/update-status.mts";

test("classifies updater network failures without blaming mailbox credentials", () => {
  const error = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
  assert.match(describeUpdateError(error), /网络、代理或 DNS/);
});

test("keeps TLS and signature failures distinct", () => {
  assert.match(describeUpdateError(new Error("CERT_HAS_EXPIRED")), /证书验证失败/);
  assert.match(describeUpdateError(new Error("New version is not signed by the application owner")), /签名验证失败/);
});

test("creates a stable renderer-safe update snapshot", () => {
  assert.deepEqual(createUpdateSnapshot("0.1.0", "checking", "正在检查。"), {
    phase: "checking",
    currentVersion: "0.1.0",
    targetVersion: null,
    percent: null,
    checkedAt: null,
    suppression: "none",
    remindAt: null,
    message: "正在检查。",
  });
});
