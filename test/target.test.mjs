// Run with: node --test   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeTarget, appLocation, MAX_TARGET } from "../src/target.mjs";

const APP = "https://app.example.com";

test("keeps the path and query of a deep link", () => {
  assert.equal(safeTarget("/schedule"), "/schedule");
  assert.equal(safeTarget("/do", "pass=5"), "/do?pass=5");
  assert.equal(safeTarget("/big-rocks/3/goals", "a=1&b=%20x"), "/big-rocks/3/goals?a=1&b=%20x");
  assert.equal(safeTarget("/", ""), "/");
  assert.equal(appLocation(APP, "/schedule"), "https://app.example.com/schedule");
  assert.equal(appLocation(APP, "/do?pass=5"), "https://app.example.com/do?pass=5");
  assert.equal(appLocation(APP, "/"), "https://app.example.com/");
});

test("never builds an open redirect", () => {
  const bad = [
    "//evil.com",
    "//evil.com/x",
    "/foo//bar",
    "/\\evil.com",
    "/%2F%2Fevil.com",
    "/%2f/evil.com",
    "/%5Cevil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "evil.com",
    "",
    "/a\u0000b",
    "/a\tb",
    "/a\nb",
    "/%0d%0aSet-Cookie:x",
    "/%E0%A4%A",          // malformed percent-encoding
    '/"><script>',
    "/a b",
    undefined,
    null,
  ];
  for (const p of bad) assert.equal(safeTarget(p), "/", JSON.stringify(p));
  for (const q of ["a=\u0001", 'x="><svg', "a=\\b", "a b"]) {
    assert.equal(safeTarget("/do", q), "/", JSON.stringify(q));
  }
  assert.equal(safeTarget("/" + "a".repeat(MAX_TARGET)), "/");
});

test("appLocation always stays on the app origin", () => {
  for (const t of ["//evil.com", "/@evil.com", "/.evil.com", "/x"]) {
    assert.equal(new URL(appLocation(APP, t)).origin, APP, t);
  }
  assert.equal(appLocation(APP + "/", "/schedule"), "https://app.example.com/schedule");
});
