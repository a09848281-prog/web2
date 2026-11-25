"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Ice = require("../network-ice.js");

const candidate = (address, type = "host") =>
  "a=candidate:1 1 udp 2122260223 " + address + " 50000 typ " + type + " generation 0";

test("classifies IPv4, global IPv6, private IPv6 and obfuscated addresses without exposing them", () => {
  assert.equal(Ice.classifyAddress("192.168.1.20"), "ipv4");
  assert.equal(Ice.classifyAddress("8.8.8.8"), "ipv4");
  assert.equal(Ice.classifyAddress("2001:4860:4860::8888"), "ipv6-global");
  assert.equal(Ice.classifyAddress("2606:4700:4700::1111"), "ipv6-global");
  assert.equal(Ice.classifyAddress("fd12:3456:789a::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("fe80::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("2001:db8::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("2001:0:1::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("2002::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("3fff::1"), "ipv6-non-global");
  assert.equal(Ice.classifyAddress("camera.local"), "unknown");
});

test("parses candidate family and candidate type", () => {
  assert.deepEqual(Ice.parseCandidateLine(candidate("203.0.113.10", "srflx")), {
    family: "ipv4", candidateType: "srflx"
  });
  assert.deepEqual(Ice.parseCandidateLine(candidate("2001:4860:4860::8888", "host")), {
    family: "ipv6-global", candidateType: "host"
  });
  assert.equal(Ice.parseCandidateLine("a=end-of-candidates"), null);
});

test("summarizes candidate counts without returning raw IP addresses", () => {
  const sdp = [
    "v=0",
    candidate("192.168.1.20", "host"),
    candidate("2001:4860:4860::8888", "srflx"),
    candidate("fd12:3456:789a::1", "host"),
    candidate("camera.local", "host")
  ].join("\r\n");
  const summary = Ice.summarizeSdp(sdp);
  assert.equal(summary.candidateCount, 4);
  assert.equal(summary.ipv4Count, 1);
  assert.equal(summary.ipv6GlobalCount, 1);
  assert.equal(summary.ipv6NonGlobalCount, 1);
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.hostCount, 3);
  assert.equal(summary.srflxCount, 1);
  assert.equal(JSON.stringify(summary).includes("2001:4860"), false);
});

test("IPv6 fallback keeps only globally routable IPv6 candidates", () => {
  const sdp = [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "a=mid:0",
    candidate("192.168.1.20", "host"),
    candidate("2001:4860:4860::8888", "srflx"),
    candidate("fe80::1234", "host"),
    candidate("2606:4700:4700::1111", "host"),
    "a=end-of-candidates"
  ].join("\r\n");
  const result = Ice.filterSdpToGlobalIpv6(sdp);
  assert.equal(result.ok, true);
  assert.equal(result.summary.candidateCount, 2);
  assert.equal(result.summary.ipv6GlobalCount, 2);
  assert.equal(result.sdp.includes("192.168.1.20"), false);
  assert.equal(result.sdp.includes("fe80::1234"), false);
  assert.equal(result.sdp.includes("2001:4860:4860::8888"), true);
  assert.equal(result.sdp.includes("2606:4700:4700::1111"), true);
  assert.equal(result.sdp.includes("a=end-of-candidates"), true);
});

test("IPv6 fallback fails safely when no global IPv6 candidates exist", () => {
  const result = Ice.filterSdpToGlobalIpv6([
    "v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96",
    candidate("192.168.1.20", "host"),
    candidate("fd12:3456:789a::1", "host")
  ].join("\r\n"));
  assert.equal(result.ok, false);
  assert.equal(result.sdp, "");
  assert.equal(result.reason, "global-ipv6-candidate-not-found");
});

test("malformed SDP and candidate lines do not throw", () => {
  assert.equal(Ice.summarizeSdp("not SDP").candidateCount, 0);
  assert.equal(Ice.filterSdpToGlobalIpv6("").ok, false);
  assert.equal(Ice.parseCandidateLine("a=candidate:broken"), null);
});


test("automatic recovery prioritizes available IPv6 before TURN relay", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const start = app.indexOf("function prepareIceRetry(reason) {");
  const end = app.indexOf("\nfunction autoReconnectKey", start);
  assert.ok(start >= 0 && end > start, "Retry strategy function must exist");
  const sandbox = {
    S: {
      iceMode: "normal", nextIceMode: "normal", ipv6RetryUsed: false,
      relayRetryUsed: false, turnConfigured: true, forceTurnRelay: false
    },
    ICE_DIAG: { localSummary: { ipv6GlobalCount: 2 }, lastError: "" },
    recordIceDiagnostic: () => {}
  };
  vm.runInNewContext(app.slice(start, end), sandbox);
  sandbox.prepareIceRetry("failed");
  assert.equal(sandbox.S.nextIceMode, "ipv6");
  assert.equal(sandbox.S.ipv6RetryUsed, true);
  sandbox.S.iceMode = "ipv6";
  sandbox.S.nextIceMode = "normal";
  sandbox.prepareIceRetry("failed");
  assert.equal(sandbox.S.nextIceMode, "relay");
  assert.equal(sandbox.S.relayRetryUsed, true);
  sandbox.S.iceMode = "relay";
  sandbox.S.nextIceMode = "normal";
  sandbox.prepareIceRetry("failed");
  assert.equal(sandbox.S.nextIceMode, "normal");
});

test("automatic recovery skips IPv6 when no global IPv6 candidate exists", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const start = app.indexOf("function prepareIceRetry(reason) {");
  const end = app.indexOf("\nfunction autoReconnectKey", start);
  const sandbox = {
    S: {
      iceMode: "normal", nextIceMode: "normal", ipv6RetryUsed: false,
      relayRetryUsed: false, turnConfigured: true, forceTurnRelay: false
    },
    ICE_DIAG: { localSummary: { ipv6GlobalCount: 0 }, lastError: "" },
    recordIceDiagnostic: () => {}
  };
  vm.runInNewContext(app.slice(start, end), sandbox);
  sandbox.prepareIceRetry("failed");
  assert.equal(sandbox.S.nextIceMode, "relay");
  assert.equal(sandbox.S.ipv6RetryUsed, false);
});

test("automatic recovery keeps the normal fallback when TURN is not configured", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const start = app.indexOf("function prepareIceRetry(reason) {");
  const end = app.indexOf("\nfunction autoReconnectKey", start);
  const sandbox = {
    S: {
      iceMode: "normal", nextIceMode: "normal", ipv6RetryUsed: true,
      relayRetryUsed: false, turnConfigured: false, forceTurnRelay: false
    },
    ICE_DIAG: { localSummary: { ipv6GlobalCount: 0 }, lastError: "" },
    recordIceDiagnostic: () => {}
  };
  vm.runInNewContext(app.slice(start, end), sandbox);
  sandbox.prepareIceRetry("failed");
  assert.equal(sandbox.S.nextIceMode, "normal");
  assert.equal(sandbox.S.relayRetryUsed, false);
});


