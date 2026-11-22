const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../recovery-core.js");

test("first retry is fast and reason-specific", () => {
  assert.equal(Recovery.retryDelay(1, "online"), 200);
  assert.equal(Recovery.retryDelay(1, "resume"), 250);
  assert.equal(Recovery.retryDelay(1, "failed"), 350);
  assert.equal(Recovery.retryDelay(1, "datachannel"), 450);
  assert.equal(Recovery.retryDelay(1, "video-stalled"), 500);
});
test("retry backoff continues and is capped at 15 seconds", () => {
  const values = [1,2,3,4,5,6,7,8,20].map(n => Recovery.retryDelay(n, "other"));
  assert.deepEqual(values, [700,1400,2800,5000,8000,12000,15000,15000,15000]);
  assert.ok(values.every(value => value > 0 && value <= Recovery.maxDelay));
});
test("retry jitter is bounded to ten percent", () => {
  assert.equal(Recovery.retryDelay(2, "other", 0), 1260);
  assert.equal(Recovery.retryDelay(2, "other", 1), 1540);
});
test("manual disconnect suppresses retry but initial connection failures keep retrying when armed", () => {
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:true,hasDevice:true,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:false,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:false}), false);
});
