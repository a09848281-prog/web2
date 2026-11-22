(function (root) {
  "use strict";
  function mapPoint(rect, videoWidth, videoHeight, clientX, clientY) {
    const width = Number(videoWidth), height = Number(videoHeight);
    if (!rect || !(width > 0) || !(height > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const shownWidth = width * scale, shownHeight = height * scale;
    const left = rect.left + (rect.width - shownWidth) / 2;
    const top = rect.top + (rect.height - shownHeight) / 2;
    const localX = clientX - left, localY = clientY - top;
    if (localX < 0 || localY < 0 || localX > shownWidth || localY > shownHeight) return null;
    return { x: Math.max(0, Math.min(width - 1, Math.round(localX / scale))), y: Math.max(0, Math.min(height - 1, Math.round(localY / scale))) };
  }
  function classifyGesture(start, end, durationMs, moved, threshold = 24, longPressMs = 550) {
    const distance = Math.hypot((end?.x ?? start.x) - start.x, (end?.y ?? start.y) - start.y);
    if (!moved && distance < 14 && durationMs >= longPressMs) return { type: "long_press" };
    if (distance >= threshold) return { type: "swipe", durationMs: Math.max(80, Math.min(900, Number(durationMs) || 250)) };
    return { type: "tap" };
  }
  function fitStageSize(containerWidth, maxHeight, videoWidth, videoHeight) {
    const boundsWidth = Number(containerWidth), boundsHeight = Number(maxHeight);
    const sourceWidth = Number(videoWidth), sourceHeight = Number(videoHeight);
    if (![boundsWidth, boundsHeight, sourceWidth, sourceHeight].every(Number.isFinite) ||
        boundsWidth <= 0 || boundsHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;
    const scale = Math.min(boundsWidth / sourceWidth, boundsHeight / sourceHeight);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
      aspectRatio: sourceWidth + " / " + sourceHeight
    };
  }
  function sanitizeText(value) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, 300);
  }
  const api = { mapPoint, classifyGesture, fitStageSize, sanitizeText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RemoteScreenUtils = api;
})(typeof window !== "undefined" ? window : globalThis);
