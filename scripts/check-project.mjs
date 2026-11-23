import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("index.html", "utf8");
const js = fs.readFileSync("app.js", "utf8");
const noiseProcessor = fs.readFileSync("noise-suppressor-processor.js", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const main = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8");
const schedule = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/ScheduleReceiver.kt", "utf8");
const torchState = fs.readFileSync("android/app/src/main/java/org/webrtc/RemoteTorchState.java", "utf8");
const torchSession = fs.readFileSync("android/app/src/main/java/org/webrtc/RemoteTorchCamera2Session.java", "utf8");
const apiClient = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/ApiClient.kt", "utf8");
const gas = fs.readFileSync("gas/Code.gs", "utf8");
const config = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/Config.kt", "utf8");
const motionCore = fs.readFileSync("motion-core.js", "utf8");
const recoveryCore = fs.readFileSync("recovery-core.js", "utf8");
const motionTests = fs.readFileSync("tests/motion-core.test.cjs", "utf8");
const audioUtils = fs.readFileSync("audio-utils.js", "utf8");
const audioTests = fs.readFileSync("tests/audio-utils.test.cjs", "utf8");
const locationUtils = fs.readFileSync("location-utils.js", "utf8");
const locationTests = fs.readFileSync("tests/location-utils.test.cjs", "utf8");
const androidBuild = fs.readFileSync("android/app/build.gradle.kts", "utf8");
const serviceWorker = fs.readFileSync("sw.js", "utf8");
const webConfig = fs.readFileSync("config.json", "utf8");
const manifestJson = JSON.parse(fs.readFileSync("manifest.webmanifest", "utf8"));

const htmlIdMatches = [...html.matchAll(/\bid=["']([^"']+)["']/g)];
const htmlIds = new Set(htmlIdMatches.map(match => match[1]));
assert.equal(htmlIds.size, htmlIdMatches.length, "Duplicate HTML id attributes detected");
const referencedIds = [...new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map(match => match[1]))];
for (const id of referencedIds) {
  assert.ok(htmlIds.has(id), "JavaScript references missing HTML id: " + id);
}

