import assert from "node:assert/strict";
import test from "node:test";
import { isHttpUrl, openInBrowser } from "../src/desktop-external-open.mts";

test("classifies only http(s) URLs as openable external links", () => {
  assert.equal(isHttpUrl("https://accounts.google.com/o/oauth2/auth?x=1"), true);
  assert.equal(isHttpUrl("http://127.0.0.1:5173/oauth"), true);
  for (const rejected of ["mailto:someone@example.com", "file:///c:/secret.txt", "javascript:alert(1)", "nami-mail://open", "not a url", ""]) {
    assert.equal(isHttpUrl(rejected), false, rejected);
  }
});

test("hands the URL to the OS browser when Chrome is not available", async () => {
  const opened: string[] = [];
  await openInBrowser("https://example.com/oauth", {
    openExternal: async (url) => { opened.push(url); },
    platform: "win32",
    resolveChrome: async () => null,
  });
  assert.deepEqual(opened, ["https://example.com/oauth"]);
});

test("prefers a detached Chrome process when one is found", async () => {
  const opened: string[] = [];
  const launched: Array<{ command: string; args: readonly string[]; unrefd: boolean }> = [];
  await openInBrowser("https://example.com/oauth", {
    openExternal: async (url) => { opened.push(url); },
    platform: "win32",
    resolveChrome: async () => "C:\\Chrome\\chrome.exe",
    launch: (command, args) => {
      const record = { command, args, unrefd: false };
      launched.push(record);
      return { unref: () => { record.unrefd = true; } };
    },
  });
  assert.deepEqual(opened, []);
  assert.deepEqual(launched, [{ command: "C:\\Chrome\\chrome.exe", args: ["https://example.com/oauth"], unrefd: true }]);
});

test("skips the Chrome probe entirely off Windows", async () => {
  const opened: string[] = [];
  let probed = false;
  await openInBrowser("https://example.com/oauth", {
    openExternal: async (url) => { opened.push(url); },
    platform: "darwin",
    resolveChrome: async () => {
      probed = true;
      return "/Applications/Google Chrome.app";
    },
  });
  assert.equal(probed, false);
  assert.deepEqual(opened, ["https://example.com/oauth"]);
});
