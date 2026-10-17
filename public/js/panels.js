// Dashboard definition: rows of Grafana-style panels. Each panel renders
// into its body and may expose data() for the "Inspect data" table view.
import * as C from './calc.js';
import { timeSeries, barChart, donut, gauge, sparkline } from './charts.js';
import { money, moneyShort, pctFmt, daysAgoText } from './format.js';
import { h, icon } from './ui.js';

// Grafana named hues (CSS tokens, re-stepped for each theme). The series orders
// below were checked for colorblind separation between neighbours in both
// themes — keep the orders when editing.
const HUE = { blue: 'var(--blue)', green: 'var(--green)', purple: 'var(--purple)', orange: 'var(--orange)', yellow: 'var(--yellow)', red: 'var(--red)', cyan: 'var(--cyan)' };
export const GROUP_COLOR = { bank: HUE.blue, fixed: HUE.green, mf: HUE.purple, equity: HUE.orange, retirement: HUE.cyan, other: HUE.yellow };
const BANK_HUES = ['blue', 'yellow', 'cyan', 'green', 'purple', 'orange'];
const SOURCE_COLOR = { salary: HUE.purple, bonus: HUE.green, freelance: HUE.blue, returns: HUE.yellow, other: HUE.cyan };
const INCOME_COLOR = HUE.purple;
const EXPENSE_COLOR = HUE.orange;
const GOOD = 'var(--good)', BAD = 'var(--critical)';

const SOURCE_GROUPS = [
  { id: 'salary', label: 'Salary', match: ['Salary'] },
  { id: 'bonus', label: 'Bonus', match: ['Bonus'] },
  { id: 'freelance', label: 'Freelance', match: ['Freelance'] },
  { id: 'returns', label: 'Interest & dividends', match: ['Interest', 'Dividends'] },
  { id: 'other', label: 'Other', match: null },
];
const sourceGroup = (src) => SOURCE_GROUPS.find((g) => g.match && g.match.includes(src)) || SOURCE_GROUPS[4];

const M = (v) => moneyShort(v);
const MF = (v) => money(v);
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

// ----------------------------------------------------------- derived data
function memo(ctx, key, fn) {
  ctx._memo ||= {};
  if (!(key in ctx._memo)) ctx._memo[key] = fn();
  return ctx._memo[key];
}

/** Earnings per month (by "counts toward" month), honoring the Income variable. */
function earnings(ctx) {
  return memo(ctx, 'earnings', () => {
    const map = new Map();
    for (const i of ctx.L.income) {
      if (ctx.vars.income === 'salary' && i.source !== 'Salary') continue;
      const m = map.get(i.month) || { total: 0, groups: {} };
      m.total += i.amount;
      const g = sourceGroup(i.source).id;
      m.groups[g] = (m.groups[g] || 0) + i.amount;
      map.set(i.month, m);
    }
    return map;
  });
}
const earned = (ctx, key) => earnings(ctx).get(key)?.total ?? 0;
const firstIncomeMonth = (ctx) => {
  const keys = [...earnings(ctx).keys()].sort();
  return keys[0] || null;
};

function netWorthSeries(ctx) {
  return memo(ctx, 'nw', () => ctx.days.map((d) => [d, ctx.L.totalAt(d)]));
}
function bankSeries(ctx) {
  return memo(ctx, 'bankTotal', () => ctx.days.map((d) => [d, ctx.L.totalAt(d, ctx.L.banks)]));
}
function monthlyCashflow(ctx) {
  return memo(ctx, 'cashflow', () => ctx.range.months.map((k) => {
    const e = ctx.L.expenseIn(C.monthStartDay(k), C.monthEndDay(k));
    const received = ctx.L.receivedInMonth(k);
    return { key: k, received, expense: e.amount, invested: e.invested, covered: e.covered, wanted: e.wanted, complete: e.complete };
  }));
}
function lastCompleteMonth(ctx) {
  return memo(ctx, 'lastComplete', () => {
    let k = C.monthOf(ctx.L.todayISO);
    for (let i = 0; i < 24; i++, k = C.addMonths(k, -1)) {
      const e = ctx.L.expenseIn(C.monthStartDay(k), C.monthEndDay(k));
      const inc = ctx.L.receivedInMonth(k);
      if (e.complete && inc > 0 && C.monthEndDay(k) <= ctx.L.today) return { key: k, expense: e.amount, income: inc };
    }
    return null;
  });
}

function delta(now, before, { upIsGood = true, label = '' } = {}) {
  if (now == null || before == null) return null;
  const diff = now - before;
  const dir = Math.abs(diff) < 0.5 ? 'flat' : diff > 0 ? 'up' : 'down';
  const tone = dir === 'flat' ? 'neutral' : (dir === 'up') === upIsGood ? 'good' : 'bad';
  return { dir, tone, pct: C.pct(now, before), diff, label };
}

// ------------------------------------------------------------ renderers
/**
 * Grafana-style stat. `color` tints the value and sparkline ("Color mode: Value");
 * `bg` fills the body with a gradient instead ("Color mode: Background gradient").
 */
function statBody(body, { value, valueClass = 'money', color, bg, d, sub, spark, pctOnly = false }) {
  body.classList.add('stat');
  if (bg) body.classList.add('bg', `bg-${bg}`);
  const hasSpark = !!spark && spark.filter((v) => v != null).length > 1;
  body.classList.toggle('has-spark', hasSpark);
  const deltaEl = d
    ? h('div', { class: `stat-delta ${d.tone}` },
      h('span', { class: 'delta-icon', html: icon(d.dir === 'up' ? 'up' : d.dir === 'down' ? 'dn' : 'right') }),
      d.pct != null ? h('span', { class: 'delta-pct' }, pctFmt(d.pct)) : null,
      !pctOnly && d.diff != null ? h('span', { class: 'delta-abs money' }, moneyShort(d.diff, { sign: true })) : null,
      d.text ? h('span', { class: 'delta-abs' }, d.text) : null,
      d.label ? h('span', { class: 'delta-label' }, d.label) : null)
    : null;
  body.append(h('div', { class: 'stat-main' },
    h('div', { class: `stat-value ${valueClass}${color && !bg ? ` c-${color}` : ''}` }, value),
    deltaEl,
    sub ? h('div', { class: 'stat-sub' }, sub) : null));
  if (hasSpark) {
    const lineColor = bg === 'orange' ? 'rgba(17, 18, 23, 0.55)' : bg ? 'rgba(255, 255, 255, 0.75)' : HUE[color] || HUE.blue;
    body.append(h('div', { class: 'stat-spark', html: sparkline(spark, lineColor) }));
  }
}

