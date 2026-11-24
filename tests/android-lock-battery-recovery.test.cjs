const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const main = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8");
const build = fs.readFileSync("android/app/build.gradle.kts", "utf8");
const web = fs.readFileSync("app.js", "utf8");

test("Android app resume requests a health check without stopping active monitoring", () => {
  const resume = main.slice(main.indexOf("override fun onResume()"), main.indexOf("override fun onPause()"));
  assert.match(resume, /if \(prefs\.getBoolean\("monitoringEnabled", false\)\)/);
  assert.match(resume, /ACTION_ACTIVITY_RESUMED/);
  assert.match(service, /if \(action == ACTION_ACTIVITY_RESUMED\)/);
  const handler = service.slice(service.indexOf("if (action == ACTION_ACTIVITY_RESUMED)"), service.indexOf("if (action == ACTION_REFRESH_CODE)"));
  assert.match(handler, /rtc\?\.recoverCameraIfStalled\(force = true\)/);
  assert.doesNotMatch(handler, /rtc\?\.dispose\(\)|closeSession\(|stopMonitoringNow/);
});

test("Camera2 error, disconnect and freeze events are observed", () => {
  assert.match(rtc, /CameraVideoCapturer\.CameraEventsHandler/);
  assert.match(rtc, /override fun onCameraError/);
  assert.match(rtc, /override fun onCameraDisconnected/);
  assert.match(rtc, /override fun onCameraFreezed/);
  assert.match(rtc, /RemoteTorchCamera2Capturer\(context, cameraId, cameraEventsHandler\)/);
});

test("camera watchdog replaces only the capturer and retains live WebRTC peer state", () => {
  assert.match(service, /rtc\?\.recoverCameraIfStalled\(\)/);
  const start = rtc.indexOf("fun recoverCameraIfStalled(");
  const recovery = rtc.slice(start, rtc.indexOf("fun captureInfo()", start));
  assert.match(recovery, /oldCapturer\?\.stopCapture\(\)/);
  assert.match(recovery, /oldCapturer\?\.dispose\(\)/);
  assert.match(recovery, /startCaptureWithFallback\(/);
  assert.doesNotMatch(recovery, /peers\.clear\(|controlChannels\.clear\(|peer\.close\(\)|factory\?\.dispose/);
  for (const delay of ["5000L", "10000L", "20000L", "30000L"]) assert.ok(recovery.includes(delay));
});

test("secure keyguard defers local camera retries without closing the RTC connection", () => {
  assert.match(rtc, /KeyguardManager/);
  assert.match(rtc, /isKeyguardLocked == true\) return false/);
  const start = rtc.indexOf("fun recoverCameraIfStalled(");
  const recovery = rtc.slice(start, rtc.indexOf("fun captureInfo()", start));
  assert.doesNotMatch(recovery, /PeerConnection\.close|peer\.close|closeSession|dispose\(\)/);
});

test("battery forecast uses charge counter and current where available, with percentage fallback", () => {
  assert.match(service, /BATTERY_PROPERTY_CHARGE_COUNTER/);
  assert.match(service, /BATTERY_PROPERTY_CURRENT_AVERAGE/);
  assert.match(service, /BATTERY_PROPERTY_CURRENT_NOW/);
  assert.match(service, /estimateBatteryMinutesFromCurrent_/);
  assert.match(service, /estimateBatteryMinutesFromLevel_/);
  assert.match(service, /batteryForecastMethod/);
  assert.match(service, /batteryForecastCurrentMa/);
  assert.match(service, /batteryForecastChargeMah/);
  assert.match(web, /電流データ取得中/);
  assert.match(web, /残量変化を測定中/);
});

test("charging resets discharge samples and the forecast target respects the cutoff", () => {
  const start = service.indexOf("private fun recordBatterySampleAndEstimate(");
  const end = service.indexOf("private fun evaluateBatteryStandby(", start);
  const estimate = service.slice(start, end);
  assert.match(estimate, /if \(charging\)/);
  assert.match(estimate, /remove\("batteryDischargeSamples"\)/);
  assert.match(estimate, /batteryCutoffPercent/);
  assert.match(service, /batteryEstimateMinutes = recordBatterySampleAndEstimate/);
});

test("v2.8.6 package is isolated from previous installs", () => {
  assert.match(build, /versionCode = 435/);
  assert.match(build, /versionName = "2\.8\.6-preview"/);
  assert.match(build, /applicationId = "jp\.a09848281\.remotecamera\.v31"/);
});
