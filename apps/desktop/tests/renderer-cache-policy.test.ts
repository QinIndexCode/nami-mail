import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_MAIL_CACHE_STORAGE_TYPES,
  clearLegacyRendererMailCache,
  isLocalApiRequestUrl,
  localApiNoStoreRequestHeaders,
  localApiNoStoreResponseHeaders,
} from "../src/renderer-cache-policy.mts";

test("clears historical HTTP and CacheStorage data without touching authentication or unrelated storage", async () => {
  const calls: Array<{ operation: string; options?: unknown }> = [];
  const measuredSizes = [4096, 0];
  const result = await clearLegacyRendererMailCache({
    getCacheSize: async () => measuredSizes.shift() ?? 0,
    clearCache: async () => {
      calls.push({ operation: "clearCache" });
    },
    clearStorageData: async (options) => {
      calls.push({ operation: "clearStorageData", options });
    },
  });

  assert.deepEqual(calls, [
    { operation: "clearCache" },
    { operation: "clearStorageData", options: { storages: ["cachestorage", "serviceworkers"] } },
  ]);
  assert.deepEqual(result, {
    cacheSizeBefore: 4096,
    cacheSizeAfter: 0,
    httpCacheCleared: true,
    storageTypesCleared: ["cachestorage", "serviceworkers"],
  });
  assert.deepEqual(LEGACY_MAIL_CACHE_STORAGE_TYPES, ["cachestorage", "serviceworkers"]);
  assert.ok(!result.storageTypesCleared.includes("cookies" as never));
  assert.ok(!result.storageTypesCleared.includes("localstorage" as never));
  assert.ok(!result.storageTypesCleared.includes("indexdb" as never));
});
test("still performs mandatory cleanup when cache-size diagnostics are unavailable", async () => {
  let clearCacheCalls = 0;
  let clearStorageCalls = 0;
  const result = await clearLegacyRendererMailCache({
    getCacheSize: async () => {
      throw new Error("cache size unavailable");
    },
    clearCache: async () => {
      clearCacheCalls += 1;
    },
    clearStorageData: async () => {
      clearStorageCalls += 1;
    },
  });
  assert.equal(clearCacheCalls, 1);
  assert.equal(clearStorageCalls, 1);
  assert.equal(result.cacheSizeBefore, null);
  assert.equal(result.cacheSizeAfter, null);
});

test("replaces conflicting cache headers while preserving content and authentication headers", () => {
  assert.deepEqual(localApiNoStoreRequestHeaders({
    "cache-control": "max-age=3600",
    pragma: "cached",
    "X-Nami-Api-Token": "process-only-token",
  }), {
    "X-Nami-Api-Token": "process-only-token",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });

  assert.deepEqual(localApiNoStoreResponseHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "CACHE-CONTROL": "public, max-age=86400",
    pragma: "cached",
    ExPiReS: "tomorrow",
    "Set-Cookie": "oauth_state=preserved",
  }), {
    "Content-Type": "application/json; charset=utf-8",
    "Set-Cookie": "oauth_state=preserved",
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
});

test("applies the no-store policy only to the exact loopback origin and api path", () => {
  const origin = "http://127.0.0.1:53124";
  assert.equal(isLocalApiRequestUrl(`${origin}/api/messages/message-1`, origin), true);
  assert.equal(isLocalApiRequestUrl(`${origin}/api/messages?folder=INBOX`, origin), true);
  assert.equal(isLocalApiRequestUrl(`${origin}/assets/index.js`, origin), false);
  assert.equal(isLocalApiRequestUrl("http://127.0.0.1:53125/api/messages", origin), false);
  assert.equal(isLocalApiRequestUrl("http://localhost:53124/api/messages", origin), false);
  assert.equal(isLocalApiRequestUrl(`${origin}.example/api/messages`, origin), false);
  assert.equal(isLocalApiRequestUrl("not a url", origin), false);
});
