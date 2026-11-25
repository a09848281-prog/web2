/**
 * Remote Camera GAS API v3.2
 * Account-free camera-first API.
 * Web controller access is granted only by an expiring Android pairing code.
 */
const TABLES = {
  Devices: ["deviceId","ownerUserId","deviceName","deviceSecretHash","codeHash","codeExpiresAt","createdAt","registeredAt","lastSeen","status","controllerSecretHash"],
  Commands: ["commandId","deviceId","ownerUserId","command","payloadJson","createdAt","expiresAt","status"],
  Signals: ["seq","sessionId","deviceId","sender","recipient","kind","sdp","candidateJson","createdAt","expiresAt"],
  Settings: ["deviceId","settingsJson","updatedAt"],
  Controllers: ["controllerId","deviceId","controllerTokenHash","createdAt","lastSeen","status"],
  LocationHistory: ["locationId","userId","deviceId","lat","lng","accuracy","timestamp","mode"],
  SecurityLog: ["timestamp","userId","deviceId","eventType","success","detail"],
  MotionEvents: ["eventId","deviceId","detectedAt","motionScore","sensitivity","source"]
};
const SESSION_DAYS = 7;
const DEFAULT_CODE_MINUTES = 10;
const ALLOWED_PAIRING_DURATIONS = [10, 20, 30, 60, 120];
const COMMAND_MINUTES = 3;
const SIGNAL_MINUTES = 3;
const PAIR_FAIL_LIMIT = 25;
const PAIR_FAIL_WINDOW_MS = 10 * 60 * 1000;
const DEVICE_BEGIN_LIMIT = 5;
const DEVICE_BEGIN_WINDOW_MS = 60 * 60 * 1000;
const MAX_MOTION_EVENTS_PER_DEVICE = 2000;

/** Public health check. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(health_()))
    .setMimeType(ContentService.MimeType.JSON);
}

function health_() {
  const version = "1.4.0";
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("DB_SPREADSHEET_ID");
  if (!spreadsheetId) {
    return {
      ok: true, service: "Remote Camera API", version: version, auth: "pairing",
      databaseReady: false, setupRequired: true,
      message: "setupDatabase()をもう一度実行してください。"
    };
  }
  try {
    const ss = SpreadsheetApp.openById(spreadsheetId);
    const missingSheets = [];
    const schemaErrors = [];
    Object.keys(TABLES).forEach(function(name) {
      const sh = ss.getSheetByName(name);
      if (!sh) {
        missingSheets.push(name);
        return;
      }
      const expected = TABLES[name];
      const actual = sh.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
      expected.forEach(function(header, index) {
        if (actual[index] !== header) schemaErrors.push(name + " の " + (index + 1) + " 列目");
      });
    });
    return {
      ok: true, service: "Remote Camera API", version: version, auth: "pairing",
      databaseReady: missingSheets.length === 0 && schemaErrors.length === 0,
      missingSheets: missingSheets, schemaErrors: schemaErrors
    };
  } catch (err) {
    return {
      ok: true, service: "Remote Camera API", version: version, auth: "pairing",
      databaseReady: false, setupRequired: true,
      message: safeError_(err)
    };
  }
}

function doPost(e) {
  let req = {};
  try {
    const params = e && e.parameter ? e.parameter : {};
    const raw = params.payload || "";
    if (!raw) throw Error("payload がありません。");
    req = JSON.parse(raw);
    const result = dispatch_(req);
    if (params.mode === "json") {
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }
    return bridge_(req.requestId || "", result, req.responseOrigin);
  } catch (err) {
    const result = { ok: false, error: safeError_(err) };
    if (e && e.parameter && e.parameter.mode === "json") {
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }
    return bridge_(req.requestId || "", result, req.responseOrigin);
  }
}

/**
 * Google HtmlService is sandboxed. Post to the top-level GitHub Pages origin,
 * not to the intermediate sandbox parent.
 */
