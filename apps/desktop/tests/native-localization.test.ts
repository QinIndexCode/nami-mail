import assert from "node:assert/strict";
import test from "node:test";
import { formatNativeMessage, nativeText, resolveNativeLocale } from "../src/native-localization.mts";

test("uses the selected native locale and canonicalizes supported BCP-47 identifiers", () => {
  assert.equal(resolveNativeLocale("en-us"), "en-US");
  assert.equal(nativeText("en-US", "trayOpen"), "Open Nami Mail");
  assert.equal(nativeText("zh-CN", "trayOpen"), "打开 Nami Mail");
});

test("falls back to the required Chinese native locale for unavailable values", () => {
  assert.equal(resolveNativeLocale("fr-FR"), "zh-CN");
  assert.equal(resolveNativeLocale("not a locale"), "zh-CN");
  assert.equal(nativeText(undefined, "startupFailureTitle"), "Nami Mail 无法启动");
});

test("formats native notification templates without dropping missing placeholders", () => {
  assert.equal(nativeText("en-US", "notificationMultipleTitle", { count: 3 }), "Nami Mail · 3 new messages");
  assert.equal(formatNativeMessage("Hello, {name}. {missing}", { name: "Nami" }), "Hello, Nami. {missing}");
});
