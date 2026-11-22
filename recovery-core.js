(function(root) {
  "use strict";
  // Deliberately slower retries reduce overlapping ICE/SDP/GAS work on mobile devices.
  // Retry forever while the user has an active connection intent; only manual disconnect stops it.
  const BACKOFF_MS = [8000, 15000, 25000, 40000, 55000, 60000];
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
  // A camera can intentionally stop producing frames when the user pauses it or
  // changes camera/quality. Only treat silence as a connection failure after the
  // operation grace period and the normal frame timeout have both elapsed.
  function shouldRecoverVideo(state) {
    if (!state || state.manualDisconnect === true || state.cameraEnabled === false ||
        state.videoVisible === false) return false;
    const now = Number(state.now);
    const lastFrameAt = Number(state.lastFrameAt);
    if (!Number.isFinite(now) || !Number.isFinite(lastFrameAt)) return false;
    const graceUntil = Number.isFinite(Number(state.graceUntil)) ? Number(state.graceUntil) : 0;
    if (now < graceUntil) return false;
    const referenceAt = Math.max(lastFrameAt, graceUntil);
    const timeout = state.hasReceivedFrame === true
      ? Math.max(1000, Number(state.freezeMs) || 15000)
      : Math.max(1000, Number(state.startupMs) || 18000);
    return now - referenceAt > timeout;
  }
  const api = Object.freeze({
    retryDelay,
    shouldRetry,
    shouldRecoverVideo,
    maxDelay: 60000,
    backoffMs: BACKOFF_MS.slice()
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RemoteCameraRecovery = api;
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : null));
