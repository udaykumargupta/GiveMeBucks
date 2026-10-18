// The app's charts: a step-after line (net worth trend, place value), signed
// single-series bars (spent, monthly growth) and sparklines. SVG is built
// from numbers only; every label goes in through textContent. Colours come
// from CSS classes, so a theme switch needs no re-render.
import { toDay, fromDay, dayLabel, monthKey, addMonths, monthStartDay } from './dates.js';
import { money, moneyShort } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
let chartSeq = 0;

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
function svgText(parent, x, y, str, attrs = {}) {
  const t = svgEl('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}
const div = (cls, attrs = {}) => {
  const d = document.createElement('div');
  d.className = cls;
  for (const [k, v] of Object.entries(attrs)) d.setAttribute(k, v);
  return d;
};
const r1 = (n) => Math.round(n * 10) / 10;
const dayOf = (p) => (typeof p.day === 'number' ? p.day : toDay(p.date));
const textWidth = (s) => String(s).length * 6.4 + 6; // 11px Inter, tabular digits

// ----------------------------------------------------------------- scales
/** Round axis bounds and 3–4 ticks: niceScale(255000, 380000, 3) → { min: 250000, max: 400000, ticks: [...] }. */
export function niceScale(min, max, count = 4, { zero = false } = {}) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 0; }
  if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) {
    if (min === 0) max = 1;
    else {
      const pad = Math.abs(min) * 0.1;
      if (zero && min > 0) max += pad;
      else if (zero && max < 0) min -= pad;
      else { min -= pad; max += pad; }
    }
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step || 0);
  return { min: lo, max: hi, step, ticks };
}

/**
 * Time-axis ticks between two day numbers: day steps up to ~3 months, then
 * month starts (January reads as its year), then years. → [{ day, label }].
 */
export function timeTicks(start, end, maxTicks = 5) {
  maxTicks = Math.max(2, maxTicks);
  const span = end - start;
  if (span <= 0) return [{ day: start, label: dayLabel(start) }];
  if (span <= 92) {
    const step = [1, 2, 3, 7, 14, 21, 28, 35].find((s) => Math.floor(span / s) + 1 <= maxTicks) || 35;
    const out = [];
    for (let d = start; d <= end; d += step) out.push(d);
    const last = out[out.length - 1];
    if (last !== end) {
      if (end - last >= step * 0.6 || out.length === 1) out.push(end);
      else out[out.length - 1] = end;
    }
    return out.map((d) => ({ day: d, label: dayLabel(d) }));
  }
  const months = [];
  for (let k = monthKey(fromDay(start)); monthStartDay(k) <= end; k = addMonths(k, 1)) {
    if (monthStartDay(k) >= start) months.push(k);
  }
  const step = [1, 2, 3, 6, 12].find((s) => Math.ceil(months.length / s) <= maxTicks);
  if (step) {
    return months.filter((k) => (Number(k.slice(5)) - 1) % step === 0).map((k) => {
      const m = Number(k.slice(5));
      return { day: monthStartDay(k), label: step === 12 || m === 1 ? k.slice(0, 4) : dayLabel(`${k}-01`).split(' ')[1] };
    });
  }
  const years = months.filter((k) => k.endsWith('-01'));
  const ystep = [2, 5, 10, 20].find((s) => Math.ceil(years.length / s) <= maxTicks) || 50;
  return years.filter((k) => Number(k.slice(0, 4)) % ystep === 0).map((k) => ({ day: monthStartDay(k), label: k.slice(0, 4) }));
}