function tableBody(body, { columns, rows, foot, onRow, empty = 'No data' }) {
  body.classList.add('table-body');
  if (!rows.length) { body.append(h('div', { class: 'chart-empty' }, empty)); return; }
  const cell = (c, col, tag = 'td') => {
    const v = c && typeof c === 'object' && !(c instanceof Node) ? c : { text: c };
    return h(tag, { class: [col.align === 'right' ? 'num' : '', v.cls || '', col.money && v.money !== false ? 'money' : ''].join(' ').trim() },
      v.node || v.text);
  };
  const table = h('table', { class: 'grid-table' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.align === 'right' ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.map((r, ri) => h('tr', { class: onRow ? 'clickable' : '', onclick: onRow ? () => onRow(ri) : null },
      r.map((c, ci) => cell(c, columns[ci]))))),
    foot ? h('tfoot', {}, h('tr', {}, foot.map((c, ci) => cell(c, columns[ci])))) : null);
  body.append(h('div', { class: 'table-scroll' }, table));
}

function emptyBody(body, message, action) {
  body.append(h('div', { class: 'chart-empty' }, h('div', {}, message), action ? h('button', { class: 'btn secondary sm', onclick: action.onClick }, action.label) : null));
}

const toneCell = (v, fmt = (x) => pctFmt(x)) => (v == null
  ? { text: '—', cls: 'muted' }
  : { node: h('span', { class: `tone ${v > 0 ? 'good' : v < 0 ? 'bad' : ''}` }, h('span', { class: 'tone-icon', html: icon(v > 0 ? 'up' : v < 0 ? 'dn' : 'right') }), fmt(v)), money: false });

function staleness(L, acc, everyDays) {
  const d = L.lastUpdatedDay(acc);
  if (L.isAuto(acc)) return { cls: 'fresh', text: 'auto' };
  if (d == null) return { cls: 'stale', text: 'never' };
  const age = L.today - d;
  return { cls: age >= everyDays * 2 ? 'stale' : age >= everyDays ? 'aging' : 'fresh', text: daysAgoText(age) };
}

