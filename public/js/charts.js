// Small SVG chart kit styled after Grafana panels: time series (line /
// stacked area), bars (grouped / stacked / diverging), donut, gauge and
// sparkline. Every chart ships a hover tooltip; labels go in via textContent.
import { dayLabel, fromDay, monthLabel, monthOf, addMonths, toDay } from './calc.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
function text(parent, x, y, str, attrs = {}) {
  const t = svgEl('text', { x, y, ...attrs }, parent);
  t.textContent = str;
  return t;
}

// ----------------------------------------------------------------- tooltip
let tipEl;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
/** rows: [{ color, label, value, key: 'line'|'rect', strong }] */
export function showTip(clientX, clientY, { title, rows = [], foot }) {
  const el = tip();
  el.replaceChildren();
  if (title) {
    const h = document.createElement('div');
    h.className = 'tip-title';
    h.textContent = title;
    el.appendChild(h);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row' + (r.strong ? ' strong' : '');
    const key = document.createElement('span');
    key.className = `tip-key ${r.key || 'line'}`;
    if (r.color) key.style.background = r.color;
    else key.style.visibility = 'hidden';
    const label = document.createElement('span');
    label.className = 'tip-label';
    label.textContent = r.label;
    const value = document.createElement('span');
    value.className = 'tip-value' + (r.money === false ? '' : ' money');
    value.textContent = r.value;
    row.append(key, label, value);
    el.appendChild(row);
  }
  if (foot) {
    const f = document.createElement('div');
    f.className = 'tip-foot';
    f.textContent = foot;
    el.appendChild(f);
  }
  el.style.display = 'block';
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = clientX + 14, y = clientY + 14;
  if (x + w > window.innerWidth - 8) x = clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = clientY - h - 14;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

// ------------------------------------------------------------------ scales
export function niceScale(min, max, count = 4, { zero = false } = {}) {
  if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad; max += pad;
    if (zero) min = Math.max(0, min) === 0 && max > 0 ? 0 : min;
  }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min: lo, max: hi, ticks };
}

function timeTicks(start, end, maxTicks) {
  const span = end - start;
  if (span <= 120) {
    const step = [1, 2, 7, 14, 28].find((s) => span / s <= maxTicks) || 28;
    const out = [];
    const first = step >= 7 ? start + ((7 - ((start + 3) % 7)) % 7) : start; // align to Mondays
    for (let d = first; d <= end; d += step) out.push({ day: d, label: dayLabel(d) });
    return out;
  }
  const months = [];
  for (let k = monthOf(fromDay(start)); toDay(`${k}-01`) <= end; k = addMonths(k, 1)) {
    const d = toDay(`${k}-01`);
    if (d >= start) months.push(k);
  }
  const step = [1, 2, 3, 6, 12, 24].find((s) => months.length / s <= maxTicks) || 24;
  return months
    .filter((k) => (Number(k.slice(5)) - 1) % Math.min(step, 12) === 0 && (step < 24 || Number(k.slice(0, 4)) % 2 === 0))
    .map((k) => ({ day: toDay(`${k}-01`), label: step >= 12 ? k.slice(0, 4) : monthLabel(k) }));
}

function measure(el, fallbackH) {
  const w = Math.max(120, el.clientWidth);
  const h = Math.max(80, el.clientHeight || fallbackH || 200);
  return { w, h };
}

function emptyState(el, msg) {
  el.replaceChildren();
  const d = document.createElement('div');
  d.className = 'chart-empty';
  d.textContent = msg;
  el.appendChild(d);
}

function legendEl(items, { values = false } = {}) {
  const lg = document.createElement('div');
  lg.className = 'legend';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = `legend-key ${it.key || 'line'}`;
    sw.style.background = it.color;
    const name = document.createElement('span');
    name.className = 'legend-name';
    name.textContent = it.name;
    row.append(sw, name);
    if (values && it.value != null) {
      const v = document.createElement('span');
      v.className = 'legend-value money';
      v.textContent = it.value;
      row.appendChild(v);
    }
    lg.appendChild(row);
  }
  return lg;
}

