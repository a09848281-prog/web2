"use strict";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "rc_paired_devices_v1";
const SELECTED_KEY = "rc_selected_device_v1";
const S = {
  cfg: null,
  devices: [],
  device: null,
  pc: null,
  connecting: false,
  mic: null,
  remoteAudioTracks: [],
  pttActive: false,
  session: "",
  seq: 0,
  map: null,
  marker: null,
  route: null,
  history: [], control: null, statsTimer: null, statsLast: null, reconnectTimer: null, reconnectAttempts: 0, everConnected: false, torchEnabled: false, reservationTimer: null,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  motion: { enabled: false, sensitivity: 3, timer: null, previous: null, streak: 0, lastEventAt: 0, sendingDevices: new Set(), retryTimer: null },
  adaptive: { tier: 2, bad: 0, good: 0, lastChange: 0 },
  audioContext: null, remoteGain: null, remoteAudioSource: null, remoteAnalyser: null,
  audioMeterFrame: null, receiveVolume: 70, remoteAudioMuted: false,
  pttLocked: false, pttStartedAt: 0, pttTimeout: null, pttKeyActive: false,
  wakeLock: null, keepAwakeWanted: false,
  videoWatchdogTimer: null, videoFrameCallbackId: null, videoUsesFrameCallback: false,
  hasReceivedVideoFrame: false, lastVideoFrameAt: 0, connectedAt: 0, sessionTimer: null,
  statsLast: null, manualDisconnect: false, reconnectResetTimer: null,
  settingsSaveQueue: Promise.resolve()
};


function prepareAudioOutput() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  try {
    if (!S.audioContext) {
      S.audioContext = new AudioContextClass();
      S.remoteGain = S.audioContext.createGain();
      S.remoteGain.gain.value = AudioUtils.receiveGain(S.receiveVolume);
      S.remoteGain.connect(S.audioContext.destination);
    }
    if (S.audioContext.state === "suspended") {
      S.audioContext.resume().catch(error => console.debug("AudioContext resume failed", error));
    }
    return true;
  } catch (error) {
    console.warn("Web Audio output setup failed; use media element audio", error);
    return false;
  }
}

function attachRemoteAudio() {
  const tracks = S.remoteAudioTracks.filter(track => track.readyState === "live");
  if (!tracks.length) {
    $("audioState").textContent = "Androidマイク待機中";
    stopAudioMeter();
    return;
  }
  if (!prepareAudioOutput()) {
    $("remoteVideo").muted = S.remoteAudioMuted;
    $("remoteVideo").volume = Math.min(1, AudioUtils.receiveGain(S.receiveVolume));
    $("audioState").textContent = "Androidマイク受信中（標準音声）";
    return;
  }
  try {
    if (S.remoteAudioSource) {
      try { S.remoteAudioSource.disconnect(); } catch (_) {}
      S.remoteAudioSource = null;
    }
    const audioStream = new MediaStream(tracks);
    S.remoteAudioSource = S.audioContext.createMediaStreamSource(audioStream);
    S.remoteAnalyser = S.audioContext.createAnalyser();
    S.remoteAnalyser.fftSize = 512;
    S.remoteAudioSource.connect(S.remoteAnalyser);
    S.remoteAnalyser.connect(S.remoteGain);
    $("remoteVideo").muted = true;
    S.remoteGain.gain.setTargetAtTime(
      S.remoteAudioMuted ? 0 : AudioUtils.receiveGain(S.receiveVolume),
      S.audioContext.currentTime,
      0.04
    );
    startAudioMeter();
    $("audioState").textContent = "Androidマイク受信中";
    if (S.audioContext.state === "suspended") {
      S.audioContext.resume().catch(error => console.debug("Remote audio resume failed", error));
    }
  } catch (error) {
    console.warn("Remote audio routing failed; using video element fallback", error);
    S.remoteAudioSource = null;
    S.remoteAnalyser = null;
    $("remoteVideo").muted = S.remoteAudioMuted;
    $("remoteVideo").volume = Math.min(1, AudioUtils.receiveGain(S.receiveVolume));
    $("audioState").textContent = "Androidマイク受信中（標準音声へ切替）";
  }
}

function startAudioMeter() {
  if (!S.remoteAnalyser || S.audioMeterFrame !== null) return;
  const data = new Uint8Array(S.remoteAnalyser.fftSize);
  const tick = () => {
    if (!S.remoteAnalyser || S.remoteAudioMuted || S.pttActive) {
      S.audioMeterFrame = null;
      $("audioLevel").value = "0";
      $("audioLevelText").textContent = S.remoteAudioMuted ? "ミュート中" : "待機中";
      return;
    }
    S.remoteAnalyser.getByteTimeDomainData(data);
    const rms = AudioUtils.rmsFromTimeDomain(data);
    $("audioLevel").value = String(AudioUtils.meterLevel(rms));
    $("audioLevelText").textContent = AudioUtils.meterLabel(rms);
    S.audioMeterFrame = requestAnimationFrame(tick);
  };
  S.audioMeterFrame = requestAnimationFrame(tick);
}

function stopAudioMeter() {
  if (S.audioMeterFrame !== null) cancelAnimationFrame(S.audioMeterFrame);
  S.audioMeterFrame = null;
  $("audioLevel").value = "0";
  $("audioLevelText").textContent = "待機中";
}

function setReceiveVolume(value, persist = true) {
  S.receiveVolume = AudioUtils.clampReceivePercent(value);
  $("receiveVolume").value = String(S.receiveVolume);
  $("receiveVolumeValue").value = S.receiveVolume + "%";
  if (S.remoteGain && S.audioContext) {
    const target = S.remoteAudioMuted ? 0 : AudioUtils.receiveGain(S.receiveVolume);
    S.remoteGain.gain.setTargetAtTime(target, S.audioContext.currentTime, 0.035);
  } else {
    $("remoteVideo").volume = Math.min(1, AudioUtils.receiveGain(S.receiveVolume));
  }
  if (persist) {
    try { localStorage.setItem("rc_receive_volume_v1", String(S.receiveVolume)); }
    catch (error) { console.warn("Could not persist received volume", error); }
  }
}

function setRemoteAudioMuted(muted) {
  S.remoteAudioMuted = muted === true;
  S.remoteAudioTracks.forEach(track => { track.enabled = !S.remoteAudioMuted && !S.pttActive; });
  if (S.remoteGain && S.audioContext) {
    S.remoteGain.gain.setTargetAtTime(
      S.remoteAudioMuted ? 0 : AudioUtils.receiveGain(S.receiveVolume),
      S.audioContext.currentTime,
      0.035
    );
  } else {
    $("remoteVideo").muted = S.remoteAudioMuted;
  }
  $("remoteMute").textContent = S.remoteAudioMuted ? "🔇 Android音声 OFF" : "🔊 Android音声 ON";
  $("remoteMute").classList.toggle("active", S.remoteAudioMuted);
  if (S.remoteAudioMuted) {
    stopAudioMeter();
    $("audioLevelText").textContent = "ミュート中";
  } else if (S.remoteAudioTracks.some(track => track.readyState === "live")) {
    attachRemoteAudio();
  }
}

function stopPttSafetyTimer() {
  if (S.pttTimeout) clearTimeout(S.pttTimeout);
  S.pttTimeout = null;
}

function ptt(enabled) {
  const track = S.mic && S.mic.getAudioTracks()[0];
  if (!track) return false;
  const next = enabled === true;
  if (next) {
    S.pttStartedAt = Date.now();
    stopPttSafetyTimer();
    S.pttTimeout = setTimeout(() => {
      S.pttLocked = false;
      $("pttLock").textContent = "送話ロック OFF";
      $("pttLock").classList.remove("active");
      ptt(false);
      toast("安全タイマーにより送話を3分で自動停止しました。");
    }, 180000);
  } else {
    stopPttSafetyTimer();
    S.pttStartedAt = 0;
  }
  S.pttActive = next;
  track.enabled = next;
  S.remoteAudioTracks.forEach(remoteTrack => { remoteTrack.enabled = !next && !S.remoteAudioMuted; });
  if (next) {
    stopAudioMeter();
    $("audioLevelText").textContent = "送話中";
  } else if (S.remoteAudioTracks.some(remoteTrack => remoteTrack.readyState === "live") && !S.remoteAudioMuted) {
    startAudioMeter();
  }
  $("ptt").classList.toggle("active", next);
  $("ptt").textContent = next ? "🎙 送話中…" : "🎙 押している間だけ話す";
  return true;
}

function togglePttLock() {
  if (!S.mic || !S.mic.getAudioTracks().some(track => track.readyState === "live")) {
    toast("先にAndroidへ接続してください。");
    return;
  }
  S.pttLocked = !S.pttLocked;
  $("pttLock").textContent = S.pttLocked ? "🔒 送話ロック ON" : "送話ロック OFF";
  $("pttLock").classList.toggle("active", S.pttLocked);
  ptt(S.pttLocked);
}

