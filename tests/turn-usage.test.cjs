"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TurnUsage = require("../turn-usage.js");

function report({ selected = "pair-1", localType = "host", remoteType = "srflx",
  sent = 1000, received = 2000, nominated = true } = {}) {
  const entries = [
    ["transport-1", { id: "transport-1", type: "transport", selectedCandidatePairId: selected }],
    ["pair-1", { id: "pair-1", type: "candidate-pair", state: "succeeded", nominated,
      localCandidateId: "local-1", remoteCandidateId: "remote-1", bytesSent: sent, bytesReceived: received }],
    ["local-1", { id: "local-1", type: "local-candidate", candidateType: localType }],
    ["remote-1", { id: "remote-1", type: "remote-candidate", candidateType: remoteType }]
  ];
  return { forEach: fn => entries.forEach(([, value]) => fn(value)),
    get: id => new Map(entries).get(id) || null };
}

test("selected transport candidate pair is preferred and relay is detected at either end", () => {
  const selected = report({ localType: "host", remoteType: "relay" });
  const sample = TurnUsage.readSelectedPair(selected);
  assert.equal(sample.id, "pair-1");
  assert.equal(sample.relay, true);
  assert.equal(sample.sent, 1000);
  assert.equal(sample.received, 2000);
});

test("direct candidate pairs are not counted as TURN traffic", () => {
  const sample = TurnUsage.readSelectedPair(report({ localType: "host", remoteType: "srflx" }));
  assert.equal(sample.relay, false);
  assert.deepEqual(TurnUsage.calculateDelta(
    { id: sample.id, relay: false, sessionKey: "s", sent: 100, received: 100 },
    { ...sample, sessionKey: "s" }
  ), { sent: 0, received: 0 });
});

test("only monotonic byte deltas from the same relay pair and session are added", () => {
  const previous = { id: "pair-1", relay: true, sessionKey: "session-a", sent: 1000, received: 500 };
  const current = { ...previous, sent: 1450, received: 900 };
  assert.deepEqual(TurnUsage.calculateDelta(previous, current), { sent: 450, received: 400 });
  assert.deepEqual(TurnUsage.calculateDelta(previous, { ...current, id: "pair-2" }), { sent: 0, received: 0 });
  assert.deepEqual(TurnUsage.calculateDelta(previous, { ...current, sessionKey: "session-b" }), { sent: 0, received: 0 });
  assert.deepEqual(TurnUsage.calculateDelta(previous, { ...current, sent: 50, received: 40 }), { sent: 0, received: 0 });
});

test("missing or unselected candidate-pair statistics are safe", () => {
  assert.equal(TurnUsage.readSelectedPair(null), null);
  assert.equal(TurnUsage.readSelectedPair({ forEach: () => {}, get: () => null }), null);
});
