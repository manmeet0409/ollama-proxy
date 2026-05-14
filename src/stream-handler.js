// ─── Streaming Request Handler ────────────────────────────────────────────────
//
// Handles non-cacheable requests (/api/chat, /api/generate, /v1/chat/completions, etc.)
// with streaming support and chat diagnostics.

import { fetchWithKeyRotation } from "./proxy-handler.js";

/**
 * Handle a non-cacheable (typically streaming) proxy request.
 */
export async function handleStreamingRequest(req, res, reqId, startTime, body, clientGone) {
  const urlPath = req.url.split("?")[0];

  await fetchWithKeyRotation(req, res, reqId, startTime, body, {
    collectBody: false,
    onSuccess: (bodyStream, forwardHeaders, keyIdx) => {
      const elapsed = Date.now() - startTime;
      console.log(`[REQ ${reqId}] 200 key=${keyIdx} ${req.method} ${req.url} ${elapsed}ms`);

      logChatDiagnostics(urlPath, body, bodyStream, reqId, startTime);

      if (clientGone || res.destroyed || res.writableEnded) {
        console.warn(`[REQ ${reqId}] client gone — discarding upstream response`);
        bodyStream.destroy();
        return;
      }

      res.writeHead(200, forwardHeaders);
      bodyStream.pipe(res);

      bodyStream.on("error", (err) => {
        console.error(`[REQ ${reqId}] upstream stream error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
      res.on("error", (err) => {
        console.error(`[REQ ${reqId}] client socket error: ${err.message}`);
        bodyStream.destroy();
      });
    },
    onAllExhausted: () => { /* writeRateLimited already called by fetchWithKeyRotation */ },
    onUpstreamError: () => { /* forwarded by fetchWithKeyRotation */ },
  });
}

/**
 * Chat-specific diagnostics: log stream mode, first-chunk latency, done marker.
 */
function logChatDiagnostics(urlPath, body, bodyStream, reqId, startTime) {
  const isChat = urlPath === "/api/chat"
    || urlPath === "/api/generate"
    || urlPath === "/v1/chat/completions";

  if (!isChat) return;

  let streamMode = "unknown";
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    streamMode = parsed.stream === false ? "non-stream" : "stream";
    console.log(`[CHAT ${reqId}] mode=${streamMode} model=${parsed.model || parsed.messages?.[0]?.role || "?"}`);
  } catch { /* non-JSON body */ }

  if (streamMode === "non-stream") return;

  let firstChunk = true;
  let chunkCount = 0;

  bodyStream.on("data", (chunk) => {
    chunkCount++;
    if (firstChunk) {
      firstChunk = false;
      console.log(`[CHAT ${reqId}] first chunk +${Date.now() - startTime}ms (${chunk.length}B)`);
    }
    try {
      const text = chunk.toString("utf8");
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (obj.done === true) {
          console.log(`[CHAT ${reqId}] done=true received after ${chunkCount} chunks +${Date.now() - startTime}ms`);
        }
      }
    } catch { /* chunk may be partial JSON — fine */ }
  });

  bodyStream.on("end", () => {
    console.log(`[CHAT ${reqId}] stream ended — ${chunkCount} chunks total +${Date.now() - startTime}ms`);
  });
}