async function enableScreenWakeLock() {
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
    toast("このブラウザーは画面スリープ防止に対応していません。");
    return false;
  }
  try {
    S.wakeLock = await navigator.wakeLock.request("screen");
    S.wakeLock.addEventListener("release", () => {
      S.wakeLock = null;
      $("keepAwake").classList.remove("active");
      $("keepAwake").textContent = "画面スリープ防止 OFF";
    }, { once: true });
    $("keepAwake").classList.add("active");
    $("keepAwake").textContent = "画面スリープ防止 ON";
    return true;
  } catch (error) {
    S.wakeLock = null;
    toast("画面スリープ防止を開始できません: " + (error.message || "ブラウザー制限"));
    return false;
  }
}

async function toggleScreenWakeLock() {
  S.keepAwakeWanted = !S.keepAwakeWanted;
  if (!S.keepAwakeWanted) {
    if (S.wakeLock) {
      try { await S.wakeLock.release(); } catch (_) {}
      S.wakeLock = null;
    }
    $("keepAwake").classList.remove("active");
    $("keepAwake").textContent = "画面スリープ防止 OFF";
    return;
  }
  if (!S.pc || S.pc.connectionState !== "connected") {
    S.keepAwakeWanted = false;
    toast("画面スリープ防止は接続中に有効にできます。");
    return;
  }
  if (!await enableScreenWakeLock()) S.keepAwakeWanted = false;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? h + "時間 " + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
    : String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function startSessionClock() {
  if (S.sessionTimer) clearInterval(S.sessionTimer);
  S.connectedAt = Date.now();
  const update = () => {
    if (!S.connectedAt) return;
    $("sessionDuration").textContent = "接続 " + formatDuration(Date.now() - S.connectedAt);
  };
  update();
  S.sessionTimer = setInterval(update, 1000);
}
function stopSessionClock() {
  if (S.sessionTimer) clearInterval(S.sessionTimer);
  S.sessionTimer = null;
  S.connectedAt = 0;
  $("sessionDuration").textContent = "未接続";
}

function stopVideoWatchdog() {
  if (S.videoWatchdogTimer) clearInterval(S.videoWatchdogTimer);
  S.videoWatchdogTimer = null;
  const video = $("remoteVideo");
  if (S.videoFrameCallbackId !== null && video && typeof video.cancelVideoFrameCallback === "function") {
    try { video.cancelVideoFrameCallback(S.videoFrameCallbackId); } catch (_) {}
  }
  S.videoFrameCallbackId = null;
  S.videoUsesFrameCallback = false;
  S.hasReceivedVideoFrame = false;
  S.lastVideoFrameAt = 0;
}

function restoreRemotePlayback() {
  const video = $("remoteVideo");
  const peer = S.pc;
  if (!peer || peer.connectionState === "closed") return;
  try {
    if (S.remoteVideoStream && video.srcObject !== S.remoteVideoStream) video.srcObject = S.remoteVideoStream;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    if (S.audioContext && S.audioContext.state === "suspended") {
      S.audioContext.resume().catch(error => console.debug("AudioContext resume failed", error));
    }
    const playback = video.play();
    if (playback && typeof playback.catch === "function") {
      playback.catch(() => { $("videoState").textContent = "接続中です。画面をタップして映像を再生してください。"; });
    }
  } catch (error) { console.debug("Remote playback restore failed", error); }
}

function startVideoWatchdog(peer) {
  if (!peer || S.pc !== peer) return;
  stopVideoWatchdog();
  const video = $("remoteVideo");
  S.hasReceivedVideoFrame = false;
  S.lastVideoFrameAt = Date.now();
  let previousCurrentTime = -1;
  const markFrame = () => {
    if (S.pc !== peer) return;
    S.hasReceivedVideoFrame = true;
    S.lastVideoFrameAt = Date.now();
    $("videoState").textContent = "映像受信中";
    if (typeof video.requestVideoFrameCallback === "function") {
      S.videoUsesFrameCallback = true;
      S.videoFrameCallbackId = video.requestVideoFrameCallback(markFrame);
    }
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    S.videoUsesFrameCallback = true;
    S.videoFrameCallbackId = video.requestVideoFrameCallback(markFrame);
  }
  S.videoWatchdogTimer = setInterval(() => {
    if (S.pc !== peer || peer.connectionState !== "connected" || document.hidden) return;
    if (!S.videoUsesFrameCallback && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      if (video.currentTime > previousCurrentTime + 0.015) {
        previousCurrentTime = video.currentTime;
        S.hasReceivedVideoFrame = true;
        S.lastVideoFrameAt = Date.now();
      }
    }
    const now = Date.now();
    if (!S.hasReceivedVideoFrame && now - S.connectedAt > 15000) {
      $("videoState").textContent = "映像未着信・再接続中";
      scheduleReconnect(peer, true, 1200);
    } else if (S.hasReceivedVideoFrame && now - S.lastVideoFrameAt > 8000) {
      $("videoState").textContent = "映像フリーズ・再接続中";
      scheduleReconnect(peer, true, 1200);
    }
  }, 2000);
}

function rid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}

function openBookmarkletDialog() {
  const target = new URL("./", window.location.href);
  target.searchParams.set("quick", "1");
  const code = "javascript:(()=>{window.open(" + JSON.stringify(target.href) + ",\"RemoteCameraWeb2\",\"noopener\");})();";
  $("bookmarkletCode").value = code;
  $("bookmarkDialog").showModal();
}

async function copyBookmarkletCode() {
  const field = $("bookmarkletCode");
  const code = field.value;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      field.focus();
      field.select();
      if (!document.execCommand("copy")) throw Error("自動コピーできませんでした。コード欄を長押ししてコピーしてください。");
    }
    $("bookmarkMessage").textContent = "コピーしました。ブックマークのURL欄へ貼り付けてください。";
  } catch (error) {
    field.focus();
    field.select();
    $("bookmarkMessage").textContent = error.message || "コード欄を選択したので、長押ししてコピーしてください。";
  }
}

function handleQuickLaunch() {
  if (new URLSearchParams(window.location.search).get("quick") !== "1") return;
  if (S.device) toast("ブックマークレットから起動しました。接続ボタンを押すと監視を開始します。");
  else toast("Web2を開きました。先にAndroidをペアリングしてください。");
}