function bridge_(id, result, requestedOrigin) {
  // Embed mode supplies the actual host page origin. Only accept a bare HTTPS origin.
  const targetOrigin = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(String(requestedOrigin || ""))
    ? String(requestedOrigin)
    : "https://a09848281-prog.github.io";
  const json = JSON.stringify({
    channel: "remote-camera-gas", requestId: String(id || ""), result: result
  }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return HtmlService.createHtmlOutput(
    "<!doctype html><html><head><meta charset='utf-8'></head><body>" +
    "<script>window.top.postMessage(" + json + ",'" + targetOrigin + "');</script>" +
    "<p>処理が完了しました。</p></body></html>"
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function dispatch_(r) {
  switch (String(r.action || "")) {
    case "health": return health_();
    case "device_begin": return deviceBegin_(r);
    case "device_refresh_code": return refreshDeviceCode_(r);
    case "claim_device": return claimDevice_(r);
    case "unpair_device": return unpairDevice_(r);
    case "device_poll": return devicePoll_(r);
    case "send_signal": return sendSignal_(r);
    case "poll_signals": return pollSignals_(r);
    case "send_command": return sendCommand_(r);
    case "ack_command": return ackCommand_(r);
    case "get_settings": return getSettings_(r);
    case "save_settings": return saveSettings_(r);
    case "save_device_schedule": return saveDeviceSchedule_(r);
    case "add_location": return addLocation_(r);
    case "get_locations": return getLocations_(r);
    case "delete_locations": return deleteLocations_(r);
    case "add_motion_event": return addMotionEvent_(r);
    case "get_motion_events": return getMotionEvents_(r);
    case "delete_motion_events": return deleteMotionEvents_(r);
    case "get_ice_config": return getIceConfig_(r);
    default: throw Error("未対応のAPIです: " + r.action);
  }
}

/**
 * Safe, non-destructive schema setup:
 * - Keeps existing data.
 * - Adds newly required trailing columns.
 * - Never clears a sheet when headers differ.
 * Legacy Users/Sessions sheets, if present, are left untouched and are no longer used.
 */
function setupDatabase() {
  const props = PropertiesService.getScriptProperties();
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const savedId = props.getProperty("DB_SPREADSHEET_ID");
    if (savedId) ss = SpreadsheetApp.openById(savedId);
  }
  if (!ss) throw Error("対象スプレッドシートから「拡張機能 → Apps Script」で作成してください。");
  Object.keys(TABLES).forEach(function(name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = TABLES[name];
    const lastColumn = sh.getLastColumn();
    if (sh.getLastRow() === 0 || lastColumn === 0 ||
        sh.getRange(1, 1).getValue() === "") {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      const existing = sh.getRange(1, 1, 1, Math.max(lastColumn, headers.length)).getValues()[0];
      for (let i = 0; i < Math.min(lastColumn, headers.length); i++) {
        if (existing[i] && existing[i] !== headers[i]) {
          throw Error(name + " シートの " + (i + 1) + " 列目の見出しが想定と異なります。データ保護のため初期化を中止しました。");
        }
      }
      for (let i = lastColumn; i < headers.length; i++) {
        sh.getRange(1, i + 1).setValue(headers[i]);
      }
    }
    sh.setFrozenRows(1);
  });
  props.setProperty("DB_SPREADSHEET_ID", ss.getId());
  return "Remote Camera database ready (existing rows preserved; spreadsheet ID saved).";
}

function db_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("DB_SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw Error("DB接続情報がありません。Apps ScriptでsetupDatabase()を実行してください。");
  props.setProperty("DB_SPREADSHEET_ID", active.getId());
  return active;
}
function sheet_(name) {
  const sh = db_().getSheetByName(name);
  if (!sh) throw Error("シートがありません。setupDatabase()を実行してください: " + name);
  return sh;
}
function rows_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, TABLES[name].length).getValues();
}
function find_(name, column, value) {
  const data = rows_(name);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][column]) === String(value)) return { row: i + 2, v: data[i] };
  }
  return null;
}
function append_(name, values) {
  const sh = sheet_(name);
  sh.appendRow(values);
  return sh.getLastRow();
}
function now_() { return new Date(); }
function iso_(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? "" : date.toISOString();
}
function randomToken_() {
  return Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
}
function hash_(value) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
  );
}
function safeError_(err) {
  return String(err && err.message ? err.message : err).slice(0, 300);
}
function log_(deviceId, eventType, success, detail) {
  append_("SecurityLog", [now_(), "", deviceId || "", eventType, !!success, String(detail || "").slice(0, 240)]);
}
function newCode_() {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    randomToken_(),
    Utilities.Charset.UTF_8
  );
  let number = 0;
  for (let i = 0; i < 4; i++) number = (number * 256 + (bytes[i] & 255)) >>> 0;
  return String(10000000 + (number % 90000000));
}
function checkPairRate_() {
  const props = PropertiesService.getScriptProperties();
  const key = "PAIR_ATTEMPTS";
  const now = Date.now();
  const raw = props.getProperty(key) || "";
  const parts = raw.split(":");
  let start = Number(parts[0] || 0);
  let count = Number(parts[1] || 0);
  if (!start || now - start >= PAIR_FAIL_WINDOW_MS) {
    start = now;
    count = 0;
  }
  if (count >= PAIR_FAIL_LIMIT) throw Error("ペアリング試行が多すぎます。10分ほど待ってください。");
  props.setProperty(key, start + ":" + (count + 1));
}
function clearPairRate_() {
  PropertiesService.getScriptProperties().deleteProperty("PAIR_ATTEMPTS");
}

