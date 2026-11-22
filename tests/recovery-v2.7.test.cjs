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


test("first-ever connection attempt is retried while the user has auto-connect armed", () => {
  assert.match(web, /autoConnectWanted: S\.autoConnectWanted/);
  assert.match(web, /S\.autoConnectWanted = true/);
  assert.match(web, /if \(RemoteCameraRecovery\.shouldRetry\(/);
  assert.match(web, /S\.autoConnectWanted = false/);
});

test("Web reservation checks seconds and runs a live scheduler", () => {
  assert.match(html, /id="reserveAt" type="datetime-local" step="1"/);
  assert.match(web, /S\.reservationTimer = setInterval\(checkConnectionReservation, 250\)/);
  assert.match(web, /function checkConnectionReservation\(\)/);
  assert.match(web, /S\.autoConnectWanted = true/);
});

test("Web UI exposes synchronized APK schedule timestamps", () => {
  for (const id of ["androidScheduleStart", "androidScheduleEnd", "androidScheduleStatus", "refreshAndroidSchedule"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(web, /function renderAndroidSchedule\(/);
});


test("first ICE/DataChannel failure retries even before the first successful connection", () => {
  assert.match(web, /S\.everConnected \|\| S\.autoConnectWanted/);
  assert.match(web, /S\.autoConnectWanted: S\.autoConnectWanted/);
});

test("second precision Web and APK schedule sync path exists", () => {
  assert.match(html, /datetime-local" step="1"/);
  assert.match(web, /setInterval\(checkConnectionReservation, 250\)/);
  assert.match(web, /api\("get_settings"/);
  assert.match(service, /save_device_schedule/);
});

test("Camera2 flashlight is integrated into the active video capture request", () => {
  const torchState = fs.readFileSync("android/app/src/main/java/org/webrtc/RemoteTorchState.java", "utf8");
  const torchSession = fs.readFileSync("android/app/src/main/java/org/webrtc/RemoteTorchCamera2Session.java", "utf8");
  assert.match(rtc, /RemoteTorchCamera2Capturer/);
  assert.match(torchSession, /FLASH_MODE_TORCH/);
  assert.match(torchState, /ready = new CountDownLatch\(1\)/);
});

test("requested FPS choices 40, 45, 50 and 55 are present in Web and APK settings", () => {
  for (const fps of ["40", "45", "50", "55"]) {
    assert.match(html, new RegExp(`option value="${fps}"`));
    assert.match(fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8"), new RegExp(`${fps} FPS`));
  }
});
