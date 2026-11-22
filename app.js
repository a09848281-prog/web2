"use strict";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "rc_paired_devices_v1";
const SELECTED_KEY = "rc_selected_device_v1";
const AUTO_RECONNECT_PREFIX = "rc_auto_reconnect_v1_";
let settingsChangeTimer = null;
let micNoiseLiveTimer = null;
const S = {
  cfg: null,
  apiVersion: "",
  lastGasTimingMs: null,
  devices: [],
  device: null,
  pc: null,
  connecting: false,
  mic: null,
  micSender: null,
  pttRequestId: 0,
  pttRequested: false,
  pttStarting: false,
  remoteAudioTracks: [],
  pendingControlAcks: new Map(),
  pttActive: false,
  session: "",
  seq: 0,
  map: null,
  marker: null,
  route: null,
  history: [],
  lastLocation: null,
  locationLiveAt: 0,
  followMap: true,
  locationRefreshTimer: null,
  deviceTelemetry: null,
  deviceDiagnostics: null, control: null, statsTimer: null, statsLast: null, reconnectTimer: null, reconnectAttempts: 0, everConnected: false, autoConnectWanted: false, torchEnabled: false, reservationTimer: null,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  motion: { enabled: false, sensitivity: 3, timer: null, previous: null, streak: 0, lastEventAt: 0, sendingDevices: new Set(), retryTimer: null },
  adaptive: { tier: 2, bad: 0, good: 0, lastChange: 0 },
  audioContext: null, remoteGain: null, remoteAudioSource: null, remoteAnalyser: null,
  noiseSuppressorNode: null, noiseWorkletLoadPromise: null, noiseWorkletLoaded: false,
  noiseStrength: 70, audioAttachGeneration: 0,
  zoomPanX: 0, zoomPanY: 0, zoomDrag: null,
  flashAvailable: false,
  androidCameraEnabled: true, androidMicEnabled: true, androidKeepAwake: false,
  audioMeterFrame: null, receiveVolume: 70, remoteAudioMuted: false,
  wakeLock: null, keepAwakeWanted: false, keepAwakeTogglePending: false, wakeLockRequestGeneration: 0,
  videoWatchdogTimer: null, videoFrameCallbackId: null, videoUsesFrameCallback: false,
  viewportRestoreTimer: null,
  hasReceivedVideoFrame: false, lastVideoFrameAt: 0, connectedAt: 0, sessionTimer: null,
  statsLast: null, manualDisconnect: false, reconnectResetTimer: null,
  connectionTimeoutTimer: null, connectionTimeoutPeer: null, cameraCapabilities: [],
  settingsSaveQueue: Promise.resolve()
};

function autoReconnectKey(deviceOrId) {
  const id = typeof deviceOrId === "string" ? deviceOrId : deviceOrId?.deviceId;
  return id ? AUTO_RECONNECT_PREFIX + id : "";
}
function setAutoReconnectIntent(deviceOrId, enabled) {
  const key = autoReconnectKey(deviceOrId);
  if (!key) return;
  try {
    if (enabled) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch (error) {
    console.warn("Could not persist auto-reconnect intent", error);
  }
}
function hasAutoReconnectIntent(deviceOrId) {
  const key = autoReconnectKey(deviceOrId);
  if (!key) return false;
  try { return localStorage.getItem(key) === "1"; } catch (_) { return false; }
}
function resumeSavedConnectionIntent() {
  const device = S.device;
  if (!device || !hasAutoReconnectIntent(device) || S.manualDisconnect) return false;
  S.manualDisconnect = false;
  S.autoConnectWanted = true;
  if (S.pc?.connectionState === "connected" && S.control?.readyState === "open") return true;
  if (!S.connecting && !S.reconnectTimer) scheduleReconnect(S.pc, "resume");
  return true;
}

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

function createScriptProcessorNoiseGate(context) {
  const node = context.createScriptProcessor(1024, 1, 1);
  let strength = S.noiseStrength, noiseFloor = 0.002, envelope = 1;
  node.setNoiseStrength = value => { strength = Math.max(0, Math.min(100, Number(value) || 0)); };
  node.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0), output = event.outputBuffer.getChannelData(0);
    if (strength <= 0) { output.set(input); envelope = 1; return; }
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, input.length));
    if (rms < noiseFloor * 3) noiseFloor = Math.max(0.00015, noiseFloor * 0.985 + rms * 0.015);
    const threshold = noiseFloor * (1.15 + strength * 0.055) + strength * 0.00001;
    const target = rms < threshold ? Math.max(0.08, rms / Math.max(threshold, 0.0001)) : 1;
    envelope += (target - envelope) * (target < envelope ? 0.58 : 0.12);
    for (let i = 0; i < input.length; i++) output[i] = input[i] * envelope;
  };
  return node;
}

async function ensureNoiseSuppressorNode() {
  if (!S.audioContext) return null;
  if (S.noiseSuppressorNode) return S.noiseSuppressorNode;
  if (S.noiseWorkletLoadPromise) return S.noiseWorkletLoadPromise;
  S.noiseWorkletLoadPromise = (async () => {
    let node = null;
    if (S.audioContext.audioWorklet && typeof AudioWorkletNode === "function") {
      try {
        if (!S.noiseWorkletLoaded) {
          await S.audioContext.audioWorklet.addModule(new URL("./noise-suppressor-processor.js", document.baseURI).href);
          S.noiseWorkletLoaded = true;
        }
        node = new AudioWorkletNode(S.audioContext, "remote-camera-noise-gate");
      } catch (error) { console.warn("AudioWorklet unavailable; using ScriptProcessor fallback", error); }
    }
    if (!node && typeof S.audioContext.createScriptProcessor === "function") node = createScriptProcessorNoiseGate(S.audioContext);
    if (node) {
      S.noiseSuppressorNode = node;
      if (node.port) node.port.postMessage({ type: "strength", value: S.noiseStrength });
      else node.setNoiseStrength?.(S.noiseStrength);
    }
    return node;
  })().finally(() => { S.noiseWorkletLoadPromise = null; });
  return S.noiseWorkletLoadPromise;
}

function setNoiseSuppressionLevel(value, persist = false) {
  const strength = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  S.noiseStrength = strength;
  if (S.noiseSuppressorNode?.port) S.noiseSuppressorNode.port.postMessage({ type: "strength", value: strength });
  else S.noiseSuppressorNode?.setNoiseStrength?.(strength);
  if (persist) {
    try { localStorage.setItem("rc_noise_strength_v1", String(strength)); }
    catch (error) { console.warn("Could not save noise suppression level", error); }
  }
  updateSliderLabels();
}

async function attachRemoteAudio() {
  const generation = ++S.audioAttachGeneration;
  const tracks = S.remoteAudioTracks.filter(track => track.readyState === "live");
  if (!tracks.length) {
    try { S.remoteAudioSource?.disconnect(); } catch (_) {}
    try { S.noiseSuppressorNode?.disconnect(); } catch (_) {}
    try { S.remoteAnalyser?.disconnect(); } catch (_) {}
    S.remoteAudioSource = null; S.remoteAnalyser = null;
    $("audioState").textContent = "Androidマイク待機中"; stopAudioMeter(); return;
  }
  if (!prepareAudioOutput()) {
    $("remoteVideo").muted = S.remoteAudioMuted;
    $("remoteVideo").volume = Math.min(1, AudioUtils.receiveGain(S.receiveVolume));
    $("audioState").textContent = "Androidマイク受信中（標準音声）"; return;
  }
  try {
    const suppressor = await ensureNoiseSuppressorNode();
    if (generation !== S.audioAttachGeneration) return;
    try { S.remoteAudioSource?.disconnect(); } catch (_) {}
    try { S.noiseSuppressorNode?.disconnect(); } catch (_) {}
    try { S.remoteAnalyser?.disconnect(); } catch (_) {}
    S.remoteAudioSource = S.audioContext.createMediaStreamSource(new MediaStream(tracks));
    S.remoteAnalyser = S.audioContext.createAnalyser(); S.remoteAnalyser.fftSize = 512;
    if (suppressor) { S.remoteAudioSource.connect(suppressor); suppressor.connect(S.remoteAnalyser); }
    else S.remoteAudioSource.connect(S.remoteAnalyser);
    S.remoteAnalyser.connect(S.remoteGain);
    $("remoteVideo").muted = true;
    S.remoteGain.gain.setTargetAtTime(S.remoteAudioMuted ? 0 : AudioUtils.receiveGain(S.receiveVolume), S.audioContext.currentTime, 0.04);
    startAudioMeter(); $("audioState").textContent = "Androidマイク受信中";
    if (S.audioContext.state === "suspended") S.audioContext.resume().catch(error => console.debug("Remote audio resume failed", error));
  } catch (error) {
    console.warn("Remote audio routing failed; using video element fallback", error);
    S.remoteAudioSource = null; S.remoteAnalyser = null;
    $("remoteVideo").muted = S.remoteAudioMuted;
    $("remoteVideo").volume = Math.min(1, AudioUtils.receiveGain(S.receiveVolume));
    $("audioState").textContent = "Androidマイク受信中（標準音声へ切替）";
  }
}

