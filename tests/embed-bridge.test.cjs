const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("v2.8.8 embed mode routes GAS replies through the parent page", () => {
  const app = fs.readFileSync("app.js", "utf8");
  const gas = fs.readFileSync("gas/Code.gs", "utf8");
  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));

  assert.equal(config.appVersion, "2.8.8-preview");
  assert.ok(app.includes('params.get("embed") === "1"'));
  assert.ok(app.includes("responseOrigin: S.embedHostOrigin"));
  assert.ok(app.includes("event.source === window.parent"));
  assert.ok(app.includes("origin === S.embedHostOrigin"));
  assert.ok(gas.includes("function bridge_(id, result, requestedOrigin)"));
  assert.ok(gas.includes("req.responseOrigin"));
  assert.ok(gas.includes('" + targetOrigin + "'));
  assert.ok(gas.includes("window.top.postMessage"));
});

test("normal non-embedded mode keeps the original GitHub Pages GAS response origin", () => {
  const gas = fs.readFileSync("gas/Code.gs", "utf8");
  assert.ok(gas.includes('"https://a09848281-prog.github.io"'));
});
