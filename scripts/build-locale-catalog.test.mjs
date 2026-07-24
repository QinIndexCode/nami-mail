import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalePacks } from "./build-locale-catalog.mjs";

function localePack(file, locale, messages) {
  return {
    file,
    pack: {
      meta: {
        locale,
        nativeName: locale,
      },
      messages,
    },
  };
}

const baselineMessages = {
  "mail.greeting": "Hello {name}",
  "mail.count": "{count} messages",
};

test("accepts complete locale packs that use canonical identifiers", () => {
  const result = validateLocalePacks([
    localePack("zh-CN.json", "zh-CN", baselineMessages),
    localePack("en-US.json", "en-US", {
      "mail.greeting": "Hello {name}",
      "mail.count": "{count} messages",
    }),
  ]);

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.packs.map((pack) => pack.locale), ["en-US", "zh-CN"]);
});

test("rejects incomplete packs, extra keys, and placeholder-name drift", () => {
  const result = validateLocalePacks([
    localePack("zh-CN.json", "zh-CN", baselineMessages),
    localePack("en-US.json", "en-US", {
      "mail.greeting": "Hello {recipient}",
      "mail.extra": "Extra copy",
    }),
  ]);

  assert.ok(result.issues.some((issue) => issue.includes("missing baseline key mail.count")));
  assert.ok(result.issues.some((issue) => issue.includes("extra key mail.extra")));
  assert.ok(result.issues.some((issue) => issue.includes("different placeholder names for mail.greeting")));
});

test("rejects non-canonical locale identifiers while detecting canonical duplicates", () => {
  const result = validateLocalePacks([
    localePack("zh-CN.json", "zh-CN", baselineMessages),
    localePack("en-US.json", "en-US", baselineMessages),
    localePack("en-us.json", "en-us", baselineMessages),
  ]);

  assert.ok(result.issues.some((issue) => issue.includes("must use canonical BCP-47 locale en-US")));
  assert.ok(result.issues.some((issue) => issue.includes("Duplicate locale en-US")));
});

test("requires zh-CN as the baseline locale pack", () => {
  const result = validateLocalePacks([
    localePack("en-US.json", "en-US", baselineMessages),
  ]);

  assert.ok(result.issues.includes("Missing required zh-CN locale pack."));
});
