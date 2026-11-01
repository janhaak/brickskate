// Run with: node --test   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTheme } from "../src/page-theme.mjs";

test("no PageTheme keeps brickskate's own look, with no extra head tags", () => {
  for (const name of [undefined, "", "  ", "nonsense"]) {
    const t = pageTheme(name);
    assert.equal(t, pageTheme(""));
    assert.equal(t.meta, "");
    assert.match(t.style, /background: #f4f2ec/);
    assert.match(t.style, /ui-rounded/);
  }
});

test("zamboni uses Zamboni's light and dark tokens and browser-bar colours", () => {
  const t = pageTheme("zamboni");
  assert.equal(pageTheme(" Zamboni "), t);
  assert.match(t.meta, /<meta name="color-scheme" content="light dark">/);
  assert.match(t.meta, /media="\(prefers-color-scheme: light\)" content="#f6f9fc"/);
  assert.match(t.meta, /media="\(prefers-color-scheme: dark\)" content="#0e141b"/);
  assert.match(t.style, /--rink: #e9eff6;/);
  assert.match(t.style, /@media \(prefers-color-scheme: dark\)[^}]*--rink: #090e14;/);
  assert.match(t.style, /html \{ background: var\(--rink\); \}/);
  assert.doesNotMatch(t.style, /ui-rounded|#f4f2ec|#191817/);
});