const MOTION_SETTINGS_KEY = "rc_motion_settings_v1";
function motionPendingKey(deviceId) {
  return "rc_motion_pending_v1_" + String(deviceId || "unpaired");
}
function loadMotionSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MOTION_SETTINGS_KEY) || "{}");
    S.motion.enabled = saved.enabled === true;
    S.motion.sensitivity = Math.max(1, Math.min(5, Number(saved.sensitivity) || 3));
  } catch (_) { S.motion.enabled = false; S.motion.sensitivity = 3; }
  $("motionEnabled").checked = S.motion.enabled;
  $("motionSensitivity").value = String(S.motion.sensitivity);
  $("motionStatus").textContent = S.motion.enabled ? "動体検知ON・映像接続待ち（画像は保存しません）" : "動体検知OFF";
  updateMotionNotificationButton();
}
function saveMotionSettings() {
  S.motion.enabled = $("motionEnabled").checked;
  S.motion.sensitivity = Math.max(1, Math.min(5, Number($("motionSensitivity").value) || 3));
  localStorage.setItem(MOTION_SETTINGS_KEY, JSON.stringify({ enabled: S.motion.enabled, sensitivity: S.motion.sensitivity }));
  if (!S.motion.enabled) stopMotionDetection("動体検知OFF");
  else if (S.pc && $("remoteVideo").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) startMotionDetection();
  else $("motionStatus").textContent = "動体検知ON・映像接続待ち";
}
function updateMotionNotificationButton() {
  const supported = "Notification" in window;
  $("motionNotify").disabled = !supported;
  $("motionNotify").textContent = !supported ? "このブラウザーは通知API非対応"
    : Notification.permission === "granted" ? "検知通知：許可済み"
    : Notification.permission === "denied" ? "検知通知：ブラウザー設定で許可してください"
    : "検知通知を有効にする";
}
async function enableMotionNotifications() {
  if (!("Notification" in window)) { toast("このブラウザーでは通知を利用できません。画面内通知は利用できます。"); return; }
  try {
    const permission = await Notification.requestPermission();
    updateMotionNotificationButton();
    toast(permission === "granted" ? "動体検知通知を有効にしました。" : "通知は許可されませんでした。画面内通知を使用します。");
  } catch (error) { toast("通知設定を開けませんでした: " + (error.message || "ブラウザーの制限")); }
}
function stopMotionDetection(message) {
  if (S.motion.timer) clearInterval(S.motion.timer);
  S.motion.timer = null; S.motion.previous = null; S.motion.streak = 0;
  if (message) $("motionStatus").textContent = message;
}
function startMotionDetection() {
  const video = $("remoteVideo");
  if (!S.motion.enabled || !S.pc || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth || !video.videoHeight || S.motion.timer) return;
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 36;
  let context;
  try { context = canvas.getContext("2d", { willReadFrequently: true }); }
  catch (_) { context = canvas.getContext("2d"); }
  if (!context || !window.MotionCore) { $("motionStatus").textContent = "動体検知を開始できません（Canvas機能を確認してください）"; return; }
  S.motion.previous = null; S.motion.streak = 0;
  $("motionStatus").textContent = "動体検知中・画像は保存していません";
  S.motion.timer = setInterval(() => {
    if (!S.motion.enabled || !S.pc || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !video.videoWidth || !video.videoHeight || document.hidden) return;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = MotionCore.toLumaPixels(context.getImageData(0, 0, canvas.width, canvas.height).data);
      if (S.motion.previous) {
        const result = MotionCore.measure(S.motion.previous, pixels, S.motion.sensitivity);
        if (result.valid && result.score >= MotionCore.minimumScore(S.motion.sensitivity)) S.motion.streak += 1;
        else S.motion.streak = 0;
        if (S.motion.streak >= 2 && Date.now() - S.motion.lastEventAt >= 10000) {
          S.motion.lastEventAt = Date.now(); S.motion.streak = 0;
          recordMotionEvent(result.score).catch(error => console.warn("Motion event save failed", error));
        }
      }
      S.motion.previous = pixels;
    } catch (error) {
      stopMotionDetection("動体検知を一時停止しました。映像表示を確認してください。");
      console.warn("Motion detection stopped", error);
    }
  }, 600);
}
function readPendingMotionEvents(deviceId) {
  try {
    const value = JSON.parse(localStorage.getItem(motionPendingKey(deviceId || (S.device && S.device.deviceId))) || "[]");
    return Array.isArray(value) ? value.filter(item =>
      item && typeof item.eventId === "string" && /^[A-Za-z0-9._:-]{8,100}$/.test(item.eventId) &&
      Number.isFinite(Number(item.detectedAt)) &&
      Number(item.detectedAt) >= Date.now() - 30 * 86400000 &&
      Number(item.detectedAt) <= Date.now() + 60000 &&
      Number.isFinite(Number(item.motionScore)) &&
      Number(item.motionScore) >= 0 && Number(item.motionScore) <= 100
    ) : [];
  } catch (_) { return []; }
}
async function syncMotionEvent(event, device = S.device) {
  if (!device) throw Error("Android端末が選択されていません。");
  return api("add_motion_event", {
    controllerToken: device.controllerToken, deviceId: device.deviceId,
    eventId: event.eventId, detectedAt: event.detectedAt, motionScore: event.motionScore,
    sensitivity: event.sensitivity, source: "browser-motion-v1"
  });
}
async function recordMotionEvent(score) {
  const targetDevice = S.device;
  if (!targetDevice) return;
  const event = {
    eventId: rid(), detectedAt: Date.now(),
    motionScore: Math.min(100, Math.max(0, Math.round(score * 10) / 10)),
    sensitivity: S.motion.sensitivity, source: "browser-motion-v1"
  };
  const pending = readPendingMotionEvents(targetDevice.deviceId); pending.push(event);
  localStorage.setItem(motionPendingKey(targetDevice.deviceId), JSON.stringify(pending.slice(-100)));
  $("motionStatus").textContent = "動きを検知しました：" + event.motionScore.toFixed(1) + "%";
  toast("動体を検知しました。");
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Remote Camera：動体を検知", {
      body: "動きの強さ " + event.motionScore.toFixed(1) + "% · " + new Date(event.detectedAt).toLocaleTimeString(),
      tag: "remote-camera-motion"
    }); } catch (error) { console.warn("Browser notification unavailable", error); }
  }
  await flushMotionEvents(targetDevice);
}
async function flushMotionEvents(targetDevice = S.device) {
  if (!targetDevice || S.motion.sendingDevices.has(targetDevice.deviceId)) return;
  const targetDeviceId = targetDevice.deviceId;
  S.motion.sendingDevices.add(targetDeviceId);
  try {
    let pending = readPendingMotionEvents(targetDeviceId);
    while (pending.length) {
      const event = pending[0];
      await syncMotionEvent(event, targetDevice);
      pending = pending.filter(item => item.eventId !== event.eventId);
      localStorage.setItem(motionPendingKey(targetDeviceId), JSON.stringify(pending));
    }
  } catch (error) {
    if (S.device && S.device.deviceId === targetDeviceId) {
      $("motionStatus").textContent = "検知イベントを一時保存中。接続回復後に再送します。";
    }
    console.warn("Motion event retry queued", error);
  } finally { S.motion.sendingDevices.delete(targetDeviceId); }
}
function csvCell(value) {
  let text = String(value == null ? "" : value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
async function loadMotionHistory(showDialog = true, limit = 500) {
  const device = S.device;
  if (!device) throw Error("Android端末をペアリングしてください。");
  const result = await api("get_motion_events", {
    controllerToken: device.controllerToken, deviceId: device.deviceId,
    limit: Math.max(1, Math.min(2000, Number(limit) || 500))
  });
  if (!S.device || S.device.deviceId !== device.deviceId) throw Error("端末が切り替わりました。履歴を再読み込みしてください。");
  const all = [...(result.events || []), ...readPendingMotionEvents(device.deviceId).map(item => ({
    eventId: item.eventId, detectedAt: new Date(item.detectedAt).toISOString(),
    motionScore: item.motionScore, sensitivity: item.sensitivity, source: item.source, pending: true
  }))];
  const unique = new Map(); all.forEach(item => unique.set(item.eventId, item));
  const events = [...unique.values()].sort((a,b) => new Date(b.detectedAt)-new Date(a.detectedAt));
  $("motionRows").replaceChildren();
  events.forEach(event => {
    const row=document.createElement("div"); row.className="historyrow";
    const left=document.createElement("span"); const right=document.createElement("b");
    left.textContent=new Date(event.detectedAt).toLocaleString()+(event.pending?" · 送信待ち":"");
    right.textContent=Number(event.motionScore).toFixed(1)+"%";
    row.append(left,right); $("motionRows").append(row);
  });
  if (!events.length) {
    const empty=document.createElement("p"); empty.className="muted";
    empty.textContent="検知履歴はありません。"; $("motionRows").append(empty);
  }
  if (showDialog) $("motionDialog").showModal();
  return events;
}
async function exportMotionCsv() {
  const events=await loadMotionHistory(false, 2000);
  const rows=[["検知日時","動体スコア(%)","検知感度","記録元"]];
  events.forEach(event=>rows.push([new Date(event.detectedAt).toISOString(),Number(event.motionScore).toFixed(1),event.sensitivity,event.source||"browser-motion-v1"]));
  const csv="\uFEFF"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const anchor=document.createElement("a"); anchor.href=url;
  anchor.download="remote-camera-motion-history-"+new Date().toISOString().slice(0,10)+".csv";
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function clearMotionHistory() {
  const device = S.device;
  if (!device || !confirm("このAndroid端末の動体検知履歴を削除しますか？")) return;
  const result=await api("delete_motion_events",{controllerToken:device.controllerToken,deviceId:device.deviceId});
  localStorage.removeItem(motionPendingKey(device.deviceId));
  if (!S.device || S.device.deviceId !== device.deviceId) return;
  $("motionRows").replaceChildren();
  $("motionRows").textContent="検知履歴を "+(result.deleted||0)+" 件削除しました。";
  toast("動体検知履歴を削除しました。");
}
function applyViewerZoom() {
  const zoom=Math.max(100,Math.min(300,Number($("zoom").value)||100));
  $("zoomValue").value=zoom+"%";
  $("remoteVideo").style.transform="scale("+(zoom/100)+")";
}
function toggleFitMode() {
  const video = $("remoteVideo");
  video.style.objectFit = video.style.objectFit === "cover" ? "contain" : "cover";
  $("fitMode").textContent = video.style.objectFit === "cover" ? "画面に合わせる" : "全体表示";
}
function nightViewStorageKey() {
  return "rc_night_view_v1_" + String(S.device ? S.device.deviceId : "default");
}
function applyNightViewFilter() {
  $("remoteVideo").style.filter = $("nightMode").checked
    ? "brightness(1.35) contrast(1.08) saturate(0.92)"
    : "";
}

function status(text, online = false) {
  $("status").textContent = text;
  $("status").className = "pill" + (online ? " online" : "");
}
function message(id, text, good = false) {
  $(id).textContent = text;
  $(id).style.color = good ? "#16714d" : "#b43e48";
}
function readDevices() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(x =>
      x && typeof x.deviceId === "string" &&
      typeof x.controllerToken === "string" && x.controllerToken.length > 20
    ) : [];
  } catch (_) {
    return [];
  }
}
function saveDevices() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(S.devices));
}
async function loadConfig() {
  const response = await fetch("./config.json", { cache: "no-store" });
  if (!response.ok) throw Error("config.jsonを読み込めません。");
  S.cfg = await response.json();
  if (typeof S.cfg.gasUrl !== "string" ||
      !S.cfg.gasUrl.startsWith("https://script.google.com/macros/s/") ||
      !S.cfg.gasUrl.endsWith("/exec") ||
      S.cfg.gasUrl.includes("GAS_EXEC_URL_HERE") ||
      S.cfg.gasUrl.includes("PASTE_YOUR_DEPLOYMENT_ID")) {
    throw Error("config.json の gasUrl にGASの /exec URLを設定してください。");
  }
}

/**
 * GAS HTML response is returned through a hidden iframe.
 * Match both the request ID and the exact iframe window before accepting it.
 */