// ---------------------------------------------------------------- tooltip
let tipEl;
function tip() {
  if (!tipEl) {
    tipEl = div('chart-tip', { role: 'tooltip' });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
/**
 * content: string | { title, lines: [string | { label, value, tone }], foot }.
 * Positioned next to (clientX, clientY), kept inside the viewport.
 */
export function showTip(clientX, clientY, content) {
  const el = tip();
  el.replaceChildren();
  const c = typeof content === 'string' ? { title: content } : content || {};
  if (c.title) { const t = div('tip-title'); t.textContent = c.title; el.appendChild(t); }
  for (const line of c.lines || []) {
    const row = div('tip-row');
    if (typeof line === 'string') row.textContent = line;
    else {
      const a = document.createElement('span');
      a.className = 'tip-label';
      a.textContent = line.label ?? '';
      const b = document.createElement('span');
      b.className = `tip-value${line.tone ? ` ${line.tone}` : ''}`;
      b.textContent = line.value ?? '';
      row.append(a, b);
    }
    el.appendChild(row);
  }
  if (c.foot) { const f = div('tip-foot'); f.textContent = c.foot; el.appendChild(f); }
  el.style.display = 'block';
  const w = el.offsetWidth, hh = el.offsetHeight;
  let x = clientX + 14, y = clientY - hh - 12;
  if (x + w > window.innerWidth - 8) x = clientX - w - 14;
  if (y < 8) y = clientY + 16;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - hh - 8, y))}px`;
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

// ------------------------------------------------------------- scaffolding
function chartHeight(el, fallback) {
  const v = parseFloat(getComputedStyle(el).getPropertyValue('--chart-h'));
  return Number.isFinite(v) && v > 40 ? v : fallback;
}

/** Shared frame: readout line (touch), focusable plot with role="img", polite live region. */
function frame(el, label) {
  el.classList.add('chart');
  const readout = div('chart-readout', { 'aria-hidden': 'true' });
  const plot = div('chart-plot', { tabindex: '0', role: 'img', 'aria-label': label || 'Chart' });
  const live = div('sr-only', { 'aria-live': 'polite' });
  el.replaceChildren(readout, plot, live);
  return { readout, plot, live };
}

// Live charts: re-render when their width changes, and release a pinned touch
// readout on a tap elsewhere. Charts whose element left the page are dropped.
const active = new Map(); // el → { render, onDoc, lastW }
let ro = null, docBound = false;
function prune() {
  for (const el of active.keys()) if (!el.isConnected && el._chartAttached) { ro?.unobserve(el); active.delete(el); }
}
function register(el, render) {
  prune();
  const entry = active.get(el) || { render, onDoc: null, lastW: el.clientWidth };
  entry.render = render;
  active.set(el, entry);
  if (el.isConnected) el._chartAttached = true;
  if (!ro && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver((items) => {
      for (const it of items) {
        const e = active.get(it.target);
        if (!e) continue;
        it.target._chartAttached = true;
        const w = it.target.clientWidth;
        if (Math.abs(w - e.lastW) >= 1) { e.lastW = w; e.render(); }
      }
    });
  }
  ro?.observe(el);
  if (!docBound) {
    docBound = true;
    document.addEventListener('pointerdown', (ev) => { for (const e of active.values()) e.onDoc && e.onDoc(ev); });
  }
  return entry;
}
function unregister(el) { ro?.unobserve(el); active.delete(el); }

function yAxis(svg, scale, y, x0, x1, fmt) {
  const g = svgEl('g', { class: 'axis y' }, svg);
  for (const t of scale.ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svgEl('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: 'grid' }, g);
    svgText(g, x0 - 8, yy + 4, fmt(t), { 'text-anchor': 'end', class: 'tick' });
  }
}
const yLabelWidth = (scale, fmt) => Math.max(...scale.ticks.map((t) => textWidth(fmt(t)))) + 8;

/** Place x labels without collisions; edge labels anchor inward. items: [{ x, label }]. */
function xLabels(svg, items, y, left, right) {
  const g = svgEl('g', { class: 'axis x' }, svg);
  const all = items.map((it) => {
    const w = textWidth(it.label);
    if (it.x - w / 2 < left - 4) return { ...it, anchor: 'start', a: it.x, b: it.x + w };
    if (it.x + w / 2 > right + 4) return { ...it, anchor: 'end', a: it.x - w, b: it.x };
    return { ...it, anchor: 'middle', a: it.x - w / 2, b: it.x + w / 2 };
  });
  const last = all[all.length - 1];
  const placed = [];
  for (const it of all) {
    const prev = placed[placed.length - 1];
    if (prev && it.a < prev.b + 6) continue;
    if (it !== last && it.b + 6 > last.a) continue;
    placed.push(it);
  }
  for (const it of placed) svgText(g, r1(it.x), y, it.label, { 'text-anchor': it.anchor, class: 'tick' });
}

// -------------------------------------------------------------- line chart
/**
 * Step-after line with an area gradient.
 * opts: {
 *   points: [{ date | day, value, set?, baseline? }] oldest first (use `key` to read another field, e.g. 'nw'),
 *   key = 'value', dots = false (3px dots on points with `set`, skipped when too dense), markers = true (hollow marker where `baseline` ≠ 0),
 *   label (aria summary), yFmt = moneyShort, height (else CSS --chart-h, else 200),
 *   readout(info) → string, tooltip(info) → string | { title, lines, foot }, onScrub(info | null),
 *   emptyText = 'The graph fills in as you update.'
 * }
 * info = { day, date, value, point (the entry on that exact day, or null), index (of the point in effect) }.
 * Returns { update(opts), destroy() }.
 */
export function lineChart(el, opts) {
  let o = opts;
  const id = `c${++chartSeq}`;
  const render = () => {
    entry.onDoc = null;
    hideTip();
    const key = o.key || 'value';
    const pts = (o.points || []).filter((p) => p && Number.isFinite(p[key])).map((p) => ({ p, day: dayOf(p), v: p[key] }));
    const { readout, plot, live } = frame(el, o.label);
    const yFmt = o.yFmt || moneyShort;
    const infoAt = (i, day = pts[i].day) => ({ day, date: fromDay(day), value: pts[i].v, point: pts[i].day === day ? pts[i].p : null, index: i });
    const readText = (info) => (o.readout ? o.readout(info) : `${dayLabel(info.date, true)} · ${money(info.value)}`);
    const tipContent = (info) => (o.tooltip ? o.tooltip(info) : { title: dayLabel(info.date, true), lines: [money(info.value)] });

    if (!pts.length) {
      el.classList.add('is-empty');
      const n = div('chart-note');
      n.textContent = o.emptyText || 'The graph fills in as you update.';
      plot.appendChild(n);
      return;
    }
    el.classList.remove('is-empty');
    const W = Math.max(160, plot.clientWidth || el.clientWidth || 320);
    const H = o.height || chartHeight(el, 200);
    const first = pts[0].day, last = pts[pts.length - 1].day;
    const single = last === first;
    let min = Math.min(...pts.map((q) => q.v)), max = Math.max(...pts.map((q) => q.v));
    const scale = niceScale(min, max, H < 190 ? 3 : 4, { zero: min >= 0 && min < (max - min) * 0.25 });
    const left = yLabelWidth(scale, yFmt), right = W - 10, top = 10, bottom = H - 24;
    const x = (d) => (single ? (left + right) / 2 : left + ((d - first) / (last - first)) * (right - left));
    const y = (v) => bottom - ((v - scale.min) / (scale.max - scale.min || 1)) * (bottom - top);
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg line-chart', 'aria-hidden': 'true', focusable: 'false' });
    plot.appendChild(svg);
    yAxis(svg, scale, y, left, right, yFmt);

    const ticks = single ? [{ day: first, label: dayLabel(first) }] : timeTicks(first, last, Math.max(2, Math.floor((right - left) / 72)));
    xLabels(svg, ticks.map((t) => ({ x: x(t.day), label: t.label })), H - 6, left, right);

    if (!single) {
      let d = `M${r1(x(pts[0].day))},${r1(y(pts[0].v))}`;
      for (let i = 1; i < pts.length; i++) d += `H${r1(x(pts[i].day))}V${r1(y(pts[i].v))}`;
      const defs = svgEl('defs', {}, svg);
      const grad = svgEl('linearGradient', { id: `${id}-fill`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      svgEl('stop', { offset: '0', class: 'area-stop-a' }, grad);
      svgEl('stop', { offset: '1', class: 'area-stop-b' }, grad);
      svgEl('path', { d: `${d}V${bottom}H${r1(x(first))}Z`, class: 'area', fill: `url(#${id}-fill)` }, svg);
      svgEl('path', { d, class: 'line' }, svg);
    }
    if (o.markers !== false) {
      for (const q of pts) if (q.p.baseline && q.p.baseline !== 0) svgEl('circle', { cx: r1(x(q.day)), cy: r1(y(q.v)), r: 4, class: 'base-mark' }, svg);
    }
    if (o.dots) {
      // Dots only while they stay apart; on a long history they would just bead the line.
      const sets = pts.filter((q) => q.p.set && !(o.markers !== false && q.p.baseline));
      const span = x(pts[pts.length - 1].day) - x(pts[0].day);
      if (sets.length * 14 <= span) for (const q of sets) svgEl('circle', { cx: r1(x(q.day)), cy: r1(y(q.v)), r: 3, class: 'set-dot' }, svg);
    }
    const lastPt = pts[pts.length - 1];
    if (!(o.markers !== false && lastPt.p.baseline)) svgEl('circle', { cx: r1(x(lastPt.day)), cy: r1(y(lastPt.v)), r: 4, class: 'end-dot' }, svg);
    if (single) {
      const n = div('chart-note overlay');
      n.textContent = o.emptyText || 'The graph fills in as you update.';
      plot.appendChild(n);
    }

    const cross = svgEl('g', { class: 'cross', visibility: 'hidden' }, svg);
    const vline = svgEl('line', { y1: top, y2: bottom, class: 'cross-line' }, cross);
    const cdot = svgEl('circle', { r: 4, class: 'cross-dot' }, cross);

    const defaultInfo = infoAt(pts.length - 1, Math.max(last, first));
    readout.textContent = readText(defaultInfo);
    const indexAtDay = (day) => {
      let i = 0;
      while (i + 1 < pts.length && pts[i + 1].day <= day) i++;
      return i;
    };
    const show = (info) => {
      const cx = r1(x(info.day)), cy = r1(y(info.value));
      vline.setAttribute('x1', cx); vline.setAttribute('x2', cx);
      cdot.setAttribute('cx', cx); cdot.setAttribute('cy', cy);
      cross.setAttribute('visibility', 'visible');
      readout.textContent = readText(info);
      el.classList.add('scrubbing');
      o.onScrub && o.onScrub(info);
      return { cx, cy };
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      readout.textContent = readText(defaultInfo);
      el.classList.remove('scrubbing');
      hideTip();
      o.onScrub && o.onScrub(null);
    };
    const infoFromEvent = (e) => {
      const r = svg.getBoundingClientRect();
      const px = Math.max(left, Math.min(right, e.clientX - r.left));
      const day = single ? first : Math.round(first + ((px - left) / (right - left)) * (last - first));
      return infoAt(indexAtDay(day), day);
    };
    let touching = false;
    const onMove = (e) => {
      if (e.pointerType === 'touch') { show(infoFromEvent(e)); return; }
      const info = infoFromEvent(e);
      show(info);
      showTip(e.clientX, e.clientY, tipContent(info));
    };
    const onDown = (e) => { if (e.pointerType === 'touch') { touching = true; show(infoFromEvent(e)); } };
    const onLeave = (e) => { if (e.pointerType !== 'touch') hide(); };
    const onUp = (e) => { if (e.pointerType === 'touch') touching = false; };
    // A tap elsewhere releases the pinned touch readout.
    const onDoc = (e) => { if (!touching && !plot.contains(e.target) && el.classList.contains('scrubbing')) hide(); };
    let kIndex = null;
    const onKey = (e) => {
      const n = pts.length;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
      if (e.key === 'Escape') { if (kIndex != null) { kIndex = null; hide(); e.stopPropagation(); } return; }
      e.preventDefault();
      if (kIndex == null) kIndex = n - 1;
      else if (e.key === 'ArrowLeft') kIndex = Math.max(0, kIndex - 1);
      else if (e.key === 'ArrowRight') kIndex = Math.min(n - 1, kIndex + 1);
      else if (e.key === 'Home') kIndex = 0;
      else kIndex = n - 1;
      const info = infoAt(kIndex);
      const { cx, cy } = show(info);
      const r = svg.getBoundingClientRect();
      showTip(r.left + cx, r.top + cy, tipContent(info));
      live.textContent = readText(info);
    };
    const onBlur = () => { kIndex = null; hide(); };
    plot.addEventListener('pointermove', onMove);
    plot.addEventListener('pointerdown', onDown);
    plot.addEventListener('pointerleave', onLeave);
    plot.addEventListener('pointerup', onUp);
    plot.addEventListener('pointercancel', onUp);
    plot.addEventListener('keydown', onKey);
    plot.addEventListener('blur', onBlur);
    entry.onDoc = onDoc;
  };
  const entry = register(el, () => render());
  render();
  return {
    update(next) { o = { ...o, ...next }; render(); },
    destroy() { unregister(el); hideTip(); el.replaceChildren(); },
  };
}

