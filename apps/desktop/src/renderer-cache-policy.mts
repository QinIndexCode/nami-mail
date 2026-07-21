export const LEGACY_MAIL_CACHE_STORAGE_TYPES = ["cachestorage", "serviceworkers"] as const;

type CacheStorageType = typeof LEGACY_MAIL_CACHE_STORAGE_TYPES[number];

export type RendererCacheSession = {
  getCacheSize: () => Promise<number>;
  clearCache: () => Promise<void>;
  clearStorageData: (options: { storages: CacheStorageType[] }) => Promise<void>;
};

export type RendererCacheCleanupResult = {
  cacheSizeBefore: number | null;
  cacheSizeAfter: number | null;
  httpCacheCleared: true;
  storageTypesCleared: CacheStorageType[];
};

async function measuredCacheSize(cacheSession: Pick<RendererCacheSession, "getCacheSize">): Promise<number | null> {
  try {
    const size = await cacheSession.getCacheSize();
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
  } catch {
    // Cache size is diagnostic only. A failed measurement must not skip the
    // mandatory cache removals below.
    return null;
  }
}
/** Clears only renderer cache surfaces that could retain old mail responses. */
export async function clearLegacyRendererMailCache(cacheSession: RendererCacheSession): Promise<RendererCacheCleanupResult> {
  const cacheSizeBefore = await measuredCacheSize(cacheSession);
  await cacheSession.clearCache();
  const storageTypesCleared = [...LEGACY_MAIL_CACHE_STORAGE_TYPES];
  await cacheSession.clearStorageData({ storages: storageTypesCleared });
  const cacheSizeAfter = await measuredCacheSize(cacheSession);
  return {
    cacheSizeBefore,
    cacheSizeAfter,
    httpCacheCleared: true,
    storageTypesCleared,
  };
}

export type HttpHeaders = Record<string, string | string[]>;

function withoutHeaders(headers: HttpHeaders, names: ReadonlySet<string>): HttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())));
}

const cacheRequestHeaderNames = new Set(["cache-control", "pragma"]);
const cacheResponseHeaderNames = new Set(["cache-control", "pragma", "expires"]);

export function localApiNoStoreRequestHeaders(headers: HttpHeaders): HttpHeaders {
  return {
    ...withoutHeaders(headers, cacheRequestHeaderNames),
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

export function localApiNoStoreResponseHeaders(headers: HttpHeaders | undefined): HttpHeaders {
  return {
    ...withoutHeaders(headers ?? {}, cacheResponseHeaderNames),
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };
}

export function isLocalApiRequestUrl(value: string, localOrigin: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === localOrigin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}
