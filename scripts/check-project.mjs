import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("index.html", "utf8");
const js = fs.readFileSync("app.js", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const main = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8");
const gas = fs.readFileSync("gas/Code.gs", "utf8");
const config = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/Config.kt", "utf8");

for (const id of ["micNoise", "micSensitivity", "micGain", "volume", "diagnostics", "deviceTotal", "networkSummary", "deviceHealth", "deviceTxSpeed", "deviceRxSpeed", "torch", "reserveConnection", "cancelReservation", "reservationStatus", "fps", "aspectRatio", "fullscreen"]) {
  assert.ok(html.includes('id="' + id + '"'), "Missing HTML element: " + id);
  assert.ok(js.includes('$("' + id + '")'), "Missing JavaScript reference: " + id);
}
assert.ok(js.includes('createDataChannel("remote-control"'), "Web must create control DataChannel");
assert.ok(js.includes("function sendControl("), "Web DataChannel sender missing");
assert.ok(js.includes("function checkConnectionReservation("), "Connection reservation scheduler missing");
assert.ok(js.includes("function toggleFullscreen("), "Fullscreen handler missing");
assert.ok(js.includes("applyAspectRatio("), "Aspect ratio selector handler missing");
assert.ok(js.includes("function scheduleReconnect("), "Automatic reconnect handler missing");
assert.ok(rtc.includes("override fun onDataChannel(channel: DataChannel)"), "Android DataChannel observer missing");
assert.ok(rtc.includes("hasOpenControlChannel()"), "Android DataChannel state check missing");
assert.ok(rtc.includes("peers.size < 3"), "Three-viewer limit missing");
assert.ok(rtc.includes("requestedFps.coerceIn(10, 60)"), "FPS control missing");
assert.ok(rtc.includes("stun:stun.l.google.com:19302"), "Android STUN configuration missing");
assert.ok(service.includes("pollIntervalSeconds"), "Custom polling interval missing");
assert.ok(service.includes("sendTelemetry()"), "Android telemetry missing");
assert.ok(service.includes("networkInfo()"), "Network diagnostics missing");
assert.ok(service.includes("setTorch("), "Android flashlight control missing");
assert.ok(service.includes("lastNetworkError"), "Automatic network error diagnostics missing");
assert.ok(service.includes("lastDevicePollAt"), "Additional viewer signaling poll scheduler missing");
assert.ok(main.includes("1～50秒"), "1-50 second polling interval UI missing");
assert.ok(config.includes("POLL_SECONDS = 10L"), "Default polling interval must be 10 seconds");
assert.ok(config.includes("MIN_POLL_SECONDS = 1"), "Minimum polling interval must be 1 second");
assert.ok(config.includes("MAX_POLL_SECONDS = 50"), "Maximum polling interval must be 50 seconds");
assert.ok(gas.includes("Controllers:"), "Multi-controller storage sheet missing");
assert.ok(gas.includes("activeControllerCount_(deviceId) >= 3"), "Three-controller pairing limit missing");
assert.ok(manifest.includes("android.permission.ACCESS_WIFI_STATE"), "Wi-Fi permission missing");
assert.ok(!/録画を開始|録音を開始/.test(html), "Recording UI must not exist");
console.log("Web2 source checks passed.");