function checkDeviceBeginRate_() {
  const props = PropertiesService.getScriptProperties();
  const key = "DEVICE_BEGIN_ATTEMPTS";
  const now = Date.now();
  const parts = String(props.getProperty(key) || "").split(":");
  let start = Number(parts[0] || 0);
  let count = Number(parts[1] || 0);
  if (!start || now - start >= DEVICE_BEGIN_WINDOW_MS) {
    start = now;
    count = 0;
  }
  if (count >= DEVICE_BEGIN_LIMIT) {
    throw Error("端末の初回登録回数が上限に達しました。1時間後に再試行してください。");
  }
  props.setProperty(key, start + ":" + (count + 1));
}

function authDevice_(deviceId, secret) {
  const d = find_("Devices", 0, deviceId);
  if (!d || !secret || hash_(secret) !== d.v[3] || !["pending", "active"].includes(String(d.v[9]))) {
    throw Error("Android端末の認証に失敗しました。");
  }
  return { deviceId: d.v[0], row: d.row, v: d.v };
}
function activeControllerCount_(deviceId) {
  let active = 0;
  try {
    active = rows_("Controllers").filter(function(row) {
      return String(row[1]) === String(deviceId) && String(row[5]) === "active";
    }).length;
  } catch (err) {
    active = 0;
  }
  const device = find_("Devices", 0, deviceId);
  const legacyActive = device && device.v[10] ? 1 : 0;
  return active + legacyActive;
}
function authController_(r) {
  const id = String(r.deviceId || "");
  const token = String(r.controllerToken || "");
  if (!id || !token) throw Error("Androidとのペアリングが必要です。");
  const d = find_("Devices", 0, id);
  if (!d || d.v[9] !== "active") throw Error("操作権限がありません。Androidのペアリングコードで再接続してください。");
  const tokenHash = hash_(token);
  let controllerHit = null;
  try {
    const data = rows_("Controllers");
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (String(row[1]) === id && String(row[2]) === tokenHash && String(row[5]) === "active") {
        controllerHit = { row: i + 2 };
        break;
      }
    }
  } catch (err) {
    // Compatibility with installations that have not yet created Controllers.
  }
  if (controllerHit) {
    sheet_("Controllers").getRange(controllerHit.row, 5).setValue(now_());
    return { deviceId: d.v[0], row: d.row, v: d.v, controllerId: true };
  }
  // Accept existing v4.0 single-controller tokens during migration.
  if (d.v[10] && tokenHash === d.v[10]) {
    return { deviceId: d.v[0], row: d.row, v: d.v, legacyController: true };
  }
  throw Error("操作権限がありません。Androidのペアリングコードで再接続してください。");
}
function ownerController_(r) { return authController_(r); }

function pairingDurationMinutes_(value) {
  const minutes = value === undefined || value === null || value === "" ?
    DEFAULT_CODE_MINUTES : Number(value);
  if (ALLOWED_PAIRING_DURATIONS.indexOf(minutes) === -1) {
    throw Error("コード有効時間は10分・20分・30分・1時間・2時間から選択してください。");
  }
  return minutes;
}

