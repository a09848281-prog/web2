(function(root) {
  "use strict";
  const BACKOFF_MS = [700, 1400, 2800, 5000, 8000, 12000, 15000];
  const FIRST = {
    online: 200, resume: 250, "setup-timeout": 300, failed: 350,
    "track-ended": 350, datachannel: 450, "video-stalled": 500,
    "connect-error": 600, disconnected: 900
  };
  function retryDelay(attempt, reason, randomValue) {
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    const why = String(reason || "disconnected");
    let base = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
    if (n === 1 && Object.prototype.hasOwnProperty.call(FIRST, why)) base = FIRST[why];
    const random = Number.isFinite(Number(randomValue))
      ? Math.max(0, Math.min(1, Number(randomValue))) : 0.5;
    return Math.max(150, Math.min(15000, Math.round(base * (0.9 + random * 0.2))));
  }
  function shouldRetry(state) {
    return !!state && state.manualDisconnect !== true &&
      state.hasDevice === true && state.everConnected === true;
  }
  const api = Object.freeze({ retryDelay, shouldRetry, maxDelay: 15000, backoffMs: BACKOFF_MS.slice() });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RemoteCameraRecovery = api;
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : null));