function startAudioMeter() {
  if (!S.remoteAnalyser || S.audioMeterFrame !== null) return;
  const data = new Uint8Array(S.remoteAnalyser.fftSize);
  const tick = () => {
    if (!S.remoteAnalyser || S.remoteAudioMuted) {
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
  S.remoteAudioTracks.forEach(track => { track.enabled = !S.remoteAudioMuted; });
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

function updateWebMicrophoneButton() {
  const button = $("ptt");
  if (!button) return;
  button.disabled = !S.pc || !S.micSender || S.pttStarting;
  button.classList.toggle("active", S.pttActive);
  button.textContent = S.pttActive ? "🎙 Webマイク ON（停止）" : "🎙 Webマイク OFF（開始）";
}
async function setWebMicEnabled(enabled) {
  if (enabled === true) {
    if (S.pttActive || S.pttStarting) return true;
    const pc = S.pc, sender = S.micSender;
    if (!pc || !sender) return false;
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("このブラウザーではマイクを利用できません。HTTPS接続とSafariの権限を確認してください。"); return false;
    }
    const requestId = ++S.pttRequestId;
    S.pttRequested = true; S.pttStarting = true; updateWebMicrophoneButton();
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("マイク音声トラックを取得できませんでした。");
      if (requestId !== S.pttRequestId || !S.pttRequested || S.pc !== pc || pc.connectionState === "closed") {
        stream.getTracks().forEach(item => item.stop()); return false;
      }
      await sender.replaceTrack(track);
      if (requestId !== S.pttRequestId || !S.pttRequested || S.pc !== pc || S.micSender !== sender) {
        try { await sender.replaceTrack(null); } catch (_) {}
        stream.getTracks().forEach(item => item.stop()); return false;
      }
      S.mic = stream; track.enabled = true; S.pttActive = true;
      toast("WebマイクをONにしました。接続中は送話が続きます。"); return true;
    } catch (error) {
      try { stream?.getTracks().forEach(item => item.stop()); } catch (_) {}
      if (S.mic === stream) S.mic = null;
      S.pttRequested = false;
      toast(error?.name === "NotAllowedError" ? "マイク使用が許可されませんでした。ブラウザーの設定からマイクを許可してください。" : "マイクを開始できません: " + (error?.message || "不明なエラー"));
      return false;
    } finally { S.pttStarting = false; updateWebMicrophoneButton(); }
  }
  S.pttRequested = false; ++S.pttRequestId; S.pttActive = false;
  const stream = S.mic, sender = S.micSender; S.mic = null;
  try { await sender?.replaceTrack(null); } catch (error) { console.warn("Could not detach Web mic", error); }
  try { stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
  updateWebMicrophoneButton();
  if (S.remoteAudioTracks.some(track => track.readyState === "live") && !S.remoteAudioMuted) startAudioMeter();
  if (S.remoteAudioMuted) $("audioLevelText").textContent = "ミュート中";
  return true;
}

function updateScreenWakeLockButton() {
  const button = $("keepAwake");
  if (!button) return;
  const held = !!S.wakeLock;
  button.textContent = held ? "画面スリープ防止 ON" :
    (S.keepAwakeWanted ? "画面スリープ防止 再開待ち" : "画面スリープ防止 OFF");
  button.classList.toggle("active", S.keepAwakeWanted || held);
  button.disabled = S.keepAwakeTogglePending || !S.pc;
}

async function enableScreenWakeLock(generation = S.wakeLockRequestGeneration) {
  if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
    toast("このブラウザーは画面スリープ防止に対応していません。");
    return false;
  }
  if (!S.keepAwakeWanted || document.hidden || generation !== S.wakeLockRequestGeneration) return false;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (!S.keepAwakeWanted || document.hidden || generation !== S.wakeLockRequestGeneration) {
      try { await lock.release(); } catch (_) {}
      return false;
    }
    if (S.wakeLock && S.wakeLock !== lock) {
      try { await S.wakeLock.release(); } catch (_) {}
    }
    S.wakeLock = lock;
    lock.addEventListener("release", () => {
      if (S.wakeLock === lock) {
        S.wakeLock = null;
        updateScreenWakeLockButton();
      }
    }, { once: true });
    updateScreenWakeLockButton();
    return true;
  } catch (error) {
    if (generation === S.wakeLockRequestGeneration) {
      S.wakeLock = null;
      updateScreenWakeLockButton();
      toast("画面スリープ防止を開始できません: " + (error.message || "ブラウザー制限"));
    }
    return false;
  }
}