function api(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = rid();
    const frame = document.createElement("iframe");
    const form = document.createElement("form");
    frame.name = "gas_" + id;
    frame.title = "GAS response";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    // Keep the iframe renderable: iOS Safari can be unreliable with hidden form targets.
    frame.style.cssText = "position:fixed;width:1px;height:1px;left:-2px;top:-2px;opacity:0;pointer-events:none;border:0";
    form.hidden = true;
    form.method = "POST";
    form.action = S.cfg.gasUrl;
    form.target = frame.name;

    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "payload";
    input.value = JSON.stringify({ action, requestId: id, ...data });
    form.appendChild(input);
    document.body.append(frame, form);

    let finished = false;
    const timer = setTimeout(() => finish(
      Error("GASから30秒以内に応答が届きませんでした。GASの再デプロイ状態と通信設定を確認してください。")
    ), Number(S.cfg.requestTimeoutMs) || 30000);

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener("message", listener);
      frame.remove();
      form.remove();
      if (error) reject(error);
      else resolve(value);
    }
    function listener(event) {
      // Apps Script HtmlService may nest its sandbox iframe. In that case the
      // message source is the nested Google frame, not frame.contentWindow.
      // The random requestId and trusted Google origin below bind the response.
      if (!event.data || event.data.channel !== "remote-camera-gas" ||
          event.data.requestId !== id) return;
      const origin = String(event.origin || "");
      const allowedOrigin = origin === "https://script.google.com" ||
        origin === "https://script.googleusercontent.com" ||
        origin.endsWith(".googleusercontent.com");
      if (!allowedOrigin) return;
      const result = event.data.result;
      if (!result || result.ok !== true) {
        finish(Error(result && result.error ? result.error : "GAS APIエラー"));
      } else {
        finish(null, result);
      }
    }
    window.addEventListener("message", listener);
    try {
      form.submit();
    } catch (error) {
      finish(error);
    }
  });
}

function renderDevices() {
  const box = $("devices");
  box.replaceChildren();
  if (!S.devices.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "登録済み端末はありません。Androidで監視待機を開始し、ペアリングしてください。";
    box.appendChild(p);
    return;
  }
  S.devices.forEach(device => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "deviceitem" + (S.device && S.device.deviceId === device.deviceId ? " selected" : "");
    const strong = document.createElement("b");
    const small = document.createElement("small");
    strong.textContent = device.deviceName || "Android端末";
    small.textContent = "端末ID: " + device.deviceId.slice(0, 12);
    button.append(strong, small);
    button.addEventListener("click", () => selectDevice(device));
    box.appendChild(button);
  });
}
function setControlsEnabled(enabled) {
  ["connect", "locate", "saveSettings", "history", "deleteHistory", "unpair", "reserveConnection", "motionHistory", "motionExport", "motionClear", "remoteMute"].forEach(id => {
    $(id).disabled = !enabled;
  });
  $("pttLock").disabled = !enabled || !S.pc;
  $("keepAwake").disabled = !enabled || !S.pc;
  $("connect").disabled = !enabled || !!S.pc || S.connecting;
  $("disconnect").disabled = !S.pc;
  $("torch").disabled = !S.pc || !S.control || S.control.readyState !== "open";
  $("camera").disabled = !enabled || !S.pc;
  $("ptt").disabled = !S.pc;
}
function selectDevice(device) {
  if ((S.pc || S.connecting) && S.device && S.device.deviceId !== device.deviceId) {
    toast("接続処理中または接続中は端末を切り替えられません。先に切断してください。");
    return;
  }
  S.device = device;
  localStorage.setItem(SELECTED_KEY, device.deviceId);
  $("deviceName").textContent = device.deviceName || "Android端末";
  $("deviceMeta").textContent = "端末ID: " + device.deviceId + " / このiPadにペアリング済み";
  renderDevices();
  setControlsEnabled(true);
  refreshReservationUi();
  status("ペアリング済み");
  loadSettings().catch(error => toast(error.message));
  flushMotionEvents().catch(error => console.warn("Motion queue flush failed", error));
}
function refreshDeviceList() {
  S.devices = readDevices();
  renderDevices();
  if (S.device) {
    const updated = S.devices.find(x => x.deviceId === S.device.deviceId);
    if (updated) S.device = updated;
  }
  if (!S.device && S.devices.length) {
    const id = localStorage.getItem(SELECTED_KEY);
    selectDevice(S.devices.find(x => x.deviceId === id) || S.devices[0]);
  } else if (!S.devices.length) {
    S.device = null;
    $("deviceName").textContent = "Android端末をペアリングしてください";
    $("deviceMeta").textContent = "待機中";
    setControlsEnabled(false);
    status("未ペアリング");
  }
}
async function claimDevice() {
  const code = $("pairCode").value.trim();
  const deviceName = $("pairName").value.trim();
  if (!/^\d{8}$/.test(code)) {
    message("pairMessage", "8桁の登録コードを入力してください。");
    return;
  }
  $("claim").disabled = true;
  message("pairMessage", "Android端末を確認しています…", true);
  try {
    const result = await api("claim_device", { code, deviceName });
    const device = {
      deviceId: result.deviceId,
      deviceName: result.deviceName || deviceName || "Android端末",
      controllerToken: result.controllerToken
    };
    S.devices = readDevices().filter(x => x.deviceId !== device.deviceId);
    S.devices.push(device);
    saveDevices();
    $("pairCode").value = "";
    $("pairName").value = "";
    $("pairDialog").close();
    refreshDeviceList();
    selectDevice(device);
    toast("Androidをペアリングしました。");
  } catch (error) {
    message("pairMessage", error.message);
  } finally {
    $("claim").disabled = false;
  }
}

