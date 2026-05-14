// ─── Cacheable Request Handler ────────────────────────────────────────────────
//
// Handles requests to metadata endpoints (/api/tags, /v1/models, /api/show)
// with response caching and inflight coalescing.

import { CACHE_TTL } from "./config.js";
import { getKeys, cooldownKey, releaseKey, earliestRetryAfterSecs } from "./key-manager.js";
import { pickKey } from "./key-picker.js";
import {
  cacheKey, cacheGet, cacheSet,
  hasInflight, getInflight, setInflight, deleteInflight,
} from "./cache.js";
import { attemptRequest, writeRateLimited } from "./http-helpers.js";

/**
 * Handle a cacheable metadata request.
 * @returns {boolean} true if handled (cacheable path), false otherwise.
 */
export async function handleCacheableRequest(req, res, reqId, startTime, body) {
  const urlPath = req.url.split("?")[0];
  const cacheTTL = CACHE_TTL[urlPath];
  if (!cacheTTL) return false;

  const key = cacheKey(urlPath, body);
  const entry = cacheGet(key);

  if (entry) {
    const elapsed = Date.now() - startTime;
    console.log(`[REQ ${reqId}] CACHE HIT ${urlPath} key="${key}" ${elapsed}ms`);
    res.writeHead(200, { ...entry.headers, "x-cache": "HIT" });
    res.end(entry.body);
    return true;
  }

  // ── Coalescing: if another request is already fetching, wait ──
  if (hasInflight(key)) {
    console.log(`[REQ ${reqId}] COALESCED ${urlPath} key="${key}"`);
    try {
      const { body: cachedBody, headers: cachedHeaders } = await getInflight(key);
      const elapsed = Date.now() - startTime;
      console.log(`[REQ ${reqId}] COALESCE RESOLVED ${urlPath} ${elapsed}ms`);
      res.writeHead(200, { ...cachedHeaders, "x-cache": "HIT" });
      res.end(cachedBody);
      return true;
    } catch (err) {
      console.warn(`[REQ ${reqId}] inflight failed: ${err.message}, becoming fetcher`);
    }
  }

  // ── This request is the designated fetcher ─────────────────────────────────
  let resolveInflight, rejectInflight;
  const inflightPromise = new Promise((r, j) => { resolveInflight = r; rejectInflight = j; });
  setInflight(key, inflightPromise);

  try {
    const result = await fetchWithKeyRotation(req, res, reqId, startTime, body, {
      onSuccess: (responseBody, forwardHeaders) => {
        const headersToStore = { ...forwardHeaders, "x-cache": "MISS" };
        cacheSet(key, cacheTTL, headersToStore, responseBody);
        console.log(`[CACHE] stored key="${key}" ttl=${cacheTTL / 1000}s`);
        resolveInflight({ body: responseBody, headers: headersToStore });
        res.writeHead(200, headersToStore);
        res.end(responseBody);
      },
      onStreamError: (err) => rejectInflight(err),
      onAllExhausted: () => rejectInflight(new Error("All keys rate-limited")),
      onUpstreamError: (status) => rejectInflight(new Error(`Upstream ${status}`)),
      collectBody: true, // Buffer full response for caching
    });
  } finally {
    deleteInflight(key);
  }

  return true;
}

/**
 * Core key-rotation loop shared by both cacheable and non-cacheable paths.
 *
 * Tries each key; on 429/401, puts the key on cooldown and tries the next.
 * The `callbacks` object lets the caller control what happens on success/failure.
 */
export async function fetchWithKeyRotation(req, res, reqId, startTime, body, callbacks) {
  const API_KEYS = getKeys();
  const triedKeys = new Set();

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const keyObj = await pickKey(triedKeys);

    if (!keyObj) {
      const retryAfter = earliestRetryAfterSecs();
      console.warn(`[REQ ${reqId}] all keys cooling, returning 429 retry-after=${retryAfter}s`);
      if (callbacks.onAllExhausted) callbacks.onAllExhausted();
      writeRateLimited(res, retryAfter);
      return;
    }

    triedKeys.add(keyObj);
    const keyIdx = API_KEYS.indexOf(keyObj);

    try {
      const { status, headers, bodyStream } = await attemptRequest(
        req.method, req.url, req.headers, body, keyObj
      );

      if (status === 429 || status === 401) {
        cooldownKey(keyObj, headers["retry-after"]);
        console.warn(`[REQ ${reqId}] key=${keyIdx} ${status} — trying next key`);
        continue;
      }

      releaseKey(keyObj);
      const forwardHeaders = { ...headers };
      delete forwardHeaders["transfer-encoding"];

      if (status === 200 && callbacks.collectBody) {
        const elapsed = Date.now() - startTime;
        console.log(`[REQ ${reqId}] 200 key=${keyIdx} ${req.method} ${req.url} ${elapsed}ms`);
        const chunks = [];
        bodyStream.on("data", (c) => chunks.push(c));
        bodyStream.on("end", () => {
          callbacks.onSuccess(Buffer.concat(chunks), forwardHeaders);
        });
        bodyStream.on("error", (err) => {
          console.error(`[REQ ${reqId}] stream error: ${err.message}`);
          if (callbacks.onStreamError) callbacks.onStreamError(err);
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Upstream stream error" }));
          }
        });
        return;
      }

      // Non-cacheable success or non-200 — delegate to caller
      if (status === 200) {
        callbacks.onSuccess(bodyStream, forwardHeaders, keyIdx);
      } else {
        console.error(`[REQ ${reqId}] upstream error status=${status} key=${keyIdx}`);
        if (callbacks.onUpstreamError) callbacks.onUpstreamError(status);
        res.writeHead(status, forwardHeaders);
        bodyStream.pipe(res);
      }
      return;

    } catch (err) {
      releaseKey(keyObj);
      console.error(`[REQ ${reqId}] key=${keyIdx} network error: ${err.message}`);
    }
  }

  // All keys exhausted via 429s
  const retryAfter = earliestRetryAfterSecs();
  if (callbacks.onAllExhausted) callbacks.onAllExhausted();
  writeRateLimited(res, retryAfter);
}
