# Ollama Proxy

> Smart Ollama gateway with sequential-primary key rotation, automatic cooldown on 429s, and admin APIs — works with Claude Code, OpenCode, Roo Code, Hermes AI, OpenClaw, CrewAI, and Kilo Code.

[![][discord]][discord] [![][license]][license]

[discord]: https://img.shields.io/discord/1452487457085063218?color=5865F2&label=discord&labelColor=black&logo=discord&logoColor=white&style=flat-square
[license]: https://img.shields.io/badge/license-MIT-yellow?style=flat-square&logoColor=black

<!--的有机 -->
## Quick Start

### For Humans

```bash
git clone https://github.com/manmeet0409/ollama-proxy
cd ollama-proxy
npm install
node ollama-proxy.js
```

Then point your AI coding tool at `http://localhost:11435`.

### For AI Agents

If you're an AI agent helping set up ollama-proxy:

```bash
# 1. Install dependencies
npm install

# 2. Start the proxy
node ollama-proxy.js
```

The agent will figure out the rest.

---

## Why ollama-proxy?

| | Feature | What it does |
|---|---|---|
| 🔁 | Sequential-primary rotation | Sequential requests reuse the same key; parallel requests shift to the next active key |
| ⚡ | Fail-count cooldowns | Key gets 60s cooldown on 429/401; after 3 consecutive failures → 10min long cooldown |
| 🔌 | Dual API support | Handles both `/v1/chat/completions` (OpenAI-style) and `/v1/messages` (Anthropic-style) |
| 📊 | Admin dashboard | Live key status, activity logs, and key management at `http://localhost:11435/dashboard` |
| 💾 | Persistent keys | Keys survive restarts via `keys.json` |
| 🧩 | Universal compatibility | Works with every AI coding framework that supports custom OpenAI-compatible endpoints |
| ⚙️ | Request coalescing | Simultaneous identical requests share one upstream call — no duplicate fetches |
| 📫 | Metadata caching | `/api/tags`, `/v1/models`, `/api/show` responses are cached to reduce upstream load |

---

## Compatibility

Works with **any AI coding framework** that supports custom OpenAI-compatible or Anthropic-compatible API endpoints.

| Framework | Config method | Key setting |
|---|---|---|
| **Claude Code** | Environment variable | `ANTHROPIC_BASE_URL=http://localhost:11435` |
| **OpenCode** | `opencode.json` → `provider.openai-compatible.options.baseURL` | `http://localhost:11435/v1` |
| **Roo Code** | VS Code `settings.json` → `roo-cline.baseUrl` | `http://localhost:11435/v1` |
| **Hermes AI** | `~/.hermes/config.yaml` → `model.base_url` | `http://localhost:11435/v1` |
| **OpenClaw** | `~/.openclaw/openclaw.json` → `models.providers.<id>.baseUrl` | `http://localhost:11435/v1` |
| **CrewAI** | Python `LLM(base_url=...)` | `http://localhost:11435/v1` |
| **Kilo Code v5** | Direct `ollama` provider UI | Base URL field → `http://localhost:11435` |
| **Kilo Code v7+** | `kilo.jsonc` → `openai-compatible` provider | `baseURL: "http://localhost:11435"` |

> **Note:** For frameworks that forward Anthropic-style requests (`/v1/messages`), ollama-proxy transparently converts them to the Ollama-compatible `/v1/chat/completions` format.

---

## Installation

### 1. Clone and install

```bash
git clone https://github.com/manmeet0409/ollama-proxy
cd ollama-proxy
npm install
```

### 2. Configure your API keys

**Option A — `keys.json`** (recommended, persists across restarts):

```json
{
  "keys": [
    { "key": "sk-your-first-key-here", "name": "Work PC" },
    { "key": "sk-your-second-key-here", "name": "Home Server" }
  ]
}
```

**Option B — Environment variable** (for quick testing):

