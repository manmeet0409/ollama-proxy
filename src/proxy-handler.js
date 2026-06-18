// ─── Cacheable Request Handler ────────────────────────────────────────────────
//
// Handles requests to metadata endpoints (/api/tags, /v1/models, /api/show)
// with response caching and inflight coalescing.

import { CACHE_TTL } from "./config.js";
import {
  getKeys,
  cooldownKey,
  releaseKey,
  earliestRetryAfterSecs,
} from "./key-manager.js";
import { pickKey } from "./key-picker.js";
import {
  cacheKey,
  cacheGet,
  cacheSet,
  hasInflight,
  getInflight,
  setInflight,
  deleteInflight,
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
    console.log(
      `[REQ ${reqId}] CACHE HIT ${urlPath} key="${key}" ${elapsed}ms`,
    );
    res.writeHead(200, { ...entry.headers, "x-cache": "HIT" });
    res.end(entry.body);
    return true;
  }

  // ── Coalescing: if another request is already fetching, wait ──
  if (hasInflight(key)) {
    console.log(`[REQ ${reqId}] COALESCED ${urlPath} key="${key}"`);
    try {
      const { body: cachedBody, headers: cachedHeaders } =
        await getInflight(key);
      const elapsed = Date.now() - startTime;
      console.log(`[REQ ${reqId}] COALESCE RESOLVED ${urlPath} ${elapsed}ms`);
      res.writeHead(200, { ...cachedHeaders, "x-cache": "HIT" });
      res.end(cachedBody);
      return true;
    } catch (err) {
      console.warn(
        `[REQ ${reqId}] inflight failed: ${err.message}, becoming fetcher`,
      );
    }
  }

  // ── This request is the designated fetcher ─────────────────────────────────
  let resolveInflight, rejectInflight;
  const inflightPromise = new Promise((r, j) => {
    resolveInflight = r;
    rejectInflight = j;
  });
  setInflight(key, inflightPromise);

  try {
    const result = await fetchWithKeyRotation(
      req,
      res,
      reqId,
      startTime,
      body,
      {
        onSuccess: (responseBody, forwardHeaders) => {
          const headersToStore = { ...forwardHeaders, "x-cache": "MISS" };
          cacheSet(key, cacheTTL, headersToStore, responseBody);
          console.log(`[CACHE] stored key="${key}" ttl=${cacheTTL / 1000}s`);
          resolveInflight({ body: responseBody, headers: headersToStore });
          res.writeHead(200, headersToStore);
          res.end(responseBody);
        },
        onStreamError: (err) => rejectInflight(err),
        onAllExhausted: () =>
          rejectInflight(new Error("All keys rate-limited")),
        onUpstreamError: (status) =>
          rejectInflight(new Error(`Upstream ${status}`)),
        collectBody: true, // Buffer full response for caching
      },
    );
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
export async function fetchWithKeyRotation(
  req,
  res,
  reqId,
  startTime,
  body,
  callbacks,
) {
  const API_KEYS = getKeys();
  const triedKeys = new Set();

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    // ── Early Disconnect Check ───────────────────────────────────────────────
    // If the client has already hung up (common during rapid retries), abort.
    if (res.destroyed || res.writableEnded) {
      console.warn(
        `[REQ ${reqId}] client left before key picker — aborting fetch`,
      );
      return;
    }

    const keyObj = await pickKey(triedKeys);

    if (!keyObj) {
      const retryAfter = earliestRetryAfterSecs();
      console.warn(
        `[REQ ${reqId}] all keys cooling, returning 429 retry-after=${retryAfter}s`,
      );
      if (callbacks.onAllExhausted) callbacks.onAllExhausted();
      writeRateLimited(res, retryAfter);
      return;
    }

    // ── Disconnect check AFTER picking (prevent leak) ────────────────────────
    if (res.destroyed || res.writableEnded) {
      console.warn(
        `[REQ ${reqId}] client left during key picker — releasing key immediately`,
      );
      releaseKey(keyObj);
      return;
    }

    triedKeys.add(keyObj);
    const keyIdx = API_KEYS.indexOf(keyObj);

    try {
      const { status, headers, bodyStream } = await attemptRequest(
        req.method,
        req.url,
        req.headers,
        body,
        keyObj,
      );

      // ── Transient / Rate Limit / Forbidden Errors ──────────────────────────
      // 429/401: Key-specific issue (rate limit / auth)
      // 403: Forbidden (model mismatch or restriction — try next key)
      // 503/504: Transient upstream issue (overload / timeout)
      if (
        status === 429 ||
        status === 401 ||
        status === 403 ||
        status === 503 ||
        status === 504
      ) {
        // ── Fuzzy Error Detection ────────────────────────────────────────────
        // Buffer the error body (max 16KB) to see WHY it failed.
        const MAX_ERROR_BUFFER = 16384;
        let bytesReceived = 0;
        const chunks = [];

        const errorBody = await new Promise((resolve) => {
          bodyStream.on("data", (c) => {
            bytesReceived += c.length;
            if (bytesReceived <= MAX_ERROR_BUFFER) {
              chunks.push(c);
            }
          });
          bodyStream.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8")),
          );
          bodyStream.on("error", () => resolve(""));
        });

        // Always destroy the error body stream after reading
        bodyStream.destroy();

        const isConcurrencyError =
          /concurrent|active|rate.limit.reached.*try.again/i.test(errorBody);

        // "this model requires a subscription" is a PERMISSION error (not quota).
        // We detect it by checking for permission_error type in the JSON body.
        const isModelPermissionError = (() => {
          try {
            const parsed = JSON.parse(errorBody);
            return parsed?.error?.type === "permission_error";
          } catch {
            return false;
          }
        })();

        const isQuotaError =
          !isModelPermissionError &&
          /quota|exhausted|balance|credit|limit/i.test(errorBody);

        let retryAfter = headers["retry-after"];

        if (isModelPermissionError) {
          // This is a permanent model-access issue — no key rotation will help.
          // Release the key without cooldown and return the upstream error to the client.
          releaseKey(keyObj);
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} model permission error (subscription required) — aborting rotation`,
          );
          if (errorBody) {
            console.warn(
              `[REQ ${reqId}] key=${keyIdx} response: ${errorBody.slice(0, 200)}`,
            );
          }
          if (!res.headersSent) {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(errorBody || JSON.stringify({ error: "Model requires a subscription" }));
          }
          return;
        }

        if (isConcurrencyError && !isQuotaError) {
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} concurrency hit — applying mini-cooldown (5s)`,
          );
          retryAfter = "5";
        } else if (isQuotaError) {
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} quota/limit hit — forcing rotation`,
          );
          // cooldownKey will handle the long cooldown via isQuota=true
        } else if (status === 403) {
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} 403 Forbidden — applying short isolation (15s) and rotating`,
          );
          retryAfter = "15"; // Short isolation for other 403 model mismatches
        } else if (status >= 500) {
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} upstream ${status} — applying transient cooldown (10s)`,
          );
          retryAfter = "10";
        } else {
          console.warn(`[REQ ${reqId}] key=${keyIdx} ${status} — GENERIC fail`);
        }

        cooldownKey(keyObj, retryAfter, isQuotaError);
        if (errorBody) {
          console.warn(
            `[REQ ${reqId}] key=${keyIdx} response: ${errorBody.slice(0, 100)}${errorBody.length > 100 ? "..." : ""}`,
          );
        }
        continue;
      }

      // ── Deferred Release Logic ─────────────────────────────────────────────
      // We MUST NOT call releaseKey immediately. We wait for the stream to end.
      let released = false;
      const doRelease = () => {
        if (!released) {
          released = true;
          releaseKey(keyObj);
        }
      };

      bodyStream.on("end", doRelease);
      bodyStream.on("error", doRelease);
      bodyStream.on("close", doRelease);

      const forwardHeaders = { ...headers };
      delete forwardHeaders["transfer-encoding"];

      if (status === 200 && callbacks.collectBody) {
        const elapsed = Date.now() - startTime;
        console.log(
          `[REQ ${reqId}] 200 key=${keyIdx} ${req.method} ${req.url} ${elapsed}ms`,
        );
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
        console.error(
          `[REQ ${reqId}] upstream error status=${status} key=${keyIdx}`,
        );
        if (callbacks.onUpstreamError) callbacks.onUpstreamError(status);
        res.writeHead(status, forwardHeaders);
        bodyStream.pipe(res);
      }
      return;
    } catch (err) {
      releaseKey(keyObj);
      console.error(
        `[REQ ${reqId}] key=${keyIdx} network error: ${err.message}`,
      );
    }
  }

  // All keys exhausted via 429s
  const retryAfter = earliestRetryAfterSecs();
  if (callbacks.onAllExhausted) callbacks.onAllExhausted();
  writeRateLimited(res, retryAfter);
}
