const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = path => fs.readFileSync(path, "utf8");
const web = read("app.js");
const html = read("index.html");
const service = read("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt");
const rtc = read("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt");
const main = read("android/app/src/main/java/jp/a09848281/remotecamera/MainActivity.kt");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const stopReceiver = read("android/app/src/main/java/jp/a09848281/remotecamera/StopMonitoringReceiver.kt");
const worklet = read("noise-suppressor-processor.js");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, "Missing section start: " + start);
  assert.notEqual(to, -1, "Missing section end: " + end);
  return source.slice(from, to);
}

test("RTC connection starts the Web microphone without blocking video setup", () => {
  const connect = section(web, "async function connect(", "function scheduleReconnect(");
  assert.match(connect, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
  assert.match(connect, /S\.micSender = audioTransceiver\.sender/);
  assert.match(connect, /void setWebMicEnabled\(true\)/);
});

test("Web microphone toggle requests, attaches, detaches and stops tracks", () => {
  const mic = section(web, "async function setWebMicEnabled(enabled)", "async function enableScreenWakeLock()");
  assert.match(mic, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(mic, /sender\.replaceTrack\(track\)/);
  assert.match(mic, /sender\?\.replaceTrack\(null\)/);
  assert.match(mic, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(mic, /requestId !== S\.pttRequestId/);
  assert.equal(html.includes('id="pttLock"'), false);
  assert.equal(web.includes("pttLock"), false);
});

test("incoming Android audio stays enabled during Web microphone transmission", () => {
  assert.match(web, /track\.enabled = !S\.remoteAudioMuted/);
  const meter = section(web, "function startAudioMeter()", "function stopAudioMeter()");
  assert.doesNotMatch(meter, /S\.pttActive/);
});

test("disconnect releases the Web microphone before bounded remote shutdown", () => {
  const disconnect = section(web, "async function disconnect(", "async function loadSettings(");
  assert.ok(disconnect.indexOf("await setWebMicEnabled(false)") < disconnect.indexOf('sendControlAndWait("disconnect"'));
  assert.match(disconnect, /sendControlAndWait\("disconnect", \{ sessionId, keepRecovery \}, 800\)/);
  assert.match(disconnect, /void api\("send_signal"/);
  assert.equal(disconnect.includes('await api("send_signal"'), false);
});

test("reservation and page initialisation do not pre-open the microphone", () => {
  const reservation = section(web, "async function reserveConnection()", "function cancelConnectionReservation()");
  assert.equal(reservation.includes("getUserMedia"), false);
  const initStart = web.indexOf('document.addEventListener("DOMContentLoaded"');
  assert.notEqual(initStart, -1);
  const init = web.slice(initStart, initStart + 4000);
  assert.equal(init.includes("getUserMedia"), false);
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

test("notification and Android app stop paths use direct foreground-service shutdown", () => {
  assert.match(service, /getBroadcast\(/);
  assert.match(service, /待機を停止/);
  assert.match(main, /StopMonitoringReceiver\.stop\(this\)/);
  assert.match(stopReceiver, /stopService\(/);
  assert.match(stopReceiver, /putBoolean\("monitoringEnabled", false\)/);
  assert.match(service, /override fun onDestroy\(\)[\s\S]*?rtc\?\.dispose\(\)[\s\S]*?updateStreamWakeLock\(false\)[\s\S]*?updateDisplayWakeLock\(false\)/);
});

test("Android screen sleep control is disabled in Web and cannot send remote commands", () => {
  assert.match(html, /id="androidKeepAwake"/);
  assert.match(html, /スリープ制御 無効/);
  assert.match(html, /WebからのAndroidスリープ制御は無効/);
  assert.doesNotMatch(web, /android_keep_awake|toggleAndroidKeepAwake|S\.androidKeepAwake/);
  assert.match(web, /安全性と接続安定性のため、WebからのAndroidスリープ制御は無効です/);
  // Keep the legacy Android handler for backward compatibility with older Web versions,
  // but the current Web client must have no path that can invoke it.
  assert.match(service, /"android_keep_awake"/);
  assert.match(service, /updateDisplayWakeLock\(false\)/);
  assert.doesNotMatch(main, /keepAwakeButton|FLAG_KEEP_SCREEN_ON|ACTION_KEEP_SCREEN_AWAKE_STATE/);
});

test("0-100 noise slider uses adjustable Web Audio DSP", () => {
  assert.match(html, /id="micNoise"[^>]*min="0"[^>]*max="100"/);
  assert.match(web, /function setNoiseSuppressionLevel\(value, persist = false\)/);
  assert.match(web, /remote-camera-noise-gate/);
  assert.match(worklet, /registerProcessor\("remote-camera-noise-gate"/);
  assert.match(worklet, /if \(this\.strength <= 0\)/);
  assert.match(rtc, /setUseHardwareNoiseSuppressor\(false\)/);
  assert.match(html, /適応ノイズゲート/);
});

test("zoom can be panned across the image and reset", () => {
  assert.match(web, /function startViewerPan\(/);
  assert.match(web, /function moveViewerPan\(/);
  assert.match(web, /translate\(" \+ S\.zoomPanX/);
  assert.match(web, /pointerdown", startViewerPan/);
  assert.match(web, /pointermove", moveViewerPan/);
  assert.match(html, /ドラッグして表示位置を移動できます/);
});