function yAxis(svg, scale, y, x0, x1, fmt, isMoney = true) {
  const g = svgEl('g', { class: 'axis y' }, svg);
  for (const t of scale.ticks) {
    const yy = Math.round(y(t)) + 0.5;
    svgEl('line', { x1: x0, x2: x1, y1: yy, y2: yy, class: t === 0 ? 'grid zero' : 'grid' }, g);
    text(g, x0 - 8, yy + 4, fmt(t), { 'text-anchor': 'end', class: isMoney ? 'tick money' : 'tick' });
  }
}
function yLabelWidth(scale, fmt) {
  return Math.max(...scale.ticks.map((t) => fmt(t).length)) * 6.6 + 14;
}

// ------------------------------------------------------------ time series
/**
 * opts.series: [{ name, color, points: [[day, value|null], ...] }] (shared x)
 * opts.stacked, opts.area, opts.zero, opts.yFmt, opts.valFmt, opts.refLines
 */
export function timeSeries(el, opts) {
  const { series, stacked = false, yFmt, valFmt = yFmt, refLines = [], legend = true, totalLabel = 'Total' } = opts;
  const xs = series[0]?.points.map((p) => p[0]) || [];
  const hasData = series.some((s) => s.points.filter((p) => p[1] != null).length >= 1);
  if (!hasData) return emptyState(el, opts.empty || 'No data in this time range yet');

  el.replaceChildren();
  const plot = document.createElement('div');
  plot.className = 'plot';
  el.appendChild(plot);
  if (legend && series.length > 1) el.appendChild(legendEl(series.map((s) => ({ name: s.name, color: s.color, key: stacked ? 'rect' : 'line' }))));
  const { w, h } = measure(plot, 200);

  // Stack (or not) into [lower, upper] per series per x.
  const layers = series.map(() => []);
  for (let i = 0; i < xs.length; i++) {
    let base = 0;
    series.forEach((s, si) => {
      const v = s.points[i][1];
      if (stacked) {
        const lo = base, hi = base + (v ?? 0);
        layers[si].push(v == null && series.every((ss) => ss.points[i][1] == null) ? null : [lo, hi]);
        base = hi;
      } else layers[si].push(v == null ? null : [0, v]);
    });
  }
  let min = Infinity, max = -Infinity;
  for (const L of layers) for (const p of L) if (p) { min = Math.min(min, stacked ? p[0] : p[1]); max = Math.max(max, p[1]); }
  for (const r of refLines) { min = Math.min(min, r.value); max = Math.max(max, r.value); }
  const scale = niceScale(min, max, Math.max(2, Math.floor(h / 55)), { zero: stacked || opts.zero });

  const left = yLabelWidth(scale, yFmt), right = 12, top = 8, bottom = 24;
  const x0 = opts.xStart ?? xs[0], x1 = opts.xEnd ?? xs[xs.length - 1];
  const X = (d) => left + ((d - x0) / Math.max(1, x1 - x0)) * (w - left - right);
  const Y = (v) => top + (1 - (v - scale.min) / (scale.max - scale.min || 1)) * (h - top - bottom);

  const svg = svgEl('svg', { width: w, height: h, class: 'chart', role: 'img' }, plot);
  yAxis(svg, scale, Y, left, w - right, yFmt);
  const xg = svgEl('g', { class: 'axis x' }, svg);
  const ticks = timeTicks(x0, x1, Math.max(2, Math.floor((w - left) / 70)));
  for (const t of ticks) {
    const x = X(t.day), half = t.label.length * 3.2;
    const anchor = x - half < left ? 'start' : x + half > w - right ? 'end' : 'middle';
    text(xg, x, h - 6, t.label, { 'text-anchor': anchor, class: 'tick' });
  }

  // Draw each series. Areas first, lines on top.
  const segments = (L) => {
    const segs = [];
    let cur = [];
    L.forEach((p, i) => {
      if (p) cur.push([xs[i], p]);
      else if (cur.length) { segs.push(cur); cur = []; }
    });
    if (cur.length) segs.push(cur);
    return segs;
  };
  series.forEach((s, si) => {
    for (const seg of segments(layers[si])) {
      if (stacked || opts.area) {
        const upper = seg.map(([d, p]) => `${X(d)},${Y(p[1])}`);
        const lower = seg.slice().reverse().map(([d, p]) => `${X(d)},${Y(stacked ? p[0] : Math.max(scale.min, 0))}`);
        svgEl('path', { d: `M${upper.join('L')}L${lower.join('L')}Z`, class: stacked ? 'area stacked' : 'area', style: `fill:${s.color}` }, svg);
      }
    }
  });
  series.forEach((s, si) => {
    for (const seg of segments(layers[si])) {
      if (seg.length === 1) {
        const [d, p] = seg[0];
        svgEl('circle', { cx: X(d), cy: Y(p[1]), r: 4, class: 'dot', style: `fill:${s.color}` }, svg);
      } else {
        svgEl('path', { d: 'M' + seg.map(([d, p]) => `${X(d)},${Y(p[1])}`).join('L'), class: 'line', style: `stroke:${s.color}` }, svg);
      }
    }
  });
  for (const r of refLines) {
    const yy = Y(r.value);
    svgEl('line', { x1: left, x2: w - right, y1: yy, y2: yy, class: 'ref', style: r.color ? `stroke:${r.color}` : null }, svg);
    text(svg, w - right - 4, yy - 5, r.label, { 'text-anchor': 'end', class: 'ref-label money' });
  }

  // Hover: crosshair snaps to the nearest x; tooltip lists every series.
  const hover = svgEl('g', { class: 'hover', style: 'display:none' }, svg);
  const cross = svgEl('line', { y1: top, y2: h - bottom, class: 'crosshair' }, hover);
  const dots = series.map((s) => svgEl('circle', { r: 4, class: 'hover-dot', style: `fill:${s.color}` }, hover));
  const hit = svgEl('rect', { x: left, y: top, width: w - left - right, height: h - top - bottom, class: 'hit', tabindex: 0 }, svg);
  const xPix = xs.map(X);
  const nearest = (px) => {
    let best = 0;
    for (let i = 1; i < xPix.length; i++) if (Math.abs(xPix[i] - px) < Math.abs(xPix[best] - px)) best = i;
    return best;
  };
  const showAt = (i, cx, cy) => {
    hover.style.display = '';
    cross.setAttribute('x1', xPix[i]); cross.setAttribute('x2', xPix[i]);
    const rows = [];
    let total = 0, anyVal = false;
    series.forEach((s, si) => {
      const p = layers[si][i];
      const v = s.points[i][1];
      dots[si].style.display = p && v != null ? '' : 'none';
      if (p && v != null) { dots[si].setAttribute('cx', xPix[i]); dots[si].setAttribute('cy', Y(p[1])); }
      rows.push({ color: s.color, label: s.name, value: v == null ? '—' : valFmt(v) });
      if (v != null) { total += v; anyVal = true; }
    });
    if (stacked && series.length > 1 && anyVal) rows.unshift({ label: totalLabel, value: valFmt(total), strong: true });
    showTip(cx, cy, { title: dayLabel(xs[i], true), rows });
  };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    showAt(nearest(e.clientX - r.left), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => { hover.style.display = 'none'; hideTip(); });
  hit.addEventListener('focus', () => {
    const r = svg.getBoundingClientRect();
    const i = xs.length - 1;
    showAt(i, r.left + xPix[i], r.top + top);
  });
  hit.addEventListener('blur', () => { hover.style.display = 'none'; hideTip(); });
}

