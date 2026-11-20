import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync("index.html", "utf8");
const js = fs.readFileSync("app.js", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const main = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8");

for (const id of ["micNoise", "micSensitivity", "micGain", "volume", "diagnostics", "deviceTotal", "networkSummary", "deviceHealth", "deviceTxSpeed", "deviceRxSpeed", "torch", "reserveConnection", "cancelReservation", "reservationStatus"]) {
  assert.ok(html.includes('id="' + id + '"'), "Missing HTML element: " + id);
  assert.ok(js.includes('$("' + id + '")'), "Missing JavaScript reference: " + id);
}
assert.ok(js.includes('createDataChannel("remote-control"'), "Web must create control DataChannel");
assert.ok(js.includes("function sendControl("), "Web DataChannel sender missing");
assert.ok(js.includes("function checkConnectionReservation("), "Connection reservation scheduler missing");
assert.ok(js.includes("function scheduleReconnect("), "Automatic reconnect handler missing");
assert.ok(rtc.includes("override fun onDataChannel(channel: DataChannel)"), "Android DataChannel observer missing");
assert.ok(rtc.includes("hasOpenControlChannel()"), "Android DataChannel state check missing");
assert.ok(rtc.includes("stun:stun.l.google.com:19302"), "Android STUN configuration missing");
assert.ok(service.includes("pollIntervalSeconds"), "Custom polling interval missing");
assert.ok(service.includes("sendTelemetry()"), "Android telemetry missing");
assert.ok(service.includes("networkInfo()"), "Network diagnostics missing");
assert.ok(service.includes("setTorch("), "Android flashlight control missing");
assert.ok(service.includes("lastNetworkError"), "Automatic network error diagnostics missing");
assert.ok(main.includes("5～3600"), "Polling interval UI missing");
assert.ok(manifest.includes("android.permission.ACCESS_WIFI_STATE"), "Wi-Fi permission missing");
assert.ok(!/録画を開始|録音を開始/.test(html), "Recording UI must not exist");
console.log("Web2 source checks passed.");
