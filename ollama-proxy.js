// ─── Ollama Proxy — Entry Point ───────────────────────────────────────────────
//
// Thin orchestrator: boots modules, wires the HTTP server, delegates to handlers.

import http from "http";
import { randomUUID } from "crypto";

// Logger MUST be imported first so console patches are active before other modules log.
import "./src/logger.js";

import { PORT, UPSTREAM_BASE, VERSION } from "./src/config.js";
import { loadKeys, getKeys, refreshCooldowns } from "./src/key-manager.js";
import { handleAdminRoutes } from "./src/admin-routes.js";
import { handleCacheableRequest } from "./src/proxy-handler.js";
import { handleStreamingRequest } from "./src/stream-handler.js";
import { receiveBody } from "./src/http-helpers.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

loadKeys();
refreshCooldowns();

const API_KEYS = getKeys();

if (API_KEYS.length === 0) {
  console.error("ERROR: No API keys configured. Set API_KEYS env var or create keys.json.");
  process.exit(1);
}

// ─── Request Handler ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const reqId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  // Track client disconnects on the *response* socket (not req).
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      console.warn(`[REQ ${reqId}] client disconnected before response completed`);
    }
  });

  // ── Admin / management routes ───────────────────────────────────────────────
  const handled = await handleAdminRoutes(req, res);
  if (handled) return;

  // ── Read request body ───────────────────────────────────────────────────────
  let body;
  try {
    body = await receiveBody(req);
  } catch (err) {
    console.error(`[REQ ${reqId}] body error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Cacheable metadata endpoints ────────────────────────────────────────────
  const wasCacheable = await handleCacheableRequest(req, res, reqId, startTime, body);
  if (wasCacheable) return;

  // ── Streaming / general proxy ───────────────────────────────────────────────
  await handleStreamingRequest(req, res, reqId, startTime, body, clientGone);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal proxy error" }));
    }
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received — draining connections…`);
  server.close(() => {
    console.log("[SERVER] All connections closed. Exiting.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[SERVER] Force exit after drain timeout");
    process.exit(1);
  }, 10_000).unref();
}

function handleServerError(err) {
  if (err.code === "EADDRINUSE") {
    console.error(`[SERVER] Port ${PORT} is already in use.`);
    console.error(`[SERVER] Stop the existing process using port ${PORT}, or set a different PORT.`);
    console.error(`[SERVER] Example: set PORT=11436 && npm run dev`);
    process.exit(1);
  }

  console.error("[SERVER] Failed to start:", err);
  process.exit(1);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.on("error", handleServerError);

server.listen(PORT, () => {
  console.log(`Proxy v${VERSION} running on http://localhost:${PORT}`);
  console.log(`Upstream: ${UPSTREAM_BASE}`);
  console.log(`Keys loaded: ${API_KEYS.length}`);
});