function deviceBegin_(r) {
  const id = String(r.deviceId || Utilities.getUuid());
  const name = String(r.deviceName || "Android端末").slice(0, 40);
  const secret = randomToken_();
  const code = newCode_();
  const durationMinutes = pairingDurationMinutes_(r.durationMinutes);
  const expiry = new Date(Date.now() + durationMinutes * 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    checkDeviceBeginRate_();
    if (find_("Devices", 0, id)) throw Error("端末IDが既に登録されています。アプリのデータを確認してください。");
    append_("Devices", [id, "", name, hash_(secret), hash_(code), expiry, now_(), "", "", "pending", ""]);
  } finally {
    lock.releaseLock();
  }
  log_(id, "device_begin", true, "Android device initialized");
  return { ok: true, deviceId: id, deviceSecret: secret, registrationCode: code, expiresAt: expiry.toISOString(), codeDurationMinutes: durationMinutes };
}

function refreshDeviceCode_(r) {
  const id = String(r.deviceId || "");
  const device = authDevice_(id, String(r.deviceSecret || ""));
  const code = newCode_();
  const durationMinutes = pairingDurationMinutes_(r.durationMinutes);
  const expiry = new Date(Date.now() + durationMinutes * 60000);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const current = find_("Devices", 0, id);
    if (!current || current.v[3] !== device.v[3]) throw Error("端末状態が変更されました。再試行してください。");
    sheet_("Devices").getRange(current.row, 5, 1, 2).setValues([[hash_(code), expiry]]);
  } finally {
    lock.releaseLock();
  }
  log_(id, "pair_code_refresh", true, "pairing code refreshed");
  return { ok: true, registrationCode: code, expiresAt: expiry.toISOString(), codeDurationMinutes: durationMinutes };
}

function claimDevice_(r) {
  const code = String(r.code || "").trim();
  if (!/^\d{8}$/.test(code)) throw Error("登録コードは8桁の数字です。");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let deviceId = "";
  try {
    checkPairRate_();
    const data = rows_("Devices");
    let hit = null;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const expiry = new Date(v[5]).getTime();
      if (v[4] && v[4] === hash_(code) && expiry > Date.now() && ["pending", "active"].includes(String(v[9]))) {
        hit = { row: i + 2, v: v };
        break;
      }
    }
    if (!hit) {
      log_("", "pair_claim", false, "invalid or expired code");
      throw Error("登録コードが無効または期限切れです。Android側で再発行してください。");
    }
    const name = String(r.deviceName || hit.v[2] || "Android端末").trim().slice(0, 40) || "Android端末";
    deviceId = String(hit.v[0]);
    // Migrate the original single-controller hash before admitting a new viewer,
    // so an already-paired browser keeps working after the schema upgrade.
    const legacyHash = String(hit.v[10] || "");
    if (legacyHash) {
      const existingControllers = rows_("Controllers");
      const alreadyMigrated = existingControllers.some(function(row) {
        return String(row[1]) === deviceId && String(row[2]) === legacyHash && String(row[5]) === "active";
      });
      if (!alreadyMigrated) append_("Controllers", [Utilities.getUuid(), deviceId, legacyHash, hit.v[7] || now_(), now_(), "active"]);
      sheet_("Devices").getRange(hit.row, 11).clearContent();
    }
    if (activeControllerCount_(deviceId) >= 3) throw Error("このAndroid端末はWeb操作端末を最大3台まで登録できます。使っていないブラウザーのペアリングを解除してください。");
    const controllerToken = randomToken_();
    const sh = sheet_("Devices");
    sh.getRange(hit.row, 2).setValue("");
    sh.getRange(hit.row, 3).setValue(name);
    sh.getRange(hit.row, 5, 1, 2).setValues([["", ""]]); // one-time code is consumed
    sh.getRange(hit.row, 8, 1, 3).setValues([[now_(), hit.v[8], "active"]]);
    append_("Controllers", [Utilities.getUuid(), deviceId, hash_(controllerToken), now_(), now_(), "active"]);
    clearPairRate_();
    log_(deviceId, "pair_claim", true, "viewer paired; active viewers=" + activeControllerCount_(deviceId));
    return { ok: true, deviceId: deviceId, deviceName: name, controllerToken: controllerToken, activeControllers: activeControllerCount_(deviceId) };
  } finally {
    lock.releaseLock();
  }
}

