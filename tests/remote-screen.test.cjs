const test = require("node:test");
const assert = require("node:assert/strict");
const Screen = require("../remote-screen-utils.js");

test("maps points through object-fit contain without letterbox offsets", () => {
  const rect = { left: 10, top: 20, width: 400, height: 400 };
  assert.deepEqual(Screen.mapPoint(rect, 1600, 900, 210, 220), { x: 800, y: 450 });
  assert.equal(Screen.mapPoint(rect, 1600, 900, 200, 25), null);
});

test("clamps mapped edge coordinates to the video frame", () => {
  const rect = { left: 0, top: 0, width: 1600, height: 900 };
  assert.deepEqual(Screen.mapPoint(rect, 1600, 900, 1600, 900), { x: 1599, y: 899 });
});

test("classifies taps, long presses and swipes", () => {
  assert.equal(Screen.classifyGesture({x:10,y:10},{x:12,y:12},100,false).type, "tap");
  assert.equal(Screen.classifyGesture({x:10,y:10},{x:10,y:10},700,false).type, "long_press");
  assert.equal(Screen.classifyGesture({x:10,y:10},{x:80,y:10},200,true).type, "swipe");
});

test("limits remote text and removes control characters", () => {
  assert.equal(Screen.sanitizeText("A\u0000B"), "AB");
  assert.equal(Screen.sanitizeText("x".repeat(500)).length, 300);
});

test("fits portrait phone screen ratio inside iPad viewport bounds", () => {
  const fitted = Screen.fitStageSize(900, 700, 1080, 2400);
  assert.deepEqual(fitted, { width: 315, height: 700, aspectRatio: "1080 / 2400" });
});

test("fits landscape phone screen ratio without exceeding either bound", () => {
  const fitted = Screen.fitStageSize(1000, 500, 2400, 1080);
  assert.deepEqual(fitted, { width: 1000, height: 450, aspectRatio: "2400 / 1080" });
});

test("rejects invalid viewport or display dimensions", () => {
  assert.equal(Screen.fitStageSize(0, 500, 1080, 2400), null);
  assert.equal(Screen.fitStageSize(800, 500, 1080, 0), null);
});
