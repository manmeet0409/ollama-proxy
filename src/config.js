import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Versioning ───────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
export const VERSION = pkg.version;

// ─── Server ───────────────────────────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || "11435", 10);
export const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "ollama.com";
export const UPSTREAM_BASE = `https://${UPSTREAM_HOST}`;
export const SOCKET_TIMEOUT_MS = parseInt(process.env.SOCKET_TIMEOUT_MS || "300000", 10);
export const BODY_RECEIVE_TIMEOUT_MS = parseInt(process.env.BODY_RECEIVE_TIMEOUT_MS || "30000", 10);
export const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || "10485760", 10);
export const KEYS_FILE = process.env.KEYS_FILE || resolve(__dirname, "..", "keys.json");

// ─── Cooldowns ────────────────────────────────────────────────────────────────
export const DEFAULT_COOLDOWN_MS = parseInt(process.env.DEFAULT_COOLDOWN_MS || "60000", 10);
export const SHORT_COOLDOWN_MS = 60_000;
export const LONG_COOLDOWN_MS = 10 * 60_000;
export const MAX_FAILS_BEFORE_LONG_COOLDOWN = 3;

// ─── Key rotation ─────────────────────────────────────────────────────────────
// Max time (ms) to wait for a busy key before giving up on a retry loop.
export const KEY_BUSY_POLL_INTERVAL_MS = parseInt(process.env.KEY_BUSY_POLL_INTERVAL_MS || "500", 10);
export const KEY_BUSY_MAX_WAIT_MS = parseInt(process.env.KEY_BUSY_MAX_WAIT_MS || "120000", 10);

// ─── Cache ────────────────────────────────────────────────────────────────────
export const CACHE_TTL = {
  "/api/tags": parseInt(process.env.CACHE_TTL_TAGS || "300000", 10),
  "/v1/models": parseInt(process.env.CACHE_TTL_MODELS || "300000", 10),
  "/api/show": parseInt(process.env.CACHE_TTL_SHOW || "600000", 10),
};
export const MAX_CACHE_ENTRIES = 100;