function unpairDevice_(r) {
  const d = authController_(r);
  const tokenHash = hash_(String(r.controllerToken || ""));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let remaining = 0;
  try {
    const rows = rows_("Controllers");
    let revoked = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (String(row[1]) === d.deviceId && String(row[2]) === tokenHash && String(row[5]) === "active") {
        sheet_("Controllers").getRange(i + 2, 6).setValue("revoked");
        revoked = true;
        break;
      }
    }
    const current = find_("Devices", 0, d.deviceId);
    if (!revoked && current && current.v[10] === tokenHash) {
      sheet_("Devices").getRange(current.row, 11).clearContent();
      revoked = true;
    }
    if (!revoked) throw Error("ペアリング状態が変更されています。端末一覧を更新してください。");
    remaining = activeControllerCount_(d.deviceId);
    if (remaining === 0) {
      sheet_("Devices").getRange(current.row, 10).setValue("pending");
      sheet_("Devices").getRange(current.row, 5, 1, 2).clearContent();
    }
  } finally {
    lock.releaseLock();
  }
  log_(d.deviceId, "unpair_device", true, "controller pairing revoked; remaining=" + remaining);
  return { ok: true, deviceId: d.deviceId, unpaired: true, remainingControllers: remaining };
}

function devicePoll_(r) {
  const id = String(r.deviceId || "");
  const secret = String(r.deviceSecret || "");
  const d = authDevice_(id, secret);
  if (d.v[9] === "pending") {
    const codeActive = !!d.v[4] && new Date(d.v[5]).getTime() > Date.now();
    return {
      ok: true, registered: false, needsPairing: true,
      pairingCodeActive: codeActive, commands: [], signals: [],
      latestSeq: Number(r.afterSeq || 0)
    };
  }
  sheet_("Devices").getRange(d.row, 9).setValue(now_());
  const commandRows = rows_("Commands");
  const commands = [];
  for (let i = 0; i < commandRows.length; i++) {
    const v = commandRows[i];
    if (v[1] !== id || v[7] !== "pending") continue;
    if (new Date(v[6]).getTime() < Date.now()) {
      sheet_("Commands").getRange(i + 2, 8).setValue("expired");
      continue;
    }
    commands.push({ commandId: v[0], command: v[3], payload: JSON.parse(v[4] || "{}") });
  }
  const after = Number(r.afterSeq || 0);
  const allSignals = rows_("Signals");
  const signals = [];
  for (let i = 0; i < allSignals.length; i++) {
    const v = allSignals[i];
    const seq = Number(v[0] || i + 2);
    if (v[2] === id && v[3] === "viewer" && v[4] === "device" &&
        seq > after && new Date(v[9]).getTime() > Date.now()) {
      signals.push({ seq: seq, sessionId: v[1], kind: v[5], sdp: v[6], candidate: v[7] ? JSON.parse(v[7]) : null });
    }
  }
  const settingsHit = find_("Settings", 0, id);
  let settings = { quality: "720", dataMode: "standard", fps: 24, aspectRatio: "original", micNoise: 0, micSensitivity: 0, micGain: 100, micMode: "ambient", speakerVolume: 70, nightMode: false, connectedLocationEnabled: false, idleLocationEnabled: false, connectedInterval: 30, idleInterval: 300 };
  if (settingsHit) {
    try { settings = Object.assign(settings, JSON.parse(settingsHit.v[1] || "{}")); } catch (err) {}
  }
  return {
    ok: true, registered: true,
    needsPairing: activeControllerCount_(id) === 0,
    pairingCodeActive: !!d.v[4] && new Date(d.v[5]).getTime() > Date.now(),
    commands: commands, signals: signals,
    latestSeq: signals.reduce(function(max, signal) { return Math.max(max, signal.seq); }, after),
    settings: settings,
    iceServers: iceServers_()
  };
}

