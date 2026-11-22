const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../recovery-core.js");

test("first reconnect retry waits eight seconds to avoid overlapping camera and ICE recovery", () => {
  assert.equal(Recovery.retryDelay(1, "resume", 0.5), 8000);
  assert.equal(Recovery.retryDelay(1, "datachannel", 0.5), 8000);
  assert.equal(Recovery.retryDelay(1, "failed", 0.5), 8000);
});

test("reconnect backoff continues without an attempt ceiling and caps at 60 seconds", () => {
  const values = [1,2,3,4,5,6,7,8,20].map(n => Recovery.retryDelay(n, "other", 0.5));
  assert.deepEqual(values, [8000,15000,25000,40000,55000,60000,60000,60000,60000]);
  assert.ok(values.every(value => value >= 5000 && value <= Recovery.maxDelay));
});

test("retry jitter is bounded to five percent", () => {
  assert.equal(Recovery.retryDelay(2, "other", 0), 14250);
  assert.equal(Recovery.retryDelay(2, "other", 1), 15750);
});

test("manual disconnect suppresses retry but active connection intent keeps retrying", () => {
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:true,hasDevice:true,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:false,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:false}), false);
});

test("intentional Android camera OFF never starts a video-stall reconnect", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 100000, cameraEnabled: false, lastFrameAt: 1,
    hasReceivedFrame: true, freezeMs: 15000
  }), false);
});

test("video watchdog waits through an active camera-operation grace period", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 110000, cameraEnabled: true, graceUntil: 120000, lastFrameAt: 90000,
    hasReceivedFrame: true, freezeMs: 15000
  }), false);
});

test("video watchdog does not recover before the post-operation freeze window expires", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 134999, cameraEnabled: true, graceUntil: 120000, lastFrameAt: 90000,
    hasReceivedFrame: true, freezeMs: 15000
  }), false);
  assert.equal(Recovery.shouldRecoverVideo({
    now: 135001, cameraEnabled: true, graceUntil: 120000, lastFrameAt: 90000,
    hasReceivedFrame: true, freezeMs: 15000
  }), true);
});

test("video watchdog uses a separate startup timeout before the first frame", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 117999, cameraEnabled: true, graceUntil: 100000, lastFrameAt: 100000,
    hasReceivedFrame: false, startupMs: 18000
  }), false);
  assert.equal(Recovery.shouldRecoverVideo({
    now: 118001, cameraEnabled: true, graceUntil: 100000, lastFrameAt: 100000,
    hasReceivedFrame: false, startupMs: 18000
  }), true);
});

test("hidden video pane never starts a video-stall reconnect", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 500000, videoVisible: false, cameraEnabled: true, lastFrameAt: 1,
    hasReceivedFrame: true, freezeMs: 15000
  }), false);
});

test("manual disconnect suppresses video-stall recovery", () => {
  assert.equal(Recovery.shouldRecoverVideo({
    now: 500000, manualDisconnect: true, cameraEnabled: true,
    graceUntil: 1, lastFrameAt: 1, hasReceivedFrame: true
  }), false);
});
