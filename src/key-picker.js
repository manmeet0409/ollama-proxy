// ─── Key Picker ───────────────────────────────────────────────────────────────
//
// Implements "1-request-per-key" round-robin with wait-and-retry:
//
//  1. Try the primary key first — if vacant (concurrency === 0, active), use it.
//  2. If primary is busy, round-robin to the next idle active key.
//  3. If ALL keys are busy (not on cooldown), wait briefly and re-poll.
//  4. After 2 full sweeps with no key becoming available, give up (return null).
//  5. Cooldown keys are never picked; they are excluded until their timer expires.
//
// The `excluding` set lets the retry loop skip keys that already 429'd
// for this specific request, preventing infinite retry on the same bad key.

import { KEY_BUSY_POLL_INTERVAL_MS, KEY_BUSY_MAX_WAIT_MS } from "./config.js";

import { getKeys, getActiveKeyIndex, refreshCooldowns } from "./key-manager.js";

/**
 * Sleep helper for the busy-wait polling loop.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to find an available key synchronously (one sweep) and atomically mark it busy.
 *
 * @param {Set<object>|null} excluding - Keys to skip (already 429'd this request)
 * @returns {{ keyObj: object, reason: string } | null}
 */
function trySweep(excluding) {
  const keys = getKeys();
  const total = keys.length;
  const primaryIdx = getActiveKeyIndex();

  // 1️⃣  Try primary first (if not excluded)
  const primary = keys[primaryIdx];
  if (
    primary.status === "active" &&
    primary.concurrency === 0 &&
    (!excluding || !excluding.has(primary))
  ) {
    primary.concurrency++; // Atomic claim
    return { keyObj: primary, reason: `primary key=${primaryIdx}` };
  }

  // 2️⃣  Round-robin to find the next idle active key
  for (let i = 1; i < total; i++) {
    const idx = (primaryIdx + i) % total;
    const k = keys[idx];
    if (
      k.status === "active" &&
      k.concurrency === 0 &&
      (!excluding || !excluding.has(k))
    ) {
      k.concurrency++; // Atomic claim
      return { keyObj: k, reason: `round-robin key=${idx}` };
    }
  }

  return null; // No idle key found in this sweep
}

/**
 * Returns true when at least one key is active-but-busy (worth waiting for).
 * Returns false when every key is either on cooldown or excluded.
 */
function hasWorthWaitingKeys(excluding) {
  const keys = getKeys();
  for (const k of keys) {
    if (
      k.status === "active" &&
      k.concurrency > 0 &&
      (!excluding || !excluding.has(k))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Pick an available API key with busy-wait retry.
 *
 * @param {Set<object>|null} excluding - Keys already 429'd for this request
 * @returns {Promise<object|null>} - The key entry, or null if all exhausted
 */
export async function pickKey(excluding) {
  // Synchronous refresh to prevent yielding the event loop before the first sweep
  refreshCooldowns();

  // Fast path: immediate sweep
  const found = trySweep(excluding);
  if (found) {
    found.keyObj.usageCount++;
    console.log(
      `[KEY] picked → ${found.reason} (concurrency=${found.keyObj.concurrency})`,
    );
    return found.keyObj;
  }

  // Slow path: all keys are busy — poll until one frees up or we time out.
  // Two full loops worth of wait time, capped at KEY_BUSY_MAX_WAIT_MS.
  if (!hasWorthWaitingKeys(excluding)) {
    // Every key is on cooldown or excluded — no point waiting.
    return null;
  }

  const deadline = Date.now() + KEY_BUSY_MAX_WAIT_MS;
  const keys = getKeys();
  const activeCount = keys.filter((k) => k.status === "active").length;
  const busyCount = keys.filter(
    (k) => k.status === "active" && k.concurrency > 0,
  ).length;
  const coolingCount = keys.filter((k) => k.status === "cooldown").length;

  console.log(
    `[KEY] all keys busy — entering wait loop (max ${KEY_BUSY_MAX_WAIT_MS / 1000}s) [Total=${keys.length} Active=${activeCount} Busy=${busyCount} Cooling=${coolingCount}]`,
  );

  while (Date.now() < deadline) {
    await sleep(KEY_BUSY_POLL_INTERVAL_MS);
    refreshCooldowns();

    const retry = trySweep(excluding);
    if (retry) {
      retry.keyObj.usageCount++;
      console.log(
        `[KEY] picked after wait → ${retry.reason} (concurrency=${retry.keyObj.concurrency})`,
      );
      return retry.keyObj;
    }

    // If nothing is worth waiting for anymore, bail early
    if (!hasWorthWaitingKeys(excluding)) {
      console.warn("[KEY] no keys worth waiting for — giving up");
      return null;
    }
  }

  console.warn("[KEY] busy-wait timeout — all keys remain occupied");
  return null;
}
