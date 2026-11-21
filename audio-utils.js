(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AudioUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clampReceivePercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 70;
    return Math.max(0, Math.min(200, Math.round(number)));
  }

  function receiveGain(value) {
    return clampReceivePercent(value) / 100;
  }

  function rmsFromTimeDomain(data) {
    if (!data || typeof data.length !== "number" || data.length === 0) return 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 1) {
      const raw = Number(data[i]);
      if (!Number.isFinite(raw)) continue;
      const sample = raw > 1 || raw < -1 ? (raw - 128) / 128 : raw;
      sum += sample * sample;
      count += 1;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  function meterLevel(rms) {
    const value = Number(rms);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.min(1, value * 3.2));
  }

  function meterLabel(rms) {
    const value = Number(rms);
    if (!Number.isFinite(value) || value < 0.008) return "静か";
    if (value < 0.04) return "小さい音";
    if (value < 0.16) return "音声受信中";
    return "大きな音";
  }

  function pttRemainingMs(startedAt, now) {
    const start = Number(startedAt);
    const current = Number(now);
    if (!Number.isFinite(start) || !Number.isFinite(current)) return 0;
    return Math.max(0, 180000 - (current - start));
  }

  return {
    clampReceivePercent: clampReceivePercent,
    receiveGain: receiveGain,
    rmsFromTimeDomain: rmsFromTimeDomain,
    meterLevel: meterLevel,
    meterLabel: meterLabel,
    pttRemainingMs: pttRemainingMs
  };
});
