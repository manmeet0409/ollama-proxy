// ─── Admin Routes ─────────────────────────────────────────────────────────────
//
// Localhost-only management endpoints for key CRUD, logs, health, and dashboard.

import { getKeys, saveKeys, refreshCooldowns, getActiveKeyIndex } from "./key-manager.js";
import { getLogs } from "./logger.js";
import { receiveBody } from "./http-helpers.js";
import { getDashboardHTML } from "./dashboard.js";

/**
 * Handle admin/management requests.
 * @returns {boolean} true if the request was handled, false otherwise.
 */
export async function handleAdminRoutes(req, res) {
  const clientIP = req.socket.remoteAddress || "";
  const isLocalhost = clientIP === "127.0.0.1" || clientIP === "::1" || clientIP === "::ffff:127.0.0.1";

  // ── Health check (public) ───────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    return handleHealth(res);
  }

  // ── Key management (localhost only) ─────────────────────────────────────────
  if (req.url.startsWith("/api/keys")) {
    if (!isLocalhost) return forbidden(res, "Admin API only accessible from localhost");
    return handleKeysAPI(req, res);
  }

  // ── Logs API (localhost only) ───────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/logs") {
    if (!isLocalhost) return forbidden(res, "Logs API only accessible from localhost");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ logs: getLogs() }));
    return true;
  }

  // ── Dashboard UI (localhost only) ───────────────────────────────────────────
  if (req.method === "GET" && req.url === "/dashboard") {
    if (!isLocalhost) { res.writeHead(403); res.end("Forbidden"); return true; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML());
    return true;
  }

  return false; // Not an admin route
}

function forbidden(res, message) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
  return true;
}

function handleHealth(res) {
  refreshCooldowns();
  const keys = getKeys();
  const active = keys.filter((k) => k.status === "active").length;
  const healthy = active > 0;

  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: healthy ? "ok" : "degraded",
    keys: keys.map((k, i) => ({
      index: i,
      status: k.status,
      concurrency: k.concurrency,
      usageCount: k.usageCount,
      cooldownRemainingSecs: k.cooldownUntil
        ? Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000))
        : 0,
    })),
  }));
  return true;
}

async function handleKeysAPI(req, res) {
  const keys = getKeys();

  // GET /api/keys
  if (req.method === "GET" && req.url === "/api/keys") {
    refreshCooldowns();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      keys: keys.map((k, i) => ({
        index: i,
        name: k.name,
        key: k.key.slice(0, 8) + "...",
        status: k.status,
        concurrency: k.concurrency,
        usageCount: k.usageCount,
        cooldownRemainingSecs: k.cooldownUntil
          ? Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000))
          : 0,
      })),
    }));
    return true;
  }

  // POST /api/keys
  if (req.method === "POST" && req.url === "/api/keys") {
    return handleAddKey(req, res, keys);
  }

  // PATCH /api/keys/:index
  const patchMatch = req.url.match(/^\/api\/keys\/(\d+)$/);
  if (req.method === "PATCH" && patchMatch) {
    return handlePatchKey(req, res, keys, parseInt(patchMatch[1], 10));
  }

  // DELETE /api/keys/:index
  const deleteMatch = req.url.match(/^\/api\/keys\/(\d+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    return handleDeleteKey(res, keys, parseInt(deleteMatch[1], 10));
  }

  return false;
}

async function handleAddKey(req, res, keys) {
  try {
    const body = await receiveBody(req);
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed.key || typeof parsed.key !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Missing 'key' field" }));
      return true;
    }
    if (keys.some((k) => k.key === parsed.key)) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Key already exists" }));
      return true;
    }
    keys.push({
      key: parsed.key,
      name: parsed.name || null,
      status: "active",
      cooldownUntil: null,
      usageCount: 0,
      failCount: 0,
      concurrency: 0,
    });
    saveKeys();
    console.log(`[ADMIN] Added new key at index ${keys.length - 1}`);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ index: keys.length - 1, status: "active" }));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
  return true;
}

async function handlePatchKey(req, res, keys, index) {
  if (index < 0 || index >= keys.length) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Key not found" }));
    return true;
  }
  try {
    const body = await receiveBody(req);
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed.name !== undefined) {
      keys[index].name = parsed.name || null;
      saveKeys();
      console.log(`[ADMIN] Updated name for key ${index}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ index, name: keys[index].name }));
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
  return true;
}

function handleDeleteKey(res, keys, index) {
  if (index < 0 || index >= keys.length) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Key not found" }));
    return true;
  }
  if (keys.length === 1) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Cannot remove last key" }));
    return true;
  }
  keys.splice(index, 1);
  saveKeys();
  console.log(`[ADMIN] Removed key at index ${index}`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ removed: index }));
  return true;
}