test("diagnostic errors redact raw IPv4 and IPv6 addresses before display or copy", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const start = app.indexOf("function sanitizeIceDiagnosticText(value) {");
  const end = app.indexOf("\nfunction recordIceDiagnostic", start);
  assert.ok(start >= 0 && end > start);
  const sanitize = new Function(app.slice(start, end) + "; return sanitizeIceDiagnosticText;")();
  const source = "IPv4 192.168.10.25 / IPv6 2001:4860:4860::8888 / bracketed [2606:4700:4700::1111]";
  const safe = sanitize(source);
  assert.equal(safe.includes("192.168.10.25"), false);
  assert.equal(safe.includes("2001:4860:4860::8888"), false);
  assert.equal(safe.includes("2606:4700:4700::1111"), false);
  assert.equal((safe.match(/\[IPv4\]/g) || []).length, 1);
  assert.equal((safe.match(/\[IPv6\]/g) || []).length, 2);
});


test("direct-first ICE server list keeps STUN servers and never advertises TURN", () => {
  const servers = [
    { urls: ["stun:stun.l.google.com:19302", "turn:relay.example:3478?transport=udp"], username: "u", credential: "p" },
    { urls: "turns:relay.example:5349" },
    { urls: ["stuns:stun.example:5349", "turn:relay.example:3478?transport=tcp"] }
  ];
  const direct = Ice.stunOnlyServers(servers);
  assert.deepEqual(direct, [
    { urls: ["stun:stun.l.google.com:19302"] },
    { urls: ["stuns:stun.example:5349"] }
  ]);
  assert.ok(direct.every(server => (Array.isArray(server.urls) ? server.urls : [server.urls])
    .every(url => /^stuns?:/i.test(url))));
});

test("direct-first ICE keeps a built-in STUN fallback if the server list contains only TURN", () => {
  assert.deepEqual(Ice.stunOnlyServers([{ urls: "turn:relay.example:3478", username: "u", credential: "p" }]),
    [{ urls: ["stun:stun.l.google.com:19302"] }]);
});
