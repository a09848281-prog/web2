"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RemoteCameraIce = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function () {
  function normalizeAddress(value) {
    let address = String(value || "").trim();
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    const zone = address.indexOf("%");
    if (zone >= 0) address = address.slice(0, zone);
    return address.toLowerCase();
  }

  function parseIpv6Groups(value) {
    const address = normalizeAddress(value);
    if (!address.includes(":") || address.includes(".") || !/^[0-9a-f:]+$/i.test(address)) return null;
    if ((address.match(/::/g) || []).length > 1) return null;
    const compressed = address.includes("::");
    const sides = address.split("::");
    const left = sides[0] ? sides[0].split(":") : [];
    const right = compressed && sides[1] ? sides[1].split(":") : [];
    const groups = left.concat(right);
    if (groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
    if (compressed) {
      const missing = 8 - groups.length;
      if (missing < 1) return null;
      return left.map(x => parseInt(x, 16))
        .concat(new Array(missing).fill(0), right.map(x => parseInt(x, 16)));
    }
    if (groups.length !== 8) return null;
    return groups.map(x => parseInt(x, 16));
  }

  function isIpv4(value) {
    const parts = normalizeAddress(value).split(".");
    return parts.length === 4 && parts.every(part => {
      if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
      const number = Number(part);
      return number >= 0 && number <= 255;
    });
  }

  function isGlobalIpv6(value) {
    const groups = parseIpv6Groups(value);
    if (!groups) return false;
    // Global unicast currently uses 2000::/3. Exclude known special-use ranges.
    if ((groups[0] & 0xe000) !== 0x2000) return false;
    // IANA special-purpose 2001::/23 and documentation 2001:db8::/32.
    if (groups[0] === 0x2001 &&
        (groups[1] <= 0x01ff || groups[1] === 0x0db8)) return false;
    if (groups[0] === 0x2002) return false; // Deprecated 6to4 transition prefix.
    // Documentation 3fff::/20: first 16 bits 3fff and next four bits zero.
    if (groups[0] === 0x3fff && (groups[1] & 0xf000) === 0x0000) return false;
    return true;
  }

  function classifyAddress(value) {
    const address = normalizeAddress(value);
    if (isIpv4(address)) return "ipv4";
    if (isGlobalIpv6(address)) return "ipv6-global";
    if (parseIpv6Groups(address)) return "ipv6-non-global";
    return "unknown";
  }

  function parseCandidateLine(line) {
    const value = String(line || "").trim().replace(/^a=/i, "");
    if (!/^candidate:/i.test(value)) return null;
    const parts = value.split(/\s+/);
    if (parts.length < 8) return null;
    const typeIndex = parts.findIndex((part, index) => index > 0 && part.toLowerCase() === "typ");
    const candidateType = typeIndex >= 0 ? String(parts[typeIndex + 1] || "").toLowerCase() : "unknown";
    const family = classifyAddress(parts[4]);
    return {
      family: family,
      candidateType: ["host", "srflx", "prflx", "relay"].includes(candidateType) ? candidateType : "unknown"
    };
  }

  function summarizeSdp(sdp) {
    const summary = {
      candidateCount: 0,
      ipv4Count: 0,
      ipv6GlobalCount: 0,
      ipv6NonGlobalCount: 0,
      unknownCount: 0,
      hostCount: 0,
      srflxCount: 0,
      prflxCount: 0,
      relayCount: 0
    };
    String(sdp || "").split(/\r?\n/).forEach(line => {
      const candidate = parseCandidateLine(line);
      if (!candidate) return;
      summary.candidateCount++;
      if (candidate.family === "ipv4") summary.ipv4Count++;
      else if (candidate.family === "ipv6-global") summary.ipv6GlobalCount++;
      else if (candidate.family === "ipv6-non-global") summary.ipv6NonGlobalCount++;
      else summary.unknownCount++;
      const key = candidate.candidateType + "Count";
      if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key]++;
    });
    return summary;
  }

  function hasUsableTurnServers(servers) {
    if (!Array.isArray(servers)) return false;
    return servers.some(server => {
      if (!server || typeof server !== "object") return false;
      const username = String(server.username || "").trim();
      const credential = String(server.credential || "").trim();
      if (!username || !credential || /[\r\n\0]/.test(username + credential)) return false;
      const rawUrls = server.urls;
      const urls = Array.isArray(rawUrls) ? rawUrls : (typeof rawUrls === "string" ? [rawUrls] : []);
      return urls.some(rawUrl => {
        const url = String(rawUrl || "").trim();
        return /^turns?:[a-z0-9.-]+(?::[0-9]{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url);
      });
    });
  }

  function filterSdpToGlobalIpv6(sdp) {
    const original = String(sdp || "");
    const lines = original.split(/\r?\n/);
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      if (/^a=candidate:/i.test(line.trim())) {
        const candidate = parseCandidateLine(line);
        if (!candidate || candidate.family !== "ipv6-global") {
          removed++;
          continue;
        }
      }
      kept.push(line);
    }
    const filtered = kept.join("\r\n");
    const summary = summarizeSdp(filtered);
    if (summary.ipv6GlobalCount === 0) {
      return { ok: false, sdp: "", removed: removed, summary: summary, reason: "global-ipv6-candidate-not-found" };
    }
    return { ok: true, sdp: filtered, removed: removed, summary: summary, reason: "" };
  }

  function stunOnlyServers(servers) {
    const result = [];
    if (Array.isArray(servers)) {
      servers.forEach(server => {
        if (!server || typeof server !== "object") return;
        const rawUrls = server.urls;
        const urls = Array.isArray(rawUrls) ? rawUrls : (typeof rawUrls === "string" ? [rawUrls] : []);
        const stunUrls = urls.map(value => String(value || "").trim())
          .filter(value => /^stuns?:[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(value));
        if (stunUrls.length) result.push({ urls: [...new Set(stunUrls)] });
      });
    }
    if (!result.length) result.push({ urls: ["stun:stun.l.google.com:19302"] });
    return result;
  }

  return {
    classifyAddress: classifyAddress,
    isGlobalIpv6: isGlobalIpv6,
    parseCandidateLine: parseCandidateLine,
    summarizeSdp: summarizeSdp,
    filterSdpToGlobalIpv6: filterSdpToGlobalIpv6,
    hasUsableTurnServers: hasUsableTurnServers,
    stunOnlyServers: stunOnlyServers
  };
});