function sendSignal_(r) {
  const id = String(r.deviceId || "");
  const recipient = String(r.recipient || "");
  if (!["device", "viewer"].includes(recipient)) throw Error("recipientが不正です。");
  let sender = "";
  if (r.deviceSecret) {
    authDevice_(id, String(r.deviceSecret));
    sender = "device";
  } else {
    authController_(r);
    sender = "viewer";
  }
  const session = String(r.sessionId || "");
  const kind = String(r.kind || "");
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(session)) throw Error("sessionIdが不正です。");
  if (!["offer", "answer", "candidate", "error", "bye"].includes(kind)) throw Error("signal kindが不正です。");
  if ((sender === "viewer" && recipient !== "device") || (sender === "device" && recipient !== "viewer")) {
    throw Error("送信先が不正です。");
  }
  const sdp = String(r.sdp || "").slice(0, 200000);
  const candidate = r.candidate ? JSON.stringify(r.candidate).slice(0, 10000) : "";
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let seq = 0;
  try {
    seq = append_("Signals", [0, session, id, sender, recipient, kind, sdp, candidate, now_(), new Date(Date.now() + SIGNAL_MINUTES * 60000)]);
    sheet_("Signals").getRange(seq, 1).setValue(seq);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, seq: seq };
}

function pollSignals_(r) {
  const d = authController_(r);
  const session = String(r.sessionId || "");
  const after = Math.max(0, Number(r.afterSeq || 0));
  const data = rows_("Signals");
  const signals = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const seq = Number(v[0] || i + 2);
    if (v[1] === session && v[2] === d.deviceId && v[4] === "viewer" && seq > after && new Date(v[9]).getTime() > Date.now()) {
      signals.push({ seq: seq, kind: v[5], sdp: v[6], candidate: v[7] ? JSON.parse(v[7]) : null });
    }
  }
  return { ok: true, signals: signals };
}

function sendCommand_(r) {
  const d = authController_(r);
  const command = String(r.command || "");
  const allowed = ["location_once", "location_settings", "camera", "volume", "quality", "data_mode", "disconnect"];
  if (!allowed.includes(command)) throw Error("許可されていない命令です。");
  const commandId = Utilities.getUuid();
  append_("Commands", [commandId, d.deviceId, "", command, JSON.stringify(r.payload || {}).slice(0, 5000), now_(), new Date(Date.now() + COMMAND_MINUTES * 60000), "pending"]);
  return { ok: true, commandId: commandId };
}

function ackCommand_(r) {
  const d = authDevice_(String(r.deviceId || ""), String(r.deviceSecret || ""));
  const commandId = String(r.commandId || "");
  const found = find_("Commands", 0, commandId);
  if (!found || found.v[1] !== d.deviceId || !["pending", "failed"].includes(String(found.v[7]))) {
    return { ok: true, ignored: true };
  }
  const status = r.success === false ? "failed" : "done";
  sheet_("Commands").getRange(found.row, 8).setValue(status);
  return { ok: true, status: status };
}