async function toggleScreenWakeLock() {
  if (S.keepAwakeTogglePending) return;
  S.keepAwakeTogglePending = true;
  updateScreenWakeLockButton();
  try {
    if (S.keepAwakeWanted) {
      S.keepAwakeWanted = false;
      ++S.wakeLockRequestGeneration;
      const lock = S.wakeLock;
      S.wakeLock = null;
      if (lock) { try { await lock.release(); } catch (_) {} }
      return;
    }
    if (!S.pc || S.pc.connectionState !== "connected") {
      toast("画面スリープ防止は接続中に有効にできます。");
      return;
    }
    S.keepAwakeWanted = true;
    const generation = ++S.wakeLockRequestGeneration;
    if (!await enableScreenWakeLock(generation) && generation === S.wakeLockRequestGeneration) {
      S.keepAwakeWanted = false;
    }
  } finally {
    S.keepAwakeTogglePending = false;
    updateScreenWakeLockButton();
  }
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
    if (!S.hasReceivedVideoFrame && now - S.connectedAt > 12000) {
      $("videoState").textContent = "映像未着信・自動復旧中";
      scheduleReconnect(peer, "video-stalled");
    } else if (S.hasReceivedVideoFrame && now - S.lastVideoFrameAt > 6000) {
      $("videoState").textContent = "映像フリーズ・自動復旧中";
      scheduleReconnect(peer, "video-stalled");
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
function updateWideCameraButton() {
  const button = $("wideCameraButton");
  if (!button) return;
  const rear = S.cameraCapabilities.filter(camera => camera && camera.facing === "back");
  const selected = $("camera")?.value || "";
  const widest = rear.slice().sort((a, b) => {
    const fovA = Number(a.horizontalFovDegrees) || 0;
    const fovB = Number(b.horizontalFovDegrees) || 0;
    if (fovA !== fovB) return fovB - fovA;
    return (Number(a.focalLengthMm) || Number.POSITIVE_INFINITY) -
      (Number(b.focalLengthMm) || Number.POSITIVE_INFINITY);
  })[0];
  button.disabled = S.control?.readyState !== "open" || rear.length < 2 || !widest || selected === widest.id;
  button.textContent = widest && Number(widest.horizontalFovDegrees) >= 90
    ? "🌄 超広角へ切替" : "🌄 最も広い背面カメラへ切替";
}
function switchToWidestCamera() {
  const rear = S.cameraCapabilities.filter(camera => camera && camera.facing === "back");
  const widest = rear.slice().sort((a, b) => {
    const fovA = Number(a.horizontalFovDegrees) || 0, fovB = Number(b.horizontalFovDegrees) || 0;
    if (fovA !== fovB) return fovB - fovA;
    return (Number(a.focalLengthMm) || Number.POSITIVE_INFINITY) -
      (Number(b.focalLengthMm) || Number.POSITIVE_INFINITY);
  })[0];
  if (!widest || rear.length < 2) return toast("Androidから切替可能な広角レンズが複数公開されていません。");
  if ($("camera").value === widest.id) return toast("現在、最も広い背面カメラを使用しています。");
  $("camera").value = widest.id;
  command("camera", { cameraId: widest.id, facing: "back" })
    .then(() => toast("最も広い背面カメラへの切替を要求しました。"))
    .catch(error => toast("広角カメラへの切替に失敗しました: " + error.message));
}
function applyViewerZoom() {
  const zoom = Math.max(100, Math.min(300, Number($("zoom").value) || 100));
  const scale = zoom / 100, video = $("remoteVideo"), pane = $("videoPane");
  const maxX = pane ? Math.max(0, pane.clientWidth * (scale - 1) / 2) : 0;
  const maxY = pane ? Math.max(0, pane.clientHeight * (scale - 1) / 2) : 0;
  S.zoomPanX = Math.max(-maxX, Math.min(maxX, S.zoomPanX));
  S.zoomPanY = Math.max(-maxY, Math.min(maxY, S.zoomPanY));
  video.style.transformOrigin = "50% 50%";
  video.style.transform = "translate(" + S.zoomPanX + "px," + S.zoomPanY + "px) scale(" + scale + ")";
  video.style.touchAction = zoom > 100 ? "none" : "pan-y";
  video.style.cursor = zoom > 100 ? "grab" : "default";
  $("zoomValue").value = zoom + "%";
}
function startViewerPan(event) {
  if (Number($("zoom").value) <= 100 || event.button > 0) return;
  event.preventDefault();
  S.zoomDrag = { pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, originX:S.zoomPanX, originY:S.zoomPanY };
  $("remoteVideo").style.cursor = "grabbing";
  try { $("remoteVideo").setPointerCapture(event.pointerId); } catch (_) {}
}
function moveViewerPan(event) {
  const drag = S.zoomDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const scale = Math.max(1, Number($("zoom").value) / 100), pane = $("videoPane");
  const maxX = Math.max(0, pane.clientWidth * (scale - 1) / 2);
  const maxY = Math.max(0, pane.clientHeight * (scale - 1) / 2);
  S.zoomPanX = Math.max(-maxX, Math.min(maxX, drag.originX + event.clientX - drag.startX));
  S.zoomPanY = Math.max(-maxY, Math.min(maxY, drag.originY + event.clientY - drag.startY));
  applyViewerZoom(); $("remoteVideo").style.cursor = "grabbing";
}
function endViewerPan(event) {
  if (!S.zoomDrag || (event && S.zoomDrag.pointerId !== event.pointerId)) return;
  S.zoomDrag = null; $("remoteVideo").style.cursor = Number($("zoom").value) > 100 ? "grab" : "default";
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
    const startedAt = performance.now();
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
      const elapsed = Math.round(performance.now() - startedAt);
      const timing = $("gasTiming");
      if (timing) timing.textContent = "GAS " + elapsed + "ms";
      S.lastGasTimingMs = elapsed;
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
  ["connect", "locate", "saveSettings", "history", "deleteHistory", "unpair", "reserveConnection", "refreshAndroidSchedule", "motionHistory", "motionExport", "motionClear", "remoteMute", "cameraToggle", "micToggle", "androidKeepAwake", "deviceInfo"].forEach(id => {
    $(id).disabled = !enabled;
  });
  $("keepAwake").disabled = !enabled || !S.pc;
  $("connect").disabled = !enabled || !!S.pc || S.connecting;
  $("disconnect").disabled = !S.pc;
  $("torch").disabled = !S.pc || !S.control || S.control.readyState !== "open" || !S.flashAvailable;
  $("camera").disabled = !enabled || !S.pc;
  $("ptt").disabled = !S.pc || !S.micSender;
  $("remoteMute").disabled = true;
  updateAndroidMediaButtons();
  $("keepAwake").disabled = !enabled || !S.pc;
}
function selectDevice(device) {
  if ((S.pc || S.connecting) && S.device && S.device.deviceId !== device.deviceId) {
    toast("接続処理中または接続中は端末を切り替えられません。先に切断してください。");
    return;
  }
  const mapWasVisible = !$("mapPane").classList.contains("hidden");
  stopLocationRefresh();
  const previousId = S.device && S.device.deviceId;
  S.device = device;
  if (previousId !== device.deviceId) {
    if (previousId) setAutoReconnectIntent(previousId, false);
    S.autoConnectWanted = false;
    if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
    S.reconnectTimer = null;
    S.history = [];
    S.lastLocation = null;
    S.followMap = true;
    S.deviceTelemetry = null;
    S.deviceDiagnostics = null;
    S.androidCameraEnabled = true;
    S.androidMicEnabled = true;
    S.flashAvailable = false;
    S.torchEnabled = false;
    if (S.map) drawMap([]);
    $("deviceTx").textContent = "送信 --";
    $("deviceRx").textContent = "受信 --";
    $("deviceTxSpeed").textContent = "送信速度 --";
    $("deviceRxSpeed").textContent = "受信速度 --";
    $("deviceTotal").textContent = "合計 --";
    $("deviceHealth").textContent = "端末情報待機中";
    $("cameraFacing").textContent = "カメラ --";
    $("flashState").textContent = "ライト --";
    $("deviceInfoOutput").textContent = "端末接続後に表示します。";
  }
  localStorage.setItem(SELECTED_KEY, device.deviceId);
  $("deviceName").textContent = device.deviceName || "Android端末";
  $("deviceMeta").textContent = "端末ID: " + device.deviceId + " / このiPadにペアリング済み";
  renderDevices();
  setControlsEnabled(true);
  refreshReservationUi();
  status("ペアリング済み");
  loadSettings().catch(error => toast(error.message));
  flushMotionEvents().catch(error => console.warn("Motion queue flush failed", error));
  if (mapWasVisible) startLocationRefresh();
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
    stopLocationRefresh();
    S.device = null;
    S.deviceTelemetry = null;
    S.deviceDiagnostics = null;
    S.history = [];
    S.lastLocation = null;
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
function clearConnectionTimeout(peer = null) {
  if (peer && S.connectionTimeoutPeer && S.connectionTimeoutPeer !== peer) return;
  if (S.connectionTimeoutTimer) clearTimeout(S.connectionTimeoutTimer);
  S.connectionTimeoutTimer = null;
  S.connectionTimeoutPeer = null;
}
function armConnectionTimeout(peer) {
  clearConnectionTimeout();
  S.connectionTimeoutPeer = peer;
  S.connectionTimeoutTimer = setTimeout(() => {
    S.connectionTimeoutTimer = null;
    if (S.pc !== peer || S.manualDisconnect) return;
    if (peer.connectionState === "connected" && S.control?.readyState === "open") {
      clearConnectionTimeout(peer);
      return;
    }
    $("streamState").textContent = "接続セットアップがタイムアウト・自動復旧中";
    scheduleReconnect(peer, "setup-timeout");
  }, 25000);
}
function markRtcStable(peer) {
  if (S.pc !== peer || peer.connectionState !== "connected" || S.control?.readyState !== "open") return;
  clearConnectionTimeout(peer);
  if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
  S.reconnectTimer = null;
  if (S.reconnectResetTimer) clearTimeout(S.reconnectResetTimer);
  S.reconnectResetTimer = setTimeout(() => {
    if (S.pc === peer && peer.connectionState === "connected" && S.control?.readyState === "open") S.reconnectAttempts = 0;
    S.reconnectResetTimer = null;
  }, 30000);
}
async function connect(automatic = false) {
  automatic = automatic === true;
  if (!S.device) return toast("先にAndroidをペアリングしてください。");
  if (S.connecting) return false;
  const device = S.device;
  if (!device) return false;
  if (!automatic) {
    S.manualDisconnect = false;
    S.autoConnectWanted = true;
    setAutoReconnectIntent(device, true);
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
    if (S.pc) await disconnect(false, automatic, true, automatic);
    if (!S.device || S.device.deviceId !== device.deviceId) {
      throw Error("接続先端末が変更されました。もう一度選択してください。");
    }
    S.mic = null;
    S.micSender = null;
    S.pttRequested = false;
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
    armConnectionTimeout(pc);
    control.onopen = () => {
      if (S.pc !== pc) return;
      $("diagnostics").disabled = false;
      $("torch").disabled = !S.flashAvailable;
      status("監視中・DataChannel直接接続", true);
      $("streamState").textContent = "映像・音声・DataChannel接続中";
      markRtcStable(pc);
      updateWideCameraButton();
      startRtcStats();
      startVideoWatchdog(pc);
      updateAndroidMediaButtons();
      updateAndroidKeepAwakeButton();
      $("remoteMute").disabled = true;
      $("keepAwake").disabled = false;
      if (S.keepAwakeWanted && !S.wakeLock) enableScreenWakeLock().catch(() => {});
    };
    control.onclose = () => {
      if (S.pc !== pc) return;
      $("diagnostics").disabled = true;
      $("torch").disabled = true;
      $("remoteMute").disabled = true;
      $("cameraToggle").disabled = true;
      $("micToggle").disabled = true;
      updateAndroidMediaButtons();
      updateAndroidKeepAwakeButton();
      settlePendingControlAcks("制御チャネルが切断されました。");
      if (S.pttActive || S.pttRequested) setWebMicEnabled(false);
      stopRtcStats();
      status("制御チャネル切断・自動復旧中");
      if (S.pc === pc && (S.everConnected || S.autoConnectWanted) && !S.manualDisconnect) scheduleReconnect(pc, "datachannel");
    };
    control.onmessage = event => { if (S.pc === pc) handleControlMessage(event.data); };
    control.onerror = () => {
      if (S.pc === pc && !S.manualDisconnect && pc.connectionState !== "closed") {
        console.warn("Unexpected DataChannel error");
        $("streamState").textContent = "制御チャネルで通信エラーが発生しました";
      }
    };
    $("camera").disabled = false;
    const remote = new MediaStream();
    S.remoteVideoStream = remote;
    $("remoteVideo").style.objectFit = "contain";
    $("remoteVideo").style.objectPosition = "50% 50%";
    $("remoteVideo").srcObject = remote;
    $("remoteVideo").muted = true;
    prepareAudioOutput();
    pc.addTransceiver("video", { direction: "recvonly" });
    const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
    S.micSender = audioTransceiver.sender;
    updateWebMicrophoneButton();
    // Start the browser microphone during Connect, but do not hold up video setup
    // while a permission prompt is open. A denied permission leaves viewing available.
    void setWebMicEnabled(true).catch(error => console.warn("Web microphone start failed", error));
    pc.ontrack = event => {
      if (S.pc !== pc) return;
      const track = event.track;
      if (track.kind === "video") {
        if (!remote.getTracks().some(existing => existing.id === track.id)) remote.addTrack(track);
        track.addEventListener("ended", () => {
          $("videoState").textContent = "映像トラック終了";
          stopMotionDetection("映像が終了しました。");
          if (S.pc === pc && !S.manualDisconnect) scheduleReconnect(pc, "track-ended");
        });
        track.addEventListener("mute", () => { $("videoState").textContent = "映像一時停止"; });
        track.addEventListener("unmute", () => { $("videoState").textContent = "映像再開中"; startMotionDetection(); });
        $("placeholder").classList.add("hidden");
        $("remoteVideo").play().then(() => {
          restoreRemotePlayback();
          startVideoWatchdog(pc);
          startMotionDetection();
        }).catch(() => toast("映像・音声を再生するには画面をタップしてください。"));
      } else if (track.kind === "audio" && !S.remoteAudioTracks.some(existing => existing.id === track.id)) {
        track.enabled = !S.remoteAudioMuted;
        track.addEventListener("unmute", () => attachRemoteAudio());
        track.addEventListener("ended", () => { $("audioState").textContent = "Androidマイク切断"; });
        S.remoteAudioTracks.push(track);
        attachRemoteAudio();
      }
    };
    pc.onconnectionstatechange = () => {
      if (S.pc !== pc) return;
      const state = pc.connectionState;
      $("iceState").textContent = "ICE: " + state;
      status(state === "connected" && S.control?.readyState === "open" ? "監視中" : state,
        state === "connected" && S.control?.readyState === "open");
      $("streamState").textContent = state === "connected"
        ? (S.control?.readyState === "open" ? "映像・音声接続中" : "映像接続済み・制御チャネル確認中")
        : "接続処理中";
      if (state === "connected") {
        S.everConnected = true;
        if (S.control?.readyState === "open") markRtcStable(pc);
        startSessionClock();
        startRtcStats();
        startVideoWatchdog(pc);
      } else if ((state === "failed" || state === "disconnected" || state === "closed") && (S.everConnected || S.autoConnectWanted) && !S.manualDisconnect) {
        if (S.reconnectResetTimer) clearTimeout(S.reconnectResetTimer);
        S.reconnectResetTimer = null;
        stopSessionClock();
        const reason = state === "failed" ? "failed" : "disconnected";
        scheduleReconnect(pc, reason);
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
    await disconnect(false, false, true, true);
    toast("接続開始失敗: " + error.message);
    if (RemoteCameraRecovery.shouldRetry({ manualDisconnect: S.manualDisconnect, hasDevice: !!S.device, everConnected: S.everConnected, autoConnectWanted: S.autoConnectWanted })) {
      scheduleReconnect(null, "connect-error");
    }
    return false;
  } finally {
    S.connecting = false;
    $("connect").disabled = !S.device || !!S.pc;
  }
}
function scheduleReconnect(expectedPc, reason = "disconnected") {
  if (!RemoteCameraRecovery.shouldRetry({
    manualDisconnect: S.manualDisconnect, hasDevice: !!S.device, everConnected: S.everConnected,
    autoConnectWanted: S.autoConnectWanted
  }) || S.reconnectTimer) return;
  if (navigator.onLine === false) {
    status("ネットワーク切断・復旧待機中");
    $("streamState").textContent = "ネットワーク復旧を待っています";
    return;
  }
  const attempt = S.reconnectAttempts + 1;
  const wait = RemoteCameraRecovery.retryDelay(attempt, reason);
  status("自動復旧を準備中");
  $("streamState").textContent = "自動復旧 " + attempt + "回目・" + (wait / 1000).toFixed(1) + "秒後";
  S.reconnectTimer = setTimeout(async () => {
    S.reconnectTimer = null;
    if (S.manualDisconnect || !S.device || (expectedPc && S.pc !== expectedPc)) return;
    if (navigator.onLine === false) {
      status("ネットワーク切断・復旧待機中");
      $("streamState").textContent = "ネットワーク復旧を待っています";
      return;
    }
    if (expectedPc && expectedPc.connectionState === "connected" && S.control?.readyState === "open") return;
    if (S.connecting) {
      scheduleReconnect(null, "connect-error");
      return;
    }
    S.reconnectAttempts = attempt;
    const ok = await connect(true);
    if (!ok && !S.reconnectTimer) scheduleReconnect(null, "connect-error");
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
async function disconnect(sendCommand = true, preserveMic = false, notifyRemote = sendCommand, keepRecovery = false) {
  if (sendCommand) {
    S.manualDisconnect = true;
    S.autoConnectWanted = false;
    setAutoReconnectIntent(S.device, false);
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
  await setWebMicEnabled(false);
  if (notifyRemote && old && device && sessionId) {
    const channelOpen = S.control?.readyState === "open";
    if (channelOpen) {
      const disconnectResult = await sendControlAndWait("disconnect", { sessionId, keepRecovery }, 800);
      if (!disconnectResult.ok) console.warn("Remote disconnect was not acknowledged", disconnectResult.message);
    }
    // During automatic recovery, keep Android's rapid signaling poll armed.
    // A bye signal is sent only for an explicit manual disconnect.
    if (!keepRecovery) {
      void api("send_signal", {
        controllerToken:device.controllerToken, deviceId:device.deviceId,
        sessionId:sessionId, recipient:"device", kind:"bye"
      }).catch(async error => {
        console.warn("Session bye signal failed", error);
        if (!channelOpen) {
          try {
            await api("send_command", {
              controllerToken:device.controllerToken, deviceId:device.deviceId,
              command:"disconnect", payload:{sessionId:sessionId}
            });
          } catch (commandError) {
            console.warn("Session disconnect fallback failed", commandError);
          }
        }
      });
    }
  }
  clearConnectionTimeout(old);
  stopRtcStats();
  stopVideoWatchdog();
  stopSessionClock();
  stopMotionDetection("動体検知：映像未接続");
  
  S.pttActive = false;
  stopAudioMeter();
  ++S.audioAttachGeneration;
  try { S.remoteAudioSource?.disconnect(); } catch (_) {}
  try { S.noiseSuppressorNode?.disconnect(); } catch (_) {}
  try { S.remoteAnalyser?.disconnect(); } catch (_) {}
  S.remoteAudioSource = null; S.remoteAnalyser = null;

  if (sendCommand && (S.wakeLock || S.keepAwakeWanted)) {
    ++S.wakeLockRequestGeneration;
    const lock = S.wakeLock;
    S.wakeLock = null;
    S.keepAwakeWanted = false;
    if (lock) { try { await lock.release(); } catch (_) {} }
    updateScreenWakeLockButton();
  }

  S.pc = null;
  settlePendingControlAcks("切断しました。");
  try { S.control?.close(); } catch (_) {}
  S.control = null;
  S.session = "";
  try { old?.close(); } catch (_) {}

  if (S.mic) {
    S.mic.getTracks().forEach(track => track.stop());
    S.mic = null;
  }
  S.micSender = null;
  S.pttRequested = false;
  S.pttStarting = false;
  updateAndroidKeepAwakeButton();
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
  $("cameraToggle").disabled = true;
  $("micToggle").disabled = true;
  updateAndroidMediaButtons();
  $("ptt").disabled = true;
  $("keepAwake").disabled = true;
  $("ptt").classList.remove("active");
  $("ptt").textContent = "🎙 Webマイク OFF（開始）";
  $("audioState").textContent = "Androidマイク待機中";
  $("videoState").textContent = "映像待機中";
  $("audioLevel").value = "0";
  $("audioLevelText").textContent = "待機中";
  $("streamState").textContent = "切断済み";
  $("iceState").textContent = "ICE: --";
  if (!preserveMic) S.remoteAudioMuted = false;
  $("remoteMute").textContent = S.remoteAudioMuted ? "🔇 Android音声 OFF" : "🔊 Android音声 ON";
  $("remoteMute").classList.toggle("active", S.remoteAudioMuted);

  stopLocationRefresh();
  if (S.device) status("ペアリング済み");
  else status("未ペアリング");
  $("keepAwake").disabled = !S.device;
  updateAndroidKeepAwakeButton();
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
  renderAndroidSchedule(settings.androidSchedule || null);
  $("quality").value = settings.quality || "720";
  $("dataMode").value = settings.dataMode || "standard";
  $("connectedLoc").checked = !!settings.connectedLocationEnabled;
  $("idleLoc").checked = !!settings.idleLocationEnabled;
  $("connectedInterval").value = String(settings.connectedInterval || 30);
  $("idleInterval").value = String(settings.idleInterval || 300);
  let noiseLevel = Number(settings.micNoise ?? 70);
  try { const saved = localStorage.getItem("rc_noise_strength_v1"); if (saved !== null) noiseLevel = Number(saved); } catch (_) {}
  $("micNoise").value = String(Math.max(0, Math.min(100, Number.isFinite(noiseLevel) ? noiseLevel : 70)));
  setNoiseSuppressionLevel($("micNoise").value, false);
  $("micSensitivity").value=String(settings.micSensitivity ?? 70);
  $("micGain").value=String(settings.micGain ?? 100);
  $("androidSpeakerVolume").value=String(settings.speakerVolume ?? 70);
  const savedMicMode = String(settings.micMode || "balanced");
  $("micMode").value = ["ambient", "balanced", "voice"].includes(savedMicMode)
    ? savedMicMode : "balanced";
  const storedReceive = localStorage.getItem("rc_receive_volume_v1");
  setReceiveVolume(storedReceive === null ? 70 : Number(storedReceive), false);
  $("nightMode").checked=localStorage.getItem(nightViewStorageKey()) === "true";
  applyNightViewFilter();
  $("fps").value=String(settings.fps || 24);
  const ratioKey = "rc_camera_ratio_choice_v1_" + device.deviceId;
  let userRatio = "";
  try { userRatio = localStorage.getItem(ratioKey) || ""; } catch (_) {}
  const serverRatio = settings.aspectRatio || "original";
  const migrateLegacyRatio = !userRatio && serverRatio === "16:9";
  $("aspectRatio").value = userRatio || (migrateLegacyRatio ? "original" : serverRatio);
  if (migrateLegacyRatio) {
    try { localStorage.setItem(ratioKey, "original"); } catch (_) {}
  }
  applyAspectRatio($("aspectRatio").value);
  updateSliderLabels();
  if (migrateLegacyRatio) {
    const migrated = readSettingsFromUi();
    queueDeviceSettingsSave(device, migrated).catch(error => console.warn("Could not migrate the old default camera ratio", error));
    if (S.control?.readyState === "open") sendControl("settings_update", migrated);
  }
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

function readSettingsFromUi() {
  return {
    quality: $("quality").value,
    dataMode: $("dataMode").value,
    fps: Number($("fps").value),
    aspectRatio: $("aspectRatio").value,
    connectedLocationEnabled: $("connectedLoc").checked,
    idleLocationEnabled: $("idleLoc").checked,
    connectedInterval: Number($("connectedInterval").value),
    idleInterval: Number($("idleInterval").value),
    micNoise: Number($("micNoise").value),
    micSensitivity: Number($("micSensitivity").value),
    micGain: Number($("micGain").value),
    speakerVolume: Number($("androidSpeakerVolume").value),
    micMode: $("micMode").value
  };
}

async function saveSettings() {
  const device = S.device;
  if (!device) return toast("Android端末をペアリングしてください。");
  const settings = readSettingsFromUi();
  if(S.control?.readyState==="open") {
    const applied = await sendControlAndWait("settings_update", settings, 3000);
    if (!applied.ok) throw Error("Androidへ設定を適用できませんでした: " + applied.message);
    try { localStorage.setItem("rc_live_settings_"+device.deviceId,JSON.stringify(settings)); }
    catch (storageError) { console.warn("Local setting cache unavailable", storageError); }
    await queueDeviceSettingsSave(device, settings);
    toast(settings.micMode !== "ambient" ? "Androidへ設定を適用し、保存しました。マイク集音モードは次回接続から反映します。" : "画質・FPSをAndroidへ適用し、GASへ保存しました。");
  } else {
    await queueDeviceSettingsSave(device, settings);
    if (S.device && S.device.deviceId === device.deviceId) {
      await api("send_command",{controllerToken:device.controllerToken,deviceId:device.deviceId,command:"quality",payload:{quality:settings.quality,dataMode:settings.dataMode,fps:settings.fps,aspectRatio:settings.aspectRatio}});
    }
    toast("設定を保存しました。次回接続時に反映します。");
  }
}
function scheduleSettingsSave() {
  if (settingsChangeTimer) clearTimeout(settingsChangeTimer);
  settingsChangeTimer = setTimeout(() => {
    settingsChangeTimer = null;
    saveSettings().catch(error => toast(error.message));
  }, 450);
}

const CONTROL_SEND_INTERVAL_MS = 120;
const CONTROL_SEND_QUEUE_LIMIT = 24;
const controlSendQueue = [];
let controlSendBusy = false;
let lastControlPacketAt = 0;

function pumpControlSendQueue() {
  if (controlSendBusy || !controlSendQueue.length) return;
  controlSendBusy = true;
  const item = controlSendQueue.shift();
  const wait = Math.max(0, CONTROL_SEND_INTERVAL_MS - (Date.now() - lastControlPacketAt));
  setTimeout(() => {
    if (item.channel !== S.control || item.channel.readyState !== "open") {
      controlSendBusy = false;
      pumpControlSendQueue();
      return;
    }
    if (item.channel.bufferedAmount > 128 * 1024) {
      controlSendQueue.unshift(item);
      controlSendBusy = false;
      setTimeout(pumpControlSendQueue, 300);
      return;
    }
    try {
      item.channel.send(item.packet);
      lastControlPacketAt = Date.now();
    } catch (error) {
      console.warn("Queued DataChannel send failed", error);
      if (S.control === item.channel) toast("DataChannelへの送信に失敗しました。自動復旧を確認してください。");
    }
    controlSendBusy = false;
    pumpControlSendQueue();
  }, wait);
}

function sendControl(name,payload={}) {
  const channel = S.control;
  if (!channel || channel.readyState !== "open") {
    toast("DataChannelが未接続です。");
    return false;
  }
  if (channel.bufferedAmount > 512 * 1024 || controlSendQueue.length >= CONTROL_SEND_QUEUE_LIMIT) {
    toast("Androidへの操作が集中しています。少し待ってから再操作してください。");
    return false;
  }
  controlSendQueue.push({
    channel,
    packet: JSON.stringify({type:"command",command:name,requestId:rid(),payload})
  });
  pumpControlSendQueue();
  return true;
}
function sendControlAndWait(name, payload = {}, timeoutMs = 1200) {
  const channel = S.control;
  if (!channel || channel.readyState !== "open" || channel.bufferedAmount > 256 * 1024) {
    return Promise.resolve({ ok: false, timeout: true, message: "DataChannel未接続または送信待ちです。" });
  }
  const requestId = rid();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      S.pendingControlAcks.delete(requestId);
      resolve({ ok: false, timeout: true, message: "Androidから応答がありませんでした。" });
    }, Math.max(250, Math.min(3000, timeoutMs)));
    S.pendingControlAcks.set(requestId, result => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      channel.send(JSON.stringify({ type: "command", command: name, requestId, payload }));
    } catch (error) {
      clearTimeout(timer);
      S.pendingControlAcks.delete(requestId);
      resolve({ ok: false, timeout: true, message: error?.message || "DataChannel送信失敗" });
    }
  });
}
function settlePendingControlAcks(message = "制御チャネルが閉じられました。") {
  for (const [requestId, resolve] of S.pendingControlAcks) {
    try { resolve({ ok: false, timeout: true, message }); } catch (_) {}
    S.pendingControlAcks.delete(requestId);
  }
}
function updateAndroidMediaButtons() {
  const open = S.control?.readyState === "open";
  $("cameraToggle").disabled = !open;
  $("micToggle").disabled = !open;
  $("camera").disabled = !open || !S.androidCameraEnabled;
  $("cameraToggle").textContent = S.androidCameraEnabled ? "📷 Androidカメラ OFF" : "📷 Androidカメラ ON";
  $("micToggle").textContent = S.androidMicEnabled ? "🎙 Androidマイク OFF" : "🎙 Androidマイク ON";
  updateAndroidKeepAwakeButton();
}

function updateAndroidKeepAwakeButton() {
  const button = $("androidKeepAwake");
  if (!button) return;
  button.textContent = S.androidKeepAwake ? "📱 Androidスリープ防止 ON" : "📱 Androidスリープ防止 OFF";
  button.classList.toggle("active", S.androidKeepAwake);
  button.disabled = !S.pc || S.control?.readyState !== "open" || button.dataset.pending === "true";
}
async function toggleAndroidKeepAwake() {
  const button = $("androidKeepAwake"), next = !S.androidKeepAwake;
  button.dataset.pending = "true"; updateAndroidKeepAwakeButton();
  try {
    const result = await sendControlAndWait("android_keep_awake", { enabled: next }, 2200);
    if (!result.ok) throw new Error(result.message || "Androidから応答がありません。");
    S.androidKeepAwake = next;
    toast(next ? "Android画面の点灯・自動消灯防止を有効にしました。" : "Androidスリープ防止を解除しました。");
  } catch (error) { toast("Androidスリープ防止を変更できませんでした: " + error.message); }
  finally { button.dataset.pending = "false"; updateAndroidKeepAwakeButton(); }
}

function toggleAndroidCamera() {
  if (!S.control || S.control.readyState !== "open") return toast("AndroidとのDataChannel接続が必要です。");
  const next = !S.androidCameraEnabled;
  if (sendControl("media_toggle", { cameraEnabled: next })) toast(next ? "Androidカメラの再開を要求しました。" : "Androidカメラの停止を要求しました。");
}
function toggleAndroidMicrophone() {
  if (!S.control || S.control.readyState !== "open") return toast("AndroidとのDataChannel接続が必要です。");
  const next = !S.androidMicEnabled;
  if (sendControl("media_toggle", { microphoneEnabled: next })) toast(next ? "Androidマイクの再開を要求しました。" : "Androidマイクの停止を要求しました。");
}
function readLiveSettings(){return {quality:$("quality").value,dataMode:$("dataMode").value,fps:Number($("fps").value),aspectRatio:$("aspectRatio").value,micNoise:Number($("micNoise").value),micSensitivity:Number($("micSensitivity").value),micGain:Number($("micGain").value),speakerVolume:Number($("androidSpeakerVolume").value),micMode:$("micMode").value};}
function bytesText(value){const b=Math.max(0,Number(value)||0);if(b<1024)return b.toFixed(0)+" B";if(b<1048576)return (b/1024).toFixed(1)+" KB";return (b/1048576).toFixed(2)+" MB";}
function renderDeviceInfo() {
  const telemetry = S.deviceTelemetry || {};
  const network = S.deviceDiagnostics || telemetry.network || {};
  const safe = {
    deviceName: S.device && S.device.deviceName ? S.device.deviceName : "Android端末",
    deviceId: S.device ? S.device.deviceId : "",
    androidVersion: telemetry.androidVersion || network.androidVersion || "取得不可",
    model: telemetry.deviceModel || network.deviceModel || "取得不可",
    batteryPercent: telemetry.batteryPercent ?? "取得不可",
    batteryCharging: telemetry.batteryCharging === true,
    batteryTemperatureC: telemetry.batteryTempC ?? "取得不可",
    thermalStatus: telemetry.thermalStatus ?? "取得不可",
    cameraFacing: telemetry.cameraFacing || "取得不可",
    cameraId: telemetry.cameraId || "取得不可",
    flashAvailable: telemetry.flashAvailable === true,
    flashEnabled: telemetry.flashEnabled === true,
    requestedFps: telemetry.requestedFps ?? "取得不可",
    cameraProfileFps: telemetry.captureFps ?? "取得不可",
    captureWidth: telemetry.captureWidth ?? "取得不可",
    captureHeight: telemetry.captureHeight ?? "取得不可",
    microphoneMode: telemetry.microphoneMode || "取得不可",
    networkTransport: network.transport || "取得不可",
    networkValidated: network.validated ?? "取得不可",
    metered: network.metered ?? "取得不可",
    localIpAddresses: network.localIpAddresses || [],
    dnsServers: network.dnsServers || [],
    interfaceName: network.networkInterface || "",
    rtcControlChannelOpen: network.rtcControlChannelOpen ?? "取得不可",
    recentError: network.recentError || "なし"
  };
  $("deviceInfoOutput").textContent = JSON.stringify(safe, null, 2);
}

function updateSliderLabels(){
  $("androidSpeakerVolumeValue").value=$("androidSpeakerVolume").value+"%";
  const level=Math.max(0,Math.min(100,Number($("micNoise").value)||0));
  $("micNoiseValue").value=level===0?"OFF（完全バイパス）":level+"%（Web適応ノイズゲート）";
  $("micSensitivityValue").value=$("micSensitivity").value+"%";
  $("micGainValue").value=$("micGain").value+"%";
  $("receiveVolumeValue").value=S.receiveVolume+"%";
}
function applyLiveLocationUpdate(raw) {
  const point = LocationUtils && LocationUtils.normalizeLiveLocation(raw);
  if (!point) { console.warn("Rejected invalid RTC location update"); return; }
  S.history = LocationUtils.mergeHistory(S.history, point, 500);
  S.lastLocation = S.history[S.history.length - 1] || point;
  S.locationLiveAt = Date.now();
  updateLocationActions();
  if (S.map && !$("mapPane").classList.contains("hidden")) {
    drawMap(S.history);
  } else {
    const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(S.lastLocation.timestamp).getTime()) / 1000));
    $("locationInfo").textContent = "最終取得: " + new Date(S.lastLocation.timestamp).toLocaleString() +
      " / 精度 ±" + (S.lastLocation.accuracy || "?") + "m / " + ageSeconds +
      "秒前 / " + (S.lastLocation.mode || "取得") + " / RTCライブ更新";
  }
  $("networkSummary").textContent = "位置情報をRTC DataChannelで受信しました。";
}

function handleControlMessage(raw){let d;try{d=JSON.parse(raw);}catch(_){return;}
 if(d.type==="ack"){
  const ackResult = { ok: d.ok === true, message: String(d.message || (d.ok ? "Android受信済み" : "適用失敗")) };
  const pending = S.pendingControlAcks.get(String(d.requestId || ""));
  if (pending) {
    S.pendingControlAcks.delete(String(d.requestId));
    pending(ackResult);
  }
  $("networkSummary").textContent=ackResult.message;
  if(!d.ok)toast(ackResult.message);
 }
 else if(d.type==="device_settings"){
  const v=d.settings||{};
  if(["auto","360","480","720","1080"].includes(String(v.quality))) $("quality").value=String(v.quality);
  $("dataMode").value="standard";
  if(Number.isFinite(Number(v.fps))) $("fps").value=String(Math.max(10,Math.min(60,Number(v.fps))));
  if(["16:9","4:3","1:1","9:16","original"].includes(String(v.aspectRatio))) {
    const ratioKey = "rc_camera_ratio_choice_v1_" + (S.device?.deviceId || "");
    let preferredRatio = "";
    try { preferredRatio = localStorage.getItem(ratioKey) || ""; } catch (_) {}
    $("aspectRatio").value = preferredRatio || (String(v.aspectRatio) === "16:9" ? "original" : String(v.aspectRatio));
  }
  if(Number.isFinite(Number(v.speakerVolume))) $("androidSpeakerVolume").value=String(v.speakerVolume);
  if (["ambient", "balanced", "voice"].includes(String(v.micMode))) {
    $("micMode").value = String(v.micMode);
  }
  if (typeof v.androidKeepAwake === "boolean") {
    S.androidKeepAwake = v.androidKeepAwake;
    updateAndroidKeepAwakeButton();
  }
  applyAspectRatio($("aspectRatio").value);
  updateSliderLabels();
  const targetDevice = S.device;
  if (targetDevice) {
    const snapshot = readSettingsFromUi();
    const cacheKey = "rc_live_settings_" + targetDevice.deviceId;
    let previous = "";
    try { previous = localStorage.getItem(cacheKey) || ""; } catch (_) {}
    const serialized = JSON.stringify(snapshot);
    if (previous !== serialized) {
      try { localStorage.setItem(cacheKey, serialized); } catch (_) {}
      queueDeviceSettingsSave(targetDevice, snapshot)
        .catch(error => toast("Android設定のGAS保存に失敗しました: " + error.message));
    }
  }
 }
 else if(d.type==="location_update"){
   applyLiveLocationUpdate(d.location || d);
 }
 else if(d.type==="camera_capabilities"){
  const select=$("camera"), cameras=Array.isArray(d.cameras)?d.cameras:[];
  S.cameraCapabilities=cameras.filter(camera=>camera&&typeof camera.id==="string");
  if(S.cameraCapabilities.length){
   const previous=select.value;select.replaceChildren();
   S.cameraCapabilities.forEach(camera=>{
    const option=document.createElement("option");option.value=camera.id;
    option.textContent=String(camera.label||"カメラ");
    option.dataset.facing=String(camera.facing||"back");
    option.dataset.horizontalFovDegrees=String(camera.horizontalFovDegrees||"");
    option.dataset.focalLengthMm=String(camera.focalLengthMm||"");
    select.appendChild(option);
   });
   const target=String(d.selectedCameraId||previous||"");
   if([...select.options].some(option=>option.value===target))select.value=target;
   updateWideCameraButton();
   toast("端末が公開しているカメラレンズ情報を読み込みました。");
  }
 }
 else if(d.type==="telemetry"){
  S.deviceTelemetry = d;
  S.androidCameraEnabled = d.cameraEnabled !== false;
  S.androidMicEnabled = d.microphoneEnabled !== false;
  S.androidKeepAwake = d.androidKeepAwake === true;
  updateAndroidMediaButtons();
  updateAndroidKeepAwakeButton();
  const width=Number(d.captureWidth)||0,height=Number(d.captureHeight)||0,profileFps=Number(d.captureFps)||0;
  const requestedFps=Number(d.requestedFps)||Number($("fps").value)||0;
  $("actualVideoFormat").textContent = width>0&&height>0
    ? "Android撮影プロファイル "+width+"×"+height+" / 希望 "+(requestedFps||"--")+"FPS・選択形式 "+(profileFps||"--")+"FPS"
    : "Android撮影プロファイル 取得待ち";
  if(Number.isFinite(Number(d.speakerVolumePercent))) $("androidSpeakerVolume").value=String(Math.max(0,Math.min(100,Number(d.speakerVolumePercent))));
  updateSliderLabels();
  $("androidMediaState").textContent = "カメラ "+(S.androidCameraEnabled?"ON":"OFF")+" / マイク "+(S.androidMicEnabled?"ON":"OFF")+" / Androidスピーカー "+$("androidSpeakerVolume").value+"%";
  const tx=Number(d.txBytesSinceConnect),rx=Number(d.rxBytesSinceConnect);
  $("deviceTx").textContent="送信 "+(tx<0?"取得不可":bytesText(tx));
  $("deviceRx").textContent="受信 "+(rx<0?"取得不可":bytesText(rx));
  $("deviceTxSpeed").textContent="送信速度 "+(Number(d.txBytesPerSecond)<0?"取得不可":bytesText(d.txBytesPerSecond)+"/s");
  $("deviceRxSpeed").textContent="受信速度 "+(Number(d.rxBytesPerSecond)<0?"取得不可":bytesText(d.rxBytesPerSecond)+"/s");
  $("deviceTotal").textContent="合計 "+(tx<0||rx<0?"取得不可":bytesText(tx+rx));
  const tx7=Number(d.txBytes7d),rx7=Number(d.rxBytes7d),tx30=Number(d.txBytes30d),rx30=Number(d.rxBytes30d);
  const usageText=value=>Number.isFinite(value)&&value>=0?bytesText(value):"取得不可";
  $("deviceTx7d").textContent="過去7日・送信 "+usageText(tx7);
  $("deviceRx7d").textContent="過去7日・受信 "+usageText(rx7);
  $("deviceTotal7d").textContent="過去7日・合計 "+(Number.isFinite(tx7)&&Number.isFinite(rx7)&&tx7>=0&&rx7>=0?bytesText(tx7+rx7):"取得不可");
  $("deviceTx30d").textContent="過去30日・送信 "+usageText(tx30);
  $("deviceRx30d").textContent="過去30日・受信 "+usageText(rx30);
  $("deviceTotal30d").textContent="過去30日・合計 "+(Number.isFinite(tx30)&&Number.isFinite(rx30)&&tx30>=0&&rx30>=0?bytesText(tx30+rx30):"取得不可");
  const charging=d.batteryCharging===true?"・充電中":"";
  const thermal=d.thermalStatus>=4?"・高温注意":"";
  $("deviceHealth").textContent=(d.deviceModel||"Android")+" / 電池 "+(d.batteryPercent>=0?d.batteryPercent+"%":"--")+charging+" / 温度 "+(d.batteryTempC>=0?d.batteryTempC+"℃":"--")+thermal;
  $("cameraFacing").textContent="カメラ "+(d.cameraFacing||"不明");
  S.flashAvailable=d.flashAvailable===true;
  S.torchEnabled=d.flashEnabled===true;
  $("torch").disabled=!S.flashAvailable||!S.control||S.control.readyState!=="open";
  $("torch").textContent=!S.flashAvailable?"ライト非対応":(S.torchEnabled?"ライトをOFF":"ライトをON");
  $("flashState").textContent=!S.flashAvailable?"ライト非対応":(S.torchEnabled?"ライト ON":"ライト OFF");
  if(d.microphoneMode){
    const modes={ambient:"環境音重視",balanced:"バランス",voice:"声重視"};
    $("audioState").textContent="Androidマイク・"+(modes[d.microphoneMode]||d.microphoneMode);
  }
  if ($("deviceInfoDialog").open) renderDeviceInfo();
  if(d.network)$("networkSummary").textContent=(d.network.transport||"不明")+(d.network.validated?" / Internet OK":" / Internet未確認");
}
 else if(d.type==="network_diagnostic"){
  S.deviceDiagnostics = d.data || d;
  $("diagnosticOutput").textContent=JSON.stringify(S.deviceDiagnostics,null,2);
  if ($("deviceInfoDialog").open) renderDeviceInfo();
}
 else if(d.type==="error"){toast(d.message||"Androidエラー");$("diagnosticOutput").textContent=d.message||"Androidエラー";}
}
function stopRtcStats(){if(S.statsTimer)clearInterval(S.statsTimer);S.statsTimer=null;}
function maybeAdaptQuality(rttMs, lossPercent) {
  const selectedQuality = $("quality").value;
  if (selectedQuality !== "auto") return;
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
    { quality: "360", fps: 15, label: "低負荷 360p" },
    { quality: "480", fps: 20, label: "中負荷 480p" },
    { quality: "720", fps: 24, label: "標準 720p" }
  ];
  const tier = tiers[nextTier];
  const payload = { quality: tier.quality, fps: tier.fps, adaptive: true };
  if (sendControl("adaptive_quality", payload)) {
    $("networkSummary").textContent = "自動画質：" + tier.label;
    toast("通信状態に合わせて画質を調整しました（" + tier.label + "）。");
  }
}
function startRtcStats() {
  stopRtcStats();
  S.statsLast = null;
  let updateRunning = false;
  const update = async () => {
    const peer = S.pc;
    if (!peer || updateRunning) return;
    updateRunning = true;
    try {
      const stats = await peer.getStats();
      if (peer !== S.pc) return;
      let sent = 0, received = 0, rtt = null, lost = 0, packets = 0, fps = null;
      stats.forEach(item => {
        if (item.type === "outbound-rtp" && !item.isRemote && item.kind === "video") sent += Number(item.bytesSent || 0);
        if (item.type === "inbound-rtp" && !item.isRemote) {
          received += Number(item.bytesReceived || 0);
          if (item.kind === "video") {
            lost += Math.max(0, Number(item.packetsLost || 0));
            packets += Math.max(0, Number(item.packetsReceived || 0));
            if (Number.isFinite(Number(item.framesPerSecond))) fps = Number(item.framesPerSecond);
          }
        }
        if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated &&
            Number.isFinite(item.currentRoundTripTime)) rtt = item.currentRoundTripTime;
      });
      const now = performance.now();
      let bitrateKbps = null;
      if (S.statsLast && now > S.statsLast.at) {
        const seconds = (now - S.statsLast.at) / 1000;
        const delta = Math.max(0, sent + received - S.statsLast.totalBytes);
        bitrateKbps = Math.round(delta * 8 / seconds / 1000);
      }
      S.statsLast = { at: now, totalBytes: sent + received };
      const lossPercent = packets + lost ? lost / (packets + lost) * 100 : null;
      $("rtcStats").textContent = "RTP " + bytesText(sent + received) +
        " / RTT " + (rtt === null ? "--" : Math.round(rtt * 1000) + "ms") +
        " / 損失 " + (lossPercent === null ? "--" : lossPercent.toFixed(1) + "%");
      const metricParts = [];
      metricParts.push("受信FPS " + (fps === null ? "--" : fps.toFixed(0)));
      metricParts.push("速度 " + (bitrateKbps === null ? "--" : bitrateKbps + "kbps"));
      metricParts.push("RTT " + (rtt === null ? "--" : Math.round(rtt * 1000) + "ms"));
      metricParts.push("損失 " + (lossPercent === null ? "--" : lossPercent.toFixed(1) + "%"));
      $("connectionMetrics").textContent = metricParts.join(" / ");
      maybeAdaptQuality(rtt === null ? null : rtt * 1000, lossPercent);
    } catch (_) {
      $("rtcStats").textContent = "統計取得不可";
      $("connectionMetrics").textContent = "通信統計取得不可";
    } finally {
      updateRunning = false;
    }
  };
  update();
  S.statsTimer = setInterval(update, 5000);
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
  if (S.lastLocation && S.lastLocation.transport === "RTC") {
    S.history = LocationUtils.mergeHistory(S.history, S.lastLocation, 500);
  }
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
  S.map.on("dragstart", () => {
    S.followMap = false;
    updateLocationActions();
  });
}
function syncRemoteVideoViewport() {
  const pane = $("videoPane");
  const video = $("remoteVideo");
  if (!pane || !video) return;
  const selected = $("aspectRatio")?.value || "original";
  if (selected === "original" && video.videoWidth > 0 && video.videoHeight > 0) {
    pane.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    pane.style.flex = "0 0 auto";
    pane.style.height = "auto";
    pane.style.minHeight = "240px";
    pane.style.maxHeight = "calc(100dvh - 190px)";
  }
  video.style.objectFit = "contain";
  video.style.objectPosition = "50% 50%";
}
function applyAspectRatio(value) {
  const ratios = { "16:9": "16 / 9", "4:3": "4 / 3", "1:1": "1 / 1", "9:16": "9 / 16" };
  const pane = $("videoPane");
  if (!pane) return;
  if (value === "original" || !ratios[value]) {
    const video = $("remoteVideo");
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      pane.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
      pane.style.flex = "0 0 auto";
    } else {
      pane.style.aspectRatio = "";
      pane.style.flex = "1 1 auto";
    }
    pane.style.height = "auto";
    pane.style.minHeight = "240px";
    pane.style.maxHeight = "calc(100dvh - 190px)";
  } else {
    pane.style.aspectRatio = ratios[value];
    pane.style.flex = "0 0 auto";
    pane.style.height = "auto";
    pane.style.minHeight = "240px";
    pane.style.maxHeight = "calc(100dvh - 190px)";
  }
  syncRemoteVideoViewport();
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
async function refreshLatestLocation() {
  const device = S.device;
  if (!device) return;
  const requestStartedAt = Date.now();
  try {
    const result = await api("get_locations", {
      controllerToken: device.controllerToken, deviceId: device.deviceId, limit: 500
    });
    if (!S.device || S.device.deviceId !== device.deviceId) return;
    // Keep a newer direct RTC fix if it arrived while the GAS request was in flight.
    const livePoint = S.lastLocation && S.lastLocation.transport === "RTC"
      ? S.lastLocation : null;
    S.history = LocationUtils.mergeHistory(result.locations || [], livePoint, 500);
    drawMap(S.history);
  } catch (error) {
    console.warn("Latest location refresh failed", error);
  }
}
function stopLocationRefresh() {
  if (S.locationRefreshTimer) clearInterval(S.locationRefreshTimer);
  S.locationRefreshTimer = null;
}
function startLocationRefresh() {
  stopLocationRefresh();
  if (!S.device) return;
  refreshLatestLocation();
  S.locationRefreshTimer = setInterval(() => {
    // RTC pushes fresh coordinates; GAS polling is only a fallback.
    if (!document.hidden && !$("mapPane").classList.contains("hidden") &&
        S.device && S.control?.readyState !== "open") {
      refreshLatestLocation();
    }
  }, 30000);
}
function showMap() {
  $("videoPane").classList.add("hidden");
  $("mapPane").classList.remove("hidden");
  $("mapTab").classList.add("active");
  $("videoTab").classList.remove("active");
  initMap();
  setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 100);
  if (S.history.length) drawMap(S.history);
  startLocationRefresh();
}
function showVideo() {
  stopLocationRefresh();
  $("mapPane").classList.add("hidden");
  $("videoPane").classList.remove("hidden");
  $("videoTab").classList.add("active");
  $("mapTab").classList.remove("active");
  restoreRemotePlayback();
  if (S.pc) startVideoWatchdog(S.pc);
}
function updateLocationActions() {
  $("copyCoordinates").disabled = !S.lastLocation;
  $("followLocation").classList.toggle("active", S.followMap);
  $("followLocation").textContent = S.followMap ? "最新位置を追尾 ON" : "最新位置を追尾 OFF";
}