// --------------------------------------------------------------- bar chart
const BAR_TONES = { spend: ['spend', 'warn'], growth: ['up', 'down'] };

function barPath(x, w, y0, y1, rad) {
  // Rounded corners on the end away from zero.
  const h = Math.abs(y1 - y0);
  const r = Math.min(rad, w / 2, h);
  if (r < 0.5) return `M${r1(x)},${r1(y0)}H${r1(x + w)}V${r1(y1)}H${r1(x)}Z`;
  if (y1 < y0) { // upwards
    return `M${r1(x)},${r1(y0)}V${r1(y1 + r)}Q${r1(x)},${r1(y1)} ${r1(x + r)},${r1(y1)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y1)} ${r1(x + w)},${r1(y1 + r)}V${r1(y0)}Z`;
  }
  return `M${r1(x)},${r1(y0)}V${r1(y1 - r)}Q${r1(x)},${r1(y1)} ${r1(x + r)},${r1(y1)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y1)} ${r1(x + w)},${r1(y1 - r)}V${r1(y0)}Z`;
}

/**
 * One series of signed bars with a zero line.
 * opts: {
 *   bars: [{ key, label, value (number | null), state: 'complete' | 'current' | 'partial' | 'untracked' | 'none' }],
 *   tone: 'spend' (periwinkle; negative in amber) | 'growth' (positive mint ▲, negative red ▼),
 *   label (aria summary), yFmt = moneyShort, height (else CSS --chart-h, else 180), selectedKey,
 *   tooltip(bar, i) → string | { title, lines, foot }, readout(bar, i) → string (touch line), onTap(bar, i)
 * }
 * States never rely on opacity: complete = solid; current = 45° hatch + solid outline;
 * partial = hatch + dashed outline. untracked / none / null value = an empty slot.
 * Returns { update(opts), destroy() }.
 */
