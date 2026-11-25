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
  assert.match(mic, /sender\.replaceTrack\(null\)/);
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
  assert.match(disconnect, /sendControlAndWait\("disconnect", \{ sessionId, keepRecovery \}, 800\)/);
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

test("Android display-awake control is disabled in current Web client", () => {
  assert.match(service, /PowerManager\.SCREEN_BRIGHT_WAKE_LOCK\s+or\s+PowerManager\.ACQUIRE_CAUSES_WAKEUP/);
  assert.match(service, /updateDisplayWakeLock\(false\)/);
  assert.match(html, /id="androidKeepAwake"/);
  assert.match(html, /スリープ制御 無効/);
  assert.doesNotMatch(web, /android_keep_awake|toggleAndroidKeepAwake|S\.androidKeepAwake/);
  assert.doesNotMatch(main, /keepAwakeButton|FLAG_KEEP_SCREEN_ON|ACTION_KEEP_SCREEN_AWAKE_STATE/);
  assert.equal(manifest.includes("android.permission.WAKE_LOCK"), true);
});

test("noise suppression uses a real adjustable Web Audio gate from 0 to 100", () => {
  assert.match(html, /id="micNoise"[^>]*min="0"[^>]*max="100"/);
  assert.match(web, /function setNoiseSuppressionLevel\(value, persist = false\)/);
  assert.match(web, /remote-camera-noise-gate/);
  assert.match(web, /suppressor\.connect\(S\.remoteAnalyser\)/);
  assert.match(worklet, /registerProcessor\("remote-camera-noise-gate"/);
  assert.match(worklet, /if \(this\.strength <= 0\)/);
  assert.match(worklet, /this\.strength = Number\.isFinite\(value\) \? Math\.max\(0, Math\.min\(100, value\)\) : 0/);
  assert.match(rtc, /\.setUseHardwareNoiseSuppressor\(false\)/);
  assert.doesNotMatch(service, /"mic_noise"|setNoiseSuppressionLevel/);
  assert.match(html, /適応ノイズゲート/);
});

test("flashlight is controlled by the active Camera2 video capture request", () => {
  const torchState = read("android/app/src/main/java/org/webrtc/RemoteTorchState.java");
  const torchSession = read("android/app/src/main/java/org/webrtc/RemoteTorchCamera2Session.java");
  assert.match(rtc, /torchRequested = enabled/);
  assert.match(rtc, /TorchCaptureControl/);
  assert.match(rtc, /setTorchEnabled\(false\)/);
  assert.match(service, /engine\.setTorchEnabled\(enabled\)/);
  assert.match(torchState, /setRepeatingRequest/);
  assert.match(torchSession, /FLASH_MODE_TORCH/);
  assert.match(service, /\.put\("flashEnabled",torchEnabled\)/);
  const cameraStart = service.indexOf('"camera" -> {');
  const torchStart = service.indexOf('"torch" -> setTorch', cameraStart);
  const cameraBlock = service.slice(cameraStart, torchStart);
  assert.doesNotMatch(cameraBlock, /delay\(|setTorch\(true\)/,
    "A failed flashlight request must not switch on unexpectedly after a later camera flip");
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

test("v2.8.6 lock-screen and battery forecast preview stays synchronized", () => {
  const build = read("android/app/build.gradle.kts");
  const config = read("config.json");
  const sw = read("sw.js");
  const pwa = JSON.parse(read("manifest.webmanifest"));
  assert.ok(build.includes("versionCode = 435"));
  assert.ok(build.includes('versionName = "2.8.6-preview"'));
  assert.ok(build.includes('applicationId = "jp.a09848281.remotecamera.v31"'));
  assert.ok(config.includes('"appVersion": "2.8.8-preview"'));
  assert.ok(sw.includes("v2-8-8"));
  assert.ok(sw.includes("noise-suppressor-processor.js"));
  assert.equal(pwa.name, "Remote Camera Web2 v2.8.8 Preview");
});

test("v2.8.6 preserves RTC during lock-screen camera contention and exposes independent battery target", () => {
  const rtc = read("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt");
  const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
  const web = read("app.js");
  const html = read("index.html");
  assert.ok(rtc.includes("CameraVideoCapturer.CameraEventsHandler"));
  assert.ok(rtc.includes("scheduleCameraRecovery("));
  assert.ok(rtc.includes("RemoteTorchCamera2Capturer(context, cameraId, cameraEventsHandler)"));
  assert.ok(service.includes("cameraRecoveryActive"));
  assert.ok(service.includes("battery_forecast_target"));
  assert.ok(service.includes("BATTERY_PROPERTY_CHARGE_COUNTER"));
  assert.ok(service.includes("BATTERY_PROPERTY_CURRENT_AVERAGE"));
  assert.ok(service.includes("covariance / variance"));
  assert.ok(web.includes("batteryForecastTarget"));
  assert.ok(web.includes("cameraRecoveryActive"));
  assert.ok(html.includes('id="batteryForecastTarget"'));
});
test("Android camera, capture and viewer all expose independent real FPS measurements", () => {
  const rtc = read("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt");
  const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
  const cameraSession = read("android/app/src/main/java/org/webrtc/RemoteTorchCamera2Session.java");
  assert.match(rtc, /private val captureFpsMonitor = object : VideoSink/);
  assert.match(rtc, /addSink\(captureFpsMonitor\)/);
  assert.match(rtc, /\.removeSink\(captureFpsMonitor\)/);
  assert.match(rtc, /\.put\("measuredFps",/);
  assert.match(rtc, /\.put\("frameAgeMs",/);
  assert.match(service, /\.put\("captureMeasuredFps", capture\.optInt\("measuredFps"/);
  assert.match(service, /\.put\("captureFrameAgeMs", capture\.optLong\("frameAgeMs"/);
  assert.match(cameraSession, /Selected target FPS range/);
  assert.match(cameraSession, /range\.min == targetMilliFps && range\.max == targetMilliFps/);
  assert.match(cameraSession, /Electronic stabilization disabled to prioritize 30\+ FPS/);
  assert.match(web, /decodedVideoFrames/);
  assert.match(web, /S\.viewerReceiveFps/);
  assert.match(web, /Web受信 /);
});

test("normal thermal protection preserves up to 30 FPS and reduces resolution first", () => {
  const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
  assert.match(service, /lowBattery = percent in 0\.\.10 && !charging/);
  assert.match(service, /criticalThermal = thermal >= PowerManager\.THERMAL_STATUS_CRITICAL/);
  assert.match(service, /currentQuality = if \(criticalThermalProtection\) "360" else "480"/);
  assert.match(service, /minOf\(currentFps, 30\)/);
  assert.match(service, /minOf\(currentFps, 20\)/);
  assert.doesNotMatch(service, /currentFps = 10\s*\n\s*\}/);
});

test("stalled WebRTC setup is bounded, invalidated and retried without stacked timers", () => {
  assert.match(web, /connectionAttemptWatchdog/);
  assert.match(web, /abortStalledConnectAttempt\(attemptId\)/);
  assert.match(web, /assertConnectAttempt\(attemptId, device\.deviceId\)/);
  assert.match(web, /withTimeout\(pc\.createOffer\(\), 8000/);
  assert.match(web, /withTimeout\(pc\.setLocalDescription\(offer\), 8000/);
  assert.match(web, /function api\(action, data = \{\}, timeoutMs = null\)/);
  assert.match(web, /consecutiveFailures >= 3/);
  assert.match(web, /if \(S\.connecting\) \{/);
  assert.ok(web.includes("++S.connectionAttemptId"));
  const disconnect = web.slice(web.indexOf("async function disconnect("), web.indexOf("async function loadSettings("));
  assert.match(disconnect, /S\.connectionAttemptWatchdog = null/);
  assert.match(disconnect, /S\.connecting = false/);
});

test("Android signaling polling has strict network timeouts", () => {
  const api = read("android/app/src/main/java/jp/a09848281/remotecamera/ApiClient.kt");
  const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
  assert.match(api, /connectTimeoutMs: Int = 15000/);
  assert.match(api, /readTimeoutMs: Int = 20000/);
  assert.match(service, /10000,\s*12000\s*\)/);
});