function drawMap(points) {
  initMap();
  if (!S.map) return;
  if (S.marker) S.marker.remove();
  if (S.route) S.route.remove();
  const valid = (Array.isArray(points) ? points : []).filter(point =>
    Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
  );
  if (!valid.length) {
    S.lastLocation = null;
    $("locationInfo").textContent = "位置情報はありません。";
    updateLocationActions();
    return;
  }
  const last = valid[valid.length - 1];
  S.lastLocation = last;
  S.marker = L.marker([Number(last.lat), Number(last.lng)]).addTo(S.map);
  if (valid.length > 1) {
    S.route = L.polyline(valid.map(point => [Number(point.lat), Number(point.lng)]), { color: "#2865d6" }).addTo(S.map);
  }
  const ageSeconds = Math.max(0, Math.round((Date.now() - new Date(last.timestamp).getTime()) / 1000));
  const sourceText = last.transport === "RTC" ? "RTCライブ更新" : "GAS履歴";
  $("locationInfo").textContent = "最終取得: " + new Date(last.timestamp).toLocaleString() +
    " / 精度 ±" + (last.accuracy || "?") + "m / " + ageSeconds + "秒前 / " +
    (last.mode || "取得") + " / " + sourceText;
  if (S.followMap) S.map.setView([Number(last.lat), Number(last.lng)], Math.max(S.map.getZoom(), 15));
  updateLocationActions();
}

