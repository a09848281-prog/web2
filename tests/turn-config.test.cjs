const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const gasSource = fs.readFileSync("gas/Code.gs", "utf8");

function createRuntime({ properties = {}, response = null, httpStatus = 201 } = {}) {
  const cache = new Map();
  const requests = [];
  let cacheTtl = null;
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] ?? null }) },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(key) ?? null,
      put: (key, value, ttl) => { cache.set(key, value); cacheTtl = ttl; },
      remove: key => cache.delete(key)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: (url, options) => {
      requests.push({ url, options });
      return { getResponseCode: () => httpStatus, getContentText: () => JSON.stringify(response ?? {}) };
    } },
    console: { warn: () => {}, error: () => {}, log: () => {} }
  };
  vm.runInNewContext(gasSource, sandbox, { filename: "Code.gs" });
  return { sandbox, cache, requests, get cacheTtl() { return cacheTtl; } };
}

const cloudflareResponse = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:443?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:untrusted.example:3478?transport=udp"
      ],
      username: "temporary-turn-user",
      credential: "temporary-turn-password"
    }
  ]
};

test("Cloudflare TURN credentials are generated server-side and sanitized", () => {
  const runtime = createRuntime({
    properties: { CF_TURN_KEY_ID: "turn-key-id", CF_TURN_KEY_SECRET: "server-only-turn-key-secret" },
    response: cloudflareResponse
  });
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, true);
  assert.equal(config.turnProvider, "cloudflare");
  assert.equal(config.turnStatus, "ready");
  assert.equal(config.iceServers.length, 2);
  assert.ok(config.iceServers[0].urls.includes("stun:stun.cloudflare.com:3478"));
  const turn = config.iceServers[1];
  assert.equal(turn.username, "temporary-turn-user");
  assert.equal(turn.credential, "temporary-turn-password");
  assert.equal(turn.urls.length, 6);
  assert.ok(turn.urls.every(url => url.startsWith("turn:turn.cloudflare.com:") || url.startsWith("turns:turn.cloudflare.com:")));
  assert.ok(turn.urls.every(url => !/:53(?:\?|$)/.test(url)));
  assert.equal(runtime.requests.length, 1);
  assert.match(runtime.requests[0].url, /\/turn\/keys\/turn-key-id\/credentials\/generate-ice-servers$/);
  assert.equal(runtime.requests[0].options.headers.Authorization, "Bearer server-only-turn-key-secret");
  assert.deepEqual(JSON.parse(runtime.requests[0].options.payload), { ttl: 172800 });
  assert.equal(runtime.cacheTtl, 21600);
  assert.ok(!JSON.stringify(config).includes("server-only-turn-key-secret"));
  assert.ok(runtime.sandbox.testCloudflareTurnSetup);
});

test("Cloudflare TURN credentials are cached to avoid API calls on every device poll", () => {
  const runtime = createRuntime({
    properties: { CF_TURN_KEY_ID: "turn-key-id", CF_TURN_KEY_SECRET: "server-only-turn-key-secret" },
    response: cloudflareResponse
  });
  runtime.sandbox.iceConfig_();
  runtime.sandbox.iceConfig_();
  runtime.sandbox.iceConfig_();
  assert.equal(runtime.requests.length, 1);
});

test("missing Cloudflare keys safely fall back to Google STUN", () => {
  const runtime = createRuntime();
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.turnProvider, "stun-only");
  assert.equal(config.turnStatus, "not-configured");
  assert.deepEqual(JSON.parse(JSON.stringify(config.iceServers)), [
    { urls: ["stun:stun.l.google.com:19302"] }
  ]);
  assert.equal(runtime.requests.length, 0);
});

test("Cloudflare API failure preserves an existing custom TURN configuration", () => {
  const runtime = createRuntime({
    properties: {
      CF_TURN_KEY_ID: "turn-key-id",
      CF_TURN_KEY_SECRET: "server-only-turn-key-secret",
      TURN_URLS: '["turn:legacy.example:3478?transport=udp"]',
      TURN_USERNAME: "legacy-user",
      TURN_CREDENTIAL: "legacy-password"
    },
    response: { errors: [{ message: "unavailable" }] },
    httpStatus: 503
  });
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, true);
  assert.equal(config.turnProvider, "custom");
  assert.equal(config.turnStatus, "custom");
  assert.equal(config.iceServers[1].username, "legacy-user");
  assert.equal(config.iceServers[1].credential, "legacy-password");
  assert.ok(config.turnError.includes("503"));
});

test("invalid Cloudflare response never leaks a secret or becomes a fake TURN server", () => {
  const runtime = createRuntime({
    properties: { CF_TURN_KEY_ID: "turn-key-id", CF_TURN_KEY_SECRET: "server-only-turn-key-secret" },
    response: { iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp"] }] }
  });
  const config = runtime.sandbox.iceConfig_();
  assert.equal(config.turnConfigured, false);
  assert.equal(config.turnStatus, "cloudflare-unavailable");
  assert.ok(!JSON.stringify(config).includes("server-only-turn-key-secret"));
});

test("Cloudflare API failures are briefly cached to protect Apps Script quotas", () => {
  const runtime = createRuntime({
    properties: { CF_TURN_KEY_ID: "turn-key-id", CF_TURN_KEY_SECRET: "server-only-turn-key-secret" },
    response: { errors: [{ message: "unavailable" }] },
    httpStatus: 503
  });
  runtime.sandbox.iceConfig_();
  runtime.sandbox.iceConfig_();
  runtime.sandbox.iceConfig_();
  assert.equal(runtime.requests.length, 1);
});

test("Web connection metrics identify the selected TURN relay candidate pair", () => {
  const app = fs.readFileSync("app.js", "utf8");
  assert.ok(app.includes('candidateTypes.includes("relay")'));
  assert.ok(app.includes('metricParts.push("経路 " + route)'));
});

test("Android receives TURN ICE servers from GAS without embedding Cloudflare API secrets", () => {
  const monitor = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/MonitorService.kt", "utf8");
  const rtc = fs.readFileSync("android/app/src/main/java/jp/a09848281/remotecamera/RtcEngine.kt", "utf8");
  const web = fs.readFileSync("app.js", "utf8");
  const config = fs.readFileSync("config.json", "utf8");
  assert.ok(monitor.includes("rtc?.setIceServers(response.optJSONArray(\"iceServers\"))"));
  assert.ok(rtc.includes('it.startsWith("turn:", true)'));
  assert.ok(rtc.includes('it.startsWith("turns:", true)'));
  assert.ok(rtc.includes("builder.setUsername(username)"));
  assert.ok(rtc.includes("builder.setPassword(credential)"));
  assert.ok(!web.includes("CF_TURN_KEY_SECRET"));
  assert.ok(!config.includes("CF_TURN_KEY_SECRET"));
  assert.ok(!rtc.includes("CF_TURN_KEY_SECRET"));
});
