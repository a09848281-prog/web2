const test = require("node:test");
const assert = require("node:assert/strict");
const AudioUtils = require("../audio-utils.js");

test("receive gain is clamped from 0 to 200 percent", () => {
  assert.equal(AudioUtils.clampReceivePercent(-5), 0);
  assert.equal(AudioUtils.clampReceivePercent(70), 70);
  assert.equal(AudioUtils.clampReceivePercent(200), 200);
  assert.equal(AudioUtils.clampReceivePercent(250), 200);
  assert.equal(AudioUtils.clampReceivePercent("nope"), 70);
  assert.equal(AudioUtils.receiveGain(150), 1.5);
});

test("calculates RMS from Web Audio float samples", () => {
  const rms = AudioUtils.rmsFromTimeDomain(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.ok(Math.abs(rms - 0.5) < 0.00001);
});

test("calculates RMS from AnalyserNode byte samples", () => {
  const rms = AudioUtils.rmsFromTimeDomain(new Uint8Array([128, 192, 64, 128]));
  assert.ok(Math.abs(rms - Math.sqrt(0.125)) < 0.0001);
});

test("audio meter level and labels are bounded", () => {
  assert.equal(AudioUtils.meterLevel(-1), 0);
  assert.equal(AudioUtils.meterLevel(0.5), 1);
  assert.equal(AudioUtils.meterLabel(0), "静か");
  assert.equal(AudioUtils.meterLabel(0.02), "小さい音");
  assert.equal(AudioUtils.meterLabel(0.1), "音声受信中");
  assert.equal(AudioUtils.meterLabel(0.3), "大きな音");
});

test("PTT timeout helper stops at three minutes", () => {
  assert.equal(AudioUtils.pttRemainingMs(1000, 1000), 180000);
  assert.equal(AudioUtils.pttRemainingMs(1000, 91000), 90000);
  assert.equal(AudioUtils.pttRemainingMs(1000, 181000), 0);
});
