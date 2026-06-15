// ─── Dashboard HTML ──────────────────────────────────────────────────────────
//
// Returns the full HTML string for the localhost-only management dashboard.

import { VERSION } from "./config.js";

export function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ollama Proxy Gateway v${VERSION}</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root { 
      --bg-color: #030305;
      --glass-bg: rgba(15, 15, 20, 0.4);
      --glass-border: rgba(255, 255, 255, 0.08);
      --card-hover: rgba(255, 255, 255, 0.05);
      --text-main: #ffffff; 
      --text-muted: #8b8b9e; 
      --accent-glow: #6366f1; 
      --accent: #818cf8;
      --success: #10b981; 
      --success-glow: rgba(16, 185, 129, 0.2);
      --error: #f43f5e; 
      --error-glow: rgba(244, 63, 94, 0.2);
      --warning: #f59e0b;
      --font-sans: 'Outfit', -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }
    
    body { 
      font-family: var(--font-sans); 
      background-color: var(--bg-color);
      color: var(--text-main); 
      height: 100vh; 
      overflow: hidden; 
      position: relative;
    }

    /* Ambient Background Glows */
    .ambient-glow {
      position: absolute;
      border-radius: 50%;
      filter: blur(100px);
      z-index: -1;
      opacity: 0.4;
      pointer-events: none;
    }
    .glow-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: radial-gradient(circle, rgba(99,102,241,0.15) 0%, rgba(0,0,0,0) 70%); }
    .glow-2 { bottom: -20%; right: -10%; width: 60vw; height: 60vw; background: radial-gradient(circle, rgba(139,92,246,0.1) 0%, rgba(0,0,0,0) 70%); }

    .layout { 
      display: grid; 
      grid-template-columns: 1fr 500px; 
      gap: 1.5rem; 
      height: 100vh; 
      padding: 1.5rem;
      max-width: 1800px;
      margin: 0 auto;
    }

    .panel { 
      background: var(--glass-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border);
      border-radius: 24px;
      padding: 2rem; 
      overflow-y: auto; 
      display: flex; 
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    
    .panel-keys { position: relative; }
    
    .header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center; 
      margin-bottom: 2rem; 
      flex-shrink: 0; 
    }

    .node-count {
      margin-left: 0.75rem;
      padding: 0.25rem 0.65rem;
      border: 1px solid rgba(99, 102, 241, 0.25);
      border-radius: 999px;
      color: var(--accent);
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
      background: rgba(99, 102, 241, 0.08);
    }

    h1 { 
      font-size: 1.5rem; 
      font-weight: 600; 
      background: linear-gradient(to right, #fff, #a5b4fc);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.02em; 
    }
    
    h2 { 
      font-size: 0.95rem; 
      font-weight: 500; 
      color: var(--text-muted); 
      text-transform: uppercase; 
      letter-spacing: 0.1em; 
    }
    
    .key-list { 
      display: flex; 
      flex-direction: column; 
      gap: 1rem; 
      flex: 1; 
      padding-right: 0.5rem;
    }

    .scroll-keys-bottom {
      position: sticky;
      bottom: 1.5rem;
      align-self: flex-end;
      flex-shrink: 0;
      z-index: 10;
      width: 44px;
      height: 44px;
      border-radius: 999px;
      border: 1px solid rgba(99,102,241,0.45);
      background: rgba(99,102,241,0.9);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 12px 30px rgba(0,0,0,0.35);
      transition: opacity 0.18s ease, transform 0.18s ease, background 0.2s, box-shadow 0.2s;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px) scale(0.96);
      line-height: 1;
      padding: 0;
    }

    .scroll-keys-bottom.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }

    .scroll-keys-bottom:hover {
      background: rgba(129,140,248,0.95);
      box-shadow: 0 16px 36px rgba(99,102,241,0.35);
      transform: translateY(-2px) scale(1.04);
    }

    .scroll-keys-bottom .arrow-up { display: none; }
    .scroll-keys-bottom.scrolled .arrow-down { display: none; }
    .scroll-keys-bottom.scrolled .arrow-up { display: block; }

    .key-item { 
      background: rgba(255, 255, 255, 0.02); 
      border: 1px solid var(--glass-border); 
      border-radius: 16px; 
      padding: 1.5rem; 
      display: grid; 
      grid-template-columns: auto auto 1fr auto; 
      gap: 1.5rem; 
      align-items: center; 
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }
    
    .key-item::before {
      content: '';
      position: absolute;
      top: 0; left: 0; width: 4px; height: 100%;
      background: transparent;
      transition: all 0.3s ease;
    }

    .key-item:hover { 
      background: var(--card-hover);
      transform: translateY(-2px);
      box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5);
      border-color: rgba(255,255,255,0.1);
    }

    .key-item.active::before { background: var(--success); box-shadow: 0 0 15px var(--success-glow); }
    .key-item.cooldown::before { background: var(--error); box-shadow: 0 0 15px var(--error-glow); }
    .key-item.busy::before { background: var(--accent); box-shadow: 0 0 15px rgba(99,102,241,0.5); }
    
    .status-indicator { 
      width: 12px; height: 12px; 
      border-radius: 50%; 
      display: inline-block; 
      margin-right: 0.75rem; 
      position: relative;
    }
    
    .serial-number {
      width: 2.2rem;
      height: 2.2rem;
      border-radius: 10px;
      display: grid;
      place-items: center;
      color: var(--text-muted);
      border: 1px solid var(--glass-border);
      background: rgba(255,255,255,0.04);
      font-family: var(--font-mono);
      font-size: 0.9rem;
      font-weight: 600;
    }
    
    .active .status-indicator { background: var(--success); box-shadow: 0 0 12px var(--success-glow); }
    .cooldown .status-indicator { background: var(--error); box-shadow: 0 0 12px var(--error-glow); }
    .busy .status-indicator { 
      background: var(--accent); 
      box-shadow: 0 0 12px rgba(99,102,241,0.6);
      animation: pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }

    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(99,102,241, 0.4); }
      70% { box-shadow: 0 0 0 10px rgba(99,102,241, 0); }
      100% { box-shadow: 0 0 0 0 rgba(99,102,241, 0); }
    }

    .key-info { display: flex; flex-direction: column; gap: 0.4rem; }
    .name-wrapper { display: flex; align-items: center; gap: 0.5rem; }
    .key-name { font-size: 1.1rem; font-weight: 500; cursor: pointer; transition: color 0.2s; }
    .key-name:hover { color: var(--accent); }
    
    .key-name-input { 
      font-family: var(--font-sans);
      font-size: 1.1rem; font-weight: 500;
      padding: 0.2rem 0.5rem; 
      border: 1px solid var(--accent); 
      border-radius: 6px; 
      background: rgba(0,0,0,0.5); 
      color: #fff; outline: none; width: 100%;
    }

    .key-preview { 
      font-family: var(--font-mono); 
      font-size: 0.85rem; 
      color: var(--text-muted); 
      display: flex; align-items: center; gap: 0.5rem; 
      background: rgba(0,0,0,0.3);
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      width: fit-content;
    }
    
    .copy-btn { 
      cursor: pointer; opacity: 0.5; transition: all 0.2s; padding: 2px; display: flex;
    }
    .copy-btn:hover { opacity: 1; color: var(--accent); transform: scale(1.1); }
    
    .key-metrics { text-align: right; display: flex; flex-direction: column; gap: 0.4rem; }
    .metric { font-size: 0.8rem; color: var(--text-muted); }
    .metric b { color: var(--text-main); font-weight: 600; font-family: var(--font-mono); font-size: 0.9rem;}
    
    .status-text { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; margin-top: 6px; letter-spacing: 0.05em;}
    .cooldown .status-text { color: var(--error); }
    .active .status-text { color: var(--success); }
    .busy .status-text { color: var(--accent); }
    
    .btn { 
      border: none; padding: 0.6rem 1.2rem; border-radius: 10px; font-size: 0.85rem; 
      cursor: pointer; font-weight: 600; transition: all 0.2s; font-family: var(--font-sans);
    }
    
    .btn-primary { 
      background: linear-gradient(135deg, var(--accent-glow), var(--accent)); 
      color: white; 
      box-shadow: 0 4px 15px rgba(99,102,241,0.3);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99,102,241,0.4);
    }

    .btn-ghost { 
      background: rgba(255,255,255,0.05); 
      color: var(--text-main); 
      border: 1px solid var(--glass-border); 
    }
    .btn-ghost:hover {
      background: rgba(255,255,255,0.1);
    }

    .btn-danger-ghost { 
      background: transparent; color: var(--text-muted); 
      border: 1px solid var(--glass-border); 
    }
    .btn-danger-ghost:hover { 
      background: rgba(244, 63, 94, 0.1); 
      color: var(--error); border-color: rgba(244, 63, 94, 0.3); 
    }
    
    .key-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .add-section { margin-top: 0; flex-shrink: 0; }
    .add-form { 
      display: grid; grid-template-columns: 1fr 1fr auto; gap: 1rem; 
      background: rgba(0,0,0,0.2); padding: 1.5rem; 
      border-radius: 16px; border: 1px solid var(--glass-border); 
    }
    .add-form input { 
      padding: 0.8rem 1rem; border-radius: 10px; 
      border: 1px solid rgba(255,255,255,0.1); 
      background: rgba(0,0,0,0.4); color: #fff; font-size: 0.9rem; 
      font-family: var(--font-sans); transition: border-color 0.2s;
    }
    .add-form input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px rgba(99,102,241,0.2); }
    
    .logs-panel { 
      flex: 1; display: flex; flex-direction: column; gap: 0.6rem; 
      font-family: var(--font-mono); font-size: 0.8rem; padding-right: 0.5rem;
      overflow-y: auto;
      min-height: 0;
    }
    
    .logs-toolbar {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 1rem;
      flex-shrink: 0;
    }

    .logs-toolbar-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .filter-group, .log-actions {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .filter-btn {
      padding: 0.35rem 0.65rem;
      border-radius: 999px;
      border: 1px solid var(--glass-border);
      background: rgba(255,255,255,0.04);
      color: var(--text-muted);
      font-size: 0.72rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .filter-btn:hover, .filter-btn.active {
      color: #fff;
      border-color: rgba(99,102,241,0.45);
      background: rgba(99,102,241,0.18);
    }
    
    .log-row { 
      display: flex; gap: 1rem; padding: 0.6rem 0.8rem; 
      border-radius: 8px; border-bottom: 1px solid rgba(255,255,255,0.03); 
      background: rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease-out forwards;
      opacity: 0;
      transform: translateX(10px);
    }
    
    @keyframes slideIn {
      to { opacity: 1; transform: translateX(0); }
    }

    .log-row:hover { background: rgba(255,255,255,0.03); }
    .log-time { color: #6b7280; flex-shrink: 0; }
    .log-level { 
      width: 45px; text-align: center; font-weight: 700; font-size: 0.65rem; 
      border-radius: 4px; height: 20px; line-height: 20px; margin-top: -2px; 
      letter-spacing: 0.05em;
    }
    
    .info .log-level { background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99,102,241,0.2); }
    .response .log-level { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.2); }
    .cached .log-level { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59,130,246,0.2); }
    .warn .log-level { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.2); }
    .error .log-level { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.2); }
    
    .log-msg { color: #d1d5db; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
    .highlight-200 { color: var(--success); font-weight: bold; text-shadow: 0 0 8px rgba(16,185,129,0.4); }
    .highlight-429, .highlight-401 { color: var(--error); font-weight: bold; text-shadow: 0 0 8px rgba(244,63,94,0.4); }
    
    .empty { padding: 4rem; text-align: center; color: var(--text-muted); font-size: 1rem; font-style: italic; }
    
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
  </style>
</head>
<body>
  <div class="ambient-glow glow-1"></div>
  <div class="ambient-glow glow-2"></div>

  <div class="layout">
    <div class="panel panel-keys">
      <div class="header">
        <h1>Gateway Nodes <span class="node-count" id="node-count">0 keys</span></h1>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-ghost" id="release-all-btn" onclick="releaseAllCooldowns()" style="color: var(--warning); border-color: rgba(245, 158, 11, 0.3); display: none;">Release All</button>
          <button class="btn btn-ghost" onclick="loadKeys()">Sync</button>
        </div>
      </div>
      
      <div class="add-section">
        <form class="add-form" onsubmit="addKey(event)">
          <input type="text" id="add-key" placeholder="API Key" required>
          <input type="text" id="add-name" placeholder="Node Alias (e.g. Primary Server)">
          <button type="submit" class="btn btn-primary">Deploy Key</button>
        </form>
        <div id="error" style="color:var(--error); font-size:0.85rem; margin-top:0.75rem;"></div>
      </div>
      
      <div class="key-list" id="key-list"></div>
      <button class="scroll-keys-bottom" id="scroll-keys-bottom" onclick="toggleScrollKeys()" title="Scroll to latest key">
        <svg class="arrow-down" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
        <svg class="arrow-up" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
      </button>
    </div>
    
    <div class="panel panel-logs">
      <div class="header" style="margin-bottom:1rem">
        <h2>Live Traffic</h2>
        <button class="btn btn-ghost" style="padding:0.4rem 0.8rem" onclick="clearLogs()">Clear</button>
      </div>
      <div class="logs-toolbar">
        <div class="logs-toolbar-row">
          <div class="filter-group" aria-label="Log filters">
            <button class="filter-btn" data-filter="error">Errors</button>
            <button class="filter-btn" data-filter="response">Responses</button>
            <button class="filter-btn" data-filter="info">Infos</button>
            <button class="filter-btn" data-filter="cached">Cached</button>
            <button class="filter-btn" data-filter="all">All</button>
          </div>
          <div class="log-actions">
            <button class="btn btn-ghost" id="pause-logs-btn" style="padding:0.4rem 0.8rem" onclick="toggleLogCapture()">Pause</button>
          </div>
        </div>
      </div>
      <div class="logs-panel" id="logs"></div>
    </div>
  </div>

  <script>
    let logsData = [];
    let logsPaused = false;
    let activeLogFilter = 'error';
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
      const nodeCount = document.getElementById('node-count');
      const safeKeys = keys || [];
      const sortedKeys = [...safeKeys].sort((a, b) => b.index - a.index);
      if (nodeCount) {
        nodeCount.textContent = safeKeys.length + " " + (safeKeys.length === 1 ? "key" : "keys");
      }
      if (!keys || sortedKeys.length === 0) {
        list.innerHTML = '<div class="empty">No gateway nodes configured</div>';
        requestAnimationFrame(updateScrollKeysButton);
        return;
      }

      const hasCooldowns = sortedKeys.some(k => k.status === 'cooldown');
      const releaseAllBtn = document.getElementById('release-all-btn');
      if (releaseAllBtn) {
        releaseAllBtn.style.display = hasCooldowns ? 'inline-block' : 'none';
      }

      list.innerHTML = sortedKeys.map((k, i) => {
        const isBusy = k.concurrency > 0;
        const statusClass = k.status === 'active' ? (isBusy ? 'busy' : 'active') : 'cooldown';
        const statusText = k.status === 'active' ? (isBusy ? 'Processing' : 'Standby') : 'Cooldown ' + k.cooldownRemainingSecs + 's';
        
        const nameContent = editingId === k.index
          ? \`<input class="key-name-input" id="edit-\${k.index}" value="\${escapeHtml(k.name || '')}" onblur="saveName(\${k.index})" onkeydown="if(event.key==='Enter')this.blur()">\`
          : \`<span class="key-name" onclick="editName(\${k.index})">\${escapeHtml(k.name || 'Unnamed Node')}</span>\`;

        const releaseButton = k.status === 'cooldown'
          ? \`<button class="btn btn-ghost" style="color: var(--success); border-color: rgba(16, 185, 129, 0.3);" onclick="releaseCooldown(\${k.index})">Release</button>\`
          : '';
        const fullKey = k.fullKey || k.key;
        const displayKey = k.key || (fullKey.slice(0, 8) + "...");

        return \`
          <div class="key-item \${statusClass}">
            <div class="serial-number">\${i + 1}</div>
            <div class="key-info">
              <div class="name-wrapper">\${nameContent}</div>
              <div class="key-preview">
                \${escapeHtml(displayKey)}
                <span class="copy-btn" onclick='copyKey(\${JSON.stringify(fullKey)}, this)' title="Copy Key">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                </span>
              </div>
              <div class="status-text"><span class="status-indicator"></span>\${statusText}</div>
            </div>
            
            <div class="key-metrics">
              <div class="metric">Load: <b>\${k.concurrency}</b> reqs</div>
              <div class="metric">Processed: <b>\${k.usageCount}</b></div>
            </div>

            <div class="key-actions">
              \${releaseButton}
              <button class="btn btn-danger-ghost" onclick="deleteKey(\${k.index})">Revoke</button>
            </div>
          </div>
        \`;
      }).join('');

      if (editingId !== null) {
        const input = document.getElementById('edit-' + editingId);
        if (input) input.focus();
      }
      requestAnimationFrame(updateScrollKeysButton);
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
      if (!confirm('Permanently revoke this node key?')) return;
      await fetch('/api/keys/' + index, { method: 'DELETE' });
      loadKeys();
    }

    async function releaseCooldown(index) {
      try {
        const res = await fetch('/api/keys/' + index + '/release', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to release cooldown');
        }
        loadKeys();
      } catch (err) {
        console.error(err);
        alert(err.message);
      }
    }

    async function releaseAllCooldowns() {
      try {
        const res = await fetch('/api/keys/release-all', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to release all cooldowns');
        }
        loadKeys();
      } catch (err) {
        console.error(err);
        alert(err.message);
      }
    }

    function toggleScrollKeys() {
      const panel = document.querySelector('.panel-keys');
      if (!panel) return;
      const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 10;
      if (atBottom) {
        panel.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
      }
    }

    function updateScrollKeysButton() {
      const panel = document.querySelector('.panel-keys');
      const btn = document.getElementById('scroll-keys-bottom');
      if (!panel || !btn) return;
      const canScroll = panel.scrollHeight > panel.clientHeight + 8;
      btn.classList.toggle('visible', canScroll);
      const scrollRatio = panel.scrollTop / (panel.scrollHeight - panel.clientHeight);
      btn.classList.toggle('scrolled', scrollRatio > 0.5);
    }

    function copyKey(text, btn) {
      navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.innerHTML = '<span style="font-size:10px; font-weight:bold; color:var(--accent)">COPIED</span>';
      setTimeout(() => btn.innerHTML = original, 1200);
    }

    async function loadLogs() {
      if (logsPaused) return;

      try {
        const res = await fetch('/api/logs');
        const data = await res.json();
        const nextLogs = data.logs || [];

        if (nextLogs.length === 0 && logsData.length > 0) {
          logsData = [];
          renderLogs();
          return;
        }

        const newLogs = nextLogs.filter((log) => !logsData.some((existing) => isSameLog(existing, log)));
        if (newLogs.length === 0) return;

        logsData.push(...newLogs);
        appendLogs(newLogs);
      } catch (err) {}
    }

    function appendLogs(logs) {
      const container = document.getElementById('logs');
      if (!container) return;
      if (container.querySelector('.empty')) container.innerHTML = '';

      const fragment = document.createDocumentFragment();
      const matchingLogs = logs.filter(logMatchesFilter);
      matchingLogs.forEach((log) => fragment.appendChild(createLogRow(log)));
      container.appendChild(fragment);
      requestAnimationFrame(scrollLogsToBottom);
    }

    function createLogRow(log) {
      const row = document.createElement('div');
      const time = log.time.split('T')[1].split('.')[0];
      const category = getLogCategory(log);
      let msg = escapeHtml(log.message);

      msg = msg.replace(/200/g, '<span class="highlight-200">200</span>');
      msg = msg.replace(/429/g, '<span class="highlight-429">429</span>');
      msg = msg.replace(/401/g, '<span class="highlight-401">401</span>');

      row.className = "log-row " + category;
      row.innerHTML = '<span class="log-time">' + time + '</span>'
        + '<span class="log-level">' + escapeHtml(log.level) + '</span>'
        + '<span class="log-msg">' + msg + '</span>';
      return row;
    }

    function isSameLog(a, b) {
      return a.time === b.time && a.level === b.level && a.message === b.message;
    }

    function renderLogs() {
      const container = document.getElementById('logs');
      if (!container) return;
      const filteredLogs = logsData.filter(logMatchesFilter).slice(-100);
      container.innerHTML = filteredLogs.length
        ? filteredLogs.map((log) => createLogRow(log).outerHTML).join('')
        : '<div class="empty">No logs matching this filter</div>';
      requestAnimationFrame(scrollLogsToBottom);
    }

    function scrollLogsToBottom() {
      const container = document.getElementById('logs');
      if (container) container.scrollTop = container.scrollHeight;
    }
    function getLogCategory(log) {
      const level = (log.level || '').toLowerCase();
      const message = log.message || '';

      if (level === 'error' || level === 'warn' || /error|failed|upstream|network|rate-limited|permission|quota|forbidden|client left|socket|stream error/i.test(message)) {
        return 'error';
      }
      if (/CACHE HIT|COALESCE RESOLVED|\[CACHE\] stored|x-cache|cached/i.test(message)) {
        return 'cached';
      }
      if (/\[REQ [^\]]+\] 200\b|\[CHAT [^\]]+\]/i.test(message)) {
        return 'response';
      }
      return 'info';
    }

    function logMatchesFilter(log) {
      if (activeLogFilter === 'all') return true;
      return getLogCategory(log) === activeLogFilter;
    }

    function setLogFilter(filter) {
      activeLogFilter = filter;
      document.querySelectorAll('.filter-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      renderLogs();
    }

    function toggleLogCapture() {
      logsPaused = !logsPaused;
      const btn = document.getElementById('pause-logs-btn');
      if (btn) {
        btn.textContent = logsPaused ? 'Start Capture' : 'Pause';
      }
      if (!logsPaused) loadLogs();
    }

    async function clearLogs() {
      try {
        await fetch('/api/logs/clear', { method: 'POST' });
        logsData = [];
        renderLogs();
      } catch (err) {
        console.error(err);
      }
    }

    function escapeHtml(s) { return (s||'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    if (window.EventSource) {
      const reloadSource = new EventSource('/__dev/reload');
      reloadSource.addEventListener('reload', () => window.location.reload());
    }

    document.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => setLogFilter(btn.dataset.filter));
    });
    setLogFilter(activeLogFilter);

    const keysPanel = document.querySelector('.panel-keys');
    if (keysPanel) {
      keysPanel.addEventListener('scroll', updateScrollKeysButton);
    }
    window.addEventListener('resize', updateScrollKeysButton);

    loadKeys();
    loadLogs();
    setInterval(loadLogs, 1000);
  </script>
</body>
</html>`;
}
