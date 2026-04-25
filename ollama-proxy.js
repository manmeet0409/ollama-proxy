import http from "http";
import https from "https";
import { randomUUID } from "crypto";
import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "11435", 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "ollama.com";
const UPSTREAM_BASE = `https://${UPSTREAM_HOST}`;
const DEFAULT_COOLDOWN_MS = parseInt(process.env.DEFAULT_COOLDOWN_MS || "60000", 10);
const SHORT_COOLDOWN_MS = 60_000;
const LONG_COOLDOWN_MS = 10 * 60_000;
const MAX_FAILS_BEFORE_LONG_COOLDOWN = 3;
const SOCKET_TIMEOUT_MS = parseInt(process.env.SOCKET_TIMEOUT_MS || "300000", 10);
const BODY_RECEIVE_TIMEOUT_MS = parseInt(process.env.BODY_RECEIVE_TIMEOUT_MS || "30000", 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || "10485760", 10);
const KEYS_FILE = process.env.KEYS_FILE || resolve(__dirname, "keys.json");

// Cache TTLs for read-only metadata endpoints
const CACHE_TTL = {
  "/api/tags": parseInt(process.env.CACHE_TTL_TAGS || "300000", 10),
  "/v1/models": parseInt(process.env.CACHE_TTL_MODELS || "300000", 10),
  "/api/show": parseInt(process.env.CACHE_TTL_SHOW || "600000", 10),
};
const MAX_CACHE_ENTRIES = 100;

// ─── API Keys ─────────────────────────────────────────────────────────────────

let API_KEYS = [];

function loadKeys() {
  if (existsSync(KEYS_FILE)) {
    try {
      const data = readFileSync(KEYS_FILE, "utf8");
      const saved = JSON.parse(data);
      API_KEYS = saved.keys.map((k) => ({
        key: k.key,
        name: k.name || null,
        status: k.status || "active",
        cooldownUntil: k.cooldownUntil || null,
        usageCount: k.usageCount || 0,
        failCount: k.failCount || 0,
        concurrency: 0,
      }));
      console.log(`[KEYS] Loaded ${API_KEYS.length} keys from ${KEYS_FILE}`);
      return;
    } catch (err) {
      console.warn(`[KEYS] Failed to load ${KEYS_FILE}: ${err.message}`);
    }
  }
  API_KEYS = (process.env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key) => ({
      key,
      name: null,
      status: "active",
      cooldownUntil: null,
      usageCount: 0,
      failCount: 0,
      concurrency: 0,
    }));
}

function saveKeys() {
  try {
    const data = JSON.stringify({
      keys: API_KEYS.map((k) => ({
        key: k.key,
        name: k.name,
        status: k.status,
        cooldownUntil: k.cooldownUntil,
        usageCount: k.usageCount,
        failCount: k.failCount,
      })),
      savedAt: new Date().toISOString(),
    }, null, 2);
    writeFileSync(KEYS_FILE, data);
  } catch (err) {
    console.error(`[KEYS] Failed to save: ${err.message}`);
  }
}

loadKeys();
refreshCooldowns();

let activeKeyIndex = 0;

if (API_KEYS.length === 0) {
  console.error("ERROR: No API keys configured. Set API_KEYS env var or create keys.json.");
  process.exit(1);
}

// ─── Logs Buffer ──────────────────────────────────────────────────────────────

const MAX_LOGS = 200;
const logs = [];

function addLog(level, message) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
}

// Wrap console methods to also capture logs
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = (...args) => {
  addLog("info", args.join(" "));
  origLog.apply(console, args);
};

console.warn = (...args) => {
  addLog("warn", args.join(" "));
  origWarn.apply(console, args);
};

console.error = (...args) => {
  addLog("error", args.join(" "));
  origError.apply(console, args);
};

// ─── In-Memory Cache ──────────────────────────────────────────────────────────
//
// Keyed by:  endpoint + ":" + stable request body hash (for POST /api/show)
// Value:     { body: Buffer, headers: object, expiresAt: number }
//
// /api/tags  → GET,  no body → cache key = "/api/tags"
// /api/show  → POST, body contains model name → cache key = "/api/show:<name>"

const responseCache = new Map();

// Inflight coalescing: cache key → Promise<{body, headers}>
// If a second request arrives while the first is still fetching upstream,
// it waits on the same promise instead of firing a duplicate upstream call.
const inflight = new Map();