async function copyCoordinates() {
  if (!S.lastLocation) {
    toast("コピーできる位置情報がありません。");
    return;
  }
  const text = Number(S.lastLocation.lat).toFixed(6) + ", " + Number(S.lastLocation.lng).toFixed(6);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard API unavailable");
    }
    toast("座標をコピーしました: " + text);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch (_) {}
    input.remove();
    toast(copied ? "座標をコピーしました: " + text : "座標をコピーできませんでした。");
  }
}

function toggleLocationFollow() {
  S.followMap = !S.followMap;
  if (S.followMap && S.lastLocation && S.map) {
    S.map.setView([Number(S.lastLocation.lat), Number(S.lastLocation.lng)], Math.max(S.map.getZoom(), 15));
  }
  updateLocationActions();
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
function renderAndroidSchedule(schedule){
 const start=Number(schedule&&schedule.startAt)||0;
 const end=Number(schedule&&schedule.endAt)||0;
 const enabled=!!(schedule&&schedule.enabled&&start>0&&end>start);
 $("androidScheduleStart").textContent="開始："+(start?new Date(start).toLocaleString():"未設定");
 $("androidScheduleEnd").textContent="終了："+(end?new Date(end).toLocaleString():"未設定");
 $("androidScheduleStatus").textContent=enabled?(end>Date.now()?"APKに予約保存済み（Android側のアラームで動作）":"登録済みの予約時刻を経過しています"):(schedule&&schedule.updatedAt?"APK側の予約は解除されています":"APK側の予約情報は未同期です");
 $("refreshAndroidSchedule").disabled=!S.device;
}
async function refreshAndroidSchedule(){
 const device=S.device;
 if(!device){renderAndroidSchedule(null);throw Error("先にAndroid端末をペアリングしてください。");}
 const result=await api("get_settings",{controllerToken:device.controllerToken,deviceId:device.deviceId});
 if(!S.device||S.device.deviceId!==device.deviceId)return;
 renderAndroidSchedule((result.settings||{}).androidSchedule||null);
 toast("APKの予約時刻を更新しました。");
}
async function reserveConnection(){
 if(!S.device)throw Error("先にAndroid端末をペアリングしてください。");
 const input=$("reserveAt").value;const when=new Date(input).getTime();
 if(!Number.isFinite(when)||when<Date.now()+15000)throw Error("15秒以上先の日時を指定してください。");
 localStorage.setItem(RESERVATION_KEY,JSON.stringify({deviceId:S.device.deviceId,when}));
 S.manualDisconnect=false;
 refreshReservationUi();toast("接続予約を秒単位で保存しました。予約時刻にWeb画面が動作している必要があります。");
}
function cancelConnectionReservation(){localStorage.removeItem(RESERVATION_KEY);refreshReservationUi();toast("接続予約を解除しました。");}
function checkConnectionReservation(){
 const r=readReservation();
 if(!r||!Number.isFinite(Number(r.when))||!r.deviceId)return;
 if(Date.now()<Number(r.when)||S.connecting)return;
 if(!S.device||S.device.deviceId!==r.deviceId){
  const target=(S.devices||[]).find(device=>device.deviceId===r.deviceId);
  if(target) selectDevice(target);
  else { refreshDeviceList(); return; }
 }
 if(!S.device||S.device.deviceId!==r.deviceId)return;
 if(S.pc&&S.pc.connectionState==="connected"&&S.control?.readyState==="open"){
  localStorage.removeItem(RESERVATION_KEY);refreshReservationUi();toast("予約時刻になりました。すでに接続中です。");return;
 }
 localStorage.removeItem(RESERVATION_KEY);refreshReservationUi();
 S.manualDisconnect=false;
 S.autoConnectWanted=true;
 S.reconnectAttempts=0;
 toast("予約時刻になりました。接続を開始します。");
 connect(true);
}

document.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(error => console.warn("PWA service worker unavailable", error));
  $("refresh").addEventListener("click", refreshDeviceList);
  $("pair").addEventListener("click", () => $("pairDialog").showModal());
  $("closePairDialog").addEventListener("click", () => $("pairDialog").close());
  $("unpair").addEventListener("click", () => unpairSelectedDevice());
  $("claim").addEventListener("click", claimDevice);
  $("connect").addEventListener("click", () => connect(false));
  $("disconnect").addEventListener("click", () => disconnect(true));
  $("ptt").addEventListener("click", () => {
    if (S.pc && S.micSender) setWebMicEnabled(!S.pttActive);
  });
  $("remoteMute").addEventListener("click", () => setRemoteAudioMuted(!S.remoteAudioMuted));
  $("keepAwake").addEventListener("click", toggleScreenWakeLock);
  $("fitMode").addEventListener("click", toggleFitMode);
    $("saveSettings").addEventListener("click", () => {
    if (settingsChangeTimer) clearTimeout(settingsChangeTimer);
    settingsChangeTimer = null;
    saveSettings().catch(error => toast(error.message));
  });
  $("locate").addEventListener("click", () => {
    const rtcReady = S.control?.readyState === "open";
    command("location_once")
      .then(() => {
        if (rtcReady) {
          toast("位置情報の取得を要求しました。取得結果はRTCで直接届きます。");
        } else {
          setTimeout(() => refreshLatestLocation(), 4000);
        }
      })
      .catch(error => toast(error.message));
  });
  $("history").addEventListener("click", () => loadHistory().catch(error => toast(error.message)));
  $("followLocation").addEventListener("click", toggleLocationFollow);
  $("copyCoordinates").addEventListener("click", () => copyCoordinates().catch(error => toast(error.message)));
  $("deviceInfo").addEventListener("click", () => {
    renderDeviceInfo();
    $("deviceInfoDialog").showModal();
  });
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
  $("zoomReset").addEventListener("click", () => {
    $("zoom").value = "100"; S.zoomPanX = 0; S.zoomPanY = 0; applyViewerZoom();
  });
  $("remoteVideo").addEventListener("pointerdown", startViewerPan);
  $("remoteVideo").addEventListener("pointermove", moveViewerPan);
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(name => $("remoteVideo").addEventListener(name, endViewerPan));
  $("remoteVideo").addEventListener("loadedmetadata", () => { applyAspectRatio($("aspectRatio").value); syncRemoteVideoViewport(); });
  $("remoteVideo").addEventListener("resize", syncRemoteVideoViewport);
  $("remoteVideo").addEventListener("playing", startMotionDetection);
  $("remoteVideo").addEventListener("pause", () => {
    if (S.pc && S.remoteVideoStream && $("remoteVideo").readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      // Full-screen transitions can briefly pause the element without ending RTP.
      setTimeout(() => restoreRemotePlayback(), 180);
    } else {
      stopMotionDetection("映像一時停止中");
    }
  });
  $("bookmarkletOpen").addEventListener("click", openBookmarkletDialog);
  $("copyBookmarklet").addEventListener("click", copyBookmarkletCode);
  const restoreAfterViewportChange = () => {
    if (S.viewportRestoreTimer) clearTimeout(S.viewportRestoreTimer);
    S.viewportRestoreTimer = setTimeout(() => {
      S.viewportRestoreTimer = null;
      if (S.map && !$("mapPane").classList.contains("hidden")) {
        try { S.map.invalidateSize({ pan: false }); } catch (_) {}
      }
      syncRemoteVideoViewport();
      restoreRemotePlayback();
    }, 240);
  };
  document.addEventListener("fullscreenchange", restoreAfterViewportChange);
  document.addEventListener("webkitfullscreenchange", restoreAfterViewportChange);
  $("remoteVideo").addEventListener("webkitendfullscreen", restoreAfterViewportChange);
  window.addEventListener("pageshow", restoreAfterViewportChange);
  window.addEventListener("resize", () => {
    if (S.pc) restoreAfterViewportChange();
    else syncRemoteVideoViewport();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopMotionDetection("画面がバックグラウンドです。復帰後に再開します。");
      // A hidden controller must never keep its Web microphone transmitting.
      if (S.pttActive || S.pttRequested || S.pttStarting) {
        // Invalidate any in-flight permission prompt too; a late getUserMedia
        // resolution must not attach a microphone while this page is hidden.
        setWebMicEnabled(false);
      }
      ++S.wakeLockRequestGeneration;
      if (S.wakeLock) {
        const lock = S.wakeLock;
        S.wakeLock = null;
        lock.release().catch(() => {});
      }
      updateScreenWakeLockButton();
    } else {
      restoreRemotePlayback();
      if (S.motion.enabled) startMotionDetection();
      if (S.keepAwakeWanted && S.pc && S.pc.connectionState === "connected") {
        enableScreenWakeLock(S.wakeLockRequestGeneration).catch(() => {});
      }
      updateScreenWakeLockButton();
      if (S.pc) startVideoWatchdog(S.pc);
    }
  });
  $("fps").addEventListener("change", scheduleSettingsSave);
  $("aspectRatio").addEventListener("change", () => {
    try { if (S.device) localStorage.setItem("rc_camera_ratio_choice_v1_" + S.device.deviceId, $("aspectRatio").value); } catch (_) {}
    applyAspectRatio($("aspectRatio").value);
    scheduleSettingsSave();
  });
  $("androidSpeakerVolume").addEventListener("change", scheduleSettingsSave);
  ["androidSpeakerVolume","micNoise","micSensitivity","micGain"].forEach(id=>$(id).addEventListener("input",updateSliderLabels));
  $("receiveVolume").addEventListener("input", event => setReceiveVolume(event.target.value, true));
  $("micMode").addEventListener("change", scheduleSettingsSave);
  $("diagnostics").addEventListener("click",()=>command("diagnostics").catch(e=>toast(e.message)));
  $("torch").addEventListener("click",()=>{
    const desired=!S.torchEnabled;
    command("torch",{enabled:desired})
      .then(()=>toast("ライト切替要求をAndroidへ送りました。実際の状態は端末応答で更新します。"))
      .catch(error=>toast(error.message));
  });
  $("cameraToggle").addEventListener("click",toggleAndroidCamera);
  $("micToggle").addEventListener("click",toggleAndroidMicrophone);
  $("androidKeepAwake").addEventListener("click", () => toggleAndroidKeepAwake().catch(error => toast(error.message)));
  $("reserveConnection").addEventListener("click",()=>reserveConnection().catch(e=>toast(e.message)));
  $("cancelReservation").addEventListener("click",cancelConnectionReservation);
  $("refreshAndroidSchedule").addEventListener("click",()=>refreshAndroidSchedule().catch(error=>toast(error.message)));
  $("micNoise").addEventListener("input", () => setNoiseSuppressionLevel($("micNoise").value, false));
  $("micNoise").addEventListener("change", () => {
    setNoiseSuppressionLevel($("micNoise").value, true);
    scheduleSettingsSave();
  });
  $("micSensitivity").addEventListener("change", scheduleSettingsSave);
  $("micGain").addEventListener("change", scheduleSettingsSave);
  $("nightMode").addEventListener("change",()=>{applyNightViewFilter();localStorage.setItem(nightViewStorageKey(),String($("nightMode").checked));});
  updateSliderLabels();
  applyAspectRatio($("aspectRatio").value);
  applyViewerZoom();
  applyNightViewFilter();
  loadMotionSettings();
  updateSliderLabels();
  $("remoteMute").disabled = true;
  $("keepAwake").disabled = true;
  $("camera").disabled = true;
  $("sessionDuration").textContent = "未接続";
  const storedVolume = localStorage.getItem("rc_receive_volume_v1");
  setReceiveVolume(storedVolume === null ? 70 : Number(storedVolume), false);
  $("camera").addEventListener("change", event => {
    const option=event.target.selectedOptions && event.target.selectedOptions[0];
    updateWideCameraButton();
    command("camera", { cameraId: event.target.value, facing: option?.dataset.facing || event.target.value }).catch(error => toast(error.message));
  });
  $("wideCameraButton").addEventListener("click", switchToWidestCamera);
  updateWideCameraButton();
  S.reservationTimer = setInterval(checkConnectionReservation, 250);
  refreshReservationUi();
  renderAndroidSchedule(null);
  $("quality").addEventListener("change", scheduleSettingsSave);
  $("dataMode").addEventListener("change", scheduleSettingsSave);
  try {
    await loadConfig();
    S.devices = readDevices();
    renderDevices();
    try {
      const health = await api("health");
      S.apiVersion = String(health.version || "unknown");
      const expectedApiVersion = S.cfg.apiVersion || S.cfg.appVersion;
      if (expectedApiVersion && S.apiVersion !== String(expectedApiVersion)) {
        toast("Web v" + S.cfg.appVersion + " と GAS API v" + S.apiVersion +
          " が一致していません。最新版の gas/Code.gs を貼り付けて再デプロイしてください。");
      }
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
        resumeSavedConnectionIntent();
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

window.addEventListener("offline", () => {
  if ((S.everConnected || S.autoConnectWanted) && !S.manualDisconnect) {
    status("ネットワーク切断・復旧待機中");
    $("streamState").textContent = "ネットワーク復旧を待っています";
  }
});
window.addEventListener("online", () => {
  if ((!S.everConnected && !S.autoConnectWanted) || S.manualDisconnect || !S.device) return;
  if (S.reconnectTimer) clearTimeout(S.reconnectTimer);
  S.reconnectTimer = null;
  scheduleReconnect(S.pc, "online");
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden || (!S.everConnected && !S.autoConnectWanted) || S.manualDisconnect || !S.device) return;
  if (S.pc?.connectionState === "connected" && S.control?.readyState === "open") {
    restoreRemotePlayback();
    return;
  }
  scheduleReconnect(S.pc, "resume");
});

window.addEventListener("pageshow", () => {
  checkConnectionReservation();
  resumeSavedConnectionIntent();
});
// Never send an explicit Android disconnect on pagehide: iPad Safari can fire
// this event when the user switches apps or backgrounds the PWA.