// ------------------------------------------------------------- the spec
export function dashboardSpec(ctx) {
  const { L, range, actions } = ctx;
  const rem = L.settings.reminders;
  const rangeStartLabel = C.dayLabel(range.startDay, true);

  return [
    {
      id: 'overview', title: 'Overview', panels: [
        {
          id: 'networth', title: 'Net worth', w: 6, h: 5,
          desc: 'Total value across every place your money sits: bank accounts, FDs, mutual funds, stocks, EPF/PPF, gold and more. Change is measured from the start of the selected time range.',
          render(body) {
            const now = L.totalAt(L.today);
            if (now == null) return emptyBody(body, 'Add accounts to see your net worth', { label: 'Add accounts', onClick: () => actions.accounts() });
            const series = netWorthSeries(ctx);
            const first = series.find((p) => p[1] != null);
            statBody(body, {
              value: M(now), color: 'green', d: delta(now, first?.[1], { label: `since ${C.dayLabel(first?.[0] ?? range.startDay, true)}` }),
              spark: series.map((p) => p[1]),
            });
          },
          data: () => ({ columns: ['Date', 'Net worth'], rows: netWorthSeries(ctx).filter((p) => p[1] != null).map(([d, v]) => [C.fromDay(d), MF(v)]) }),
        },
        {
          id: 'bank', title: 'Bank balance', w: 6, h: 5, alerts: ['bank'],
          desc: 'Combined balance of all your bank accounts, from your latest check-in. Change is from the start of the selected range.',
          render(body) {
            const now = L.totalAt(L.today, L.banks);
            if (now == null) return emptyBody(body, 'No bank balances yet', { label: 'Update balances', onClick: () => actions.checkin() });
            const series = bankSeries(ctx);
            const first = series.find((p) => p[1] != null);
            statBody(body, {
              value: M(now), color: 'blue', d: delta(now, first?.[1], { label: `since ${C.dayLabel(first?.[0] ?? range.startDay, true)}` }),
              spark: series.map((p) => p[1]),
              sub: `${L.banks.filter((a) => L.isActive(a)).length} accounts · checked in ${daysAgoText(L.lastCheckin == null ? null : L.today - L.lastCheckin)}`,
            });
          },
          data: () => ({ columns: ['Date', 'Bank balance'], rows: bankSeries(ctx).filter((p) => p[1] != null).map(([d, v]) => [C.fromDay(d), MF(v)]) }),
        },
        {
          id: 'earn-month', w: 6, h: 5, alerts: ['income'],
          title: () => {
            const cur = C.monthOf(L.todayISO);
            const k = earned(ctx, cur) > 0 ? cur : C.addMonths(cur, -1);
            return `Earnings · ${C.monthLabel(k)}`;
          },
          desc: 'What you earned in the month (by the month each income counts toward), compared with the month before. Shows last month until this month\'s income is logged.',
          render(body) {
            const cur = C.monthOf(L.todayISO);
            const k = earned(ctx, cur) > 0 ? cur : C.addMonths(cur, -1);
            const now = earned(ctx, k), prev = earned(ctx, C.addMonths(k, -1));
            if (!now && !prev) return emptyBody(body, 'No income logged yet', { label: 'Log income', onClick: () => actions.income() });
            const ly = earned(ctx, C.addMonths(k, -12));
            statBody(body, {
              value: M(now), color: 'purple', d: delta(now, prev, { label: `vs ${C.monthLabel(C.addMonths(k, -1))}` }),
              sub: ly ? `${pctFmt(C.pct(now, ly))} vs ${C.monthLabel(C.addMonths(k, -12))}` : null,
              spark: range.months.map((m) => earned(ctx, m)),
            });
          },
        },
        {
          id: 'savings-rate', w: 6, h: 5,
          title: () => { const lc = lastCompleteMonth(ctx); return lc ? `Savings rate · ${C.monthLabel(lc.key)}` : 'Savings rate'; },
          desc: 'Share of the income you received that you did not spend, for the most recent fully checked-in month. Money moved into investments counts as saved.',
          render(body) {
            const lc = lastCompleteMonth(ctx);
            if (!lc) return emptyBody(body, 'Needs one full month of weekly check-ins');
            const rate = (lc.income - lc.expense) / lc.income;
            const pk = C.addMonths(lc.key, -1);
            const pe = L.expenseIn(C.monthStartDay(pk), C.monthEndDay(pk));
            const pi = L.receivedInMonth(pk);
            const prevRate = pe.complete && pi ? (pi - pe.amount) / pi : null;
            const d = prevRate == null ? null : {
              dir: rate > prevRate ? 'up' : rate < prevRate ? 'down' : 'flat',
              tone: rate > prevRate ? 'good' : rate < prevRate ? 'bad' : 'neutral',
              text: `${rate >= prevRate ? '+' : '−'}${Math.abs((rate - prevRate) * 100).toFixed(1)} pts`, label: `vs ${C.monthLabel(pk)}`,
            };
            // Thresholds: under 10% red, 10–25% orange, 25%+ green.
            statBody(body, {
              value: pctFmt(rate, { sign: false }), valueClass: '', d,
              bg: rate < 0.1 ? 'red' : rate < 0.25 ? 'orange' : 'green',
              sub: h('span', {}, 'Saved ', h('span', { class: 'money' }, M(lc.income - lc.expense)), ' of ', h('span', { class: 'money' }, M(lc.income)), ' · target 25%+'),
              spark: monthlyCashflow(ctx).map((m) => (m.complete && m.received ? (m.received - m.expense) / m.received : null)),
            });
          },
        },
        {
          id: 'banks', title: 'Bank accounts', w: 8, h: 6, alerts: ['bank'],
          desc: 'Each bank account\'s latest balance, how it moved since the previous check-in, and how fresh the number is.',
          render(body) {
            const banks = L.banks.filter((a) => L.isActive(a));
            if (!banks.length) return emptyBody(body, 'Add your bank accounts', { label: 'Add account', onClick: () => actions.accounts() });
            body.classList.add('bank-tiles');
            banks.forEach((a, i) => {
              const list = L.snaps.get(a.id) || [];
              const last = list[list.length - 1], prev = list[list.length - 2];
              const st = staleness(L, a, rem.bankEveryDays);
              const d = last && prev ? delta(last.value, prev.value, { label: `since ${C.dayLabel(prev.day)}` }) : null;
              body.append(h('div', { class: 'bank-tile' },
                h('div', { class: 'bank-name' }, h('span', { class: 'swatch', style: { background: HUE[bankHue(L, a)] } }), a.name),
                h('div', { class: `bank-value money c-${bankHue(L, a)}` }, last ? MF(last.value) : '—'),
                d ? h('div', { class: `stat-delta small ${d.tone}` },
                  h('span', { class: 'delta-icon', html: icon(d.dir === 'up' ? 'up' : d.dir === 'down' ? 'dn' : 'right') }),
                  h('span', { class: 'delta-abs money' }, moneyShort(d.diff, { sign: true })),
                  h('span', { class: 'delta-label' }, d.label)) : null,
                h('div', { class: `fresh-badge ${st.cls}` }, h('span', { class: 'dot' }), `Updated ${st.text}`)));
            });
          },
        },
        {
          id: 'runway', title: 'Emergency fund', w: 4, h: 6,
          desc: 'How many months your bank balance would cover at your average monthly spending (last 3 fully checked-in months). 6+ months is a common target.',
          render(body) {
            const avg = L.avgMonthlyExpense(3);
            const bank = L.totalAt(L.today, L.banks);
            if (!avg || !bank || avg.value <= 0) return emptyBody(body, 'Needs a full month of check-ins');
            gauge(body, {
              value: bank / avg.value, min: 0, max: 12, fmt: (v) => `${v.toFixed(1)} mo`,
              sub: `at ${M(avg.value)}/mo spend`,
              thresholds: [{ from: 0, color: 'var(--critical)' }, { from: 3, color: 'var(--warning)' }, { from: 6, color: 'var(--good)' }],
            });
          },
        },
        {
          id: 'gains', title: 'Investment gains', w: 4, h: 6, alerts: ['investments'],
          desc: 'Current value of all investments (FDs, funds, stocks, EPF, gold…) minus what you put in. Returns are simple (absolute), not annualised.',
          render(body) {
            const hs = L.holdings().filter((x) => x.active && x.invested != null);
            if (!hs.length) return emptyBody(body, 'No investments yet', { label: 'Add investment', onClick: () => actions.accounts() });
            const invested = sum(hs.map((x) => x.invested)), value = sum(hs.map((x) => x.value));
            statBody(body, {
              value: moneyShort(value - invested, { sign: true }), color: value >= invested ? 'green' : 'red',
              d: { dir: value >= invested ? 'up' : 'down', tone: value >= invested ? 'good' : 'bad', pct: invested ? (value - invested) / invested : null, label: 'total return' },
              sub: h('span', {}, h('span', { class: 'money' }, M(invested)), ' invested → ', h('span', { class: 'money' }, M(value))),
              spark: ctx.days.map((d) => {
                let v = 0, i = 0, any = false;
                for (const a of L.investments) { const x = L.valueAt(a, d), y = L.investedAt(a, d); if (x != null && y != null) { v += x; i += y; any = true; } }
                return any ? v - i : null;
              }),
            });
          },
        },
        {
          id: 'alerts', title: 'Needs your input', w: 8, h: 6,
          desc: `What to update so the numbers stay accurate. A macOS reminder is sent daily at ${rem.notifyAt} when something is due (while the GiveMeBucks server is running).`,
          render(body) {
            const items = ctx.due;
            if (!items.length) {
              body.classList.add('bg', 'bg-green');
              body.append(h('div', { class: 'all-good' },
                h('div', { class: 'all-good-title' }, h('span', { html: icon('check') }), 'All caught up'),
                h('div', { class: 'all-good-sub' }, `Last check-in ${L.lastCheckin == null ? 'never' : C.dayLabel(L.lastCheckin, true)} · next one ${dueIn(Math.max(0, rem.bankEveryDays - (L.today - (L.lastCheckin ?? L.today))))}`)));
              return;
            }
            body.classList.add('alert-list');
            const state = { critical: ['Overdue', 'fire'], warning: ['Due', 'warn'], info: ['Upcoming', 'info'] };
            for (const it of items) {
              const [label, ic] = state[it.severity];
              body.append(h('div', { class: `alert-item ${it.severity}` },
                h('span', { class: 'alert-icon', html: icon(ic) }),
                h('div', { class: 'alert-text' },
                  h('div', { class: 'alert-title' }, h('span', { class: 'alert-state' }, label), it.title),
                  h('div', { class: 'alert-detail' }, it.detail)),
                h('button', { class: 'btn secondary sm', onclick: () => actions[it.action]() },
                  it.action === 'income' ? 'Log' : it.action === 'checkin' ? 'Update' : 'Open')));
            }
          },
        },
      ],
    },
    {
      id: 'growth', title: 'Growth', panels: [
        {
          id: 'goal', title: 'Net worth goal', w: 24, h: 3,
          desc: 'Progress toward your net-worth goal, with a projection from your average monthly growth over the last 6 months.',
          render(body) { renderGoal(body, ctx); },
        },
        {
          id: 'nw-ts', title: 'Net worth by asset class', w: 16, h: 9,
          desc: 'Stacked total of every account, grouped by asset class. Values are carried forward between updates; FDs grow automatically at their interest rate.',
          render(body) {
            const groups = C.GROUPS.filter((g) => ctx.days.some((d) => L.groupAt(g.id, d) > 0));
            const nw = netWorthSeries(ctx);
            const target = Number(L.settings.goal.target) || 0;
            const max = Math.max(...nw.map((p) => p[1] ?? 0));
            timeSeries(body, {
              stacked: true, totalLabel: 'Net worth',
              series: groups.map((g) => ({ name: g.label, color: GROUP_COLOR[g.id], points: ctx.days.map((d, i) => [d, nw[i][1] == null ? null : L.groupAt(g.id, d)]) })),
              yFmt: M, valFmt: MF, xStart: range.startDay, xEnd: range.endDay,
              refLines: target && target <= max * 1.25 ? [{ value: target, label: `Goal ${M(target)}` }] : [],
              empty: 'No balances in this range yet',
            });
          },
          data: () => {
            const groups = C.GROUPS;
            return {
              columns: ['Date', ...groups.map((g) => g.label), 'Total'],
              rows: ctx.days.filter((d) => L.totalAt(d) != null).map((d) => [C.fromDay(d), ...groups.map((g) => MF(L.groupAt(g.id, d))), MF(L.totalAt(d))]),
            };
          },
        },
        {
          id: 'alloc', title: 'Where your money is', w: 8, h: 9,
          desc: 'Today\'s split of your net worth across asset classes.',
          render(body) {
            donut(body, { slices: L.allocation().map((g) => ({ name: g.label, value: g.value, color: GROUP_COLOR[g.id] })), valFmt: M, centerLabel: 'Net worth' });
          },
          data: () => ({ columns: ['Asset class', 'Value', 'Share'], rows: (() => { const a = L.allocation(); const t = sum(a.map((g) => g.value)); return a.map((g) => [g.label, MF(g.value), t ? `${((g.value / t) * 100).toFixed(1)}%` : '—']); })() }),
        },
        {
          id: 'bank-ts', title: 'Bank balances', w: 12, h: 8,
          desc: 'Balance of each bank account over time, from your check-ins.',
          render(body) {
            const banks = L.banks.filter((a) => ctx.days.some((d) => L.valueAt(a, d) != null));
            timeSeries(body, {
              series: banks.map((a) => ({ name: a.name, color: HUE[bankHue(L, a)], points: ctx.days.map((d) => [d, L.valueAt(a, d)]) })),
              yFmt: M, valFmt: MF, xStart: range.startDay, xEnd: range.endDay, zero: true,
            });
          },
          data: () => ({ columns: ['Date', ...L.banks.map((a) => a.name)], rows: ctx.days.map((d) => [C.fromDay(d), ...L.banks.map((a) => MF(L.valueAt(a, d)))]) }),
        },
        {
          id: 'inv-ts', title: 'Invested vs current value', w: 12, h: 8,
          desc: 'What you have put into investments (cost) against what they are worth. The gap is your gain.',
          render(body) {
            const pts = ctx.days.map((d) => {
              let v = 0, i = 0, any = false;
              for (const a of L.investments) { const x = L.valueAt(a, d), y = L.investedAt(a, d); if (x != null && y != null) { v += x; i += y; any = true; } }
              return any ? [d, v, i] : [d, null, null];
            });
            timeSeries(body, {
              area: true,
              series: [
                { name: 'Current value', color: HUE.green, points: pts.map((p) => [p[0], p[1]]) },
                { name: 'Invested', color: HUE.blue, points: pts.map((p) => [p[0], p[2]]) },
              ],
              yFmt: M, valFmt: MF, xStart: range.startDay, xEnd: range.endDay,
            });
          },
        },
      ],
    },
    {
      id: 'earnings', title: 'Earnings', panels: [
        {
          id: 'earn-monthly', title: 'Monthly earnings', w: 12, h: 8, alerts: ['income'],
          desc: 'Income per month, split by source. Uses the month each income counts toward (e.g. salary for September).',
          render(body) {
            const map = earnings(ctx);
            const groups = SOURCE_GROUPS.filter((g) => range.months.some((k) => map.get(k)?.groups[g.id]));
            const totals = range.months.map((k) => earned(ctx, k));
            const maxI = totals.indexOf(Math.max(...totals));
            barChart(body, {
              stacked: true,
              categories: range.months.map((k) => ({ label: C.monthLabel(k, range.months.length <= 6), title: C.monthLabel(k) })),
              series: groups.map((g) => ({ name: g.label, color: SOURCE_COLOR[g.id], values: range.months.map((k) => map.get(k)?.groups[g.id] ?? null) })),
              yFmt: M, valFmt: MF,
              labelFn: (ci) => (ci === totals.length - 1 || ci === maxI) && totals[ci] ? M(totals[ci]) : null,
              tipFoot: (ci) => {
                const prev = earned(ctx, C.addMonths(range.months[ci], -1));
                return `Total ${MF(totals[ci])}${prev ? ` · ${pctFmt(C.pct(totals[ci], prev))} vs previous month` : ''}`;
              },
              empty: 'No income logged in this range',
            });
          },
          data: () => ({ columns: ['Month', ...SOURCE_GROUPS.map((g) => g.label), 'Total'], rows: range.months.map((k) => [C.monthLabel(k), ...SOURCE_GROUPS.map((g) => MF(earnings(ctx).get(k)?.groups[g.id] ?? 0)), MF(earned(ctx, k))]) }),
        },
        {
          id: 'earn-mom', title: 'Month-over-month growth', w: 12, h: 8,
          desc: 'Percentage change in earnings versus the previous month. Bonuses cause spikes — switch the Income variable to "Salary only" to see underlying growth.',
          render(body) {
            const vals = range.months.map((k) => {
              const p = earned(ctx, C.addMonths(k, -1));
              const n = earned(ctx, k);
              return p && n ? C.pct(n, p) * 100 : null;
            });
            barChart(body, {
              categories: range.months.map((k) => ({ label: C.monthLabel(k, range.months.length <= 6), title: C.monthLabel(k) })),
              series: [{ name: 'MoM growth', color: GOOD, values: vals }],
              money: false,
              colorFn: (si, ci, v) => (v >= 0 ? GOOD : BAD),
              yFmt: (v) => `${Number(v.toFixed(1))}%`, valFmt: (v) => pctFmt(v / 100),
              labelFn: (ci) => (ci === vals.length - 1 && vals[ci] != null ? pctFmt(vals[ci] / 100) : null),
              tipRows: (ci) => {
                const k = range.months[ci], pk = C.addMonths(k, -1);
                return [
                  { label: 'Growth', value: vals[ci] == null ? '—' : pctFmt(vals[ci] / 100), money: false, strong: true, color: vals[ci] >= 0 ? GOOD : BAD, key: 'rect' },
                  { label: C.monthLabel(k), value: MF(earned(ctx, k)) },
                  { label: C.monthLabel(pk), value: MF(earned(ctx, pk)) },
                ];
              },
              empty: 'Needs two months of income',
            });
          },
          data: () => ({ columns: ['Month', 'Earned', 'Previous', 'MoM %'], rows: range.months.map((k) => { const n = earned(ctx, k), p = earned(ctx, C.addMonths(k, -1)); return [C.monthLabel(k), MF(n), MF(p), p && n ? pctFmt(C.pct(n, p)) : '—']; }) }),
        },
        {
          id: 'earn-yearly', w: 12, h: 8, hint: 'all time',
          title: () => `Yearly earnings · ${ctx.vars.yearMode === 'fy' ? 'financial year' : 'calendar year'}`,
          desc: 'Total earnings per year with year-over-year growth. The current year is year-to-date and is compared with the same months of the previous year.',
          render(body) {
            const rows = yearly(ctx);
            if (!rows.length) return emptyBody(body, 'No income logged yet');
            barChart(body, {
              categories: rows.map((r) => ({ label: r.label + (r.partial ? ' (YTD)' : r.startsLate ? ' (part)' : ''), title: r.label })),
              series: [{ name: 'Earnings', color: INCOME_COLOR, values: rows.map((r) => r.total) }],
              colorFn: (si, ci) => (rows[ci].partial || rows[ci].startsLate ? 'color-mix(in srgb, var(--purple) 45%, transparent)' : INCOME_COLOR),
              yFmt: M, valFmt: MF,
              labelFn: (ci) => (rows[ci].growth != null ? pctFmt(rows[ci].growth) : null),
              labelMoney: false,
              tipRows: (ci) => {
                const r = rows[ci];
                return [
                  { label: r.partial ? `Earned so far (${r.months} mo)` : 'Earned', value: MF(r.total), strong: true, color: INCOME_COLOR, key: 'rect' },
                  { label: r.partial ? 'Same months last year' : 'Previous year', value: r.compare == null ? '—' : MF(r.compare) },
                  { label: 'Growth', value: r.growth == null ? '—' : pctFmt(r.growth), money: false },
                  { label: 'Average / month', value: MF(r.total / Math.max(1, r.months)) },
                ];
              },
              tipFoot: (ci) => (rows[ci].startsLate ? `Tracking started ${C.monthLabel(rows[ci].startsLate)} — no growth figure for a partial year.` : undefined),
            });
          },
          data: () => ({ columns: ['Year', 'Earned', 'Compared with', 'YoY %'], rows: yearly(ctx).map((r) => [r.label + (r.partial ? ' (YTD)' : ''), MF(r.total), r.compare == null ? '—' : MF(r.compare), r.growth == null ? '—' : pctFmt(r.growth)]) }),
        },
        {
          id: 'earn-table', title: 'Earnings by month', w: 12, h: 8,
          desc: 'Month-by-month earnings with change versus the previous month and the same month last year.',
          render(body) {
            const months = range.months.slice().reverse().filter((k) => earned(ctx, k) || earned(ctx, C.addMonths(k, -1)));
            tableBody(body, {
              columns: [{ label: 'Month' }, { label: 'Earned', align: 'right', money: true }, { label: 'vs prev', align: 'right', money: true }, { label: 'MoM', align: 'right' }, { label: 'Last year', align: 'right', money: true }, { label: 'YoY', align: 'right' }],
              rows: months.map((k) => {
                const n = earned(ctx, k), p = earned(ctx, C.addMonths(k, -1)), y = earned(ctx, C.addMonths(k, -12));
                return [C.monthLabel(k), MF(n), p ? moneyShort(n - p, { sign: true }) : '—', toneCell(p ? C.pct(n, p) : null), y ? M(y) : '—', toneCell(y ? C.pct(n, y) : null)];
              }),
              empty: 'No income logged in this range',
            });
          },
        },
      ],
    },
    {
      id: 'spending', title: 'Spending', panels: [
        ...spendStats(ctx),
        {
          id: 'cashflow', title: 'Income vs expenses', w: 12, h: 8,
          desc: 'Income received each month against what you spent. Spending is derived from your check-ins: opening bank balance + income − money moved into investments − closing balance.',
          render(body) {
            const rows = monthlyCashflow(ctx);
            barChart(body, {
              categories: rows.map((r) => ({ label: C.monthLabel(r.key, rows.length <= 6), title: C.monthLabel(r.key) })),
              series: [
                { name: 'Income received', color: INCOME_COLOR, values: rows.map((r) => r.received || null) },
                { name: 'Expenses', color: EXPENSE_COLOR, values: rows.map((r) => r.expense) },
              ],
              yFmt: M, valFmt: MF,
              tipRows: (ci) => {
                const r = rows[ci];
                const saved = r.expense == null ? null : r.received - r.expense;
                return [
                  { label: 'Income received', value: MF(r.received), color: INCOME_COLOR, key: 'rect' },
                  { label: 'Expenses', value: r.expense == null ? '—' : MF(r.expense), color: EXPENSE_COLOR, key: 'rect' },
                  { label: 'Saved', value: saved == null ? '—' : MF(saved), strong: true },
                  { label: 'Savings rate', value: saved == null || !r.received ? '—' : pctFmt(saved / r.received, { sign: false }), money: false },
                  { label: 'Moved to investments', value: MF(r.invested) },
                ];
              },
              tipFoot: (ci) => (rows[ci].complete ? undefined : rows[ci].covered ? `Partial: check-ins cover ${rows[ci].covered} of ${rows[ci].wanted} days` : 'No check-ins this month'),
              empty: 'Needs at least two bank check-ins',
            });
          },
          data: () => ({ columns: ['Month', 'Income received', 'Expenses', 'Saved', 'Moved to investments', 'Coverage'], rows: monthlyCashflow(ctx).map((r) => [C.monthLabel(r.key), MF(r.received), MF(r.expense), r.expense == null ? '—' : MF(r.received - r.expense), MF(r.invested), `${r.covered}/${r.wanted} days`]) }),
        },
        {
          id: 'weekly', title: 'Weekly expenses', w: 12, h: 8,
          desc: 'Spending per week (Monday–Sunday), derived from your weekly bank check-ins. The line is your average over complete weeks shown.',
          render(body) {
            const weeks = weeklyRows(ctx);
            const complete = weeks.filter((w) => w.complete && w.amount != null);
            const avg = complete.length ? sum(complete.map((w) => w.amount)) / complete.length : null;
            barChart(body, {
              categories: weeks.map((w) => ({ label: C.dayLabel(w.start), title: `Week of ${C.dayLabel(w.start, true)}` })),
              series: [{ name: 'Expenses', color: EXPENSE_COLOR, values: weeks.map((w) => w.amount) }],
              yFmt: M, valFmt: MF,
              refLine: avg ? { value: avg, label: `avg ${M(avg)}` } : null,
              labelFn: (ci) => (ci === weeks.length - 1 && weeks[ci].amount != null ? M(weeks[ci].amount) : null),
              tipFoot: (ci) => {
                const w = weeks[ci];
                const span = `${C.dayLabel(w.start)} – ${C.dayLabel(w.start + 6)}`;
                return w.complete ? span : `${span} · partial (${w.covered}/${w.wanted} days checked in)`;
              },
              empty: 'Needs at least two bank check-ins',
            });
          },
          data: () => ({ columns: ['Week starting', 'Expenses', 'Coverage'], rows: weeklyRows(ctx).map((w) => [C.fromDay(w.start), MF(w.amount), `${w.covered}/${w.wanted} days`]) }),
        },
      ],
    },
    {
      id: 'investments', title: 'Investments', panels: [
        {
          id: 'holdings', title: 'Holdings', w: 16, h: 9, alerts: ['investments', 'fd-'],
          desc: 'Every account with what you put in, what it is worth now, and when you last updated it. Click a row to edit the account.',
          render(body) {
            const hs = L.holdings().filter((x) => x.active).sort((a, b) => b.value - a.value);
            const inv = hs.filter((x) => x.invested != null);
            const tInv = sum(inv.map((x) => x.invested)), tVal = sum(hs.map((x) => x.value));
            tableBody(body, {
              columns: [{ label: 'Account' }, { label: 'Type' }, { label: 'Invested', align: 'right', money: true }, { label: 'Current value', align: 'right', money: true }, { label: 'Gain', align: 'right', money: true }, { label: 'Return', align: 'right' }, { label: 'Updated' }],
              rows: hs.map((x) => {
                const st = staleness(L, x.acc, x.acc.meta.liquid ? rem.bankEveryDays : rem.investmentEveryDays);
                return [
                  { node: h('span', { class: 'acct' }, h('span', { class: 'swatch', style: { background: GROUP_COLOR[x.acc.meta.group] } }), x.acc.name, x.acc.sip?.amount ? h('span', { class: 'chip money' }, `SIP ${M(x.acc.sip.amount)}`) : null) },
                  x.acc.meta.label,
                  x.invested == null ? '—' : MF(x.invested),
                  MF(x.value),
                  x.gain == null ? { text: '—', money: false } : { node: h('span', { class: `tone ${x.gain > 0 ? 'good' : x.gain < 0 ? 'bad' : ''}` }, moneyShort(x.gain, { sign: true })) },
                  toneCell(x.ret),
                  { node: h('span', { class: `fresh-badge ${st.cls}` }, h('span', { class: 'dot' }), st.text) },
                ];
              }),
              foot: ['Total', '', tInv ? MF(tInv) : '—', MF(tVal), tInv ? moneyShort(sum(inv.map((x) => x.gain)), { sign: true }) : '—', toneCell(tInv ? sum(inv.map((x) => x.gain)) / tInv : null), ''],
              onRow: (ri) => actions.accounts(hs[ri].acc.id),
              empty: 'No accounts yet',
            });
          },
        },
        {
          id: 'fds', title: 'Fixed deposits', w: 8, h: 9, alerts: ['fd-'],
          desc: 'Your FDs with their maturity dates. Values grow automatically using quarterly compounding at the FD rate.',
          render(body) {
            const fds = L.investments.filter((a) => L.isAuto(a) && L.isActive(a))
              .sort((a, b) => (a.fd.maturityDate || '9999').localeCompare(b.fd.maturityDate || '9999'));
            if (!fds.length) return emptyBody(body, 'No FDs yet — add one and its value will grow automatically.', { label: 'Add FD', onClick: () => actions.accounts() });
            body.classList.add('fd-list');
            for (const a of fds) {
              const start = C.toDay(a.fd.startDate), end = a.fd.maturityDate ? C.toDay(a.fd.maturityDate) : null;
              const progress = end ? Math.min(1, Math.max(0, (L.today - start) / (end - start))) : 0;
              const left = end != null ? end - L.today : null;
              const matVal = end ? L.fdValue(a, end) : null;
              body.append(h('div', { class: 'fd-item' },
                h('div', { class: 'fd-top' },
                  h('span', { class: 'fd-name' }, a.name),
                  h('span', { class: `fd-when ${left != null && left <= 30 ? 'soon' : ''}` }, left == null ? 'No maturity date' : left <= 0 ? 'Matured' : `${left} days left`)),
                h('div', { class: 'meter', role: 'meter', 'aria-valuenow': Math.round(progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${a.name} tenure elapsed` },
                  h('div', { class: 'meter-fill', style: { width: `${progress * 100}%` } })),
                h('div', { class: 'fd-meta' },
                  h('span', {}, h('span', { class: 'money' }, M(Number(a.fd.principal))), ` @ ${a.fd.rate}%`),
                  h('span', {}, 'now ', h('span', { class: 'money' }, M(L.current(a)))),
                  matVal ? h('span', {}, `${C.dayLabel(end, true)} → `, h('span', { class: 'money' }, M(matVal))) : null)));
            }
          },
        },
      ],
    },
  ];
}

// ------------------------------------------------------------- helpers
const dueIn = (days) => (days <= 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} days`);

/** A bank keeps its color everywhere (tiles, lines) — based on its position, never on rank. */
const bankHue = (L, acc) => BANK_HUES[Math.max(0, L.banks.indexOf(acc)) % BANK_HUES.length];

function yearly(ctx) {
  return memo(ctx, 'yearly', () => {
    const first = firstIncomeMonth(ctx);
    if (!first) return [];
    const mode = ctx.vars.yearMode;
    const cur = C.monthOf(ctx.L.todayISO);
    const out = [];
    for (let y = C.yearStartOf(first, mode); y <= C.yearStartOf(cur, mode); y++) {
      const months = C.yearMonths(y, mode).filter((k) => k <= cur);
      const total = sum(months.map((k) => earned(ctx, k)));
      const partial = months.length < 12;
      const tracked = months.filter((k) => k >= first);
      const prevMonths = C.yearMonths(y - 1, mode).slice(0, months.length);
      const fullPrev = prevMonths.every((k) => k >= first) && tracked.length === months.length;
      const compare = fullPrev ? sum(prevMonths.map((k) => earned(ctx, k))) : null;
      out.push({
        label: C.yearLabel(y, mode), total, partial, months: tracked.length, compare,
        growth: compare ? C.pct(total, compare) : null,
        startsLate: tracked.length < months.length ? tracked[0] : null,
      });
    }
    return out.slice(-8);
  });
}

function weeklyRows(ctx) {
  return memo(ctx, 'weekly', () => {
    const { L, range } = ctx;
    const out = [];
    const firstWeek = C.weekStartDay(range.startDay);
    for (let w = C.weekStartDay(Math.min(range.endDay, L.today)); w >= firstWeek && out.length < 26; w -= 7) {
      const e = L.expenseIn(w, w + 6);
      out.unshift({ start: w, ...e });
    }
    return out;
  });
}

function spendStats(ctx) {
  const { L } = ctx;
  const lc = L.lastCheckin;
  const through = lc == null ? '' : `through ${C.dayLabel(lc)}`;
  const NEGATIVE = 'Balances rose more than the income you logged — is some income missing?';
  // "Usual" = average spend over the same number of days at the start of past
  // complete periods, so a rent payment early in the month doesn't look like overspending.
  const usualFor = (starts, span, need) => {
    const vals = [];
    for (const s of starts) {
      const e = L.expenseIn(s, s + span - 1);
      if (e.complete && e.amount != null) vals.push(e.amount);
      if (vals.length >= need) break;
    }
    return vals.length ? sum(vals) / vals.length : null;
  };
  // Green at or under your usual spend, orange up to 20% over, red beyond.
  const paceHue = (now, usual) => (usual == null || usual <= 0 ? 'orange' : now <= usual ? 'green' : now <= usual * 1.2 ? 'orange' : 'red');
  const vsUsual = (now, usual) => (usual > 0 ? delta(now, usual, { upIsGood: false, label: 'vs usual' }) : null);
  const tile = (id, title, desc, compute) => ({
    id, title, desc, w: 6, h: 5,
    render(body) {
      const r = compute();
      if (!r) return emptyBody(body, 'Needs more check-ins');
      if (r.negative) r.sub = h('span', { class: 'warn-text' }, h('span', { html: icon('warn', 'small') }), NEGATIVE);
      statBody(body, r);
    },
  });
  return [
    tile('spend-week', 'Spent this week', 'Spending since Monday, up to your latest check-in.', () => {
      const ws = C.weekStartDay(L.today);
      const e = L.expenseIn(ws, L.today);
      if (e.amount == null) return { value: '—', valueClass: '', sub: 'No check-in yet this week' };
      const usual = e.covered ? usualFor(Array.from({ length: 16 }, (_, i) => ws - 7 * (i + 1)), e.covered, 8) : null;
      return {
        value: M(e.amount), color: e.amount < 0 ? 'orange' : paceHue(e.amount, usual), negative: e.amount < 0, pctOnly: true,
        d: e.amount >= 0 ? vsUsual(e.amount, usual) : null,
        sub: usual != null ? h('span', {}, `${e.covered} of ${e.wanted} days · usually `, h('span', { class: 'money' }, M(usual))) : `${through} · ${e.covered} of ${e.wanted} days`,
      };
    }),
    tile('spend-month', 'Spent this month', 'Spending since the 1st, up to your latest check-in.', () => {
      const k = C.monthOf(L.todayISO);
      const e = L.expenseIn(C.monthStartDay(k), L.today);
      if (e.amount == null) return { value: '—', valueClass: '', sub: 'No check-in yet this month' };
      const starts = Array.from({ length: 6 }, (_, i) => C.monthStartDay(C.addMonths(k, -(i + 1))));
      const usual = e.covered ? usualFor(starts, Math.min(e.covered, 28), 3) : null;
      return {
        value: M(e.amount), color: e.amount < 0 ? 'orange' : paceHue(e.amount, usual), negative: e.amount < 0, pctOnly: true,
        d: e.amount >= 0 ? vsUsual(e.amount, usual) : null,
        sub: usual != null ? h('span', {}, `Usually `, h('span', { class: 'money' }, M(usual)), ` by day ${e.covered}`) : through,
      };
    }),
    tile('spend-avg', 'Average monthly spend', 'Average of the last 3 fully checked-in months.', () => {
      const avg = L.avgMonthlyExpense(3), prev = L.avgMonthlyExpense(6);
      if (!avg) return null;
      return { value: M(avg.value), color: 'orange', d: prev && prev.months > avg.months ? delta(avg.value, prev.value, { upIsGood: false, label: 'vs 6-month avg' }) : null, sub: `last ${avg.months} complete month${avg.months > 1 ? 's' : ''}`, spark: monthlyCashflow(ctx).map((m) => (m.complete ? m.expense : null)) };
    }),
    tile('spend-weekavg', 'Average weekly spend', 'Average over the complete weeks in the selected range (up to 26).', () => {
      const weeks = weeklyRows(ctx).filter((w) => w.complete && w.amount != null);
      if (!weeks.length) return null;
      const avg = sum(weeks.map((w) => w.amount)) / weeks.length;
      return { value: M(avg), color: 'yellow', sub: `over ${weeks.length} complete week${weeks.length > 1 ? 's' : ''}`, spark: weeklyRows(ctx).map((w) => (w.complete ? w.amount : null)) };
    }),
  ];
}

function renderGoal(body, ctx) {
  const { L, actions } = ctx;
  const target = Number(L.settings.goal.target) || 0;
  body.classList.add('goal');
  if (!target) {
    body.append(h('div', { class: 'goal-empty' }, h('span', { class: 'muted' }, 'Set a net-worth goal to track progress and see when you will reach it.'),
      h('button', { class: 'btn secondary sm', onclick: () => actions.settings() }, 'Set a goal')));
    return;
  }
  const now = L.totalAt(L.today) ?? 0;
  const progress = Math.min(1, now / target);
  // Average monthly growth over the last 6 month-ends (linear fit).
  const pts = [];
  for (let i = 6; i >= 0; i--) {
    const d = i === 0 ? L.today : C.monthEndDay(C.addMonths(C.monthOf(L.todayISO), -i));
    const v = L.totalAt(d);
    if (v != null) pts.push([6 - i, v]);
  }
  let slope = null;
  if (pts.length >= 3) {
    const n = pts.length, mx = sum(pts.map((p) => p[0])) / n, my = sum(pts.map((p) => p[1])) / n;
    slope = sum(pts.map((p) => (p[0] - mx) * (p[1] - my))) / sum(pts.map((p) => (p[0] - mx) ** 2));
  }
  const by = L.settings.goal.by;
  let projection = 'Needs a few months of history to project.', tone = 'neutral', badge = null;
  if (now >= target) { projection = 'Goal reached — time to set a bigger one.'; tone = 'good'; badge = 'Reached'; }
  else if (slope != null && slope > 0) {
    const months = Math.ceil((target - now) / slope);
    const eta = C.addMonths(C.monthOf(L.todayISO), months);
    projection = h('span', {}, `At your 6-month pace (`, h('span', { class: 'money' }, `${moneyShort(slope, { sign: true })}/mo`), `) you will get there around ${C.monthLabelLong(eta)}`);
    if (by) {
      const late = eta > C.monthOf(by);
      tone = late ? 'bad' : 'good';
      badge = late ? 'Behind' : 'On track';
      if (late) {
        const monthsLeft = Math.max(1, C.monthsBetween(C.monthOf(L.todayISO), C.monthOf(by)).length - 1);
        projection.append(h('span', {}, ` — you need `, h('span', { class: 'money' }, `${M((target - now) / monthsLeft)}/mo`), ` to hit it by ${C.dayLabel(C.toDay(by), true)}.`));
      } else projection.append('.');
    }
  } else if (slope != null) { projection = 'Net worth has not grown over the last 6 months.'; tone = 'bad'; badge = 'Behind'; }

  body.append(
    h('div', { class: 'goal-head' },
      h('div', { class: 'goal-figures' },
        h('span', { class: 'goal-now money' }, M(now)),
        h('span', { class: 'muted' }, ' of '),
        h('span', { class: 'money' }, M(target)),
        by ? h('span', { class: 'muted' }, ` by ${C.dayLabel(C.toDay(by), true)}`) : null),
      h('div', { class: 'goal-right' },
        badge ? h('span', { class: `badge ${tone}` }, h('span', { class: 'badge-icon', html: icon(tone === 'good' ? 'check' : 'warn') }), badge) : null,
        h('span', { class: 'goal-pct' }, `${(progress * 100).toFixed(1)}%`))),
    h('div', { class: 'meter big', role: 'meter', 'aria-valuenow': Math.round(progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Goal progress' },
      h('div', { class: `meter-fill ${tone}`, style: { width: `${progress * 100}%` } })),
    h('div', { class: 'goal-proj muted' }, projection));
}
