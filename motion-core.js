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
    let signedDelta = 0;
    let globallyChangedPixels = 0;
    for (let i = 0; i < current.length; i += 1) {
      const delta = current[i] - previous[i];
      const absolute = Math.abs(delta);
      totalDelta += absolute;
      signedDelta += delta;
      if (absolute >= thresholds[level - 1]) globallyChangedPixels += 1;
    }
    const averageDelta = totalDelta / current.length;
    const globalChangeShare = globallyChangedPixels / current.length;
    const exposureDirectionShare = totalDelta > 0 ? Math.abs(signedDelta) / totalDelta : 0;
    // Exposure/flicker affects most pixels in the same direction. A moving
    // object usually creates both entering and leaving edges or remains local.
    if (averageDelta > 20 && globalChangeShare > 0.7 && exposureDirectionShare > 0.75) {
      return { score: 0, changedPixels: 0, averageDelta: averageDelta, valid: true };
    }
    // Cap the adaptive threshold so a large localized object is not filtered out.
    const pixelThreshold = Math.max(thresholds[level - 1], Math.min(32, averageDelta * 0.8 + 4));
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
