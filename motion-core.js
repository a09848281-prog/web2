(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MotionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function toLumaPixels(rgba) {
    if (!rgba || typeof rgba.length !== "number" || rgba.length % 4 !== 0) {
      throw new TypeError("RGBA pixel buffer is invalid.");
    }
    const result = new Uint8Array(rgba.length / 4);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
      result[target] = Math.round(0.2126 * rgba[source] + 0.7152 * rgba[source + 1] + 0.0722 * rgba[source + 2]);
    }
    return result;
  }

  function measure(previous, current, sensitivity) {
    if (!previous || !current || previous.length !== current.length || current.length === 0) {
      return { score: 0, changedPixels: 0, averageDelta: 0, valid: false };
    }
    const level = Math.max(1, Math.min(5, Math.round(Number(sensitivity) || 3)));
    const thresholds = [13, 17, 22, 28, 35];
    let totalDelta = 0;
    for (let i = 0; i < current.length; i += 1) {
      totalDelta += Math.abs(current[i] - previous[i]);
    }
    const averageDelta = totalDelta / current.length;
    // A near-uniform brightness jump is usually auto-exposure or a lighting change.
    if (averageDelta > 20) {
      return { score: 0, changedPixels: 0, averageDelta: averageDelta, valid: true };
    }
    const pixelThreshold = Math.max(thresholds[level - 1], averageDelta * 1.65 + 4);
    let changedPixels = 0;
    for (let i = 0; i < current.length; i += 1) {
      if (Math.abs(current[i] - previous[i]) >= pixelThreshold) changedPixels += 1;
    }
    return {
      score: changedPixels / current.length * 100,
      changedPixels: changedPixels,
      averageDelta: averageDelta,
      valid: true
    };
  }

  function minimumScore(sensitivity) {
    const values = [0.9, 1.3, 1.8, 2.5, 3.3];
    const level = Math.max(1, Math.min(5, Math.round(Number(sensitivity) || 3)));
    return values[level - 1];
  }

  return { toLumaPixels: toLumaPixels, measure: measure, minimumScore: minimumScore };
});
