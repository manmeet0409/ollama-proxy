// ─── Key Management ───────────────────────────────────────────────────────────
//
// Design goals:
//   1. Each key supports only 1 concurrent request (concurrency cap = 1).
//   2. Primary key (activeKeyIndex) is always preferred when vacant.
//   3. If primary is busy → round-robin to the next available key.
//   4. Key exhausted (429/401) → short cooldown; failCount++.
//   5. 3 consecutive 429s on same key → long cooldown (10 min); failCount resets.
//   6. If all keys are busy (not cooling), wait & re-poll up to KEY_BUSY_MAX_WAIT_MS.
//   7. On the 2nd full loop, if every key is still exhausted → return null (429).

import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  KEYS_FILE,
  DEFAULT_COOLDOWN_MS,
  LONG_COOLDOWN_MS,
  MAX_FAILS_BEFORE_LONG_COOLDOWN,
  KEY_BUSY_POLL_INTERVAL_MS,
  KEY_BUSY_MAX_WAIT_MS,
} from "./config.js";

/** @type {import("./types.js").KeyEntry[]} */
let API_KEYS = [];
let activeKeyIndex = 0;

// ─── Persistence ──────────────────────────────────────────────────────────────

export function loadKeys() {
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

export function saveKeys() {
  try {
    const data = JSON.stringify(
      {
        keys: API_KEYS.map((k) => ({
          key: k.key,
          name: k.name,
          status: k.status,
          cooldownUntil: k.cooldownUntil,
          usageCount: k.usageCount,
          failCount: k.failCount,
        })),
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    writeFileSync(KEYS_FILE, data);
  } catch (err) {
    console.error(`[KEYS] Failed to save: ${err.message}`);
  }
}

// ─── Accessors ────────────────────────────────────────────────────────────────

export function getKeys() {
  return API_KEYS;
}

export function getActiveKeyIndex() {
  return activeKeyIndex;
}

// ─── Cooldown management ──────────────────────────────────────────────────────

export function refreshCooldowns() {
  const now = Date.now();
  let changed = false;
  for (const k of API_KEYS) {
    if (
      k.status === "cooldown" &&
      k.cooldownUntil !== null &&
      now >= k.cooldownUntil
    ) {
      k.cooldownUntil = null;
      k.status = "active";
      console.log(
        `[KEY] key=${API_KEYS.indexOf(k)} cooldown expired → active (failCount=${k.failCount})`,
      );
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

export function releaseKey(keyObj) {
  const old = keyObj.concurrency;
  keyObj.concurrency = Math.max(0, keyObj.concurrency - 1);
  if (old !== keyObj.concurrency) {
    console.log(
      `[KEY] released key=${API_KEYS.indexOf(keyObj)} (concurrency=${keyObj.concurrency})`,
    );
  }
}

export function cooldownKey(keyObj, retryAfterHeader, isQuota = false) {
  if (keyObj.status === "cooldown") {
    releaseKey(keyObj);
    return;
  }

  keyObj.failCount++;
  const keyIdx = API_KEYS.indexOf(keyObj);

  let ms;
  if (isQuota) {
    ms = LONG_COOLDOWN_MS;
    console.warn(
      `[KEY] key=${keyIdx} QUOTA EXHAUSTED → immediate LONG cooldown ${ms / 1000}s`,
    );
    keyObj.failCount = 0; // Reset as we're already at max penalty
  } else if (keyObj.failCount >= MAX_FAILS_BEFORE_LONG_COOLDOWN) {
    ms = LONG_COOLDOWN_MS;
    console.warn(
      `[KEY] key=${keyIdx} fail #${keyObj.failCount} → LONG cooldown ${ms / 1000}s — resetting failCount`,
    );
    keyObj.failCount = 0;
  } else {
    if (retryAfterHeader) {
      // Retry-After can be seconds (e.g. "60") or a Date string.
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed)) {
        ms = parsed * 1000;
      } else {
        const date = new Date(retryAfterHeader);
        if (!isNaN(date.getTime())) {
          ms = Math.max(0, date.getTime() - Date.now());
        } else {
          ms = DEFAULT_COOLDOWN_MS;
        }
      }
    } else {
      ms = DEFAULT_COOLDOWN_MS;
    }
    console.warn(
      `[KEY] key=${keyIdx} fail #${keyObj.failCount} → short cooldown ${ms / 1000}s`,
    );
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
export function earliestRetryAfterSecs() {
  const now = Date.now();
  let soonest = Infinity;
  for (const k of API_KEYS) {
    if (k.status === "cooldown" && k.cooldownUntil !== null) {
      soonest = Math.min(soonest, k.cooldownUntil - now);
    }
  }
  return soonest === Infinity ? 60 : Math.ceil(soonest / 1000);
}

export function releaseCooldown(index) {
  if (index < 0 || index >= API_KEYS.length) return false;
  const keyObj = API_KEYS[index];
  if (keyObj.status === "cooldown") {
    keyObj.status = "active";
    keyObj.cooldownUntil = null;
    keyObj.failCount = 0;
    console.log(`[KEY] Manual cooldown release for key=${index}`);
    saveKeys();
    return true;
  }
  return false;
}

export function releaseAllCooldowns() {
  let changed = false;
  for (let i = 0; i < API_KEYS.length; i++) {
    const keyObj = API_KEYS[i];
    if (keyObj.status === "cooldown") {
      keyObj.status = "active";
      keyObj.cooldownUntil = null;
      keyObj.failCount = 0;
      console.log(`[KEY] Manual cooldown release for key=${i}`);
      changed = true;
    }
  }
  if (changed) {
    saveKeys();
  }
  return changed;
}
