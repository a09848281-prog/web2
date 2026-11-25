const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const gasSource = fs.readFileSync("gas/Code.gs", "utf8");
const iceHelper = require("../network-ice.js");

function createRuntime({ properties = {} } = {}) {
  const logs = [];
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: key => properties[key] ?? null })
    },
    Logger: { log: value => logs.push(String(value)) },
    console: { warn: () => {}, error: () => {}, log: () => {} }
  };
  vm.runInNewContext(gasSource, sandbox, { filename: "Code.gs" });
  return { sandbox, logs };
}

test("ExpressTURN free-plan credentials are returned only with the documented UDP/TCP 3478 endpoints", () => {
  const runtime = createRuntime({
    properties: {
      EXPRESSTURN_USERNAME: "account-turn-user",
      EXPRESSTURN_CREDENTIAL: "account-turn-password"
    }
  });
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, true);
  assert.equal(config.turnProvider, "expressturn");
  assert.equal(config.turnStatus, "ready");
  assert.deepEqual(JSON.parse(JSON.stringify(config.iceServers)), [
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302"
    ] },
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp"
      ],
      username: "account-turn-user",
      credential: "account-turn-password"
    }
  ]);
  assert.equal(runtime.logs.length, 0);
});

test("missing ExpressTURN credentials safely fall back to Google STUN only", () => {
  const runtime = createRuntime();
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.turnProvider, "stun-only");
  assert.equal(config.turnStatus, "not-configured");
  assert.deepEqual(JSON.parse(JSON.stringify(config.iceServers)), [
    { urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302",
      "stun:stun3.l.google.com:19302",
      "stun:stun4.l.google.com:19302"
    ] }
  ]);
});

test("partial, overlong, or newline-injected ExpressTURN credentials are rejected safely", () => {
  for (const properties of [
    { EXPRESSTURN_USERNAME: "user" },
    { EXPRESSTURN_CREDENTIAL: "password" },
    { EXPRESSTURN_USERNAME: "u".repeat(257), EXPRESSTURN_CREDENTIAL: "password" },
    { EXPRESSTURN_USERNAME: "user\ninjected", EXPRESSTURN_CREDENTIAL: "password" },
    { EXPRESSTURN_USERNAME: "user", EXPRESSTURN_CREDENTIAL: "pass\r\ninjected" }
  ]) {
    const config = createRuntime({ properties }).sandbox.iceConfig_();
    assert.equal(config.turnConfigured, false);
    assert.equal(config.turnProvider, "stun-only");
    assert.equal(config.turnStatus, "invalid-credentials");
    assert.equal(config.iceServers.length, 1);
  }
});

test("old Cloudflare properties are ignored and never trigger external credential requests", () => {
  const runtime = createRuntime({
    properties: {
      CF_TURN_KEY_ID: "old-id",
      CF_TURN_KEY_SECRET: "old-secret"
    }
  });
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.turnProvider, "stun-only");
  assert.ok(!JSON.stringify(config).includes("old-secret"));
  assert.ok(!gasSource.includes("CF_TURN_KEY_ID"));
  assert.ok(!gasSource.includes("rtc.live.cloudflare.com"));
});

test("diagnostic helper reports ExpressTURN readiness without returning credentials", () => {
  const runtime = createRuntime({
    properties: {
      EXPRESSTURN_USERNAME: "private-user",
      EXPRESSTURN_CREDENTIAL: "private-password"
    }
  });
  const result = runtime.sandbox.testExpressTurnSetup();
  assert.equal(result.turnConfigured, true);
  assert.equal(result.turnProvider, "expressturn");
  assert.equal(result.turnUrlCount, 2);
  assert.equal(JSON.stringify(result).includes("private-user"), false);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
  assert.equal(runtime.logs.length, 1);
  assert.equal(runtime.logs[0].includes("private-password"), false);
});

