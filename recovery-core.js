(function(root) {
  "use strict";
  // Deliberately slower retries reduce overlapping ICE/SDP/GAS work on mobile devices.
  // Retry forever while the user has an active connection intent; only manual disconnect stops it.
  const BACKOFF_MS = [5000, 10000, 20000, 30000, 45000, 60000];
  function retryDelay(attempt, reason, randomValue) {
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    const base = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
    const random = Number.isFinite(Number(randomValue))
      ? Math.max(0, Math.min(1, Number(randomValue))) : 0.5;
    return Math.max(3000, Math.min(60000, Math.round(base * (0.95 + random * 0.1))));
  }
  function shouldRetry(state) {
    return !!state && state.manualDisconnect !== true &&
      state.hasDevice === true && (state.everConnected === true || state.autoConnectWanted === true);
  }
  const api = Object.freeze({
    retryDelay,
    shouldRetry,
    maxDelay: 60000,
    backoffMs: BACKOFF_MS.slice()
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RemoteCameraRecovery = api;
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : null));