// -------------------------------------------------------------------- bars
function barPath(x, y0, y1, width, radius) {
  // Rounded on the data end (y1), square at the baseline (y0).
  const up = y1 < y0;
  const hgt = Math.abs(y1 - y0);
  const r = Math.min(radius, hgt, width / 2);
  if (hgt < 0.5) return '';
  if (up) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + width - r}Q${x + width},${y1} ${x + width},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + width - r}Q${x + width},${y1} ${x + width},${y1 - r}V${y0}Z`;
}

/**
 * opts.categories: [{ label, title }]
 * opts.series: [{ name, color, values: [] }]
 * opts.stacked, opts.colorFn(si, ci, v), opts.labelFn(ci) -> string|null,
 * opts.refLine {value,label}, opts.tipFoot(ci), opts.tipRows(ci)
 */
export function barChart(el, opts) {
  const { categories, series, stacked = false, yFmt, valFmt = yFmt, labelFn, refLine, legend = true, money: isMoney = true } = opts;
  const hasData = series.some((s) => s.values.some((v) => v != null && v !== 0));
  if (!categories.length || !hasData) return emptyState(el, opts.empty || 'No data in this time range yet');

  el.replaceChildren();
  const plot = document.createElement('div');
  plot.className = 'plot';
  el.appendChild(plot);
  if (legend && series.length > 1) el.appendChild(legendEl(series.map((s) => ({ name: s.name, color: s.color, key: 'rect' }))));
  const { w, h } = measure(plot, 200);

  let min = 0, max = 0;
  categories.forEach((_, ci) => {
    if (stacked) {
      let pos = 0, neg = 0;
      for (const s of series) { const v = s.values[ci] ?? 0; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    } else for (const s of series) { const v = s.values[ci]; if (v != null) { max = Math.max(max, v); min = Math.min(min, v); } }
  });
  if (refLine) { max = Math.max(max, refLine.value); min = Math.min(min, refLine.value); }
  const scale = niceScale(min, max, Math.max(2, Math.floor(h / 55)), { zero: true });
  const labelRoom = labelFn ? 16 : 0;
  const left = yLabelWidth(scale, yFmt), right = 10, top = 8 + labelRoom, bottom = 24;
  const Y = (v) => top + (1 - (v - scale.min) / (scale.max - scale.min || 1)) * (h - top - bottom);
  const band = (w - left - right) / categories.length;

  const svg = svgEl('svg', { width: w, height: h, class: 'chart', role: 'img' }, plot);
  yAxis(svg, scale, Y, left, w - right, yFmt, isMoney);
  const nGroups = stacked ? 1 : series.length;
  const gap = 2;
  const barW = Math.min(24, Math.max(3, (band * 0.7 - gap * (nGroups - 1)) / nGroups));
  const groupW = barW * nGroups + gap * (nGroups - 1);
  const y0 = Y(0);

  // X labels: thin them so they never collide.
  const maxLabel = Math.max(...categories.map((c) => c.label.length)) * 6.2 + 14;
  const every = Math.max(1, Math.ceil(maxLabel / band));
  const xg = svgEl('g', { class: 'axis x' }, svg);
  categories.forEach((c, ci) => {
    if ((categories.length - 1 - ci) % every !== 0) return;
    const x = left + band * ci + band / 2, half = c.label.length * 3.2;
    // Edge labels anchor inward so they never spill past the plot.
    if (x - half < left) text(xg, left + band * ci, h - 6, c.label, { 'text-anchor': 'start', class: 'tick' });
    else if (x + half > w - right) text(xg, left + band * (ci + 1), h - 6, c.label, { 'text-anchor': 'end', class: 'tick' });
    else text(xg, x, h - 6, c.label, { 'text-anchor': 'middle', class: 'tick' });
  });

  const bandEls = [];
  categories.forEach((c, ci) => {
    const g = svgEl('g', { class: 'bar-group' }, svg);
    const gx = left + band * ci + (band - groupW) / 2;
    let posBase = 0, negBase = 0;
    let topY = y0;
    const visible = series.map((s) => (s.values[ci] ?? 0) !== 0);
    const lastPos = series.map((_, si) => si).filter((si) => visible[si] && series[si].values[ci] > 0).pop();
    const lastNeg = series.map((_, si) => si).filter((si) => visible[si] && series[si].values[ci] < 0).pop();
    series.forEach((s, si) => {
      const v = s.values[ci];
      if (v == null || v === 0) return;
      const color = opts.colorFn ? opts.colorFn(si, ci, v) : s.color;
      if (stacked) {
        const from = v >= 0 ? posBase : negBase;
        const to = from + v;
        const ya = Y(from), yb = Y(to);
        const isEnd = v >= 0 ? si === lastPos : si === lastNeg;
        // 2px surface gap between stacked segments.
        const yStart = from === 0 ? ya : ya + (v >= 0 ? -gap / 2 : gap / 2);
        const yEnd = isEnd ? yb : yb + (v >= 0 ? gap / 2 : -gap / 2);
        const d = isEnd ? barPath(gx, yStart, yEnd, barW, 4) : `M${gx},${yStart}H${gx + barW}V${yEnd}H${gx}Z`;
        if (d) svgEl('path', { d, class: 'bar', style: `fill:${color}` }, g);
        if (v >= 0) posBase = to; else negBase = to;
        topY = Math.min(topY, yb);
      } else {
        const bx = gx + si * (barW + gap);
        const d = barPath(bx, y0, Y(v), barW, 4);
        if (d) svgEl('path', { d, class: 'bar', style: `fill:${color}` }, g);
        topY = Math.min(topY, Y(Math.max(v, 0)));
      }
    });
    const label = labelFn && labelFn(ci);
    if (label) {
      const neg = series.every((s) => (s.values[ci] ?? 0) <= 0);
      const yy = neg ? Math.max(...series.map((s) => Y(s.values[ci] ?? 0))) + 13 : topY - 5;
      text(g, left + band * ci + band / 2, yy, label, { 'text-anchor': 'middle', class: (opts.labelMoney ?? isMoney) ? 'bar-label money' : 'bar-label' });
    }
    const hit = svgEl('rect', { x: left + band * ci, y: top - labelRoom, width: band, height: h - top - bottom + labelRoom, class: 'hit band', tabindex: 0 }, svg);
    bandEls.push(hit);
    const show = (cx, cy) => {
      hit.classList.add('active');
      const rows = opts.tipRows ? opts.tipRows(ci) : series
        .filter((s) => !stacked || s.values[ci] != null)
        .map((s) => ({
          color: opts.colorFn ? opts.colorFn(series.indexOf(s), ci, s.values[ci] ?? 0) : s.color,
          key: 'rect',
          label: s.name,
          value: s.values[ci] == null ? '—' : valFmt(s.values[ci]),
        }));
      showTip(cx, cy, { title: c.title || c.label, rows, foot: opts.tipFoot ? opts.tipFoot(ci) : undefined });
    };
    hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    hit.addEventListener('pointerleave', () => { hit.classList.remove('active'); hideTip(); });
    hit.addEventListener('focus', () => { const r = hit.getBoundingClientRect(); show(r.right, r.top + 20); });
    hit.addEventListener('blur', () => { hit.classList.remove('active'); hideTip(); });
  });

  if (refLine) {
    const yy = Y(refLine.value);
    svgEl('line', { x1: left, x2: w - right, y1: yy, y2: yy, class: 'ref' }, svg);
    text(svg, w - right - 4, yy - 5, refLine.label, { 'text-anchor': 'end', class: isMoney ? 'ref-label money' : 'ref-label' });
  }
  // Keep the hit layer above the reference line.
  for (const b of bandEls) svg.appendChild(b);
}

// ------------------------------------------------------------------- donut
export function donut(el, { slices, valFmt, centerLabel = 'Total' }) {
  const data = slices.filter((s) => s.value > 0);
  const total = data.reduce((a, s) => a + s.value, 0);
  if (!total) return emptyState(el, 'Add accounts to see your allocation');
  el.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'donut-wrap';
  el.appendChild(wrap);
  const plot = document.createElement('div');
  plot.className = 'donut-plot';
  wrap.appendChild(plot);
  const { w, h } = measure(plot, 200);
  const size = Math.min(w, h);
  const R = size / 2 - 4, r = R * 0.68, cx = w / 2, cy = h / 2;
  const svg = svgEl('svg', { width: w, height: h, class: 'chart' }, plot);
  let a0 = -Math.PI / 2;
  const gapAngle = data.length > 1 ? 2 / R : 0; // ≈2px surface gap
  for (const s of data) {
    const sweep = (s.value / total) * Math.PI * 2;
    const a1 = a0 + sweep;
    const s0 = a0 + gapAngle / 2, s1 = Math.max(s0 + 0.001, a1 - gapAngle / 2);
    const large = s1 - s0 > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${cx + rad * Math.cos(ang)},${cy + rad * Math.sin(ang)}`;
    const d = data.length === 1
      ? `M${cx - R},${cy}A${R},${R} 0 1 1 ${cx + R},${cy}A${R},${R} 0 1 1 ${cx - R},${cy}M${cx - r},${cy}A${r},${r} 0 1 0 ${cx + r},${cy}A${r},${r} 0 1 0 ${cx - r},${cy}Z`
      : `M${p(R, s0)}A${R},${R} 0 ${large} 1 ${p(R, s1)}L${p(r, s1)}A${r},${r} 0 ${large} 0 ${p(r, s0)}Z`;
    const path = svgEl('path', { d, class: 'slice', style: `fill:${s.color}`, tabindex: 0, 'fill-rule': 'evenodd' }, svg);
    const show = (x, y) => showTip(x, y, { title: s.name, rows: [
      { color: s.color, key: 'rect', label: 'Value', value: valFmt(s.value) },
      { label: 'Share', value: `${((s.value / total) * 100).toFixed(1)}%`, money: false },
    ] });
    path.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    path.addEventListener('pointerleave', hideTip);
    path.addEventListener('focus', () => { const b = path.getBoundingClientRect(); show(b.right, b.top); });
    path.addEventListener('blur', hideTip);
    a0 = a1;
  }
  text(svg, cx, cy - 4, valFmt(total), { 'text-anchor': 'middle', class: 'donut-total money' });
  text(svg, cx, cy + 14, centerLabel, { 'text-anchor': 'middle', class: 'donut-sub' });

  const lg = document.createElement('div');
  lg.className = 'legend table';
  for (const s of data) {
    const row = document.createElement('div');
    row.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-key rect';
    sw.style.background = s.color;
    const name = document.createElement('span');
    name.className = 'legend-name';
    name.textContent = s.name;
    const v = document.createElement('span');
    v.className = 'legend-value money';
    v.textContent = valFmt(s.value);
    const pc = document.createElement('span');
    pc.className = 'legend-pct';
    pc.textContent = `${((s.value / total) * 100).toFixed(1)}%`;
    row.append(sw, name, v, pc);
    lg.appendChild(row);
  }
  wrap.appendChild(lg);
}

