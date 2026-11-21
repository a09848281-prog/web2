(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocationUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function timestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1000000000000 ? value * 1000 : value;
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric < 1000000000000 ? numeric * 1000 : numeric;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
  }

  function normalizeLiveLocation(raw) {
    if (!raw || typeof raw !== "object") return null;
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    const accuracy = Number(raw.accuracy);
    const timestamp = timestampMs(raw.timestamp);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        !Number.isFinite(timestamp) || timestamp <= 0 ||
        timestamp > Date.now() + 60000) return null;
    const mode = ["manual", "connected", "background"].includes(String(raw.mode))
      ? String(raw.mode) : "manual";
    return {
      id: String(raw.id || ("rtc-" + Math.trunc(timestamp))),
      lat: lat,
      lng: lng,
      accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0,
      timestamp: new Date(timestamp).toISOString(),
      mode: mode,
      transport: "RTC"
    };
  }

  function mergeHistory(history, livePoint, limit) {
    const maxItems = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 500;
    const points = Array.isArray(history) ? history.slice() : [];
    if (livePoint && typeof livePoint === "object") points.push(livePoint);
    const unique = new Map();
    for (const point of points) {
      if (!point || typeof point !== "object") continue;
      const lat = Number(point.lat);
      const lng = Number(point.lng);
      const timestamp = timestampMs(point.timestamp);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
          !Number.isFinite(lng) || lng < -180 || lng > 180 ||
          !Number.isFinite(timestamp) || timestamp <= 0) continue;
      const key = timestamp + "|" + lat.toFixed(6) + "|" + lng.toFixed(6);
      const existing = unique.get(key);
      if (!existing || point.transport === "RTC" || !existing.transport) {
        unique.set(key, point);
      }
    }
    return [...unique.values()]
      .sort((a, b) => timestampMs(a.timestamp) - timestampMs(b.timestamp))
      .slice(-maxItems);
  }

  return { normalizeLiveLocation, mergeHistory, timestampMs };
});
