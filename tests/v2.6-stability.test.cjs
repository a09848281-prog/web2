const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const read = path => fs.readFileSync(path, "utf8");
const web = read("app.js");
const html = read("index.html");
const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
const rtc = read("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt");
const main = read("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const stopReceiver = read("android/app/src/main/java/jp/a09848281/remotecamera/StopMonitoringReceiver.kt");

test("RTC connect does not request a browser microphone", () => {
  const connect = web.slice(web.indexOf("async function connect("), web.indexOf("function scheduleReconnect("));
  assert.ok(connect.length > 0);
  assert.equal(connect.includes("getUserMedia"), false);
  assert.match(connect, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
});

test("PTT obtains a track only after press and stops it after release", () => {
  const ptt = web.slice(web.indexOf("async function ptt(enabled)"), web.indexOf("function togglePttLock("));
  assert.match(ptt, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(ptt, /S\.micSender\.replaceTrack\(track\)/);
  assert.match(ptt, /S\.micSender\?\.replaceTrack\(null\)/);
  assert.match(ptt, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(ptt, /pttRequestId/);
});

test("disconnect releases PTT before a bounded Android acknowledgement and does not wait for GAS", () => {
  const disconnect = web.slice(web.indexOf("async function disconnect("), web.indexOf("async function loadSettings("));
  assert.ok(disconnect.indexOf("await ptt(false)") < disconnect.indexOf('sendControlAndWait("disconnect"'));
  assert.match(disconnect, /sendControlAndWait\("disconnect", \{ sessionId \}, 800\)/);
  assert.match(disconnect, /void api\("send_signal"/);
  assert.equal(disconnect.includes("await api(\"send_signal\""), false);
});

test("screen capture and remote screen control are absent", () => {
  assert.equal(html.includes('id="screenPane"'), false);
  assert.equal(html.includes('id="screenTab"'), false);
  assert.equal(web.includes("screen_start"), false);
  assert.equal(web.includes("remoteScreen"), false);
  assert.equal(rtc.includes("MediaProjection"), false);
  assert.equal(rtc.includes("ScreenCapturer"), false);
  assert.equal(service.includes("screenRequesters"), false);
  assert.equal(manifest.includes("RemoteControlAccessibilityService"), false);
});

test("notification stop action uses a receiver and never restarts the foreground service", () => {
  assert.match(service, /getBroadcast\(/);
  assert.match(service, /待機を停止/);
  assert.match(service, /StopMonitoringReceiver::class\.java/);
  assert.match(stopReceiver, /stopService\(/);
  assert.match(stopReceiver, /putBoolean\("monitoringEnabled", false\)/);
  assert.match(manifest, /\.StopMonitoringReceiver/);
});

test("cancelled polling cannot repost the initial startup failure notification", () => {
  assert.match(service, /catch \(cancelled: CancellationException\)/);
  assert.match(service, /if \(!prefs\.getBoolean\("monitoringEnabled", false\)\)/);
  const notifyState = service.slice(service.indexOf("private fun notifyState("), service.indexOf("private suspend fun pollLoop("));
  assert.match(notifyState, /if \(!prefs\.getBoolean\("monitoringEnabled", false\)\)/);
  assert.match(notifyState, /cancel\(NOTIFICATION_ID\)/);
});

test("Android display-awake control is reversible and service-owned", () => {
  assert.match(service, /PowerManager\.SCREEN_DIM_WAKE_LOCK/);
  assert.match(service, /ACTION_DISPLAY_AWAKE/);
  assert.match(service, /updateDisplayWakeLock\(false\)/);
  assert.match(main, /FLAG_KEEP_SCREEN_ON/);
  assert.match(main, /ACTION_KEEP_SCREEN_AWAKE_STATE/);
  assert.match(web, /sendControl\("android_keep_awake"/);
  assert.match(html, /id="androidKeepAwake"/);
});

test("noise suppression slider maps 0 to off and sends live 0-100 values", () => {
  assert.match(html, /id="micNoise"[^>]*min="0"[^>]*max="100"/);
  assert.match(web, /sendControl\("mic_noise", \{ strength: Number\(\$\("micNoise"\)\.value\) \}\)/);
  assert.match(service, /setNoiseSuppressionLevel\(strength\)/);
  assert.match(rtc, /noiseSuppressionLevel > 0/);
  assert.match(rtc, /module\.setNoiseSuppressorEnabled\(enabled\)/);
});

test("flashlight OFF is idempotent and transient capability errors are retried", () => {
  assert.match(service, /if \(!enabled && !torchEnabled\)/);
  assert.match(service, /activeTorchCameraId/);
  assert.match(service, /flashAvailableCache = null/);
  assert.match(service, /CameraAccessException\.CAMERA_IN_USE/);
});

test("Android version, PWA version and fresh cache stay synchronized", () => {
  assert.match(read("android/app/build.gradle.kts"), /versionCode = 427/);
  assert.match(read("android/app/build.gradle.kts"), /applicationId = "jp\\.a09848281\\.remotecamera\\.v26"/);
  assert.match(read("android/app/build.gradle.kts"), /versionName = "2\.6\.0-preview"/);
  assert.match(read("config.json"), /"appVersion": "2\.6\.0-preview"/);
  assert.match(read("sw.js"), /v2-6-0/);
  assert.match(read("manifest.webmanifest"), /Remote Camera Web2 v2\.6 Preview/);
});
