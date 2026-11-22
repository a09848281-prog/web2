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
const worklet = read("noise-suppressor-processor.js");

test("browser microphone starts automatically when RTC connection is created", () => {
  const connectStart = web.indexOf("async function connect(");
  const connectEnd = web.indexOf("function scheduleReconnect(", connectStart);
  const connect = web.slice(connectStart, connectEnd);
  assert.ok(connect.length > 0);
  assert.match(connect, /void setWebMicEnabled\(true\)/);
  assert.match(connect, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
});

test("Web microphone toggle acquires, attaches and releases the browser audio track", () => {
  const start = web.indexOf("async function setWebMicEnabled(enabled)");
  const end = web.indexOf("async function enableScreenWakeLock()", start);
  const mic = web.slice(start, end);
  assert.ok(mic.length > 0);
  assert.match(mic, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mic, /sender\.replaceTrack\(track\)/);
  assert.match(mic, /sender\?\.replaceTrack\(null\)/);
  assert.match(mic, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(mic, /requestId !== S\.pttRequestId/);
  assert.equal(html.includes('id="pttLock"'), false);
  assert.equal(web.includes("pttLock"), false);
});

test("full-duplex audio keeps Android receive enabled while Web microphone transmits", () => {
  assert.match(web, /track\.enabled = !S\.remoteAudioMuted/);
  const meterStart = web.indexOf("function startAudioMeter()");
  const meterEnd = web.indexOf("function stopAudioMeter()", meterStart);
  const meter = web.slice(meterStart, meterEnd);
  assert.ok(meter.length > 0);
  assert.doesNotMatch(meter, /S\.pttActive/);
});

test("disconnect releases browser microphone before bounded remote acknowledgement and GAS fallback", () => {
  const start = web.indexOf("async function disconnect(");
  const end = web.indexOf("async function loadSettings(", start);
  const disconnect = web.slice(start, end);
  assert.ok(disconnect.indexOf("await setWebMicEnabled(false)") < disconnect.indexOf('sendControlAndWait("disconnect"'));
  assert.match(disconnect, /sendControlAndWait\("disconnect", \{ sessionId \}, 800\)/);
  assert.match(disconnect, /void api\("send_signal"/);
  assert.equal(disconnect.includes('await api("send_signal"'), false);
});

test("screen capture and remote screen control remain absent", () => {
  assert.equal(html.includes('id="screenPane"'), false);
  assert.equal(html.includes('id="screenTab"'), false);
  assert.equal(web.includes("screen_start"), false);
  assert.equal(web.includes("remoteScreen"), false);
  assert.equal(rtc.includes("MediaProjection"), false);
  assert.equal(rtc.includes("ScreenCapturer"), false);
  assert.equal(service.includes("screenRequesters"), false);
  assert.equal(manifest.includes("RemoteControlAccessibilityService"), false);
});

test("notification stop action uses a receiver and does not restart the foreground service", () => {
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

test("Android display-awake is controlled only from Web and confirms successful application", () => {
  assert.match(service, /PowerManager\.SCREEN_BRIGHT_WAKE_LOCK\s+or\s+PowerManager\.ACQUIRE_CAUSES_WAKEUP/);
  assert.match(service, /updateDisplayWakeLock\(false\)/);
  assert.match(service, /\.put\("androidKeepAwake", displayWakeLock\?\.isHeld == true\)/);
  assert.match(service, /if \(!updateDisplayWakeLock\(enabled\)\)/);
  assert.match(web, /sendControlAndWait\("android_keep_awake", \{ enabled: next \}, 2200\)/);
  assert.match(web, /typeof v\.androidKeepAwake === "boolean"/);
  assert.match(html, /id="androidKeepAwake"/);
  assert.doesNotMatch(main, /keepAwakeButton|FLAG_KEEP_SCREEN_ON|ACTION_KEEP_SCREEN_AWAKE_STATE/);
  assert.equal(manifest.includes("android.permission.WAKE_LOCK"), true);
});

test("noise suppression uses a real adjustable Web Audio gate from 0 to 100", () => {
  assert.match(html, /id="micNoise"[^>]*min="0"[^>]*max="100"/);
  assert.match(web, /function setNoiseSuppressionLevel\(value, persist = false\)/);
  assert.match(web, /remote-camera-noise-gate/);
  assert.match(web, /noiseSuppressorNode\.connect\(S\.remoteAnalyser\)/);
  assert.match(worklet, /registerProcessor\("remote-camera-noise-gate"/);
  assert.match(worklet, /if \(this\.strength <= 0\)/);
  assert.match(worklet, /this\.strength = Number\.isFinite\(value\) \? Math\.max\(0, Math\.min\(100, value\)\) : 0/);
  assert.match(rtc, /\.setUseHardwareNoiseSuppressor\(false\)/);
  assert.doesNotMatch(service, /"mic_noise"|setNoiseSuppressionLevel/);
  assert.match(html, /適応ノイズゲート/);
});

test("flashlight requests are tracked and restored after camera switching", () => {
  assert.match(service, /torchRequested/);
  assert.match(service, /registerTorchCallback/);
  assert.match(service, /onTorchModeChanged\(cameraId: String, enabled: Boolean\)/);
  assert.match(service, /sortedByDescending \{ it == selectedId \}/);
  assert.doesNotMatch(service, /Torch restore after camera switch/);\n  assert.match(service, /if \(enabled\) torchRequested = false/);
  assert.match(service, /activeTorchCameraId/);
  assert.match(service, /CameraAccessException\.CAMERA_IN_USE/);
  assert.match(service, /\.put\("flashEnabled",torchEnabled\)/);
});

test("zoomed video can be dragged in both directions and reset", () => {
  assert.match(web, /function startViewerPan\(/);
  assert.match(web, /function moveViewerPan\(/);
  assert.match(web, /translate\(" \+ S\.zoomPanX/);
  assert.match(web, /pointerdown", startViewerPan/);
  assert.match(web, /pointermove", moveViewerPan/);
  assert.match(web, /S\.zoomPanX = 0; S\.zoomPanY = 0/);
  assert.match(html, /ドラッグして表示位置を移動できます/);
});

test("v2.6.1 Android, PWA and service-worker versions stay synchronized", () => {
  const build = read("android/app/build.gradle.kts");
  const config = read("config.json");
  const sw = read("sw.js");
  const pwa = JSON.parse(read("manifest.webmanifest"));
  assert.match(build, /versionCode = 428/);
  assert.match(build, /versionName = "2\.6\.1-preview"/);
  assert.match(build, /applicationId = "jp\.a09848281\.remotecamera\.v26"/);
  assert.match(config, /"appVersion": "2\.6\.1-preview"/);
  assert.match(sw, /v2-6-1/);
  assert.match(sw, /noise-suppressor-processor\.js/);
  assert.equal(pwa.name, "Remote Camera Web2 v2.6.1 Preview");
});