```env
API_KEYS=sk-key-1,sk-key-2
```

**Option C — Dashboard UI** (no file editing needed):

Visit `http://localhost:11435/dashboard` after starting the proxy. Use the **Add Key** form at the bottom of the left panel — keys are saved to `keys.json` automatically.

### 3. Start the proxy

```bash
node ollama-proxy.js
```

Output:
```
[KEYS] Loaded 2 keys from /path/to/keys.json
Proxy running on http://localhost:11435
Upstream: https://ollama.com
Keys loaded: 2
```

### 4. Point your AI coding tool

Set the base URL to `http://localhost:11435` in your framework's settings (see [Compatibility](#compatibility) for per-framework examples).

---

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `11435` | Proxy listen port |
| `UPSTREAM_HOST` | `ollama.com` | Upstream Ollama host |
| `API_KEYS` | — | Comma-separated keys (fallback if no `keys.json`) |
| `KEYS_FILE` | `./keys.json` | Path to keys persistence file |
| `SOCKET_TIMEOUT_MS` | `300000` | Upstream connect + first-byte timeout |
| `BODY_RECEIVE_TIMEOUT_MS` | `30000` | Max time to read request body |
| `MAX_BODY_SIZE` | `10485760` | Max request body size (10MB) |
| `CACHE_TTL_TAGS` | `300000` | Cache TTL for `/api/tags` (5min) |
| `CACHE_TTL_MODELS` | `300000` | Cache TTL for `/v1/models` (5min) |
| `CACHE_TTL_SHOW` | `600000` | Cache TTL for `/api/show` (10min) |

### `keys.json` format

```json
{
  "keys": [
    { "key": "...", "name": "Work PC", "status": "active" },
    { "key": "...", "name": "Home Server", "status": "active", "cooldownUntil": null, "usageCount": 0, "failCount": 0 }
  ],
  "savedAt": "2026-04-25T12:00:00.000Z"
}
```

Fields:
- `key` **(required)** — the API key
- `name` — friendly label shown in dashboard
- `status` — `active` or `cooldown`
- `cooldownUntil` — Unix timestamp (ms), set automatically on 429
- `usageCount` — total requests served by this key
- `failCount` — consecutive 429/401 failures (resets after long cooldown)

---

## API Reference

### Proxy endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns key statuses |
| `*` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `*` | `/v1/messages` | Anthropic Messages API (proxied to Ollama's `/v1/chat/completions`) |
| `GET` | `/api/tags` | Ollama model list (cached) |
| `GET` | `/v1/models` | Model list (cached) |
| `POST` | `/api/show` | Model info (cached) |
| `GET` | `/dashboard` | Admin dashboard UI (localhost only) |

### Admin API (localhost only)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/keys` | List all keys with status and metrics |
| `POST` | `/api/keys` | Add a new key |
| `PATCH` | `/api/keys/:index` | Update key name |
| `DELETE` | `/api/keys/:index` | Remove a key |
| `GET` | `/api/logs` | Live activity logs |

---

## Dashboard

The admin dashboard is available at **`http://localhost:11435/dashboard`** (only accessible from localhost).

Features:
- **Key list** — name, masked key, status (Ready / Busy / Cooldown), concurrency, usage count
- **Live activity** — real-time request logs with status code highlighting
- **Add/remove keys** — manage keys without editing `keys.json`

```
http://localhost:11435/dashboard
```

---

## Verification

Test the proxy is running:

```bash
curl http://localhost:11435/health
```

Expected response:

```json
{
  "status": "ok",
  "keys": [
    { "index": 0, "status": "active", "concurrency": 0, "usageCount": 3, "cooldownRemainingSecs": 0 }
  ]
}
```

Test a chat completion:

```bash
curl -X POST http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"minimax-m2.7","messages":[{"role":"user","content":"Hi"}],"max_tokens":20}'
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

[discord]: https://discord.gg/your-server
