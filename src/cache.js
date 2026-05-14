// ─── In-Memory Cache ──────────────────────────────────────────────────────────
//
// Keyed by:  endpoint + ":" + stable request body hash (for POST /api/show)
// Value:     { body: Buffer, headers: object, expiresAt: number }
//
// /api/tags  → GET,  no body → cache key = "/api/tags"
// /api/show  → POST, body contains model name → cache key = "/api/show:<name>"

import { MAX_CACHE_ENTRIES } from "./config.js";

const responseCache = new Map();

// Inflight coalescing: cache key → Promise<{body, headers}>
// If a second request arrives while the first is still fetching upstream,
// it waits on the same promise instead of firing a duplicate upstream call.
const inflight = new Map();

/** Build a deterministic cache key for cacheable requests. */
export function cacheKey(url, body) {
  if (url === "/api/tags" || url === "/v1/models") return url;

  if (url === "/api/show") {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      const raw = parsed.name || parsed.model || "__unknown__";
      return `/api/show:${raw.trim().toLowerCase()}`;
    } catch {
      return `/api/show:__raw__:${body.toString("base64")}`;
    }
  }

  return url;
}

export function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry;
}

export function cacheSet(key, ttl, headers, body) {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey = null;
    let oldestExpiry = Infinity;
    for (const [k, entry] of responseCache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      responseCache.delete(oldestKey);
      console.log(`[CACHE] evicted "${oldestKey}" (LRU)`);
    }
  }
  responseCache.set(key, {
    body,
    headers,
    expiresAt: Date.now() + ttl,
  });
}

// ─── Inflight coalescing ──────────────────────────────────────────────────────

export function getInflight(key) {
  return inflight.get(key);
}

export function hasInflight(key) {
  return inflight.has(key);
}

export function setInflight(key, promise) {
  inflight.set(key, promise);
}

export function deleteInflight(key) {
  inflight.delete(key);
}