function waitIce(pc, ms) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}
async function connect(automatic = false) {
  automatic = automatic === true;
  if (!S.device) return toast("先にAndroidをペアリングしてください。");
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return toast("このブラウザではマイクを利用できません。SafariのHTTPS接続を確認してください。");
  }
  if (S.connecting) return false;
  const device = S.device;
  if (!device) return false;
  if (!automatic) {
    S.manualDisconnect = false;
    S.reconnectAttempts = 0;
  }
  if (S.reconnectTimer) {
    clearTimeout(S.reconnectTimer);
    S.reconnectTimer = null;
  }
  S.connecting = true;
  $("connect").disabled = true;
  // Resume/create Web Audio while the Connect click still has user activation on iPad Safari.
  prepareAudioOutput();
  try {
    if (S.pc) await disconnect(false, automatic);
    if (!S.device || S.device.deviceId !== device.deviceId) {
      throw Error("接続先端末が変更されました。もう一度選択してください。");
    }
    // Reuse the already-authorized microphone during automatic recovery.
    let stream = S.mic;
    let localAudioTrack = stream && stream.getAudioTracks().find(track => track.readyState === "live");
    if (!localAudioTrack) {
      if (stream) stream.getTracks().forEach(track => track.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      S.mic = stream;
      localAudioTrack = stream.getAudioTracks()[0] || null;
    }
    if (!localAudioTrack) throw Error("マイク音声トラックを作成できませんでした。");
    if (!S.device || S.device.deviceId !== device.deviceId) throw Error("接続先端末が変更されました。");
    localAudioTrack.enabled = false;
    S.pttActive = false;
    S.session = rid();
    S.seq = 0;
    S.hasReceivedVideoFrame = false;
    try {
      const iceConfig = await api("get_ice_config", { controllerToken:device.controllerToken, deviceId:device.deviceId });
      if (!S.device || S.device.deviceId !== device.deviceId) throw Error("接続先端末が変更されました。");
      if (Array.isArray(iceConfig.iceServers) && iceConfig.iceServers.length) S.iceServers = iceConfig.iceServers;
    } catch (iceError) {
      console.warn("TURN configuration unavailable; continue with public STUN", iceError);
      S.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    const pc = new RTCPeerConnection({ iceServers: S.iceServers });
    S.pc = pc;
    const control = pc.createDataChannel("remote-control", { ordered: true });
    S.control = control;
    control.onopen = () => {
      if (S.pc !== pc) return;
      $("diagnostics").disabled = false;
      $("torch").disabled = false;
      status("監視中・DataChannel直接接続", true);
      $("streamState").textContent = "映像・音声・DataChannel接続中";
      startRtcStats();
      startVideoWatchdog(pc);
      sendControl("settings_update", readLiveSettings());
      $("remoteMute").disabled = false;
      $("pttLock").disabled = false;
      if (S.keepAwakeWanted && !S.wakeLock) enableScreenWakeLock().catch(() => {});
    };
    control.onclose = () => {
      if (S.pc !== pc) return;
      $("diagnostics").disabled = true;
      $("torch").disabled = true;
      stopRtcStats();
      status("制御チャネル切断");
      if (S.pc === pc && S.everConnected && !S.manualDisconnect) scheduleReconnect(pc);
    };
    control.onmessage = event => { if (S.pc === pc) handleControlMessage(event.data); };
    control.onerror = () => { if (S.pc === pc) toast("DataChannel通信エラー"); };
    $("camera").disabled = false;
    const remote = new MediaStream();
    S.remoteVideoStream = remote;
    $("remoteVideo").srcObject = remote;
    $("remoteVideo").muted = true;
    prepareAudioOutput();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTrack(localAudioTrack, stream);
    pc.ontrack = event => {
      if (S.pc !== pc) return;
      const tracks = event.streams[0] ? event.streams[0].getTracks() : [event.track];
      tracks.forEach(track => {
        if (!remote.getTracks().some(existing => existing.id === track.id)) remote.addTrack(track);
        if (track.kind === "video") {
          track.addEventListener("ended", () => {
            $("videoState").textContent = "映像トラック終了";
            stopMotionDetection("映像が終了しました。");
            if (S.pc === pc && !S.manualDisconnect) scheduleReconnect(pc, true, 1200);
          });
          track.addEventListener("mute", () => { $("videoState").textContent = "映像一時停止"; });
          track.addEventListener("unmute", () => { $("videoState").textContent = "映像再開中"; startMotionDetection(); });
        }
        if (track.kind === "audio" && !S.remoteAudioTracks.some(existing => existing.id === track.id)) {
          track.enabled = !S.pttActive && !S.remoteAudioMuted;
          track.addEventListener("unmute", () => attachRemoteAudio());
          track.addEventListener("ended", () => { $("audioState").textContent = "Androidマイク切断"; });
          S.remoteAudioTracks.push(track);
          attachRemoteAudio();
        }
      });
      $("placeholder").classList.add("hidden");
      $("remoteVideo").play().then(() => {
        restoreRemotePlayback();
        startVideoWatchdog(pc);
        startMotionDetection();
      }).catch(() => toast("映像・音声を再生するには画面をタップしてください。"));
    };
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      const state = pc.connectionState;
      $("iceState").textContent = "ICE: " + state;
      status(state === "connected" ? "監視中" : state, state === "connected");
      $("streamState").textContent = state === "connected" ? "映像・音声接続中" : "接続処理中";
      if (state === "connected") {
        S.everConnected = true;
        if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
        S.reconnectTimer = null;
        if (S.reconnectResetTimer) clearTimeout(S.reconnectResetTimer);
        S.reconnectResetTimer = setTimeout(() => {
          if (S.pc === pc && pc.connectionState === "connected") S.reconnectAttempts = 0;
          S.reconnectResetTimer = null;
        }, 30000);
        startSessionClock();
        startRtcStats();
        startVideoWatchdog(pc);
      } else if ((state === "failed" || state === "disconnected" || state === "closed") && S.everConnected && !S.manualDisconnect) {
        if (S.reconnectResetTimer) clearTimeout(S.reconnectResetTimer);
        S.reconnectResetTimer = null;
        stopSessionClock();
        scheduleReconnect(pc, false, state === "disconnected" ? 8000 : 1500);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc, 12000);
    await api("send_signal", {
      controllerToken: device.controllerToken,
      deviceId: device.deviceId,
      sessionId: S.session,
      recipient: "device",
      kind: "offer",
      sdp: pc.localDescription.sdp
    });
    $("connect").disabled = true;
    $("disconnect").disabled = false;
    $("ptt").disabled = false;
    $("streamState").textContent = "Android応答待ち";
    status("接続要求中");
    pollAnswers(pc, S.session, device);
    return true;
  } catch (error) {
    const permissionDenied = error.name === "NotAllowedError" || error.name === "PermissionDeniedError" || error.name === "SecurityError";
    await disconnect(false, !permissionDenied && (automatic || S.everConnected));
    toast("接続開始失敗: " + error.message);
    if (S.everConnected && !S.manualDisconnect) scheduleReconnect(null);
    return false;
  } finally {
    S.connecting = false;
    $("connect").disabled = !S.device || !!S.pc;
  }
}
function scheduleReconnect(expectedPc, forceReconnect = false, initialWait = null) {
  if (S.manualDisconnect || S.reconnectTimer || !S.everConnected || !S.device) return;
  const waits = [2500, 5000, 10000, 15000, 20000];
  if (S.reconnectAttempts >= waits.length) {
    toast("自動再接続を5回試しました。回線とAndroidの待機状態を確認してください。");
    return;
  }
  const attempt = S.reconnectAttempts + 1;
  const wait = initialWait === null ? waits[S.reconnectAttempts] : initialWait;
  status("再接続を準備中");
  $("streamState").textContent = "再接続 " + attempt + "/" + waits.length;
  S.reconnectTimer = setTimeout(async () => {
    S.reconnectTimer = null;
    if (S.manualDisconnect || !S.device || (expectedPc && S.pc !== expectedPc)) return;
    if (expectedPc && expectedPc.connectionState === "connected" && !forceReconnect) return;
    S.reconnectAttempts = attempt;
    const ok = await connect(true);
    if (!ok && !S.reconnectTimer) scheduleReconnect(null);
  }, wait);
}
async function pollAnswers(peer, sessionId, device) {
  while (S.pc === peer && S.session === sessionId && S.device &&
      S.device.deviceId === device.deviceId && (!S.control || S.control.readyState !== "open")) {
    try {
      const result = await api("poll_signals", {
        controllerToken: device.controllerToken, deviceId: device.deviceId,
        sessionId: sessionId, afterSeq: S.seq
      });
      if (S.pc !== peer || S.session !== sessionId) return;
      for (const signal of result.signals || []) {
        S.seq = Math.max(S.seq, Number(signal.seq) || 0);
        if (signal.kind === "answer" && !peer.remoteDescription) {
          await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        } else if (signal.kind === "error") toast(signal.sdp || "Android側で接続エラーが発生しました。");
      }
    } catch (error) { console.warn("pollAnswers", error); }
    await new Promise(resolve => setTimeout(resolve, Number(S.cfg.pollIntervalMs) || 2500));
  }
}
async function disconnect(sendCommand = true, preserveMic = false) {
  if (sendCommand) {
    S.manualDisconnect = true;
    S.pttLocked = false;
    S.everConnected = false;
    S.reconnectAttempts = 0;
    if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
    S.reconnectTimer = null;
    if (S.reconnectResetTimer) clearTimeout(S.reconnectResetTimer);
    S.reconnectResetTimer = null;
  }
  const device = S.device;
  const sessionId = S.session;
  const old = S.pc;
  if (sendCommand && old && device && sessionId) {
    const channelOpen = S.control && S.control.readyState === "open";
    if (channelOpen) sendControl("disconnect", {});
    try {
      await api("send_signal", {
        controllerToken:device.controllerToken, deviceId:device.deviceId,
        sessionId:sessionId, recipient:"device", kind:"bye"
      });
    } catch (error) {
      console.warn("Session bye signal failed", error);
      if (!channelOpen) {
        try {
          await api("send_command", {
            controllerToken:device.controllerToken, deviceId:device.deviceId,
            command:"disconnect", payload:{sessionId:sessionId}
          });
        } catch (commandError) {
          console.warn("Session disconnect command failed", commandError);
        }
      }
    }
  }

  stopRtcStats();
  stopVideoWatchdog();
  stopSessionClock();
  stopMotionDetection("動体検知：映像未接続");
  stopPttSafetyTimer();
  S.pttLocked = false;
  S.pttKeyActive = false;
  S.pttActive = false;
  $("pttLock").textContent = "送話ロック OFF";
  $("pttLock").classList.remove("active");
  try {
    const track = S.mic && S.mic.getAudioTracks()[0];
    if (track) track.enabled = false;
  } catch (_) {}
  stopAudioMeter();
  try { S.remoteAudioSource?.disconnect(); } catch (_) {}
  S.remoteAudioSource = null;
  S.remoteAnalyser = null;

  if (sendCommand && S.wakeLock) {
    try { await S.wakeLock.release(); } catch (_) {}
    S.wakeLock = null;
    S.keepAwakeWanted = false;
    $("keepAwake").classList.remove("active");
    $("keepAwake").textContent = "画面スリープ防止 OFF";
  }

  S.pc = null;
  try { S.control?.close(); } catch (_) {}
  S.control = null;
  S.session = "";
  try { old?.close(); } catch (_) {}

  if (!preserveMic && S.mic) {
    S.mic.getTracks().forEach(track => track.stop());
    S.mic = null;
  }
  S.remoteAudioTracks = [];
  S.remoteVideoStream = null;
  $("remoteVideo").srcObject = null;
  $("remoteVideo").muted = false;
  $("placeholder").classList.remove("hidden");
  $("connect").disabled = !S.device || S.connecting;
  $("disconnect").disabled = true;
  $("camera").disabled = true;
  $("torch").disabled = true;
  $("diagnostics").disabled = true;
  $("remoteMute").disabled = true;
  $("ptt").disabled = true;
  $("ptt").classList.remove("active");
  $("ptt").textContent = "🎙 押している間だけ話す";
  $("audioState").textContent = "Androidマイク待機中";
  $("videoState").textContent = "映像待機中";
  $("audioLevel").value = "0";
  $("audioLevelText").textContent = "待機中";
  $("streamState").textContent = "切断済み";
  $("iceState").textContent = "ICE: --";
  $("remoteMute").textContent = "🔊 Android音声 ON";
  $("remoteMute").classList.remove("active");
  S.remoteAudioMuted = false;

  if (S.device) status("ペアリング済み");
  else status("未ペアリング");
  $("pttLock").disabled = !S.device;
  $("keepAwake").disabled = !S.device;
}
async function loadSettings() {
  const device = S.device;
  if (!device) return;
  const result = await api("get_settings", {
    controllerToken: device.controllerToken,
    deviceId: device.deviceId
  });
  if (!S.device || S.device.deviceId !== device.deviceId) return;
  const settings = result.settings || {};
  $("quality").value = settings.quality || "720";
  $("dataMode").value = settings.dataMode || "standard";
  $("connectedLoc").checked = !!settings.connectedLocationEnabled;
  $("idleLoc").checked = !!settings.idleLocationEnabled;
  $("connectedInterval").value = String(settings.connectedInterval || 30);
  $("idleInterval").value = String(settings.idleInterval || 300);
  $("micNoise").value=String(settings.micNoise ?? 0);
  $("micSensitivity").value=String(settings.micSensitivity ?? 0);
  $("micGain").value=String(settings.micGain ?? 100);
  $("androidSpeakerVolume").value=String(settings.speakerVolume ?? 70);
  $("micMode").value=["ambient","balanced","voice"].includes(settings.micMode) ? settings.micMode : "ambient";
  const storedReceive = localStorage.getItem("rc_receive_volume_v1");
  setReceiveVolume(storedReceive === null ? 70 : Number(storedReceive), false);
  $("nightMode").checked=localStorage.getItem(nightViewStorageKey()) === "true";
  applyNightViewFilter();
  $("fps").value=String(settings.fps || 24);
  $("aspectRatio").value=settings.aspectRatio || "16:9";
  applyAspectRatio($("aspectRatio").value);
  updateSliderLabels();
}
function queueDeviceSettingsSave(device, settings) {
  const work = () => api("save_settings", {
    controllerToken: device.controllerToken,
    deviceId: device.deviceId,
    settings: settings
  });
  const next = S.settingsSaveQueue.catch(() => {}).then(work);
  S.settingsSaveQueue = next.catch(() => {});
  return next;
}

async function saveSettings() {
  const device = S.device;
  if (!device) return toast("Android端末をペアリングしてください。");
  const settings = {
    quality: $("quality").value,
    dataMode: $("dataMode").value,
    fps: Number($("fps").value),
    aspectRatio: $("aspectRatio").value,
    connectedLocationEnabled: $("connectedLoc").checked,
    idleLocationEnabled: $("idleLoc").checked,
    connectedInterval: Number($("connectedInterval").value),
    idleInterval: Number($("idleInterval").value),
    micNoise:Number($("micNoise").value), micSensitivity:Number($("micSensitivity").value),
    micGain:Number($("micGain").value), speakerVolume:Number($("androidSpeakerVolume").value),
    micMode:$("micMode").value
  };
  if(S.control?.readyState==="open") {
    if (!sendControl("settings_update",settings)) throw Error("DataChannelへの設定送信に失敗しました。");
    try { localStorage.setItem("rc_live_settings_"+device.deviceId,JSON.stringify(settings)); }
    catch (storageError) { console.warn("Local setting cache unavailable", storageError); }
    queueDeviceSettingsSave(device, settings)
      .then(()=>toast(settings.micMode !== "ambient" ? "設定を保存しました。マイク集音モードは次回接続から反映します。" : "設定をDataChannelで反映し、GASへ保存しました。"))
      .catch(error=>toast("設定は反映済みですが、GAS保存に失敗しました: "+error.message));
  } else {
    await queueDeviceSettingsSave(device, settings);
    if (S.device && S.device.deviceId === device.deviceId) {
      await api("send_command",{controllerToken:device.controllerToken,deviceId:device.deviceId,command:"quality",payload:{quality:settings.quality,dataMode:settings.dataMode,fps:settings.fps,aspectRatio:settings.aspectRatio}});
    }
    toast("設定を保存しました。次回接続時に反映します。");
  }
}
function sendControl(name,payload={}) {
  if(!S.control||S.control.readyState!=="open"){toast("DataChannelが未接続です。");return false;}
  S.control.send(JSON.stringify({type:"command",command:name,requestId:rid(),payload}));return true;
}
function readLiveSettings(){return {quality:$("quality").value,dataMode:$("dataMode").value,fps:Number($("fps").value),aspectRatio:$("aspectRatio").value,micNoise:Number($("micNoise").value),micSensitivity:Number($("micSensitivity").value),micGain:Number($("micGain").value),speakerVolume:Number($("androidSpeakerVolume").value),micMode:$("micMode").value};}
function bytesText(value){const b=Math.max(0,Number(value)||0);if(b<1024)return b.toFixed(0)+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";return (b/1048576).toFixed(2)+" MB";}
function updateSliderLabels(){$("androidSpeakerVolumeValue").value=$("androidSpeakerVolume").value+"%";$("micNoiseValue").value=$("micNoise").value+"%";$("micSensitivityValue").value=$("micSensitivity").value+"%";$("micGainValue").value=$("micGain").value+"%";$("receiveVolumeValue").value=S.receiveVolume+"%";}
function handleControlMessage(raw){let d;try{d=JSON.parse(raw);}catch(_){return;}
 if(d.type==="ack"){$("networkSummary").textContent=d.message||(d.ok?"Android受信済み":"適用失敗");if(!d.ok)toast(d.message||"Android側で適用失敗");}
 else if(d.type==="camera_capabilities"){
  const select=$("camera");
  const cameras=Array.isArray(d.cameras)?d.cameras:[];
  if(cameras.length){
   const previous=select.value;
   select.replaceChildren();
   cameras.forEach(camera=>{
    if(!camera||typeof camera.id!=="string")return;
    const option=document.createElement("option");
    option.value=camera.id;
    option.textContent=String(camera.label||"カメラ");
    option.dataset.facing=String(camera.facing||"back");
    select.appendChild(option);
   });
   const target=String(d.selectedCameraId||previous||"");
   if([...select.options].some(option=>option.value===target))select.value=target;
   toast("端末が対応するカメラ・画角を読み込みました。");
  }
 }
 else if(d.type==="telemetry"){const tx=Number(d.txBytesSinceConnect),rx=Number(d.rxBytesSinceConnect);$("deviceTx").textContent="送信 "+(tx<0?"取得不可":bytesText(tx));$("deviceRx").textContent="受信 "+(rx<0?"取得不可":bytesText(rx));$("deviceTxSpeed").textContent="送信速度 "+(Number(d.txBytesPerSecond)<0?"取得不可":bytesText(d.txBytesPerSecond)+"/s");$("deviceRxSpeed").textContent="受信速度 "+(Number(d.rxBytesPerSecond)<0?"取得不可":bytesText(d.rxBytesPerSecond)+"/s");$("deviceTotal").textContent="合計 "+(tx<0||rx<0?"取得不可":bytesText(tx+rx));$("deviceHealth").textContent="バッテリー "+(d.batteryPercent>=0?d.batteryPercent+"%":"--")+" / 温度 "+(d.batteryTempC>=0?d.batteryTempC+"℃":"--");if(d.network)$("networkSummary").textContent=(d.network.transport||"不明")+(d.network.validated?" / Internet OK":" / Internet未確認");}
 else if(d.type==="network_diagnostic"){$("diagnosticOutput").textContent=JSON.stringify(d.data||d,null,2);}
 else if(d.type==="error"){toast(d.message||"Androidエラー");$("diagnosticOutput").textContent=d.message||"Androidエラー";}
}
function stopRtcStats(){if(S.statsTimer)clearInterval(S.statsTimer);S.statsTimer=null;}
function maybeAdaptQuality(rttMs, lossPercent) {
  const selectedQuality = $("quality").value;
  const selectedMode = $("dataMode").value;
  if (selectedQuality !== "auto" && selectedMode !== "auto") return;
  const now = Date.now();
  const bad = (Number.isFinite(rttMs) && rttMs > 550) || (Number.isFinite(lossPercent) && lossPercent > 8);
  const good = (rttMs === null || rttMs < 260) && (lossPercent === null || lossPercent < 1.8);
  if (bad) { S.adaptive.bad += 1; S.adaptive.good = 0; }
  else if (good) { S.adaptive.good += 1; S.adaptive.bad = 0; }
  else { S.adaptive.bad = 0; S.adaptive.good = 0; }
  let nextTier = S.adaptive.tier;
  if (S.adaptive.bad >= 2) nextTier = Math.max(0, S.adaptive.tier - 1);
  else if (S.adaptive.good >= 5) nextTier = Math.min(2, S.adaptive.tier + 1);
  if (nextTier === S.adaptive.tier || now - S.adaptive.lastChange < 10000) return;
  S.adaptive.tier = nextTier;
  S.adaptive.bad = 0; S.adaptive.good = 0; S.adaptive.lastChange = now;
  const tiers = [
    { quality: "360", dataMode: "ultra", fps: 15, label: "低負荷 360p" },
    { quality: "480", dataMode: "save", fps: 15, label: "節約 480p" },
    { quality: "720", dataMode: "standard", fps: 24, label: "標準 720p" }
  ];
  const tier = tiers[nextTier];
  const payload = {
    quality: selectedQuality === "auto" ? tier.quality : selectedQuality,
    dataMode: selectedMode === "auto" ? tier.dataMode : selectedMode,
    fps: tier.fps,
    adaptive: true
  };
  if (sendControl("adaptive_quality", payload)) {
    $("networkSummary").textContent = "自動画質：" + tier.label;
    toast("通信状態に合わせて画質を調整しました（" + tier.label + "）。");
  }
}
function startRtcStats() {
  stopRtcStats();
  const update = async () => {
    const peer = S.pc;
    if (!peer) return;
    try {
      const stats = await peer.getStats();
      if (peer !== S.pc) return;
      let sent = 0, received = 0, rtt = null, lost = 0, packets = 0;
      stats.forEach(item => {
        if (item.type === "outbound-rtp" && !item.isRemote) sent += Number(item.bytesSent || 0);
        if (item.type === "inbound-rtp" && !item.isRemote) {
          received += Number(item.bytesReceived || 0);
          lost += Math.max(0, Number(item.packetsLost || 0));
          packets += Math.max(0, Number(item.packetsReceived || 0));
        }
        if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated &&
            Number.isFinite(item.currentRoundTripTime)) rtt = item.currentRoundTripTime;
      });
      const lossPercent = packets + lost ? lost / (packets + lost) * 100 : null;
      $("rtcStats").textContent = "RTP " + bytesText(sent + received) +
        " / RTT " + (rtt === null ? "--" : Math.round(rtt * 1000) + "ms") +
        " / 損失 " + (lossPercent === null ? "--" : lossPercent.toFixed(1) + "%");
      maybeAdaptQuality(rtt === null ? null : rtt * 1000, lossPercent);
    } catch (_) {
      $("rtcStats").textContent = "統計取得不可";
    }
  };
  update();
  S.statsTimer = setInterval(update, 2000);
}
async function command(name,payload={}) {
  if (!S.device) throw Error("Android端末をペアリングしてください。");
  if (S.control?.readyState === "open") {
    if (!sendControl(name,payload)) throw Error("DataChannelへの送信に失敗しました。");
    toast("DataChannelでAndroidへ直接送信しました。"); return true;
  }
  await api("send_command",{controllerToken:S.device.controllerToken,deviceId:S.device.deviceId,command:name,payload});
  toast("接続前命令をGASに登録しました。"); return true;
}

async function unpairSelectedDevice() {
  if (!S.device) return;
  if (!confirm("このAndroid端末とiPadのペアリングを解除します。Android側の監視映像・音声も次回通信時に停止します。よろしいですか？")) return;
  const selected = S.device;
  $("unpair").disabled = true;
  try {
    await disconnect(true);
    await api("unpair_device", {
      controllerToken: selected.controllerToken,
      deviceId: selected.deviceId
    });
    S.devices = S.devices.filter(device => device.deviceId !== selected.deviceId);
    saveDevices();
    localStorage.removeItem(SELECTED_KEY);
    S.device = null;
    refreshDeviceList();
    status("ペアリング解除済み");
    toast("ペアリングを解除しました。");
  } catch (error) {
    toast("ペアリング解除失敗: " + error.message);
    $("unpair").disabled = false;
  }
}

async function loadHistory() {
  const device = S.device;
  if (!device) return toast("Android端末をペアリングしてください。");
  const result = await api("get_locations", {
    controllerToken: device.controllerToken,
    deviceId: device.deviceId,
    limit: 500
  });
  if (!S.device || S.device.deviceId !== device.deviceId) return;
  S.history = result.locations || [];
  $("historyRows").replaceChildren();
  for (const point of [...S.history].reverse()) {
    const row = document.createElement("div");
    const span = document.createElement("span");
    const button = document.createElement("button");
    row.className = "historyrow";
    span.textContent = new Date(point.timestamp).toLocaleString() + " · " +
      Number(point.lat).toFixed(5) + ", " + Number(point.lng).toFixed(5);
    button.textContent = "地図";
    button.type = "button";
    button.addEventListener("click", () => {
      showMap();
      drawMap([point]);
      $("historyDialog").close();
    });
    row.append(span, button);
    $("historyRows").append(row);
  }
  showMap();
  drawMap(S.history);
  $("historyDialog").showModal();
}
function initMap() {
  if (S.map || !window.L) return;
  S.map = L.map("map").setView([35.6812, 139.7671], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(S.map);
}
function applyAspectRatio(value) {
  const ratios = { "16:9": "16 / 9", "4:3": "4 / 3", "1:1": "1 / 1" };
  const pane = $("videoPane");
  if (!pane) return;
  if (value === "original" || !ratios[value]) {
    pane.style.aspectRatio = "";
    pane.style.flex = "1";
    pane.style.minHeight = "380px";
  } else {
    pane.style.aspectRatio = ratios[value];
    pane.style.flex = "none";
    pane.style.height = "auto";
    pane.style.minHeight = "240px";
    pane.style.maxHeight = "calc(100vh - 220px)";
  }
}
async function toggleFullscreen() {
  const pane = $("videoPane");
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (pane.requestFullscreen) await pane.requestFullscreen();
    else if (pane.webkitRequestFullscreen) pane.webkitRequestFullscreen();
    else if ($("remoteVideo").webkitEnterFullscreen) $("remoteVideo").webkitEnterFullscreen();
    else toast("このブラウザーでは全画面表示を利用できません。");
  } catch (error) {
    toast("全画面表示に失敗しました: " + (error.message || "ブラウザーの制限"));
  }
}
function showMap() {
  $("videoPane").classList.add("hidden");
  $("mapPane").classList.remove("hidden");
  $("mapTab").classList.add("active");
  $("videoTab").classList.remove("active");
  initMap();
  setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 100);
}
function showVideo() {
  $("mapPane").classList.add("hidden");
  $("videoPane").classList.remove("hidden");
  $("videoTab").classList.add("active");
  $("mapTab").classList.remove("active");
}
function drawMap(points) {
  initMap();
  if (!S.map) return;
  if (S.marker) S.marker.remove();
  if (S.route) S.route.remove();
  const valid = points.filter(point =>
    Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
  );
  if (!valid.length) {
    $("locationInfo").textContent = "位置情報はありません。";
    return;
  }
  const last = valid[valid.length - 1];
  S.marker = L.marker([last.lat, last.lng]).addTo(S.map);
  if (valid.length > 1) {
    S.route = L.polyline(valid.map(point => [point.lat, point.lng]), { color: "#2865d6" }).addTo(S.map);
  }
  $("locationInfo").textContent = "最終取得: " + new Date(last.timestamp).toLocaleString() +
    " / 精度 ±" + (last.accuracy || "?") + "m";
  if (S.route) S.map.fitBounds(S.route.getBounds().pad(0.15));
  else S.map.setView([last.lat, last.lng], 15);
}
async function deleteHistory() {
  const device = S.device;
  if (!device || !confirm("この端末の位置情報履歴をすべて削除します。よろしいですか？")) return;
  const result = await api("delete_locations", {
    controllerToken: device.controllerToken,
    deviceId: device.deviceId,
    all: true
  });
  if (!S.device || S.device.deviceId !== device.deviceId) return;
  S.history = [];
  drawMap([]);
  toast("履歴を " + (result.deleted || 0) + " 件削除しました。");
}