for (const id of ["micNoise", "micSensitivity", "micGain", "androidSpeakerVolume", "androidSpeakerVolumeValue", "receiveVolume", "receiveVolumeValue", "micMode", "audioLevel", "audioLevelText", "remoteMute", "keepAwake", "fitMode", "videoState", "audioState", "cameraFacing", "flashState", "connectionMetrics", "gasTiming", "sessionDuration", "deviceInfo", "deviceInfoDialog", "deviceInfoOutput", "followLocation", "copyCoordinates", "diagnostics", "deviceTotal", "networkSummary", "deviceHealth", "deviceTxSpeed", "deviceRxSpeed", "torch", "reserveConnection", "cancelReservation", "reservationStatus", "androidScheduleStart", "androidScheduleEnd", "androidScheduleStatus", "refreshAndroidSchedule", "fps", "aspectRatio", "fullscreen", "bookmarkletOpen", "bookmarkletCode", "bookmarkDialog", "copyBookmarklet", "zoom", "zoomValue", "zoomReset", "motionEnabled", "motionSensitivity", "motionNotify", "motionHistory", "motionExport", "motionClear", "motionDialog", "motionRows", "motionStatus"]) {
  assert.ok(html.includes('id="' + id + '"'), "Missing HTML element: " + id);
  assert.ok(js.includes('$("' + id + '")'), "Missing JavaScript reference: " + id);
}
assert.ok(js.includes('createDataChannel("remote-control"'), "Web must create control DataChannel");
assert.ok(js.includes("function sendControl("), "Web DataChannel sender missing");
assert.ok(js.includes("function checkConnectionReservation("), "Connection reservation scheduler missing");
assert.ok(js.includes("function toggleFullscreen("), "Fullscreen handler missing");
assert.ok(js.includes("function openBookmarkletDialog("), "Bookmarklet generator missing");
assert.ok(js.includes("function handleQuickLaunch("), "Bookmarklet quick launch handler missing");
assert.ok(js.includes("applyAspectRatio("), "Aspect ratio selector handler missing");
assert.ok(js.includes("function scheduleReconnect("), "Automatic reconnect handler missing");
assert.ok(js.includes("function startMotionDetection("), "Motion detector missing");
assert.ok(js.includes("function loadMotionHistory("), "Motion event history UI missing");
assert.ok(js.includes("function exportMotionCsv("), "Motion CSV export missing");
assert.ok(js.includes("function maybeAdaptQuality("), "Adaptive quality policy missing");
assert.ok(js.includes('api("get_ice_config"'), "Web TURN configuration fetch missing");
assert.ok(js.includes("function applyViewerZoom("), "Viewer zoom control missing");
assert.ok(js.includes("function attachRemoteAudio("), "Web Audio receive routing missing");
assert.ok(js.includes("createGain()"), "Web Audio receive volume gain missing");
assert.ok(js.includes("function setReceiveVolume("), "0-200% receive volume control missing");
assert.ok(js.includes("function startAudioMeter("), "Incoming audio meter missing");
assert.ok(html.includes("./location-utils.js"), "RTC location helper must be loaded before app.js");
assert.ok(serviceWorker.includes("location-utils.js"), "Location helper must be precached by the PWA service worker");
assert.ok(js.includes('d.type==="location_update"'), "Web RTC location update receiver missing");
assert.ok(js.includes("LocationUtils.normalizeLiveLocation"), "Incoming RTC coordinates must be validated");
assert.ok(js.includes('S.control?.readyState !== "open"'), "GAS map polling must be fallback-only while RTC is open");
assert.ok(locationUtils.includes("function normalizeLiveLocation("), "RTC location validation helper missing");
assert.ok(locationUtils.includes("function mergeHistory("), "Location history merge helper missing");
assert.ok(locationTests.includes("supports Unix timestamps in seconds"), "Location timestamp compatibility test missing");
assert.equal([...js.matchAll(/function\s+setWebMicEnabled\s*\(/g)].length, 1, "Only one browser microphone toggle must exist");
assert.ok(js.includes("setWebMicEnabled(false)") && js.includes("visibilitychange"), "Web microphone must stop on background or RTC failure");
assert.ok(js.includes("function updateWebMicrophoneButton("), "Persistent Web microphone button missing");
assert.ok(js.includes("disconnect(false, automatic, true, automatic)"), "Automatic reconnect must replace the previous RTC session");
assert.ok(js.includes("notifyRemote = sendCommand"), "Disconnect must support remote session cleanup independently from manual stop");
assert.ok(js.includes("function showVideo()") && js.includes("restoreRemotePlayback();"), "Returning from map must restore video playback");
assert.ok(js.includes("setWebMicEnabled(false)") && js.includes("visibilitychange") && js.includes("S.pttActive || S.pttRequested || S.pttStarting"), "Web microphone and pending permission prompts must stop when the page is backgrounded");
assert.ok(!js.includes("togglePttLock") && !js.includes("180000"), "Old push-to-talk lock and timeout must be removed");
assert.ok(js.includes("function startVideoWatchdog("), "Video frame watchdog missing");
assert.ok(js.includes("function restoreRemotePlayback("), "Fullscreen playback recovery missing");
assert.ok(js.includes("function startSessionClock("), "Connection duration counter missing");
assert.ok(js.includes("performance.now()"), "GAS request latency measurement missing");
assert.ok(js.includes("S.apiVersion"), "GAS API version compatibility warning missing");
assert.ok(js.includes("function toggleFitMode("), "Fit/fill video display mode missing");
assert.ok(js.includes("function toggleLocationFollow("), "Latest location follow toggle missing");
assert.ok(js.includes("function copyCoordinates("), "Coordinate clipboard action missing");
assert.ok(js.includes("function refreshLatestLocation("), "Automatic latest location refresh missing");
assert.ok(js.includes("function renderDeviceInfo("), "Device detail display missing");
assert.ok(js.includes("S.locationRefreshTimer = setInterval"), "Map location periodic refresh missing");
assert.ok(js.includes("function updateLocationActions("), "Map follow/copy availability UI missing");
assert.ok(audioUtils.includes("function clampReceivePercent("), "Receive audio gain clamping missing");
assert.ok(audioUtils.includes("function rmsFromTimeDomain("), "Audio RMS level calculation missing");
assert.ok(audioTests.includes("PTT timeout helper stops at three minutes"), "PTT timer unit test missing");
assert.ok(audioTests.includes("receive gain is clamped from 0 to 200 percent"), "Receive volume bounds unit test missing");
assert.ok(js.includes("S.connecting = true"), "WebRTC connection setup lock missing");
assert.ok(js.includes("if (S.pc !== pc) return;"), "Stale PeerConnection callbacks must be ignored");
assert.ok(js.includes("motionPendingKey(targetDeviceId)"), "Motion event retry queue must be device scoped");
assert.ok(js.includes("text = \"'\" + text"), "CSV formula injection protection missing");

assert.ok(js.includes("disconnect(false, automatic, true, automatic)"), "Automatic reconnect must replace the previous RTC session without a manual bye");
assert.ok(js.includes("if (!keepRecovery)"), "Automatic reconnect must not disable Android recovery polling");
assert.ok(!js.includes('window.addEventListener("pagehide"'), "Page backgrounding must not send a forced disconnect");
assert.ok(js.includes("AUTO_RECONNECT_PREFIX") && js.includes("resumeSavedConnectionIntent()"), "Reconnect intent must survive a PWA reload");
assert.ok(main.includes("https://script.google.com/macros/s/"), "Android config must validate Apps Script deployment URL");
assert.ok(service.includes("https://script.google.com/macros/s/"), "Foreground Service must validate Apps Script deployment URL");
assert.ok(apiClient.includes("https://script.google.com/macros/s/") && apiClient.includes('endsWith("/exec")'), "Android API client must validate exact GAS /exec URL");
assert.ok(js.includes("https://script.google.com/macros/s/") && js.includes('endsWith("/exec")'), "Web app must validate exact GAS /exec URL");
assert.ok(motionCore.includes("function measure("), "Motion pixel comparison missing");
assert.ok(motionCore.includes("averageDelta > 20"), "Exposure-change false-positive filter missing");
assert.ok(motionTests.includes("ignores a near-uniform automatic exposure change"), "Motion exposure unit test missing");
assert.ok(rtc.includes("override fun onDataChannel(channel: DataChannel)"), "Android DataChannel observer missing");
assert.ok(rtc.includes("hasOpenControlChannel()"), "Android DataChannel state check missing");
assert.ok(rtc.includes("peers.size < 3"), "Three-viewer limit missing");
assert.ok(rtc.includes("requestedFps.coerceIn(10, 60)"), "FPS control missing");
assert.ok(rtc.includes("private val captureFpsMonitor = object : VideoSink"), "Actual camera FPS monitor missing");
assert.ok(rtc.includes("addSink(captureFpsMonitor)") && rtc.includes("removeSink(captureFpsMonitor)"), "Actual camera FPS monitor lifecycle missing");
assert.ok(rtc.includes('.put("measuredFps",') && rtc.includes('.put("frameAgeMs",'), "Actual Android capture FPS telemetry missing");
assert.ok(torchSession.includes("Selected target FPS range") &&
  torchSession.includes("range.min == targetMilliFps && range.max == targetMilliFps"),
  "Camera2 must prefer exact fixed frame-rate ranges before variable ranges");
assert.ok(torchSession.includes("Electronic stabilization disabled to prioritize 30+ FPS"),
  "Electronic stabilization should be disabled at high requested FPS");
assert.ok(service.includes('.put("captureMeasuredFps", capture.optInt("measuredFps"') &&
  service.includes('.put("captureFrameAgeMs", capture.optLong("frameAgeMs"'),
  "Android measured camera FPS and frame-age telemetry missing");
assert.ok(service.includes("currentQuality = if (criticalThermalProtection) \"360\" else \"480\"") &&
  service.includes("minOf(currentFps, 30)") && service.includes("minOf(currentFps, 20)"),
  "Thermal protection must reduce resolution first and retain 30 FPS outside critical temperature");
assert.ok(service.includes("10000,\n                        12000") &&
  apiClient.includes("connectTimeoutMs: Int = 15000") && apiClient.includes("readTimeoutMs: Int = 20000"),
  "Android GAS signaling must use bounded network timeouts");

assert.ok(rtc.includes("fun sendCameraCapabilities("), "Camera capability sender missing");
assert.ok(rtc.includes("fun selectCamera(cameraId: String)"), "Selectable camera lens handler missing");
assert.ok(js.includes("camera_capabilities"), "Web camera capability receiver missing");
assert.ok(rtc.includes("stun:stun.l.google.com:19302"), "Android STUN configuration missing");
assert.ok(rtc.includes("fun setIceServers("), "Android dynamic ICE server setup missing");
assert.ok(rtc.includes("private fun failSession("), "RTC failure cleanup missing");
assert.ok(rtc.includes("JavaAudioDeviceModule.builder"), "Android ambient audio device module missing");
assert.ok(rtc.includes("ensureWebRtcInitialized(context.applicationContext)"), "WebRTC native factory initialization must be process-scoped");
assert.ok(rtc.includes("private fun startCaptureWithFallback("), "Aspect-ratio preserving camera format fallback missing");
assert.ok(rtc.includes("source.capturerObserver"), "Capture fallback must use the observer exposed by VideoSource");
assert.ok(!rtc.includes("VideoCapturer.CapturerObserver"), "Do not hard-code version-sensitive WebRTC observer type names");
assert.ok(rtc.includes("private fun fallbackCaptureSizes(cameraId: String)"), "Camera fallback size profiles missing");
assert.ok(rtc.includes("Media startup failed; releasing partial resources"), "Partial camera/ADM startup rollback missing");
assert.ok(rtc.includes("MediaRecorder.AudioSource.MIC"), "Ambient microphone input source missing");
assert.ok(rtc.includes("setUseHardwareAcousticEchoCanceler"), "Selectable hardware AEC handling missing");
assert.ok(rtc.includes("setUseHardwareNoiseSuppressor"), "Selectable hardware noise suppressor handling missing");
assert.ok(rtc.includes("audioDeviceModule?.release()"), "AudioDeviceModule must be released after the factory");
assert.ok(rtc.includes('currentAspectRatio'), "Capture aspect ratio state missing");
assert.ok(rtc.includes('"9:16"'), "Portrait video capture ratio missing");
assert.ok(service.includes("pollIntervalSeconds"), "Custom polling interval missing");
assert.ok(service.includes("delay(250L)"), "Connected polling scheduler must support the one-second interval");
assert.ok(service.includes("sendTelemetry()"), "Android telemetry missing");
assert.ok(service.includes('JSONObject().put("type", "location_update")'), "Android must send fresh location over RTC DataChannel");
assert.ok(service.includes("rtc?.sendControlToOpenDataChannels("), "Android live location must reach each open Web controller");
assert.ok(service.includes("private fun applyLocationSettings("), "Android live location settings handler missing");
assert.ok(service.includes("applyLocationSettings(payload)"), "RTC settings update must apply periodic location preferences immediately");
assert.ok(service.includes('putBoolean("connectedLocationEnabled", connectedLocationEnabled)'), "Connected tracking preference must persist from RTC settings");
assert.ok(service.includes('putLong("idleInterval", idleInterval)'), "Idle tracking interval must persist from RTC settings");
assert.ok(service.includes("cached.time < 5000L"), "Location tracking must not reuse two-minute-old cached coordinates");
assert.ok(service.includes("networkInfo()"), "Network diagnostics missing");
assert.ok(service.includes("setTorch("), "Android flashlight control missing");
assert.ok(service.includes("lastNetworkError"), "Automatic network error diagnostics missing");
assert.ok(service.includes("lastDevicePollAt"), "Additional viewer signaling poll scheduler missing");
assert.ok(service.includes('"adaptive_quality"'), "Android adaptive quality command missing");
assert.ok(service.includes("private fun applyVideoSettings("), "Android persistent quality application missing");
assert.ok(service.includes("START_STICKY"), "Foreground service process recovery policy missing");
assert.ok(service.includes("updateStreamWakeLock("), "Live stream wake lock management missing");
assert.ok(service.includes("powerSaveActive"), "Battery/thermal quality override missing");
assert.ok(service.includes("microphoneMode = prefs.getString"), "Android microphone preset must be loaded for each fresh RTC engine");
assert.ok(service.includes("captureAspectRatio = prefs.getString"), "Android capture ratio must be loaded for each fresh RTC engine");
assert.ok(service.includes("private fun closeRtcViewerSession("), "Empty RTC engines must be released after the last viewer");
assert.ok(service.includes("STREAM_MUSIC"), "PTT return audio must use the media speaker stream");
assert.ok(service.includes("batteryCharging"), "Charging state telemetry missing");
assert.ok(service.includes("cameraFacing"), "Camera facing telemetry missing");
assert.ok(service.includes("flashAvailable"), "Flash availability telemetry missing");
assert.ok(main.includes("1～50秒"), "1-50 second polling interval UI missing");
assert.ok(main.includes("StopMonitoringReceiver.stop(this)"), "Android stop button must call the shared service cleanup path");
assert.ok(service.includes("override fun onDestroy()") && service.includes("rtc?.dispose()"), "Service destruction must dispose RTC resources");
assert.ok(service.includes("updateStreamWakeLock(false)"), "Service shutdown must release its wake lock");
const stopShutdown = service.slice(service.indexOf("private fun stopMonitoringNow"), service.indexOf("private fun notifyState"));
const destroyShutdown = service.slice(service.indexOf("override fun onDestroy()"));
for (const shutdown of [stopShutdown, destroyShutdown]) {
  assert.ok(shutdown.indexOf("rtc?.setTorchEnabled(false)") >= 0 &&
    shutdown.indexOf("rtc?.setTorchEnabled(false)") < shutdown.indexOf("rtc?.dispose()") &&
    shutdown.indexOf("rtc?.dispose()") < shutdown.indexOf("rtc = null"),
    "Active Camera2 capture must switch its in-stream torch off before RTC resources are disposed");
}
assert.ok(service.includes("if (needsPairing)") && service.includes("rtc?.dispose()"), "No-controller state must close orphan camera sessions");
assert.ok(service.includes('val signals = if (needsPairing || batteryStandby) JSONArray()'), "Unpaired and battery-standby states must ignore stale offers");
assert.ok(service.includes('val sessionId = payload.optString("sessionId", "")'), "Disconnect commands must be viewer-session scoped");
assert.ok(js.includes("payload:{sessionId:sessionId}"), "Web disconnect fallback must include its session ID");
assert.ok(js.includes("void api(\"send_signal\""), "Web disconnect must send the GAS bye signal without blocking local cleanup");
assert.ok(js.includes('window.addEventListener("online"'), "Motion metadata must retry after network recovery");
assert.ok(js.includes("S.motion.retryTimer = setInterval"), "Motion metadata must have a periodic retry fallback");
assert.ok(config.includes("POLL_SECONDS = 10L"), "Default polling interval must be 10 seconds");
assert.ok(config.includes("MIN_POLL_SECONDS = 1"), "Minimum polling interval must be 1 second");
assert.ok(config.includes("MAX_POLL_SECONDS = 50"), "Maximum polling interval must be 50 seconds");
assert.ok(gas.includes("Controllers:"), "Multi-controller storage sheet missing");
assert.ok(gas.includes("activeControllerCount_(deviceId) >= 3"), "Three-controller pairing limit missing");
assert.ok(manifest.includes("android.permission.ACCESS_WIFI_STATE"), "Wi-Fi permission missing");
assert.ok(manifest.includes("android.permission.WAKE_LOCK"), "Live stream wake lock permission missing");
assert.ok(androidBuild.includes('versionName = "2.8.4-preview"'), "Android app version must be v2.8.4");
assert.ok(androidBuild.includes("versionCode = 433"), "Android version code must be 433");
assert.ok(androidBuild.includes('applicationId = "jp.a09848281.remotecamera.v29"'), "v2.8 uses a separate package so v2.7 data and install remain intact");
assert.ok(webConfig.includes('"appVersion": "2.8.4-preview"'), "Web config version must be v2.8.4");
assert.ok(html.includes("v2.8.4 Preview"), "PWA display version must be v2.8.4");
assert.ok(serviceWorker.includes('const CACHE = CACHE_PREFIX + "v2-8-4"'), "PWA cache key must be bumped to v2.8.4");
assert.ok(serviceWorker.includes("noise-suppressor-processor.js"), "Audio worklet must be precached");
assert.ok(serviceWorker.includes("key.startsWith(CACHE_PREFIX)"), "Service worker must only delete its own cache namespace");
assert.ok(!serviceWorker.includes("keys.filter(key => key !== CACHE)"), "Service worker must not delete unrelated origin caches");
assert.ok(serviceWorker.includes("caches.open(CACHE).then(cache => cache.match(event.request))"), "Offline fallback must only read this PWA cache");
assert.ok(js.includes("viewportRestoreTimer"), "Viewport restore debounce timer missing");
assert.ok(!js.includes('window.dispatchEvent(new Event("resize"))'), "Viewport restore must not recursively dispatch resize");
assert.ok(js.includes('$("camera").disabled = !open || !S.androidCameraEnabled;'), "Camera selector must be disabled when Android camera is OFF");
assert.ok(rtc.includes('check(cameraEnabled) { "カメラがOFFの間は切り替えできません。先にカメラをONにしてください。" }'), "Camera switching must reject requests while camera is OFF");
assert.ok(!service.includes("if ((rtc?.peerCount() ?: 0) >= 3)"), "GAS polling must continue when three viewers are connected");
assert.ok(service.includes("Keep polling even at viewer capacity"), "Capacity polling regression guard missing");
assert.ok(js.includes('const savedMicMode = String(settings.micMode || "balanced");'), "Saved microphone preset must be restored");
const deviceSettingsHandler = js.slice(js.indexOf('else if(d.type==="device_settings")'), js.indexOf('else if(d.type==="location_update")'));
assert.ok(deviceSettingsHandler.includes("queueDeviceSettingsSave(targetDevice, snapshot)"), "Android settings should be stored without echoing a settings_update back to Android");
assert.ok(!deviceSettingsHandler.includes("saveSettings()"), "Device settings handler must not echo settings back to Android");
assert.ok(gas.includes("MotionEvents:"), "Motion event metadata sheet missing");
assert.ok(gas.includes("function addMotionEvent_("), "Motion event write endpoint missing");
assert.ok(gas.includes("function getMotionEvents_("), "Motion event history endpoint missing");
assert.ok(gas.includes("function deleteMotionEvents_("), "Motion history deletion endpoint missing");
assert.ok(gas.includes("crossViewerDuplicate") && gas.includes("<= 3000"), "Motion events from multiple viewers must be coalesced");
assert.ok(gas.includes("function iceServers_("), "GAS ICE/TURN configuration missing");
assert.ok(gas.includes("TURN_CREDENTIAL"), "TURN credentials must be read from Script Properties");
assert.ok(gas.includes('micMode: ["ambient", "balanced", "voice"]'), "GAS microphone preset validation missing");
assert.ok(gas.includes('const version = "1.4.0"'), "GAS API version must be 1.4.0");
assert.ok(gas.includes('"9:16"'), "GAS must persist portrait capture ratio");
assert.ok(androidBuild.includes("versionCode = 433"), "Android version code must be 433 for v2.8.3");
assert.equal(manifestJson.name, "Remote Camera Web2 v2.8.4 Preview", "PWA display name must match v2.8.4");
assert.ok(!/録画を開始|録音を開始/.test(html), "Recording UI must not exist");
assert.ok(html.includes('id="reserveAt" type="datetime-local" step="1"'), "Web schedule must accept second precision");
assert.ok(js.includes("S.reservationTimer = setInterval(checkConnectionReservation, 250)"), "Web reservation scheduler missing");
assert.ok(html.includes('option value="40"') && html.includes('option value="45"') &&
  html.includes('option value="50"') && html.includes('option value="55"'), "Web FPS 40/45/50/55 options missing");
assert.ok(main.includes('listOf(10, 15, 20, 24, 30, 40, 45, 50, 55, 60)'), "APK FPS 40/45/50/55 options missing");
assert.ok(schedule.includes("import android.app.AlarmManager") &&
  schedule.includes("ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED"), "APK exact-alarm restore receiver is incomplete");
assert.ok(gas.includes("ALLOWED_PAIRING_DURATIONS = [10, 20, 30, 60, 120]"), "GAS must accept only supported pairing durations");
assert.ok(gas.includes("pairingDurationMinutes_(r.durationMinutes)"), "GAS must validate Android-selected pairing duration");
assert.ok(main.includes("pairingDurationSpinner") && main.includes("EXTRA_PAIRING_DURATION_MINUTES"), "Android pairing duration selector must be wired to the service");
assert.ok(service.includes("evaluateBatteryStandby(battery.first, battery.second)"), "Android battery cutoff evaluator missing");
assert.ok(service.includes("batteryStandbyActive") && service.includes("batteryWaitEnabled"), "Battery standby state and wait toggle missing");
assert.ok(service.includes("batteryForecastMinutes"), "Battery runtime estimate telemetry missing");
assert.ok(html.includes('id="toggleSettings"') && js.includes("setSettingsCollapsed("), "Collapsible Web settings panel missing");
assert.ok(html.includes('id="batteryForecast"') && js.includes("renderBatteryForecast("), "Web battery estimate chip missing");
assert.ok(js.includes('d.type==="battery_standby"'), "Web must stop automatic reconnect on battery standby");
assert.ok(gas.includes('case "save_device_schedule": return saveDeviceSchedule_(r);') &&
  gas.includes("function saveDeviceSchedule_(r)") && gas.includes("androidSchedule"), "APK reservation sync endpoint missing");
assert.ok(js.includes("function renderAndroidSchedule(") && js.includes('api("get_settings"') &&
  js.includes('"refreshAndroidSchedule"'), "Web APK schedule display/refresh missing");
assert.ok(js.includes("S.autoConnectWanted") &&
  js.includes("(S.everConnected || S.autoConnectWanted)"), "First-connection retry guard missing");
assert.ok(service.includes("setTorchEnabled(enabled)") && rtc.includes("TorchCaptureControl") &&
  torchSession.includes("FLASH_MODE_TORCH") && torchState.includes("CountDownLatch"), "Camera2 in-stream torch integration missing");
assert.ok(main.includes("scheduleSyncPending") && service.includes("lastScheduleSyncAt") &&
  service.includes("60000L"), "APK schedule sync must retry after connectivity failures");

assert.ok(torchState.includes("ready = new CountDownLatch(1)"), "Torch state must support repeated camera sessions");
assert.ok(html.includes('id="reserveAt" type="datetime-local" step="1"'), "Web schedule must accept second precision");
assert.ok(js.includes("S.reservationTimer = setInterval(checkConnectionReservation, 250)"), "Web reservation scheduler missing");
assert.ok(html.includes('option value="40"') && html.includes('option value="45"') &&
  html.includes('option value="50"') && html.includes('option value="55"'), "Web FPS 40/45/50/55 options missing");
assert.ok(main.includes('listOf(10, 15, 20, 24, 30, 40, 45, 50, 55, 60)'), "APK FPS 40/45/50/55 options missing");
assert.ok(schedule.includes("import android.app.AlarmManager") &&
  schedule.includes("ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED"), "APK exact-alarm restore receiver is incomplete");
assert.ok(gas.includes('case "save_device_schedule": return saveDeviceSchedule_(r);') &&
  gas.includes("function saveDeviceSchedule_(r)") && gas.includes("androidSchedule"), "APK reservation sync endpoint missing");
assert.ok(js.includes("function renderAndroidSchedule(") && js.includes('api("get_settings"') &&
  js.includes('"refreshAndroidSchedule"'), "Web APK schedule display/refresh missing");
assert.ok(js.includes("S.autoConnectWanted") &&
  js.includes("(S.everConnected || S.autoConnectWanted)"), "First-connection retry guard missing");
assert.ok(service.includes("setTorchEnabled(enabled)") && rtc.includes("TorchCaptureControl") &&
  torchSession.includes("FLASH_MODE_TORCH") && torchState.includes("CountDownLatch"), "Camera2 in-stream torch integration missing");
assert.ok(torchState.includes("ready = new CountDownLatch(1)"), "Torch state must support repeated camera sessions");
console.log("Web2 source checks passed.");


assert.ok(!html.includes('id="screenTab"') && !html.includes('id="screenPane"'), "Android screen sharing UI must be removed");
assert.ok(!js.includes("screen_start") && !js.includes("screen_stop") && !js.includes("remoteScreen"), "Web screen sharing code must be removed");
assert.ok(!rtc.includes("MediaProjection") && !rtc.includes("ScreenCapturer") && !rtc.includes("remote-screen"), "Android RTC must not create a screen-share track");
assert.ok(!service.includes("MediaProjection") && !service.includes("screenRequesters") && !service.includes("screen_start"), "Android service must not retain screen-share lifecycle code");
assert.ok(!manifest.includes("FOREGROUND_SERVICE_MEDIA_PROJECTION") && !manifest.includes("mediaProjection") && !manifest.includes("RemoteControlAccessibilityService"), "Manifest must not declare screen capture or accessibility control");
assert.ok(js.includes("function setWebMicEnabled(enabled)") && js.includes("navigator.mediaDevices.getUserMedia"), "Web microphone must have an explicit ON/OFF lifecycle");
assert.ok(js.includes('$("micNoise").addEventListener("input"') && js.includes("setNoiseSuppressionLevel"), "Noise slider must apply local DSP values");
const connectFunction = js.slice(js.indexOf("async function connect("), js.indexOf("function scheduleReconnect("));
assert.ok(connectFunction.includes("void setWebMicEnabled(true)"), "Browser microphone must start automatically during connection setup");
assert.ok(js.includes("connectionAttemptWatchdog") && js.includes("abortStalledConnectAttempt(attemptId)"),
  "A stuck WebRTC setup must be force-reset by a hard connection-attempt watchdog");
assert.ok(js.includes("assertConnectAttempt(attemptId, device.deviceId)") &&
  js.includes("withTimeout(pc.createOffer(), 8000"),
  "Connection stages must have stale-attempt guards and bounded promise waits");
assert.ok(js.includes("consecutiveFailures >= 3") && js.includes("if (S.connecting)"),
  "Signal polling must trigger recovery after repeated failures without stacking reconnect timers");

assert.ok(js.includes("sender.replaceTrack(track)") && js.includes("sender.replaceTrack(null)") && js.includes("track.stop()"), "Web mic must attach and release real tracks");
assert.ok(js.includes("await setWebMicEnabled(false)") && js.includes('sendControlAndWait("disconnect", { sessionId, keepRecovery }, 800)'), "Disconnect must release the Web mic before bounded remote shutdown");
assert.ok(!js.includes("pttLock") && !html.includes('id="pttLock"'), "Obsolete PTT lock UI must be removed");
assert.ok(html.includes("接続時にマイクを開始します") || html.includes("接続時自動ON"), "UI must explain automatic Web microphone startup");
assert.ok(main.includes("StopMonitoringReceiver.stop(this)"), "Android UI stop button must use common stop receiver");
assert.ok(fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/StopMonitoringReceiver.kt", "utf8").includes("stopService("), "Notification stop action must directly stop the foreground service");
assert.ok(service.includes("getBroadcast(") && service.includes("待機を停止"), "Persistent notification must expose a service-independent stop action");
assert.ok(service.includes("if (!prefs.getBoolean(\"monitoringEnabled\", false))") && service.includes("catch (cancelled: CancellationException)"), "A cancelled service must not recreate a startup-error notification or retry");
assert.ok(service.includes("updateDisplayWakeLock(false)") && service.includes("PowerManager.SCREEN_BRIGHT_WAKE_LOCK") && service.includes("PowerManager.ACQUIRE_CAUSES_WAKEUP"), "Remote screen wake must turn the display on and release on stop");
assert.ok(service.includes('"android_keep_awake"') && service.includes('"androidKeepAwake"'), "Android display-awake state must be remotely controlled and reported");
assert.ok(!main.includes("FLAG_KEEP_SCREEN_ON") && !main.includes("keepAwakeButton") && !main.includes("ACTION_KEEP_SCREEN_AWAKE_STATE"), "Android APK must not expose a local sleep-prevention button");
assert.ok(html.includes('id="androidKeepAwake"') && html.includes("スリープ制御 無効") &&
  !js.includes("android_keep_awake") && !js.includes("toggleAndroidKeepAwake"),
  "Web must show a non-operational Android sleep status and must not send remote display-wake commands");
assert.ok(js.includes("S.androidCameraEnabled === false") && js.includes("RemoteCameraRecovery.shouldRecoverVideo"),
  "Video watchdog must not reconnect while the Android camera is intentionally OFF");
assert.ok(recoveryCore.includes("function shouldRecoverVideo") && recoveryCore.includes("state.cameraEnabled === false"),
  "Camera-aware video watchdog policy must be present");
assert.ok(js.includes('sendControlAndWait("media_toggle"') && js.includes('dataset.pending === "true"'),
  "Android media buttons must await acknowledgements and reject duplicate clicks");
assert.ok(js.includes("prepareForVideoCommand(name, payload)") && js.includes("Math.min(12000, timeoutMs)"),
  "Video-changing commands must receive recovery grace and bounded acknowledgement time");
assert.ok(rtc.includes("torchRequested") && rtc.includes("setTorchEnabled") &&
  rtc.includes("TorchCaptureControl"), "Torch intent must be owned by the active RTC camera capturer");
assert.ok(torchSession.includes("FLASH_MODE_TORCH") && torchSession.includes("torchState.attach"),
  "The active Camera2 repeating request must support in-stream flashlight control");
assert.ok(!service.includes("CameraManager") && !service.includes("CameraAccessException.CAMERA_IN_USE"),
  "The service must not use the separate CameraManager torch path while the camera is streaming");
assert.ok(rtc.includes(".setUseHardwareNoiseSuppressor(false)"), "Fixed-strength Android noise suppression must be disabled");
assert.ok(noiseProcessor.includes('registerProcessor("remote-camera-noise-gate"') && noiseProcessor.includes("this.strength"), "Graduated Web Audio noise-gate processor missing");
assert.ok(js.includes("remote-camera-noise-gate") && js.includes("noiseSuppressorNode") && js.includes("setNoiseSuppressionLevel"), "Web receive audio must apply graduated software noise reduction");
assert.ok(!service.includes('"mic_noise"') && !service.includes("setNoiseSuppressionLevel"), "Android binary noise setting must no longer control the slider");
assert.ok(html.includes("0は完全にOFF") && html.includes("適応ノイズゲート"), "Noise UI must explain 0-100 Web noise gating");
assert.equal([...js.matchAll(/function updateAndroidKeepAwakeButton\(/g)].length, 0, "Android display-awake helper must be removed from Web");
assert.equal([...js.matchAll(/function toggleAndroidKeepAwake\(/g)].length, 0, "Android display-awake handler must be removed from Web");
assert.equal([...js.matchAll(/sendControlAndWait\("android_keep_awake"/g)].length, 0, "Web must never send Android display-awake commands");
assert.equal([...html.matchAll(/id="androidKeepAwake"/g)].length, 1, "Keep the original button slot to preserve viewer layout");
assert.ok(js.includes("安全性と接続安定性のため、WebからのAndroidスリープ制御は無効です"), "Retired Android sleep control must explain its disabled state");
assert.ok(js.includes('$("androidKeepAwake").addEventListener("click", () => toast('), "Sleep-control slot must only display an informational message and must not send an Android command");
assert.ok(html.includes('class="settingsGroup"'), "Legacy v4.1 collapsible settings groups must be restored");
assert.ok(html.includes('class="viewerControls"'), "Legacy v4.1 viewer toolbar must be restored");
assert.ok(html.includes('<button id="followLocation"'), "Map follow control must be a button matching its handler");
assert.ok(html.includes('class="ptt pttProminent"'), "Prominent microphone control missing");
assert.ok(js.includes("startViewerPan") && js.includes("moveViewerPan") && js.includes("translate("), "Zoomed video must be pannable rather than center-only");
assert.ok(!html.includes('id="snapshot"'), "Static image capture must remain excluded");
assert.equal([...js.matchAll(/\$\("fitMode"\)\.addEventListener\("click"/g)].length, 1, "Fit/fill action must be registered once");
assert.ok(js.includes('pointerdown", startViewerPan') && js.includes('pointermove", moveViewerPan'), "Zoom pan pointer listeners must exist");
assert.ok(html.includes("RTC接続中はAndroidの現在地をDataChannelで直接受信"), "Location UI must explain RTC live updates");
console.log("Web2 v2.6 stability, microphone lifecycle, notification stop, and screen-share removal checks passed.");

assert.ok(main.includes("addTextChangedListener") && main.includes('putInt("pollIntervalSeconds", seconds)'), "Polling interval must be saved as it is edited");
assert.ok(main.includes("saveMonitoringSchedule()") && main.includes("setExactAndAllowWhileIdle") && main.includes("NumberPicker") && main.includes("SCHEDULE_EXACT_ALARM"), "Android standby schedule UI missing");
assert.ok(schedule.includes("ACTION_START") && schedule.includes("ACTION_STOP"), "Android scheduled start/stop receiver missing");
assert.ok(js.includes("function scheduleSettingsSave()"), "Web setting change debounce missing");
assert.ok(js.includes("CONTROL_SEND_INTERVAL_MS = 120") && js.includes("CONTROL_SEND_QUEUE_LIMIT = 24"), "Remote commands must be serialized and rate limited");
assert.ok(js.includes("channel.bufferedAmount > 512 * 1024"), "DataChannel send backpressure guard missing");
assert.ok(js.includes('!S.manualDisconnect && pc.connectionState !== "closed"'), "Expected manual DataChannel close suppression missing");
assert.ok(rtc.includes('setOf("16:9", "4:3", "1:1", "9:16", "original")'), "Original camera aspect ratio support missing");
assert.ok(service.includes("dataChannelCommandMutex.withLock"), "DataChannel commands must be serialized");
assert.ok(service.includes("now - lastTelemetryAt >= 5000L"), "Active RTC telemetry rate limit missing");
assert.ok(service.includes("v212OriginalAspectMigrationComplete"), "Legacy 16:9 camera ratio migration missing");
assert.ok(schedule.includes("restoreScheduleAfterBoot"), "Scheduled monitoring must be restored after reboot");
assert.ok(manifest.includes("android.permission.SCHEDULE_EXACT_ALARM"), "Exact alarm permission missing");
assert.ok(manifest.includes("android.permission.RECEIVE_BOOT_COMPLETED"), "Boot restore permission missing");
assert.ok(service.includes("WIFI_MODE_FULL") && service.includes("PARTIAL_WAKE_LOCK"), "Live screen-off connection locks missing");
assert.ok(service.includes("txBytes7d") && service.includes("txBytes30d"), "7/30-day traffic aggregation missing");
assert.ok(js.includes('d.type==="device_settings"'), "Android settings synchronization missing");
assert.ok(js.includes('media_toggle') && js.includes('cameraToggle') && js.includes('micToggle'), "Remote camera/microphone toggles missing");
assert.ok(rtc.includes("1920 to 1080") && rtc.includes("setCameraEnabled") && rtc.includes("captureInfo"), "Wide 16:9 camera capture and live media controls missing");
assert.ok(html.includes('id="actualVideoFormat"') && html.includes('id="deviceTotal30d"'), "Actual video format and traffic history UI missing");
assert.ok(!html.includes('option value="ultra"') && html.includes('type="hidden" id="dataMode"'), "Legacy confusing data-mode selector must be hidden");
