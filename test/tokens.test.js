// §8.9 colour-token contrast (CT): WCAG ratios computed from the hex values in
// app.css, with rgba tokens composited over --surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function tokens(selector) {
  const block = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(',').map((s) => s.trim()).includes(selector));
  assert.ok(block, `no rule for ${selector}`);
  const out = {};
  for (const [, name, value] of block[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

function parse(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), a: 1 };
  const rgba = color.match(/^rgba\(([^)]+)\)$/);
  assert.ok(rgba, `unparsed colour ${color}`);
  const [r, g, b, a] = rgba[1].split(',').map(Number);
  return { rgb: [r, g, b], a };
}
const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a)));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const THEMES = { dark: tokens(':root[data-theme="dark"]'), light: tokens(':root[data-theme="light"]') };

function pair(t, fgName, bgName) {
  const surface = parse(t.surface).rgb;
  const bg = over(parse(t[bgName]), surface);
  const fg = over(parse(t[fgName]), bg);
  return ratio(fg, bg);
}

const VECTORS = [
  ['text-3', 'surface', 4.5, 4.83, 5.30],
  ['text-2', 'surface-2', 4.5, 7.14, 6.93],
  ['input-border', 'surface', 3, 3.80, 3.58],
  ['input-border', 'surface-2', 3, 3.50, 3.19],
  ['text', 'accent-weak', 4.5, 11.22, 15.80],
  ['spend', 'surface', 3, 7.05, 5.33],
  ['on-accent', 'accent', 4.5, 10.63, 5.39],
  ['warn', 'warn-weak', 4.5, 7.50, 5.16],
];

for (const [fg, bg, min, dark, light] of VECTORS) {
  test(`CT --${fg} on --${bg} ≥ ${min}`, () => {
    for (const [theme, expected] of [['dark', dark], ['light', light]]) {
      const r = pair(THEMES[theme], fg, bg);
      assert.ok(r >= min, `${theme}: ${r.toFixed(2)} < ${min}`);
      assert.ok(Math.abs(r - expected) < 0.02, `${theme}: ${r.toFixed(2)} ≠ ${expected}`);
    }
  });
}

test('CT both themes define the same tokens; dark is the default', () => {
  assert.deepEqual(Object.keys(THEMES.dark).sort(), Object.keys(THEMES.light).sort());
  assert.equal(THEMES.dark.up, 'var(--accent)');
  assert.equal(THEMES.light.up, 'var(--accent)');
  assert.ok(tokens(':root').bg === '#0d0f12', ':root alone carries the dark tokens');
});