export function barChart(el, opts) {
  let o = opts;
  const id = `c${++chartSeq}`;
  const render = () => {
    entry.onDoc = null;
    hideTip();
    const bars = o.bars || [];
    const [posTone, negTone] = BAR_TONES[o.tone] || BAR_TONES.spend;
    const { readout, plot, live } = frame(el, o.label);
    const yFmt = o.yFmt || moneyShort;
    const drawn = (b) => b && Number.isFinite(b.value) && b.state !== 'untracked' && b.state !== 'none';
    const tipContent = (b, i) => (o.tooltip ? o.tooltip(b, i) : { title: b.label, lines: [drawn(b) ? money(b.value) : 'Not tracked'] });
    const readText = (b, i) => (o.readout ? o.readout(b, i) : `${b.label} · ${drawn(b) ? money(b.value) : '—'}`);
    if (!bars.length) {
      const n = div('chart-note');
      n.textContent = o.emptyText || 'Nothing to show yet.';
      plot.appendChild(n);
      return;
    }
    const W = Math.max(160, plot.clientWidth || el.clientWidth || 320);
    const H = o.height || chartHeight(el, 180);
    const vals = bars.filter(drawn).map((b) => b.value);
    const scale = niceScale(Math.min(0, ...vals), Math.max(0, ...vals), H < 170 ? 3 : 4, { zero: true });
    const left = yLabelWidth(scale, yFmt), right = W - 6, top = 10, bottom = H - 24;
    const y = (v) => bottom - ((v - scale.min) / (scale.max - scale.min || 1)) * (bottom - top);
    const band = (right - left) / bars.length;
    const bw = Math.max(3, Math.min(18, band * 0.62));
    const cx = (i) => left + band * (i + 0.5);

    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg bar-chart', 'aria-hidden': 'true', focusable: 'false' });
    plot.appendChild(svg);
    const defs = svgEl('defs', {}, svg);
    for (const tone of [posTone, negTone]) {
      const pat = svgEl('pattern', { id: `${id}-hatch-${tone}`, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 5, class: `hatch-line ${tone}` }, pat);
    }
    yAxis(svg, scale, y, left, right, yFmt);
    const bandG = svgEl('g', {}, svg);
    const hover = svgEl('rect', { x: 0, y: top, width: r1(band), height: bottom - top, rx: 4, class: 'band', visibility: 'hidden' }, bandG);
    const selected = o.selectedKey != null ? bars.findIndex((b) => b.key === o.selectedKey) : -1;
    if (selected >= 0) svgEl('rect', { x: r1(left + band * selected), y: top, width: r1(band), height: bottom - top, rx: 4, class: 'band selected' }, bandG);

    const y0 = Math.round(y(0)) + 0.5;
    bars.forEach((b, i) => {
      if (!drawn(b) || b.value === 0) return;
      const tone = b.value < 0 ? negTone : posTone;
      const state = b.state === 'current' || b.state === 'partial' ? b.state : 'complete';
      svgEl('path', {
        d: barPath(cx(i) - bw / 2, bw, y0, y(b.value), 3),
        class: `bar ${tone} ${state}`,
        fill: state === 'complete' ? null : `url(#${id}-hatch-${tone})`,
      }, svg);
    });
    svgEl('line', { x1: left, x2: right, y1: y0, y2: y0, class: 'zero' }, svg);
    // Thin the labels to what fits; always keep the newest.
    const lw = Math.max(...bars.map((b) => textWidth(b.label || '')));
    const every = Math.max(1, Math.ceil((lw + 6) / band));
    xLabels(svg, bars.map((b, i) => ({ x: cx(i), label: b.label || '', i }))
      .filter((it) => (bars.length - 1 - it.i) % every === 0), H - 6, left, right);

    if (o.onTap) el.classList.add('tappable');
    const lastI = bars.length - 1;
    readout.textContent = readText(bars[lastI], lastI);
    const slotAt = (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.floor((e.clientX - r.left - left) / band);
      return i >= 0 && i < bars.length ? i : null;
    };
    const showSlot = (i) => {
      hover.setAttribute('x', r1(left + band * i));
      hover.setAttribute('visibility', 'visible');
      readout.textContent = readText(bars[i], i);
      el.classList.add('scrubbing');
    };
    const hideSlot = () => {
      hover.setAttribute('visibility', 'hidden');
      readout.textContent = readText(bars[lastI], lastI);
      el.classList.remove('scrubbing');
      hideTip();
    };
    let down = null;
    const onMove = (e) => {
      const i = slotAt(e);
      if (i == null) { if (e.pointerType !== 'touch') hideSlot(); return; }
      showSlot(i);
      if (e.pointerType !== 'touch') showTip(e.clientX, e.clientY, tipContent(bars[i], i));
      else if (down && Math.abs(e.clientX - down.x) > 8) down.moved = true;
    };
    const onDown = (e) => {
      down = { x: e.clientX, moved: false };
      const i = slotAt(e);
      if (i != null && e.pointerType === 'touch') showSlot(i);
    };
    const onUp = (e) => {
      const i = slotAt(e);
      const tap = down && !down.moved;
      down = null;
      if (!tap || i == null) return;
      if (o.onTap) o.onTap(bars[i], i);
      else if (e.pointerType === 'touch') {
        const r = svg.getBoundingClientRect();
        showTip(r.left + cx(i), r.top + top, tipContent(bars[i], i));
      }
    };
    const onLeave = (e) => { if (e.pointerType !== 'touch') hideSlot(); };
    const onDoc = (e) => { if (!plot.contains(e.target) && el.classList.contains('scrubbing')) hideSlot(); };
    let kIndex = null;
    const onKey = (e) => {
      if (e.key === 'Escape') { if (kIndex != null) { kIndex = null; hideSlot(); e.stopPropagation(); } return; }
      if ((e.key === 'Enter' || e.key === ' ') && kIndex != null && o.onTap) { e.preventDefault(); o.onTap(bars[kIndex], kIndex); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      if (kIndex == null) kIndex = lastI;
      else if (e.key === 'ArrowLeft') kIndex = Math.max(0, kIndex - 1);
      else if (e.key === 'ArrowRight') kIndex = Math.min(lastI, kIndex + 1);
      else kIndex = e.key === 'Home' ? 0 : lastI;
      showSlot(kIndex);
      const r = svg.getBoundingClientRect();
      showTip(r.left + cx(kIndex), r.top + top + 8, tipContent(bars[kIndex], kIndex));
      live.textContent = readText(bars[kIndex], kIndex);
    };
    const onBlur = () => { kIndex = null; hideSlot(); };
    plot.addEventListener('pointermove', onMove);
    plot.addEventListener('pointerdown', onDown);
    plot.addEventListener('pointerup', onUp);
    plot.addEventListener('pointercancel', () => { down = null; });
    plot.addEventListener('pointerleave', onLeave);
    plot.addEventListener('keydown', onKey);
    plot.addEventListener('blur', onBlur);
    entry.onDoc = onDoc;
  };
  const entry = register(el, () => render());
  render();
  return {
    update(next) { o = { ...o, ...next }; render(); },
    destroy() { unregister(el); hideTip(); el.replaceChildren(); },
  };
}

// --------------------------------------------------------------- sparkline
/**
 * 64×20 SVG markup (numbers only, safe for `html:`). `values`: numbers (evenly
 * spaced) or [{ date | day, value }] (time-scaled, step-after, like the place chart).
 * Decorative: the value sits next to it as text.
 */
export function sparkline(values, { width = 64, height = 20, key = 'value' } = {}) {
  const pad = 2;
  const pts = (values || []).map((v, i) => (typeof v === 'number' ? { x: i, v } : { x: dayOf(v), v: v[key] }))
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.x));
  const open = `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">`;
  if (!pts.length) return `${open}</svg>`;
  const step = typeof values[0] !== 'number';
  const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) { lo -= 1; hi += 1; }
  const X = (x) => (x1 === x0 ? width - pad : pad + ((x - x0) / (x1 - x0)) * (width - 2 * pad));
  const Y = (v) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  let d = `M${r1(x1 === x0 ? pad : X(pts[0].x))},${r1(Y(pts[0].v))}`;
  for (let i = 1; i < pts.length; i++) {
    d += step ? `H${r1(X(pts[i].x))}V${r1(Y(pts[i].v))}` : `L${r1(X(pts[i].x))},${r1(Y(pts[i].v))}`;
  }
  if (x1 === x0) d += `H${r1(width - pad)}`;
  const end = pts[pts.length - 1];
  return `${open}<path class="spark-line" d="${d}"/><circle class="spark-dot" cx="${r1(X(end.x))}" cy="${r1(Y(end.v))}" r="1.75"/></svg>`;
}