function clamp_(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}
function getSettings_(r) {
  const d = authController_(r);
  const found = find_("Settings", 0, d.deviceId);
  let settings = { quality: "720", dataMode: "standard", fps: 24, aspectRatio: "original", micNoise: 0, micSensitivity: 0, micGain: 100, micMode: "ambient", speakerVolume: 70, nightMode: false, connectedLocationEnabled: false, idleLocationEnabled: false, connectedInterval: 30, idleInterval: 300 };
  if (found) {
    try { settings = Object.assign(settings, JSON.parse(found.v[1] || "{}")); } catch (err) {}
  }
  return { ok: true, settings: settings };
}
function saveSettings_(r) {
  const d = authController_(r);
  const s = r.settings || {};
  const clean = {
    quality: ["auto", "360", "480", "720", "1080"].includes(String(s.quality)) ? String(s.quality) : "720",
    dataMode: ["auto", "ultra", "save", "standard", "high"].includes(String(s.dataMode)) ? String(s.dataMode) : "standard",
    fps: [10, 15, 20, 24, 30, 40, 45, 50, 55, 60].includes(Number(s.fps)) ? Number(s.fps) : 24,
    aspectRatio: ["16:9", "4:3", "1:1", "9:16", "original"].includes(String(s.aspectRatio)) ? String(s.aspectRatio) : "16:9",
    micNoise: clamp_(s.micNoise, 0, 100, 0),
    micSensitivity: clamp_(s.micSensitivity, 0, 100, 0),
    micGain: clamp_(s.micGain, 0, 100, 100),
    micMode: ["ambient", "balanced", "voice"].includes(String(s.micMode)) ? String(s.micMode) : "ambient",
    speakerVolume: clamp_(s.speakerVolume, 0, 100, 70),
    nightMode: s.nightMode === true,
    connectedLocationEnabled: s.connectedLocationEnabled === true,
    idleLocationEnabled: s.idleLocationEnabled === true,
    connectedInterval: clamp_(s.connectedInterval, 10, 3600, 30),
    idleInterval: clamp_(s.idleInterval, 10, 3600, 300)
  };
  const found = find_("Settings", 0, d.deviceId);
  if (found) {
    try {
      const previous = JSON.parse(found.v[1] || "{}");
      if (previous.androidSchedule) clean.androidSchedule = previous.androidSchedule;
    } catch (err) {}
  }
  const sh = sheet_("Settings");
  const json = JSON.stringify(clean);
  if (found) sh.getRange(found.row, 2, 1, 2).setValues([[json, now_()]]);
  else append_("Settings", [d.deviceId, json, now_()]);
  return { ok: true, settings: clean };
}
function saveDeviceSchedule_(r) {
  const device = authDevice_(String(r.deviceId || ""), String(r.deviceSecret || ""));
  const startAt = Number(r.startAt || 0);
  const endAt = Number(r.endAt || 0);
  const clear = startAt === 0 && endAt === 0;
  if (!clear && (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt <= 0 || endAt <= startAt)) {
    throw Error("Android予約時刻が不正です。");
  }
  const found = find_("Settings", 0, device.deviceId);
  let settings = {};
  if (found) {
    try { settings = JSON.parse(found.v[1] || "{}"); } catch (err) { settings = {}; }
  }
  const schedule = {
    enabled: !clear && endAt > Date.now(),
    startAt: clear ? 0 : Math.round(startAt),
    endAt: clear ? 0 : Math.round(endAt),
    updatedAt: Date.now()
  };
  settings.androidSchedule = schedule;
  const sh = sheet_("Settings");
  const json = JSON.stringify(settings);
  if (found) sh.getRange(found.row, 2, 1, 2).setValues([[json, now_()]]);
  else append_("Settings", [device.deviceId, json, now_()]);
  log_(device.deviceId, clear ? "android_schedule_clear" : "android_schedule_save", true,
    clear ? "Android schedule cleared" : "Android schedule saved");
  return { ok: true, schedule: schedule };
}

function addLocation_(r) {
  const d = authDevice_(String(r.deviceId || ""), String(r.deviceSecret || ""));
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  const accuracy = Number(r.accuracy || 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw Error("位置情報が不正です。");
  }
  const mode = ["manual", "connected", "background"].includes(String(r.mode)) ? String(r.mode) : "manual";
  const timestamp = r.timestamp ? new Date(Number(r.timestamp)) : now_();
  if (isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 60000) throw Error("取得日時が不正です。");
  append_("LocationHistory", [Utilities.getUuid(), "", d.deviceId, lat, lng, Math.max(0, accuracy), timestamp, mode]);
  return { ok: true };
}
function getLocations_(r) {
  const d = authController_(r);
  const limit = clamp_(r.limit, 1, 1000, 500);
  const data = rows_("LocationHistory");
  const locations = [];
  for (let i = data.length - 1; i >= 0 && locations.length < limit; i--) {
    const v = data[i];
    if (v[2] === d.deviceId) {
      locations.push({ id: v[0], lat: v[3], lng: v[4], accuracy: v[5], timestamp: iso_(v[6]), mode: v[7] });
    }
  }
  return { ok: true, locations: locations.reverse() };
}
function deleteLocations_(r) {
  const d = authController_(r);
  const sh = sheet_("LocationHistory");
  const data = rows_("LocationHistory");
  let deleted = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const v = data[i];
    if (v[2] === d.deviceId && (r.all === true || !r.before || new Date(v[6]).getTime() <= new Date(r.before).getTime())) {
      sh.deleteRow(i + 2);
      deleted++;
    }
  }
  log_(d.deviceId, "location_delete", true, String(deleted));
  return { ok: true, deleted: deleted };
}

