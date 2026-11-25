"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const gasSource = fs.readFileSync("gas/Code.gs", "utf8");

test("GAS exposes only free Google STUN endpoints and never requests relay credentials", () => {
  const sandbox = {};
  vm.runInNewContext(gasSource, sandbox, { filename: "Code.gs" });
  const config = sandbox.iceConfig_();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.turnProvider, "stun-only");
  assert.deepEqual(JSON.parse(JSON.stringify(config.iceServers)), [{
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302"
    ]
  }]);
  assert.doesNotMatch(gasSource, /CF_TURN|TURN_CREDENTIAL|TURN_URLS|rtc\.live\.cloudflare/i);
});

test("Android continues to receive STUN settings from GAS without requiring an APK update", () => {
  const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
  const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
  assert.ok(service.includes('rtc?.setIceServers(response.optJSONArray("iceServers"))'));
  assert.ok(rtc.includes("private fun buildIceServers()"));
  assert.ok(rtc.includes('builder("stun:stun.l.google.com:19302")'));
});
