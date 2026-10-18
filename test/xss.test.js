// §7.3: user text never reaches the DOM as markup. Every `html:` value and every
// innerHTML assignment in public/js must be icon(...), logoSvg(...) or sparkline(...)
// (static or numbers-only SVG), or a template literal whose only ${} parts are those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = new URL('../public/js/', import.meta.url);
const SAFE_CALL = /^(icon|logoSvg|sparkline)\(/;
// The single place that turns `html:` into markup (inside h()).
const SINK = /else if \(k === 'html'\) el\.innerHTML = v;/;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f, src: fs.readFileSync(new URL(f, DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1') }));

// The expression that starts at `i`: a balanced call or a template literal.
function exprAt(src, i) {
  while (/\s/.test(src[i])) i++;
  if (src[i] === '`') {
    let j = i + 1, depth = 0;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (depth === 0 && src[j] === '`') break;
      if (src[j] === '$' && src[j + 1] === '{') { depth++; j++; continue; }
      if (depth && src[j] === '}') depth--;
    }
    return src.slice(i, j + 1);
  }
  let j = i, depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { if (depth === 0) break; depth--; if (depth === 0) { j++; break; } }
    else if (depth === 0 && /[,;}\n]/.test(src[j])) break;
  }
  return src.slice(i, j).trim();
}

function safe(expr) {
  if (SAFE_CALL.test(expr)) return true;
  if (!expr.startsWith('`')) return false;
  const parts = [...expr.matchAll(/\$\{([^}]*(?:\([^)]*\))?[^}]*)\}/g)].map((m) => m[1].trim());
  return parts.every((p) => SAFE_CALL.test(p) && !/\$\{/.test(p));
}

test('every html: value and innerHTML assignment is icon/logoSvg/sparkline markup', () => {
  const bad = [];
  let sites = 0;
  for (const { name, src } of files) {
    for (const m of src.matchAll(/\bhtml:\s*/g)) {
      sites++;
      const expr = exprAt(src, m.index + m[0].length);
      if (!safe(expr)) bad.push(`${name}: html: ${expr.slice(0, 80)}`);
    }
    for (const m of src.matchAll(/\.innerHTML\s*=(?!=)\s*/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (name === 'ui.js' && SINK.test(line)) continue;
      sites++;
      const expr = exprAt(src, m.index + m[0].length);
      if (!safe(expr)) bad.push(`${name}: innerHTML = ${expr.slice(0, 80)}`);
    }
  }
  assert.ok(sites > 0, 'found no html: call sites at all; the scan is broken');
  assert.deepEqual(bad, []);
});

test('no other markup sinks are used in public/js', () => {
  for (const { name, src } of files) {
    assert.doesNotMatch(src, /\b(outerHTML|insertAdjacentHTML|createContextualFragment|document\.write)\b/, name);
  }
});

test('the scanner rejects user text in html:', () => {
  assert.equal(safe('icon(\'x\')'), true);
  assert.equal(safe('`${icon(\'trash\')}<span>Delete</span>`'), true);
  assert.equal(safe('place.name'), false);
  assert.equal(safe('`<b>${place.name}</b>`'), false);
  assert.equal(safe('`${icon(\'x\')}${note}`'), false);
});