function addMotionEvent_(r) {
  const controller = authController_(r);
  const eventId = String(r.eventId || "");
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(eventId)) throw Error("検知イベントIDが不正です。");
  const detectedAt = new Date(Number(r.detectedAt));
  if (isNaN(detectedAt.getTime()) || detectedAt.getTime() > Date.now() + 60000 || detectedAt.getTime() < Date.now() - 86400000 * 30) {
    throw Error("検知日時が不正です。");
  }
  const score = Number(r.motionScore);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw Error("動体スコアが不正です。");
  const sensitivity = clamp_(r.sensitivity, 1, 5, 3);
  const source = String(r.source || "browser-motion-v1").slice(0, 40);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const allEvents = rows_("MotionEvents");
    const existing = allEvents.find(function(row) { return String(row[0]) === eventId; });
    if (existing) return { ok: true, duplicate: true, eventId: eventId };
    // Three viewers can analyse the same incoming stream independently. Merge
    // nearly simultaneous reports from the same camera/source into one event.
    const crossViewerDuplicate = allEvents.some(function(row) {
      return String(row[1]) === controller.deviceId &&
        String(row[5] || "browser-motion-v1") === source &&
        Math.abs(new Date(row[2]).getTime() - detectedAt.getTime()) <= 3000;
    });
    if (crossViewerDuplicate) return { ok: true, duplicate: true, coalesced: true, eventId: eventId };
    const ownEvents = allEvents.filter(function(row) { return String(row[1]) === controller.deviceId; });
    if (ownEvents.length >= MAX_MOTION_EVENTS_PER_DEVICE) {
      const oldest = ownEvents.reduce(function(current, row) {
        if (!current) return row;
        return new Date(row[2]).getTime() < new Date(current[2]).getTime() ? row : current;
      }, null);
      const oldestIndex = oldest ? allEvents.findIndex(function(row) { return String(row[0]) === String(oldest[0]); }) : -1;
      if (oldestIndex >= 0) sheet_("MotionEvents").deleteRow(oldestIndex + 2);
    }
    append_("MotionEvents", [eventId, controller.deviceId, detectedAt, Math.round(score * 10) / 10, sensitivity, source]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, eventId: eventId };
}

function getMotionEvents_(r) {
  const controller = authController_(r);
  const limit = clamp_(r.limit, 1, MAX_MOTION_EVENTS_PER_DEVICE, 500);
  const data = rows_("MotionEvents");
  const events = [];
  for (let i = data.length - 1; i >= 0 && events.length < limit; i--) {
    const row = data[i];
    if (String(row[1]) !== controller.deviceId) continue;
    events.push({
      eventId: String(row[0]),
      detectedAt: iso_(row[2]),
      motionScore: Number(row[3]) || 0,
      sensitivity: Number(row[4]) || 3,
      source: String(row[5] || "browser-motion-v1")
    });
  }
  return { ok: true, events: events };
}

function deleteMotionEvents_(r) {
  const controller = authController_(r);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let deleted = 0;
  try {
    const sh = sheet_("MotionEvents");
    const data = rows_("MotionEvents");
    for (let i = data.length - 1; i >= 0; i--) {
      if (String(data[i][1]) === controller.deviceId) {
        sh.deleteRow(i + 2);
        deleted++;
      }
    }
  } finally {
    lock.releaseLock();
  }
  log_(controller.deviceId, "motion_history_delete", true, String(deleted));
  return { ok: true, deleted: deleted };
}

// Free STUN-only configuration. WebRTC gathers IPv4 and IPv6 candidates
// automatically when each network interface and browser/OS permits them.
function iceServers_() {
  return [{
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302"
    ]
  }];
}
function iceConfig_() {
  return { iceServers: iceServers_(), turnConfigured: false,
    turnProvider: "stun-only", turnStatus: "stun-only", turnError: "" };
}
function getIceConfig_(r) {
  authController_(r);
  const config = iceConfig_();
  return { ok: true, iceServers: config.iceServers, turnConfigured: false,
    turnProvider: "stun-only", turnStatus: "stun-only", turnError: "" };
}
