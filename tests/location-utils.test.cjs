"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LocationUtils = require("../location-utils.js");

test("normalizes a valid RTC location with source metadata", () => {
  const now = Date.now();
  const point = LocationUtils.normalizeLiveLocation({
    lat: 35.681236,
    lng: 139.767125,
    accuracy: 8.5,
    timestamp: now,
    mode: "connected"
  });
  assert.ok(point);
  assert.equal(point.transport, "RTC");
  assert.equal(point.mode, "connected");
  assert.equal(point.accuracy, 8.5);
  assert.equal(new Date(point.timestamp).getTime(), now);
});

test("accepts valid zero coordinates and clamps negative accuracy", () => {
  const point = LocationUtils.normalizeLiveLocation({
    lat: 0, lng: 0, accuracy: -5, timestamp: Date.now()
  });
  assert.ok(point);
  assert.equal(point.lat, 0);
  assert.equal(point.lng, 0);
  assert.equal(point.accuracy, 0);
});

test("rejects invalid coordinates, missing time and unreasonable future time", () => {
  assert.equal(LocationUtils.normalizeLiveLocation({lat: 91,lng: 0,timestamp:Date.now()}), null);
  assert.equal(LocationUtils.normalizeLiveLocation({lat: 0,lng: 181,timestamp:Date.now()}), null);
  assert.equal(LocationUtils.normalizeLiveLocation({lat: 0,lng: 0}), null);
  assert.equal(LocationUtils.normalizeLiveLocation({lat: 0,lng: 0,timestamp:Date.now()+120000}), null);
});

test("supports Unix timestamps in seconds", () => {
  const point = LocationUtils.normalizeLiveLocation({
    lat: 1, lng: 2, timestamp: 1760000000, mode: "background"
  });
  assert.ok(point);
  assert.equal(new Date(point.timestamp).getTime(), 1760000000000);
});

test("merges history in timestamp order and avoids duplicate points", () => {
  const earlier = {lat:35,lng:139,accuracy:10,timestamp:"2026-11-20T00:00:00.000Z",id:"g1"};
  const live = LocationUtils.normalizeLiveLocation({
    lat:36,lng:140,accuracy:4,timestamp:Date.now(),mode:"manual"
  });
  const sameAsLiveFromGas = {...live,id:"g2",transport:undefined};
  const merged = LocationUtils.mergeHistory([live, earlier, sameAsLiveFromGas], live, 20);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "g1");
  assert.equal(merged[1].transport, "RTC");
});

test("limits retained history to the newest points", () => {
  const base = Array.from({length:8}, (_,i)=>({
    lat:i,lng:i,accuracy:1,timestamp:new Date(Date.now()-(8-i)*1000).toISOString(),id:"p"+i
  }));
  const merged = LocationUtils.mergeHistory(base, null, 3);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, "p5");
  assert.equal(merged[2].id, "p7");
});