// ------------------------------------------------------------------- gauge
/** Grafana-style 240° gauge: thin threshold ring outside, value arc inside. */
export function gauge(el, { value, min = 0, max, thresholds, fmt, sub }) {
  el.replaceChildren();
  const plot = document.createElement('div');
  plot.className = 'plot';
  el.appendChild(plot);
  const { w, h } = measure(plot, 160);
  const R = Math.min(w / 2, h / 1.55) - 6;
  const cx = w / 2, cy = R + 8;
  const svg = svgEl('svg', { width: w, height: h, class: 'chart gauge' }, plot);
  const start = (210 * Math.PI) / 180, sweep = (240 * Math.PI) / 180;
  const ang = (v) => start - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * sweep;
  const arc = (rad, a0, a1) => {
    const p = (a) => `${cx + rad * Math.cos(a)},${cy - rad * Math.sin(a)}`;
    const large = a0 - a1 > Math.PI ? 1 : 0;
    return `M${p(a0)}A${rad},${rad} 0 ${large} 1 ${p(a1)}`;
  };
  const ringR = R - 2, valR = R - 14;
  thresholds.forEach((t, i) => {
    const to = thresholds[i + 1] ? thresholds[i + 1].from : max;
    svgEl('path', { d: arc(ringR, ang(t.from), ang(to) + (thresholds[i + 1] ? 0.02 : 0)), class: 'gauge-ring', style: `stroke:${t.color}` }, svg);
  });
  svgEl('path', { d: arc(valR, start, start - sweep), class: 'gauge-track' }, svg);
  const color = [...thresholds].reverse().find((t) => (value ?? 0) >= t.from)?.color || thresholds[0].color;
  if (value != null && value > min) svgEl('path', { d: arc(valR, start, ang(value)), class: 'gauge-value', style: `stroke:${color}` }, svg);
  text(svg, cx, cy + 8, value == null ? '—' : fmt(value), { 'text-anchor': 'middle', class: 'gauge-text' });
  if (sub) text(svg, cx, cy + 28, sub, { 'text-anchor': 'middle', class: 'gauge-sub money' });
}

// --------------------------------------------------------------- sparkline
export function sparkline(values, color, { w = 200, h = 40 } = {}) {
  const pts = values.map((v, i) => [i, v]).filter((p) => p[1] != null);
  if (pts.length < 2) return '';
  const vs = pts.map((p) => p[1]);
  const min = Math.min(...vs), max = Math.max(...vs);
  const n = values.length - 1 || 1;
  const X = (i) => (i / n) * w;
  const Y = (v) => (max === min ? h / 2 : 2 + (1 - (v - min) / (max - min)) * (h - 4));
  const line = pts.map(([i, v]) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('L');
  const area = `M${X(pts[0][0])},${h}L${line}L${X(pts[pts.length - 1][0])},${h}Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" style="fill:${color}" class="spark-area"/>
    <path d="M${line}" style="stroke:${color}" class="spark-line" vector-effect="non-scaling-stroke"/></svg>`;
}
