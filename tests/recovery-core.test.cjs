const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../recovery-core.js");

test("first retry waits five seconds to avoid overlapping mobile RTC setup", () => {
  assert.equal(Recovery.retryDelay(1, "resume", 0.5), 5000);
  assert.equal(Recovery.retryDelay(1, "datachannel", 0.5), 5000);
  assert.equal(Recovery.retryDelay(1, "failed", 0.5), 5000);
});

test("retry backoff continues without an attempt ceiling and caps at 60 seconds", () => {
  const values = [1,2,3,4,5,6,7,8,20].map(n => Recovery.retryDelay(n, "other", 0.5));
  assert.deepEqual(values, [5000,10000,20000,30000,45000,60000,60000,60000,60000]);
  assert.ok(values.every(value => value >= 3000 && value <= Recovery.maxDelay));
});

test("retry jitter is bounded to five percent", () => {
  assert.equal(Recovery.retryDelay(2, "other", 0), 9500);
  assert.equal(Recovery.retryDelay(2, "other", 1), 10500);
});

test("manual disconnect suppresses retry but armed first attempts keep retrying", () => {
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:true}), true);
  assert.equal(Recovery.shouldRetry({manualDisconnect:true,hasDevice:true,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:false,everConnected:true,autoConnectWanted:true}), false);
  assert.equal(Recovery.shouldRetry({manualDisconnect:false,hasDevice:true,everConnected:false,autoConnectWanted:false}), false);
});
