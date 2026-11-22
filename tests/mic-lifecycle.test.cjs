const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const web = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const service = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
const main = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt", "utf8");
const manifest = fs.readFileSync("android/app/src/main/AndroidManifest.xml", "utf8");
const stopReceiver = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/StopMonitoringReceiver.kt", "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, "Missing section start: " + start);
  assert.notEqual(to, -1, "Missing section end: " + end);
  return source.slice(from, to);
}

test("WebRTC connection never opens a browser microphone while idle", () => {
  const connect = section(web, "async function connect(", "function scheduleReconnect(");
  assert.equal(connect.includes("getUserMedia"), false);
  assert.match(connect, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
  assert.match(connect, /S\.micSender = audioTransceiver\.sender/);
});

test("PTT requests a microphone only after the talk action", () => {
  const ptt = section(web, "async function ptt(enabled)", "function togglePttLock(");
  assert.match(ptt, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(ptt, /S\.micSender\.replaceTrack\(track\)/);
  assert.match(ptt, /S\.micSender\?\.replaceTrack\(null\)/);
  assert.match(ptt, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(ptt, /180000/);
});

test("Connection reservation and page initialisation never request a microphone", () => {
  const reservation = section(web, "async function reserveConnection()", "function cancelConnectionReservation()");
  assert.equal(reservation.includes("getUserMedia"), false);
  assert.equal(web.includes("DOMContentLoaded") && section(web, 'document.addEventListener("DOMContentLoaded"', "});").includes("getUserMedia"), false);
});

test("Android screen sharing, projection and remote accessibility controls are removed", () => {
  assert.equal(html.includes("screenPane"), false);
  assert.equal(html.includes("screenTab"), false);
  assert.equal(web.includes("screen_start"), false);
  assert.equal(web.includes("screen_stop"), false);
  assert.equal(rtc.includes("MediaProjection"), false);
  assert.equal(rtc.includes("ScreenCapturer"), false);
  assert.equal(service.includes("screenRequesters"), false);
  assert.equal(manifest.includes("RemoteControlAccessibilityService"), false);
  assert.equal(manifest.includes("mediaProjection"), false);
});

test("Notification and app stop paths share direct foreground-service shutdown", () => {
  assert.match(service, /getBroadcast\(/);
  assert.match(service, /待機を停止/);
  assert.match(main, /StopMonitoringReceiver\.stop\(this\)/);
  assert.match(stopReceiver, /stopService\(/);
  assert.match(stopReceiver, /putBoolean\("monitoringEnabled", false\)/);
  assert.match(service, /override fun onDestroy\(\)[\s\S]*?rtc\?\.dispose\(\)[\s\S]*?updateStreamWakeLock\(false\)[\s\S]*?updateDisplayWakeLock\(false\)/);
});

test("Android display awake can be switched remotely and is released on shutdown", () => {
  assert.match(html, /id="androidKeepAwake"/);
  assert.match(web, /sendControl\("android_keep_awake"/);
  assert.match(service, /"android_keep_awake"/);
  assert.match(service, /PowerManager\.SCREEN_DIM_WAKE_LOCK/);
  assert.match(service, /updateDisplayWakeLock\(false\)/);
});

test("Android noise suppression is bounded and uses zero as hardware suppression off", () => {
  assert.match(rtc, /noiseSuppressionLevel > 0/);
  assert.match(rtc, /setUseHardwareNoiseSuppressor\(hardwareNoiseSuppression\)/);
  assert.match(rtc, /level\.coerceIn\(0,100\)/);
  assert.match(html, /min="0" max="100"/);
});