test("TURN configuration validation requires a real URL and both credentials", () => {
  assert.equal(iceHelper.hasUsableTurnServers([
    { urls: ["turn:free.expressturn.com:3478?transport=udp"], username: "u", credential: "p" }
  ]), true);
  assert.equal(iceHelper.hasUsableTurnServers([
    { urls: ["turn:free.expressturn.com:3478?transport=udp"], username: "u", credential: "" }
  ]), false);
  assert.equal(iceHelper.hasUsableTurnServers([
    { urls: ["https://free.expressturn.com"], username: "u", credential: "p" }
  ]), false);
  assert.equal(iceHelper.hasUsableTurnServers([
    { urls: ["turn:free.expressturn.com:3478?transport=udp"], username: "u\nx", credential: "p" }
  ]), false);
});

test("Android receives standard ICE server URLs and reads TURN username/password from GAS", () => {
  const monitor = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
  const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
  const web = fs.readFileSync("app.js", "utf8");
  const config = fs.readFileSync("config.json", "utf8");
  const gasSource = fs.readFileSync("gas/Code.gs", "utf8");
  assert.ok(monitor.includes("rtc?.setIceServers(response.optJSONArray(\"iceServers\"))"));
  assert.ok(rtc.includes('url.startsWith("turn:", true)'));
  assert.ok(rtc.includes('url.startsWith("turns:", true)'));
  assert.ok(rtc.includes("builder.setUsername(username)"));
  assert.ok(rtc.includes("builder.setPassword(credential)"));
  assert.ok(!web.includes("EXPRESSTURN_CREDENTIAL"));
  assert.ok(!config.includes("EXPRESSTURN_CREDENTIAL"));
  assert.ok(!rtc.includes("EXPRESSTURN_CREDENTIAL"));
});

test("Web tries direct-only ICE first, then global IPv6, and enables TURN only as fallback", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
  const monitor = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
  const gasSource = fs.readFileSync("gas/Code.gs", "utf8");
  assert.ok(app.includes('const relayAttempt = S.iceMode === "relay" && S.turnConfigured;'));
  assert.ok(app.includes("RemoteCameraIce.stunOnlyServers(S.iceServers)"));
  assert.ok(app.includes('iceTransportPolicy = relayAttempt ? "relay" : "all"'));
  assert.ok(rtc.includes("buildIceServers(allowTurn)") && rtc.includes("allowTurn &&"));
  assert.ok(monitor.includes('signal.optJSONObject("metadata")?.optString("iceMode", "all")'));
  assert.ok(gasSource.includes("metadataJson") && gasSource.includes("parseSignalMetadata_"));
  assert.ok(app.includes('S.nextIceMode = "ipv6"'));
  assert.ok(app.includes('S.nextIceMode = "relay"'));
  assert.ok(app.includes("hasUsableTurnServers"));
  assert.ok(app.includes("S.iceServers = defaultIceServers()"));
  assert.ok(app.includes("S.forceTurnRelay = false"));
});

test("Web fallback does not carry stale TURN credentials into a later STUN-only attempt", () => {
  const app = fs.readFileSync("app.js", "utf8");
  assert.ok(app.includes("Never reuse credentials from an earlier attempt"));
  assert.ok(app.includes("S.turnConfigured = serverReportedTurn &&"));
  assert.ok(app.includes('S.iceMode = "normal"'));
  assert.ok(app.includes('S.turnProvider = "stun-only"'));
});

test("current project sources contain no Cloudflare TURN integration", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const gas = fs.readFileSync("gas/Code.gs", "utf8");
  const html = fs.readFileSync("index.html", "utf8");
  const config = fs.readFileSync("config.json", "utf8");
  assert.doesNotMatch(app + gas + html + config, /CF_TURN|cloudflareTurn|turn\.cloudflare\.com|rtc\.live\.cloudflare\.com/i);
});

test("Web connection metrics identify the selected TURN relay candidate pair", () => {
  const app = fs.readFileSync("app.js", "utf8");
  assert.ok(app.includes('candidateTypes.includes("relay")'));
  assert.ok(app.includes('metricParts.push("経路 " + route)'));
});
