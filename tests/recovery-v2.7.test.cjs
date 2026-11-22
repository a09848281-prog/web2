const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const web = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");

test("Web recovery handles DataChannel loss, ICE failure, setup timeout and frozen video", () => {
  assert.match(web, /scheduleReconnect\(pc, true, 450, "datachannel"\)/);
  assert.match(web, /const reason = state === "failed" \? "failed" : "disconnected"/);
  assert.match(web, /setup-timeout/);
  assert.match(web, /video-stalled/);
  assert.match(web, /addEventListener\("online"/);
  assert.match(web, /addEventListener\("visibilitychange"/);
});

test("retry has no fixed attempt ceiling and manual disconnect prevents reconnect", () => {
  assert.match(web, /RemoteCameraRecovery\.shouldRetry/);
  assert.match(web, /RemoteCameraRecovery\.retryDelay/);
  assert.doesNotMatch(web, /自動再接続を5回試しました/);
  assert.match(web, /S\.manualDisconnect = true/);
  assert.match(web, /S\.reconnectTimer\) return/);
});

test("connection setup timeout clears after a healthy channel and when disconnecting", () => {
  assert.match(web, /armConnectionTimeout\(pc\)/);
  assert.match(web, /markRtcStable\(pc\)/);
  assert.match(web, /clearConnectionTimeout\(old\)/);
});

test("Android polls for a replacement offer every second during bounded recovery", () => {
  assert.match(service, /recoveryPollUntil/);
  assert.match(service, /recoveryActive/);
  assert.match(service, /1000L - elapsed/);
  assert.match(service, /System\.currentTimeMillis\(\) \+ 45000L/);
});

test("Android reports DataChannel close to the service recovery handler", () => {
  assert.match(rtc, /DataChannel\.State\.CLOSED/);
  assert.match(rtc, /DATA_CHANNEL_CLOSED/);
  assert.match(service, /"DATA_CHANNEL_CLOSED"/);
});

test("wide-camera selector compares Camera2 field of view and needs multiple rear camera IDs", () => {
  assert.match(rtc, /SENSOR_INFO_PHYSICAL_SIZE/);
  assert.match(rtc, /horizontalFovDegrees/);
  assert.match(html, /id="wideCameraButton"/);
  assert.match(web, /rear\.length < 2/);
});
