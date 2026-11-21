const test = require("node:test");
const assert = require("node:assert/strict");
const MotionCore = require("../motion-core.js");

test("converts RGBA to perceptual luma", () => {
  const actual = MotionCore.toLumaPixels(new Uint8Array([
    255, 255, 255, 255,
    0, 0, 0, 255
  ]));
  assert.deepEqual([...actual], [255, 0]);
});

test("detects local scene movement", () => {
  const previous = new Uint8Array(100).fill(80);
  const current = previous.slice();
  current.fill(160, 0, 12);
  const measured = MotionCore.measure(previous, current, 3);
  assert.equal(measured.valid, true);
  assert.equal(measured.changedPixels, 12);
  assert.equal(measured.score, 12);
  assert.ok(measured.score >= MotionCore.minimumScore(3));
});

test("ignores a near-uniform automatic exposure change", () => {
  const previous = new Uint8Array(100).fill(50);
  const current = new Uint8Array(100).fill(90);
  const measured = MotionCore.measure(previous, current, 1);
  assert.equal(measured.score, 0);
  assert.ok(measured.averageDelta > 20);
});

test("filters small sensor noise and sensitivity is ordered", () => {
  const previous = new Uint8Array(100).fill(100);
  const current = new Uint8Array(100).fill(105);
  assert.equal(MotionCore.measure(previous, current, 1).score, 0);
  assert.ok(MotionCore.minimumScore(1) < MotionCore.minimumScore(5));
});

test("rejects invalid pixel buffers safely", () => {
  assert.throws(() => MotionCore.toLumaPixels(new Uint8Array([1, 2, 3])), TypeError);
  assert.equal(MotionCore.measure(new Uint8Array(2), new Uint8Array(3), 3).valid, false);
});
