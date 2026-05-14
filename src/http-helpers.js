// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

import https from "https";
import {
  UPSTREAM_BASE,
  SOCKET_TIMEOUT_MS,
  BODY_RECEIVE_TIMEOUT_MS,
  MAX_BODY_SIZE,
} from "./config.js";

/**
 * Read the full request body with timeout & size limits.
 */
export function receiveBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    const timer = setTimeout(() => {
      req.destroy(new Error("Body receive timeout"));
    }, BODY_RECEIVE_TIMEOUT_MS);

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timer);
        req.destroy(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Write a 429 rate-limited response.
 */
export function writeRateLimited(res, retryAfter) {
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(retryAfter),
  });
  res.end(JSON.stringify({
    error: "All API keys are rate-limited",
    retryAfterSeconds: retryAfter,
  }));
}

/**
 * Fire a single upstream request with the given key.
 */
export function attemptRequest(method, path, incomingHeaders, body, keyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, UPSTREAM_BASE);

    const headers = { ...incomingHeaders };
    delete headers["host"];
    delete headers["content-length"];
    headers["authorization"] = `Bearer ${keyObj.key}`;

    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        // Response headers received — cancel the connect/first-byte timeout
        // so it doesn't fire and destroy the socket during a long stream.
        req.setTimeout(0);
        resolve({ status: res.statusCode, headers: res.headers, bodyStream: res });
      }
    );

    // This timeout only guards connect + first-byte latency.
    // Once headers arrive (above) it is cleared immediately.
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error("Upstream connect/first-byte timeout"));
    });

    req.on("error", reject);

    if (body && body.length > 0) req.write(body);
    req.end();
  });
}
