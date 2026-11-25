"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TurnUsage = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  function readSelectedPair(stats) {
    if (!stats || typeof stats.forEach !== "function" || typeof stats.get !== "function") return null;
    let pair = null;
    stats.forEach(item => {
      if (item && item.type === "transport" && item.selectedCandidatePairId) {
        pair = stats.get(item.selectedCandidatePairId) || pair;
      }
    });
    if (!pair) {
      stats.forEach(item => {
        if (item && item.type === "candidate-pair" &&
            item.state === "succeeded" && item.nominated === true) pair = item;
      });
    }
    if (!pair) return null;
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
    return {
      id: String(pair.id || ""),
      relay: local?.candidateType === "relay" || remote?.candidateType === "relay",
      sent: Math.max(0, Number(pair.bytesSent) || 0),
      received: Math.max(0, Number(pair.bytesReceived) || 0)
    };
  }

  function calculateDelta(previous, current) {
    if (!current || !current.relay) return { sent: 0, received: 0 };
    // Count the pair's current counters the first time it becomes selected,
    // and whenever a new relay pair/session is selected. This prevents the
    // first polling interval from disappearing from the monthly estimate.
    if (!previous || !previous.relay || previous.id !== current.id ||
        previous.sessionKey !== current.sessionKey) {
      return { sent: current.sent, received: current.received };
    }
    return {
      sent: current.sent >= previous.sent ? current.sent - previous.sent : 0,
      received: current.received >= previous.received ? current.received - previous.received : 0
    };
  }

  return { readSelectedPair, calculateDelta };
});