const RESERVATION_KEY="rc_connection_reservation_v1";
function readReservation(){try{return JSON.parse(localStorage.getItem(RESERVATION_KEY)||"null");}catch(_){return null;}}
function refreshReservationUi(){
 const r=readReservation();const valid=r&&Number.isFinite(Number(r.when));
 $("reservationStatus").textContent=valid?"予約中："+new Date(Number(r.when)).toLocaleString()+(S.device&&r.deviceId===S.device.deviceId?"":"（別端末の予約）"):"予約なし";
 $("cancelReservation").disabled=!valid;
}
async function reserveConnection(){
 if(!S.device)throw Error("先にAndroid端末をペアリングしてください。");
 const input=$("reserveAt").value;const when=new Date(input).getTime();
 if(!Number.isFinite(when)||when<Date.now()+15000)throw Error("15秒以上先の日時を指定してください。");
 // Request microphone permission during the user gesture; no track is kept while waiting.
 if(!navigator.mediaDevices?.getUserMedia)throw Error("このブラウザーではマイクを利用できません。");
 const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
 stream.getTracks().forEach(track=>track.stop());
 localStorage.setItem(RESERVATION_KEY,JSON.stringify({deviceId:S.device.deviceId,when}));
 refreshReservationUi();toast("接続予約を保存しました。予約時刻にこのWeb画面が動作している必要があります。");
}
function cancelConnectionReservation(){localStorage.removeItem(RESERVATION_KEY);refreshReservationUi();toast("接続予約を解除しました。");}
function checkConnectionReservation(){
 const r=readReservation();if(!r||!Number.isFinite(Number(r.when))||Date.now()<Number(r.when))return;
 localStorage.removeItem(RESERVATION_KEY);refreshReservationUi();
 if(!S.device||S.device.deviceId!==r.deviceId){toast("予約時刻になりましたが、対象Androidが選択されていません。");return;}
 if(S.pc){toast("予約時刻になりましたが、すでに接続中です。");return;}
 toast("予約した接続を開始します。");connect(true);
}