/** Build a deterministic cache key for cacheable requests. */
function cacheKey(url, body) {
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

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key, ttl, headers, body) {
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

// ─── Key Management ───────────────────────────────────────────────────────────
//
// Design goals:
//   1. Sequential requests → always reuse the same active key (no needless rotation).
//   2. Parallel requests   → second+ concurrent request gets the next key in sequence.
//   3. Key exhausted (429) → short cooldown (60 s); failCount++.
//   4. Still 429 after cooldown, 3 times → long cooldown (10 min); failCount resets.
//   5. activeKeyIndex always advances sequentially (circular, wrapping at end).

function refreshCooldowns() {
  const now = Date.now();
  let changed = false;
  for (const k of API_KEYS) {
    if (k.status === "cooldown" && k.cooldownUntil !== null && now >= k.cooldownUntil) {
      k.cooldownUntil = null;
      k.status = "active";
      console.log(`[KEY] key=${API_KEYS.indexOf(k)} cooldown expired → active (failCount=${k.failCount})`);
      changed = true;
    }
  }
  if (changed) saveKeys();
}

function advanceActiveKey() {
  const total = API_KEYS.length;
  for (let i = 1; i <= total; i++) {
    const idx = (activeKeyIndex + i) % total;
    if (API_KEYS[idx].status === "active") {
      activeKeyIndex = idx;
      console.log(`[KEY] activeKeyIndex advanced → ${activeKeyIndex}`);
      return;
    }
  }
}

function pickKey(excluding) {
  refreshCooldowns();
  const total = API_KEYS.length;

  if (!excluding || excluding.size === 0) {
    const primary = API_KEYS[activeKeyIndex];

    if (primary.status === "active" && primary.concurrency === 0) {
      primary.concurrency++;
      primary.usageCount++;
      console.log(`[KEY] sequential reuse → key=${activeKeyIndex} (concurrency=${primary.concurrency})`);
      return primary;
    }

    if (primary.status === "active" && primary.concurrency > 0) {
      for (let i = 1; i < total; i++) {
        const idx = (activeKeyIndex + i) % total;
        const k = API_KEYS[idx];
        if (k.status === "active") {
          k.concurrency++;
          k.usageCount++;
          console.log(`[KEY] parallel → key=${idx} (primary=${activeKeyIndex} busy, concurrency=${k.concurrency})`);
          return k;
        }
      }
      return null;
    }

    if (primary.status === "cooldown") {
      advanceActiveKey();
      const next = API_KEYS[activeKeyIndex];
      if (next.status !== "active") return null;
      next.concurrency++;
      next.usageCount++;
      console.log(`[KEY] primary was cooling → now using key=${activeKeyIndex} (concurrency=${next.concurrency})`);
      return next;
    }
  }

  for (let i = 0; i < total; i++) {
    const idx = (activeKeyIndex + i) % total;
    const k = API_KEYS[idx];
    if (k.status === "active" && (!excluding || !excluding.has(k))) {
      k.concurrency++;
      k.usageCount++;
      console.log(`[KEY] retry → key=${idx} (after ${excluding ? excluding.size : 0} failed attempt(s))`);
      return k;
    }
  }
  return null;
}

function releaseKey(keyObj) {
  keyObj.concurrency = Math.max(0, keyObj.concurrency - 1);
}

function cooldownKey(keyObj, retryAfterHeader) {
  if (keyObj.status === "cooldown") {
    releaseKey(keyObj);
    return;
  }

  keyObj.failCount++;
  const keyIdx = API_KEYS.indexOf(keyObj);

  let ms;
  if (keyObj.failCount >= MAX_FAILS_BEFORE_LONG_COOLDOWN) {
    ms = LONG_COOLDOWN_MS;
    console.warn(`[KEY] key=${keyIdx} fail #${keyObj.failCount} → LONG cooldown ${ms / 1000}s — resetting failCount`);
    keyObj.failCount = 0;
  } else {
    ms = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : DEFAULT_COOLDOWN_MS;
    console.warn(`[KEY] key=${keyIdx} fail #${keyObj.failCount} → short cooldown ${ms / 1000}s`);
  }

  keyObj.status = "cooldown";
  keyObj.cooldownUntil = Date.now() + ms;
  keyObj.concurrency = 0;

  if (keyIdx === activeKeyIndex) {
    advanceActiveKey();
  }

  saveKeys();
}

/**
 * Returns seconds until the soonest cooling key becomes active.
 */
function earliestRetryAfterSecs() {
  const now = Date.now();
  let soonest = Infinity;
  for (const k of API_KEYS) {
    if (k.status === "cooldown" && k.cooldownUntil !== null) {
      soonest = Math.min(soonest, k.cooldownUntil - now);
    }
  }
  return soonest === Infinity ? 60 : Math.ceil(soonest / 1000);
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ollama Proxy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root { 
      --bg: #0a0a0a; 
      --card: #141414; 
      --border: #262626; 
      --text: #fafafa; 
      --muted: #a3a3a3; 
      --accent: #3b82f6; 
      --success: #22c55e; 
      --error: #ef4444; 
      --warning: #f59e0b;
      --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }
    .layout { display: grid; grid-template-columns: 1fr 450px; gap: 0; height: 100vh; }
    .panel { padding: 1.5rem; overflow-y: auto; display: flex; flex-direction: column; }
    .panel-keys { border-right: 1px solid var(--border); }
    .panel-logs { background: #050505; }
    
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-shrink: 0; }
    h1 { font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; color: var(--text); }
    h2 { font-size: 0.9rem; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    
    .key-list { display: flex; flex-direction: column; gap: 0.75rem; flex: 1; }
    .key-item { 
      background: var(--card); 
      border: 1px solid var(--border); 
      border-radius: 12px; 
      padding: 1.25rem; 
      display: grid; 
      grid-template-columns: auto 1fr auto; 
      gap: 1.25rem; 
      align-items: center; 
      transition: transform 0.1s, border-color 0.2s;
    }
    .key-item:hover { border-color: #404040; }
    .key-item.active { border-left: 4px solid var(--success); }
    .key-item.cooldown { border-left: 4px solid var(--error); }
    .key-item.busy { border-left: 4px solid var(--accent); }
    
    .status-indicator { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 0.5rem; }
    .active .status-indicator { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .cooldown .status-indicator { background: var(--error); }
    .busy .status-indicator { background: var(--accent); animation: blink 1s infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    .key-info { display: flex; flex-direction: column; gap: 0.25rem; }
    .name-wrapper { display: flex; align-items: center; gap: 0.5rem; }
    .key-name { font-size: 0.95rem; font-weight: 500; cursor: pointer; border-bottom: 1px dashed transparent; }
    .key-name:hover { border-color: var(--muted); }
    .key-name-input { 
      font-size: 0.95rem; padding: 0.1rem 0.4rem; border: 1px solid var(--accent); 
      border-radius: 4px; background: #000; color: #fff; outline: none; width: 100%;
    }
    .key-preview { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); display: flex; align-items: center; gap: 0.5rem; }
    .copy-btn { cursor: pointer; opacity: 0.5; transition: opacity 0.2s; padding: 2px; }
    .copy-btn:hover { opacity: 1; color: var(--accent); }
    
    .key-metrics { text-align: right; display: flex; flex-direction: column; gap: 0.25rem; }
    .metric { font-size: 0.7rem; color: var(--muted); font-family: var(--font-mono); white-space: nowrap; }
    .metric b { color: var(--text); font-weight: 500; }
    
    .status-text { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-top: 4px; }
    .cooldown .status-text { color: var(--error); }
    .active .status-text { color: var(--success); }
    
    .btn { 
      border: none; padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.8rem; 
      cursor: pointer; font-weight: 500; transition: all 0.2s; 
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
    .btn-danger-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); margin-left: 0.5rem; }
    .btn-danger-ghost:hover { background: rgba(239, 68, 68, 0.1); color: var(--error); border-color: var(--error); }
    
    .add-section { margin-top: 1.5rem; flex-shrink: 0; }
    .add-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; background: var(--card); padding: 1rem; border-radius: 12px; border: 1px solid var(--border); }
    .add-form input { padding: 0.6rem 0.8rem; border-radius: 6px; border: 1px solid var(--border); background: #000; color: #fff; font-size: 0.85rem; }
    .add-form input:focus { border-color: var(--accent); outline: none; }
    
    .logs-panel { flex: 1; display: flex; flex-direction: column; gap: 0.5rem; font-family: var(--font-mono); font-size: 0.75rem; }
    .log-row { display: flex; gap: 0.75rem; padding: 0.35rem 0.5rem; border-radius: 4px; border-bottom: 1px solid #111; }
    .log-row:hover { background: #0f0f0f; }
    .log-time { color: #525252; flex-shrink: 0; }
    .log-level { width: 35px; text-align: center; font-weight: 700; font-size: 0.6rem; border-radius: 3px; height: 16px; line-height: 16px; margin-top: 1px; }
    .info .log-level { background: rgba(59, 130, 246, 0.1); color: #60a5fa; }
    .warn .log-level { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
    .error .log-level { background: rgba(239, 68, 68, 0.1); color: #f87171; }
    .log-msg { color: #d4d4d4; line-height: 1.4; white-space: pre-wrap; word-break: break-all; }
    .highlight-200 { color: var(--success); font-weight: bold; }
    .highlight-429, .highlight-401 { color: var(--error); font-weight: bold; }
    
    .empty { padding: 3rem; text-align: center; color: var(--muted); font-size: 0.9rem; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #262626; border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: #333; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="panel panel-keys">
      <div class="header">
        <h1>Ollama Proxy</h1>
        <button class="btn btn-ghost" onclick="loadKeys()">Refresh</button>
      </div>
      
      <div class="key-list" id="key-list"></div>
      
      <div class="add-section">
        <form class="add-form" onsubmit="addKey(event)">
          <input type="text" id="add-name" placeholder="Name (e.g. Work PC)">
          <input type="text" id="add-key" placeholder="API Key" required>
          <button type="submit" class="btn btn-primary">Add Key</button>
        </form>
        <div id="error" style="color:var(--error); font-size:0.75rem; margin-top:0.5rem;"></div>
      </div>
    </div>
    
    <div class="panel panel-logs">
      <div class="header" style="margin-bottom:1rem">
        <h2>Live Activity</h2>
        <button class="btn btn-ghost" style="padding:0.25rem 0.5rem" onclick="clearLogs()">Clear</button>
      </div>
      <div class="logs-panel" id="logs"></div>
    </div>
  </div>

  <script>
    let logsData = [];
    let editingId = null;

    async function loadKeys() {
      try {
        const res = await fetch('/api/keys');
        const data = await res.json();
        renderKeys(data.keys);
      } catch (err) {
        console.error(err);
      }
    }

    function renderKeys(keys) {
      const list = document.getElementById('key-list');
      if (!keys || keys.length === 0) {
        list.innerHTML = '<div class="empty">No API keys found</div>';
        return;
      }

      list.innerHTML = keys.map(k => {
        const isBusy = k.concurrency > 0;
        const statusClass = k.status === 'active' ? (isBusy ? 'busy' : 'active') : 'cooldown';
        const statusText = k.status === 'active' ? (isBusy ? 'Busy' : 'Ready') : 'Cooldown ' + k.cooldownRemainingSecs + 's';
        
        const nameContent = editingId === k.index 
          ? \`<input class="key-name-input" id="edit-\${k.index}" value="\${escapeHtml(k.name || '')}" onblur="saveName(\${k.index})" onkeydown="if(event.key==='Enter')this.blur()">\`
          : \`<span class="key-name" onclick="editName(\${k.index})">\${escapeHtml(k.name || 'Set Name')}</span>\`;

        return \`
          <div class="key-item \${statusClass}">
            <div class="key-info">
              <div class="name-wrapper">\${nameContent}</div>
              <div class="key-preview">
                \${k.key}
                <span class="copy-btn" onclick="copyKey('\${k.key}', this)" title="Copy ID">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </span>
              </div>
              <div class="status-text">\${statusText}</div>
            </div>
            
            <div class="key-metrics">
              <div class="metric">Concurrency: <b>\${k.concurrency}</b></div>
              <div class="metric">Usage Count: <b>\${k.usageCount}</b></div>
            </div>

            <div class="key-actions">
              <button class="btn btn-danger-ghost" onclick="deleteKey(\${k.index})">Remove</button>
            </div>
          </div>
        \`;
      }).join('');

      if (editingId !== null) {
        const input = document.getElementById('edit-' + editingId);
        if (input) input.focus();
      }
    }

    async function addKey(e) {
      e.preventDefault();
      const keyInput = document.getElementById('add-key');
      const nameInput = document.getElementById('add-name');
      const errorDiv = document.getElementById('error');
      
      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyInput.value, name: nameInput.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        
        keyInput.value = '';
        nameInput.value = '';
        errorDiv.textContent = '';
        loadKeys();
      } catch (err) {
        errorDiv.textContent = err.message;
      }
    }

    function editName(index) {
      editingId = index;
      loadKeys();
    }

    async function saveName(index) {
      const val = document.getElementById('edit-' + index).value;
      editingId = null;
      try {
        await fetch('/api/keys/' + index, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: val })
        });
        loadKeys();
      } catch (err) { console.error(err); }
    }

    async function deleteKey(index) {
      if (!confirm('Permanently remove this key?')) return;
      await fetch('/api/keys/' + index, { method: 'DELETE' });
      loadKeys();
    }

    function copyKey(text, btn) {
      navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.innerHTML = '<small style="font-size:8px">COPIED</small>';
      setTimeout(() => btn.innerHTML = original, 1000);
    }

    async function loadLogs() {
      try {
        const res = await fetch('/api/logs');
        const data = await res.json();
        if (JSON.stringify(data.logs) !== JSON.stringify(logsData)) {
          logsData = data.logs;
          renderLogs();
        }
      } catch (err) {}
    }

    function renderLogs() {
      const container = document.getElementById('logs');
      const html = logsData.slice(-100).reverse().map(l => {
        const time = l.time.split('T')[1].split('.')[0];
        let msg = escapeHtml(l.message);
        
        // Highlights
        msg = msg.replace(/200/g, '<span class="highlight-200">200</span>');
        msg = msg.replace(/429/g, '<span class="highlight-429">429</span>');
        msg = msg.replace(/401/g, '<span class="highlight-401">401</span>');

        return \`
          <div class="log-row \${l.level}">
            <span class="log-time">\${time}</span>
            <span class="log-level">\${l.level.toUpperCase()}</span>
            <span class="log-msg">\${msg}</span>
          </div>
        \`;
      }).join('');
      container.innerHTML = html || '<div class="empty">No activity logs</div>';
    }

    function clearLogs() { logsData = []; renderLogs(); }
    function escapeHtml(s) { return (s||'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    loadKeys();
    loadLogs();
    setInterval(loadKeys, 3000);
    setInterval(loadLogs, 1000);
  </script>
</body>
</html>`;
}

// ─── Body Reader ──────────────────────────────────────────────────────────────

function receiveBody(req) {
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

// ─── Proxy Helpers ────────────────────────────────────────────────────────────

function writeRateLimited(res, retryAfter) {
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(retryAfter),
  });
  res.end(JSON.stringify({
    error: "All API keys are rate-limited",
    retryAfterSeconds: retryAfter,
  }));
}

function attemptRequest(method, path, incomingHeaders, body, keyObj) {
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

async function handleRequest(req, res) {
  const reqId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  // Track whether Kilo closed the connection before we finished responding.
  // We listen on `res` (not `req`) because req "close" fires normally as soon
  // as the request body is sent — that is not a disconnect. res "close" only
  // fires if the TCP connection to Kilo is torn down before we finish writing.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      console.warn(`[REQ ${reqId}] client disconnected before response completed`);
    }
  });

  // ── Health check ────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/health") {
    refreshCooldowns();
    const active = API_KEYS.filter((k) => k.status === "active").length;
    const cooled = API_KEYS.filter((k) => k.status === "cooldown").length;
    const healthy = active > 0;

    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: healthy ? "ok" : "degraded",
      keys: API_KEYS.map((k, i) => ({
        index: i,
        status: k.status,
        concurrency: k.concurrency,
        usageCount: k.usageCount,
        cooldownRemainingSecs: k.cooldownUntil
          ? Math.max(0, Math.ceil((k.cooldownUntil - Date.now()) / 1000))
          : 0,
      })),
    }));
    return;
  }

  // ── Admin API (localhost only) ─────────────────────────────────────────────
  const clientIP = req.socket.remoteAddress || "";
  const isLocalhost = clientIP === "127.0.0.1" || clientIP === "::1" || clientIP === "::ffff:127.0.0.1";

  if (req.url.startsWith("/api/keys")) {
    if (!isLocalhost) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Admin API only accessible from localhost" }));
      return;
    }

    // GET /api/keys - list all keys
    if (req.method === "GET" && req.url === "/api/keys") {
      refreshCooldowns();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        keys: API_KEYS.map((k, i) => ({
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
      return;
    }

    // POST /api/keys - add new key
    if (req.method === "POST" && req.url === "/api/keys") {
      let body;
      try {
        body = await receiveBody(req);
        const parsed = JSON.parse(body.toString("utf8"));
        if (!parsed.key || typeof parsed.key !== "string") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'key' field" }));
          return;
        }
        if (API_KEYS.some((k) => k.key === parsed.key)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Key already exists" }));
          return;
        }
        API_KEYS.push({
          key: parsed.key,
          name: parsed.name || null,
          status: "active",
          cooldownUntil: null,
          usageCount: 0,
          failCount: 0,
          concurrency: 0,
        });
        saveKeys();
        console.log(`[ADMIN] Added new key at index ${API_KEYS.length - 1}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ index: API_KEYS.length - 1, status: "active" }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // PATCH /api/keys/:index - update key name
    const patchMatch = req.url.match(/^\/api\/keys\/(\d+)$/);
    if (req.method === "PATCH" && patchMatch) {
      const index = parseInt(patchMatch[1], 10);
      if (index < 0 || index >= API_KEYS.length) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Key not found" }));
        return;
      }
      let body;
      try {
        body = await receiveBody(req);
        const parsed = JSON.parse(body.toString("utf8"));
        if (parsed.name !== undefined) {
          API_KEYS[index].name = parsed.name || null;
          saveKeys();
          console.log(`[ADMIN] Updated name for key ${index}`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ index, name: API_KEYS[index].name }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // DELETE /api/keys/:index - remove key
    const deleteMatch = req.url.match(/^\/api\/keys\/(\d+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const index = parseInt(deleteMatch[1], 10);
      if (index < 0 || index >= API_KEYS.length) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Key not found" }));
        return;
      }
      if (API_KEYS.length === 1) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Cannot remove last key" }));
        return;
      }
      API_KEYS.splice(index, 1);
      saveKeys();
      console.log(`[ADMIN] Removed key at index ${index}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ removed: index }));
      return;
    }
  }

  // ── Logs API (localhost only) ────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/logs") {
    if (!isLocalhost) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Logs API only accessible from localhost" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ logs }));
    return;
  }

  // ── Dashboard UI (localhost only) ───────────────────────────────────────────
  if (req.method === "GET" && req.url === "/dashboard") {
    if (!isLocalhost) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Dashboard only accessible from localhost");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(getDashboardHTML());
    return;
  }

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

  // ── Cache check (metadata endpoints only) ──────────────────────────────────
  const urlPath = req.url.split("?")[0]; // strip query string for matching
  const cacheTTL = CACHE_TTL[urlPath];

  if (cacheTTL) {
    const key = cacheKey(urlPath, body);
    const entry = cacheGet(key);

    if (entry) {
      const elapsed = Date.now() - startTime;
      console.log(`[REQ ${reqId}] CACHE HIT ${urlPath} key="${key}" ${elapsed}ms`);
      res.writeHead(200, { ...entry.headers, "x-cache": "HIT" });
      res.end(entry.body);
      return;
    }

    // ── Coalescing: if another request is already fetching this key, wait ──
    if (inflight.has(key)) {
      console.log(`[REQ ${reqId}] COALESCED ${urlPath} key="${key}"`);
      try {
        const { body: cachedBody, headers: cachedHeaders } = await inflight.get(key);
        const elapsed = Date.now() - startTime;
        console.log(`[REQ ${reqId}] COALESCE RESOLVED ${urlPath} ${elapsed}ms`);
        res.writeHead(200, { ...cachedHeaders, "x-cache": "HIT" });
        res.end(cachedBody);
        return;
      } catch (err) {
        console.warn(`[REQ ${reqId}] inflight request failed: ${err.message}, becoming fetcher`);
      }
    }

    // ── This request is the designated fetcher — register inflight promise ─
    let resolveInflight, rejectInflight;
    const inflightPromise = new Promise((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    });
    inflight.set(key, inflightPromise);

    // try/finally guarantees inflight.delete(key) runs on EVERY exit path:
    // success, 429 exhaustion, network errors, thrown exceptions, early returns.
    // Without this, a mid-flight crash leaves a stale Promise in the map forever.
    // All coalesced waiters would then await a Promise that never resolves,
    // hanging Kilo's loader until the process restarts.
    try {
      const triedKeys = new Set();
      for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
        const keyObj = pickKey(triedKeys);

        if (!keyObj) {
          const retryAfter = earliestRetryAfterSecs();
          console.warn(`[REQ ${reqId}] all keys cooling, returning 429 retry-after=${retryAfter}s`);
          rejectInflight(new Error("All keys rate-limited"));
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

          if (status === 200) {
            const elapsed = Date.now() - startTime;
            console.log(`[REQ ${reqId}] 200 key=${keyIdx} ${req.method} ${req.url} ${elapsed}ms`);

            // Collect full body, then cache + resolve waiters + respond
            const chunks = [];
            bodyStream.on("data", (c) => chunks.push(c));
            bodyStream.on("end", () => {
              const responseBody = Buffer.concat(chunks);
              const headersToStore = { ...forwardHeaders, "x-cache": "MISS" };
              cacheSet(key, cacheTTL, headersToStore, responseBody);
              console.log(`[CACHE] stored key="${key}" ttl=${cacheTTL / 1000}s`);
              resolveInflight({ body: responseBody, headers: headersToStore });
              res.writeHead(200, headersToStore);
              res.end(responseBody);
            });
            bodyStream.on("error", (err) => {
              rejectInflight(err);
              console.error(`[REQ ${reqId}] stream error: ${err.message}`);
              if (!res.headersSent) {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "Upstream stream error" }));
              }
            });
            return; // finally still runs — inflight.delete called there
          }

          // Non-200 — don't cache, unblock waiters with error, forward as-is
          console.error(`[REQ ${reqId}] upstream error status=${status} key=${keyIdx}`);
          rejectInflight(new Error(`Upstream ${status}`));
          res.writeHead(status, forwardHeaders);
          bodyStream.pipe(res);
          return;

        } catch (err) {
          releaseKey(keyObj);
          console.error(`[REQ ${reqId}] key=${keyIdx} network error: ${err.message}`);
        }
      }

      // All keys exhausted via 429s
      const retryAfter = earliestRetryAfterSecs();
      rejectInflight(new Error("All retries failed"));
      writeRateLimited(res, retryAfter);

    } finally {
      // Single guaranteed cleanup point — no matter how this block exits.
      // Safe to call multiple times: Map.delete on a missing key is a no-op.
      inflight.delete(key);
    }
    return;
  }

  // ── Try each key at most once per request ────────────────────────────────
  const triedKeys = new Set();

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const keyObj = pickKey(triedKeys);

    if (!keyObj) {
      const retryAfter = earliestRetryAfterSecs();
      console.warn(`[REQ ${reqId}] all keys cooling, returning 429 retry-after=${retryAfter}s`);
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

      const elapsed = Date.now() - startTime;
      if (status === 200) {
        console.log(`[REQ ${reqId}] 200 key=${keyIdx} ${req.method} ${req.url} ${elapsed}ms`);

        // ── Chat diagnostics ────────────────────────────────────────────────
        const isChat = urlPath === "/api/chat" || urlPath === "/api/generate"
          || urlPath === "/v1/chat/completions";
        if (isChat) {
          let streamMode = "unknown";
          try {
            const parsed = JSON.parse(body.toString("utf8"));
            streamMode = parsed.stream === false ? "non-stream" : "stream";
            console.log(`[CHAT ${reqId}] mode=${streamMode} model=${parsed.model || parsed.messages?.[0]?.role || "?"}`);
          } catch { /* non-JSON body */ }

          if (streamMode !== "non-stream") {
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
        }
        // ── End chat diagnostics ────────────────────────────────────────────

      } else if (status >= 400) {
        console.error(`[REQ ${reqId}] upstream error status=${status} key=${keyIdx} ${elapsed}ms`);
      }

      if (clientGone || res.destroyed || res.writableEnded) {
        console.warn(`[REQ ${reqId}] client socket gone after retry — discarding upstream response`);
        bodyStream.destroy();
        return;
      }

      res.writeHead(status, headers);
      bodyStream.pipe(res);

      bodyStream.on("error", (err) => {
        console.error(`[REQ ${reqId}] upstream stream error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
      res.on("error", (err) => {
        console.error(`[REQ ${reqId}] client socket error: ${err.message}`);
        bodyStream.destroy();
      });
      return;

    } catch (err) {
      releaseKey(keyObj);
      console.error(`[REQ ${reqId}] key=${keyIdx} network error: ${err.message} (+${Date.now() - startTime}ms)`);
    }
  }

  // All keys tried and 429'd
  writeRateLimited(res, earliestRetryAfterSecs());
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

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT}`);
  console.log(`Upstream: ${UPSTREAM_BASE}`);
  console.log(`Keys loaded: ${API_KEYS.length}`);
});