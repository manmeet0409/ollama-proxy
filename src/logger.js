// ─── Logs Buffer ──────────────────────────────────────────────────────────────
//
// In-memory ring buffer of log entries exposed via /api/logs.
// Wraps the global console so every log/warn/error is automatically captured.

const MAX_LOGS = 200;

/** @type {Array<{time: string, level: string, message: string}>} */
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

export function getLogs() {
  return logs;
}