document.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(error => console.warn("PWA service worker unavailable", error));
  $("refresh").addEventListener("click", refreshDeviceList);
  $("pair").addEventListener("click", () => $("pairDialog").showModal());
  $("unpair").addEventListener("click", () => unpairSelectedDevice());
  $("claim").addEventListener("click", claimDevice);
  $("connect").addEventListener("click", () => connect(false));
  $("disconnect").addEventListener("click", () => disconnect(true));
  $("ptt").addEventListener("pointerdown", event => {
    if (!S.pc || !S.mic) return;
    event.preventDefault();
    try { $("ptt").setPointerCapture(event.pointerId); } catch (_) {}
    if (S.pttLocked) {
      S.pttLocked = false;
      $("pttLock").textContent = "送話ロック OFF";
      $("pttLock").classList.remove("active");
      ptt(false);
      return;
    }
    ptt(true);
  });
  ["pointerup", "pointerleave", "pointercancel", "lostpointercapture"].forEach(name => {
    $("ptt").addEventListener(name, () => { if (!S.pttLocked) ptt(false); });
  });
  $("pttLock").addEventListener("click", togglePttLock);
  $("remoteMute").addEventListener("click", () => setRemoteAudioMuted(!S.remoteAudioMuted));
  $("keepAwake").addEventListener("click", toggleScreenWakeLock);
  $("fitMode").addEventListener("click", toggleFitMode);
  document.addEventListener("keydown", event => {
    if (event.code !== "Space" && event.code !== "Enter") return;
    const target = event.target;
    if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return;
    if (event.repeat || S.pttKeyActive || S.pttLocked) return;
    if (!S.pc || !S.mic) return;
    event.preventDefault();
    S.pttKeyActive = true;
    ptt(true);
  });
  document.addEventListener("keyup", event => {
    if ((event.code === "Space" || event.code === "Enter") && S.pttKeyActive) {
      event.preventDefault();
      S.pttKeyActive = false;
      if (!S.pttLocked) ptt(false);
    }
  });
  window.addEventListener("blur", () => {
    if (S.pttKeyActive) {
      S.pttKeyActive = false;
      if (!S.pttLocked) ptt(false);
    }
  });
    $("saveSettings").addEventListener("click", () => saveSettings().catch(error => toast(error.message)));
  $("locate").addEventListener("click", () => command("location_once").catch(error => toast(error.message)));
  $("history").addEventListener("click", () => loadHistory().catch(error => toast(error.message)));
  $("deleteHistory").addEventListener("click", () => deleteHistory().catch(error => toast(error.message)));
  $("videoTab").addEventListener("click", showVideo);
  $("mapTab").addEventListener("click", showMap);
  $("fullscreen").addEventListener("click", toggleFullscreen);
  $("motionEnabled").addEventListener("change", saveMotionSettings);
  $("motionSensitivity").addEventListener("change", saveMotionSettings);
  window.addEventListener("online", () => {
    if (S.device) flushMotionEvents(S.device).catch(error => console.warn("Motion retry after network recovery failed", error));
  });
  if (!S.motion.retryTimer) {
    S.motion.retryTimer = setInterval(() => {
      if (navigator.onLine && S.device) {
        flushMotionEvents(S.device).catch(error => console.warn("Scheduled motion retry failed", error));
      }
    }, 30000);
  }
  $("motionNotify").addEventListener("click", enableMotionNotifications);
  $("motionHistory").addEventListener("click", () => loadMotionHistory().catch(error => toast(error.message)));
  $("motionExport").addEventListener("click", () => exportMotionCsv().catch(error => toast(error.message)));
  $("motionClear").addEventListener("click", () => clearMotionHistory().catch(error => toast(error.message)));
  $("zoom").addEventListener("input", applyViewerZoom);
  $("zoomReset").addEventListener("click", () => { $("zoom").value = "100"; applyViewerZoom(); });
  $("remoteVideo").addEventListener("playing", startMotionDetection);
  $("remoteVideo").addEventListener("pause", () => {
    if (S.pc && S.remoteVideoStream && $("remoteVideo").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      // Full-screen transitions can briefly pause the element without ending RTP.
      setTimeout(() => restoreRemotePlayback(), 180);
    } else {
      stopMotionDetection("映像一時停止中");
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopMotionDetection("画面がバックグラウンドです。復帰後に再開します。");
      // Never leave the local microphone sending while the controller is hidden.
      if (S.pttActive) {
        S.pttLocked = false;
        $("pttLock").textContent = "送話ロック OFF";
        $("pttLock").classList.remove("active");
        ptt(false);
      }
    } else if (S.motion.enabled) startMotionDetection();
  });
  $("bookmarkletOpen").addEventListener("click", openBookmarkletDialog);
  $("copyBookmarklet").addEventListener("click", copyBookmarkletCode);
  const restoreAfterViewportChange = () => {
    setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
      restoreRemotePlayback();
    }, 180);
  };
  document.addEventListener("fullscreenchange", restoreAfterViewportChange);
  document.addEventListener("webkitfullscreenchange", restoreAfterViewportChange);
  $("remoteVideo").addEventListener("webkitendfullscreen", restoreAfterViewportChange);
  window.addEventListener("pageshow", restoreAfterViewportChange);
  window.addEventListener("resize", () => {
    if (S.pc) restoreAfterViewportChange();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopMotionDetection("画面がバックグラウンドです。復帰後に再開します。");
      if (S.wakeLock) {
        S.wakeLock.release().catch(() => {});
        S.wakeLock = null;
      }
    } else {
      restoreRemotePlayback();
      if (S.motion.enabled) startMotionDetection();
      if (S.keepAwakeWanted && S.pc && S.pc.connectionState === "connected") {
        enableScreenWakeLock().catch(() => {});
      }
      if (S.pc) startVideoWatchdog(S.pc);
    }
  });
  $("fps").addEventListener("change", () => saveSettings().catch(error => toast(error.message)));
  $("aspectRatio").addEventListener("change", () => { applyAspectRatio($("aspectRatio").value); saveSettings().catch(error => toast(error.message)); });
  $("androidSpeakerVolume").addEventListener("change", () => saveSettings().catch(error => toast(error.message)));
  ["androidSpeakerVolume","micNoise","micSensitivity","micGain"].forEach(id=>$(id).addEventListener("input",updateSliderLabels));
  $("receiveVolume").addEventListener("input", event => setReceiveVolume(event.target.value, true));
  $("micMode").addEventListener("change", () => {
    saveSettings().then(() => toast("マイク集音モードは次回接続から反映します。"))
      .catch(error => toast(error.message));
  });
  $("diagnostics").addEventListener("click",()=>command("diagnostics").catch(e=>toast(e.message)));
  $("torch").addEventListener("click",()=>{S.torchEnabled=!S.torchEnabled;command("torch",{enabled:S.torchEnabled}).then(()=>{$("torch").textContent=S.torchEnabled?"ライトをOFF":"ライトをON";}).catch(e=>{S.torchEnabled=!S.torchEnabled;toast(e.message);});});
  $("reserveConnection").addEventListener("click",()=>reserveConnection().catch(e=>toast(e.message)));
  $("cancelReservation").addEventListener("click",cancelConnectionReservation);
  $("micNoise").addEventListener("change",()=>saveSettings().catch(x=>toast(x.message)));
  $("micSensitivity").addEventListener("change",()=>saveSettings().catch(x=>toast(x.message)));
  $("micGain").addEventListener("change",()=>saveSettings().catch(x=>toast(x.message)));
  $("nightMode").addEventListener("change",()=>{applyNightViewFilter();localStorage.setItem(nightViewStorageKey(),String($("nightMode").checked));});
  updateSliderLabels();
  applyAspectRatio($("aspectRatio").value);
  applyViewerZoom();
  applyNightViewFilter();
  loadMotionSettings();
  updateSliderLabels();
  $("pttLock").disabled = true;
  $("remoteMute").disabled = true;
  $("keepAwake").disabled = true;
  $("sessionDuration").textContent = "未接続";
  const storedVolume = localStorage.getItem("rc_receive_volume_v1");
  setReceiveVolume(storedVolume === null ? 70 : Number(storedVolume), false);
  $("fitMode").addEventListener("click", () => {
    const video = $("remoteVideo");
    video.style.objectFit = video.style.objectFit === "cover" ? "contain" : "cover";
    $("fitMode").textContent = video.style.objectFit === "cover" ? "画面に合わせる" : "全体表示";
  });
  $("camera").addEventListener("change", event => {
    const option=event.target.selectedOptions && event.target.selectedOptions[0];
    command("camera", { cameraId: event.target.value, facing: option?.dataset.facing || event.target.value }).catch(error => toast(error.message));
  });
  $("quality").addEventListener("change", () => saveSettings().catch(error => toast(error.message)));
  $("dataMode").addEventListener("change", () => saveSettings().catch(error => toast(error.message)));
  try {
    await loadConfig();
    S.devices = readDevices();
    renderDevices();
    try {
      const health = await api("health");
      if (!health.databaseReady) {
        $("pair").disabled = true;
        setControlsEnabled(false);
        status("GAS接続済み・DB未設定");
        toast(health.message || "GASのsetupDatabase()を実行し、最新バージョンをデプロイしてください。");
      } else {
        $("pair").disabled = false;
        refreshDeviceList();
        status(S.device ? "ペアリング済み" : "GAS接続済み・端末未登録", true);
        handleQuickLaunch();
      }
    } catch (healthError) {
      $("pair").disabled = true;
      setControlsEnabled(false);
      status("GAS応答なし");
      toast("GASへのPOST応答を確認できません: " + (healthError && healthError.message ? healthError.message : "不明な通信エラー") + "。Code.gsの更新・再デプロイも確認してください。");
      console.error("GAS health check failed", healthError);
    }
  } catch (error) {
    $("pair").disabled = true;
    setControlsEnabled(false);
    toast(error.message);
    status("設定エラー");
  }
});
