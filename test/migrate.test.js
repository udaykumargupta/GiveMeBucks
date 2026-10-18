// §8.5 migration vectors and the parity check against the old engine, whose numbers were
// frozen in test/fixtures by an uncommitted step-0 script before the old engine was retired.
// Monthly rules are not part of v2, so the vectors' rule assertions are dropped; the
// estimated SIP installments are still emitted as plain moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrate, validateDoc, emptyDoc, isV1Shaped } from '../public/js/model.js';
import { Ledger } from '../public/js/ledger.js';
import { toDay, fromDay, monthStartDay, monthEndDay } from '../public/js/dates.js';
import { r2 } from './core-fixtures.js';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const MG = fixture('v1-mg.json');
const OLD = fixture('v1-mg-expected.json');
const NOW = '2026-10-18T05:00:00.000Z';
const near = (actual, expected, what = '') => assert.ok(Math.abs(actual - expected) <= 0.01, `${what}: ${actual} ≠ ${expected}`);

function run(v1, today) {
  const v2 = migrate(v1, today, NOW);
  const v = validateDoc(v2, { today });
  assert.ok(v.ok, `migrated doc must validate: ${v.error}`);
  return { v2, L: new Ledger(v2, today), report: v2.legacyV1 && v2.legacyV1.report };
}
const monthSpent = (L, k) => r2(L.spentIn(fromDay(monthStartDay(k)), fromDay(monthEndDay(k))));
const weekSpent = (L, monday) => r2(L.spentIn(monday, fromDay(toDay(monday) + 6)));
const row = (e) => [e.seq, e.date.slice(5), e.id, e.kind, e.kind === 'move' ? `${e.fromId}→${e.toId}` : e.placeId, e.amount, e.baseline ? 'B' : ''];
const ZERO_REPORT = {
  droppedIncomeBeforeTracking: 0, droppedFutureDated: 0, droppedAfterClose: 0, droppedInvalid: 0, replacedSameDay: 0,
  estimatedFdValues: 0, futureFds: [], sampleRemoved: null,
};
const bank = (id, name = id, extra = {}) => ({ id, name, kind: 'bank', ...extra });
const snap = (id, accountId, date, value, invested) => ({ id, accountId, date, value, ...(invested != null ? { invested } : {}) });
const v1doc = (accounts, snapshots, income = []) => ({ accounts, snapshots, income, settings: {}, meta: {} });

test('MG1 · fixture M1', () => {
  const { v2, L, report } = run(MG.M1.doc, MG.M1.today);
  assert.equal(v2.rev, 0);
  assert.deepEqual(v2.places, [
    { id: 'hdfc', name: 'HDFC Savings', type: 'bank', note: 'HDFC Bank', createdOn: '2026-08-02' },
    { id: 'sbi', name: 'SBI', type: 'bank', createdOn: '2026-08-02' },
    { id: 'mf', name: 'Mutual funds', type: 'sip', note: 'Groww', createdOn: '2026-08-02' },
    { id: 'fd', name: 'HDFC FD', type: 'fd', note: '7.2% · 15 Sep 2026 → 15 Sep 2027', createdOn: '2026-09-15' },
    { id: 'epf', name: 'EPF', type: 'retirement', note: 'EPF', createdOn: '2026-08-02' },
  ]);
  assert.deepEqual(v2.entries.map(row), [
    [1, '08-02', 's-s1', 'set', 'hdfc', 200000, 'B'],
    [2, '08-02', 's-s2', 'set', 'sbi', 50000, 'B'],
    [3, '08-02', 's-s3', 'set', 'mf', 100000, 'B'],
    [4, '08-02', 's-s4', 'set', 'epf', 300000, 'B'],
    [5, '08-10', 'mig-sip-mf-2026-08', 'move', 'hdfc→mf', 10000, ''],
    [6, '08-31', 'i-i2', 'add', 'hdfc', 120000, ''],
    [7, '09-06', 's-s5', 'set', 'hdfc', 150000, ''],
    [8, '09-06', 's-s6', 'set', 'sbi', 45000, ''],
    [9, '09-06', 's-s7', 'set', 'mf', 112000, ''],
    [10, '09-10', 'mig-sip-mf-2026-09', 'move', 'hdfc→mf', 10000, ''],
    [11, '09-15', 'fo-fd', 'move', 'hdfc→fd', 100000, ''],
    [12, '09-30', 'i-i3', 'add', 'hdfc', 120000, ''],
    [13, '09-30', 'fv-fd-2026-09', 'set', 'fd', 100293.69, ''],
    [14, '10-04', 's-s8', 'set', 'hdfc', 160000, ''],
    [15, '10-04', 's-s9', 'set', 'sbi', 40000, ''],
    [16, '10-04', 's-s10', 'set', 'epf', 310000, ''],
    [17, '10-10', 'mig-sip-mf-2026-10', 'move', 'hdfc→mf', 10000, ''],
    [18, '10-18', 'fv-fd-end', 'set', 'fd', 100647.26, ''],
  ]);
  assert.equal(v2.entries.find((e) => e.id === 'i-i2').note, 'Salary');
  assert.equal(v2.entries.find((e) => e.id === 'i-i3').note, 'Salary · Sept pay');
  assert.equal(v2.entries.find((e) => e.id === 'mig-sip-mf-2026-08').note, 'Monthly');
  assert.equal(v2.entries.find((e) => e.id === 'fv-fd-end').note, 'Estimated from FD rate');
  assert.ok(v2.entries.every((e) => !('ruleId' in e)));
  assert.equal(v2.recurring, undefined);
  assert.deepEqual(report, { ...ZERO_REPORT, places: 5, entries: 18, droppedIncomeBeforeTracking: 1, estimatedFdValues: 2 });

  // Spending: old engine = v2.
  near(L.spentIn('2026-08-03', '2026-09-06'), 165000, '08-03…09-06');
  near(L.spentIn('2026-09-07', '2026-10-04'), 5000, '09-07…10-04');
  assert.deepEqual(OLD.M1.intervals.map((i) => i.amount), [165000, 5000]);
  for (const [k, old] of Object.entries(OLD.M1.months)) near(monthSpent(L, k), old, k);
  assert.deepEqual(['2026-08', '2026-09', '2026-10'].map((k) => monthSpent(L, k)), [136714.29, 32571.43, 714.29]);
  assert.equal(L.period('month', '2026-08').status, 'complete');
  assert.equal(L.period('month', '2026-09').status, 'complete');
  for (const [w, old] of Object.entries(OLD.M1.weeks)) near(weekSpent(L, w), old, `week ${w}`);
  assert.deepEqual(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'].map((w) => weekSpent(L, w)), [33000, 33000, 33000, 33000, 33000]);
  assert.deepEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'].map((w) => weekSpent(L, w)), [1250, 1250, 1250, 1250, 0, 0]);

  // Net worth; only FD accrual between month ends differs from the old engine.
  assert.deepEqual(['2026-08-02', '2026-09-06', '2026-09-30'].map((d) => L.netWorthAt(d)), [650000, 607000, 727293.69]);
  assert.equal(L.netWorthAt('2026-10-18'), 732647.26);
  near(OLD.M1.nw['2026-10-18'], 742647.26, 'old engine (counts the ₹10,000 SIP twice)');

  const growth = (k) => r2(L.growthIn(fromDay(monthStartDay(k)), fromDay(monthEndDay(k))));
  assert.deepEqual(['2026-08', '2026-09', '2026-10'].map(growth), [-10453.97, 92827.02, 274.2]);
  assert.equal(L.completeThrough(), '2026-10-04');
  assert.deepEqual(L.lagging(), ['hdfc', 'sbi']);
});

test('MG2 · fixture M2: closed bank and closed fund', () => {
  const { v2, L } = run(MG.M2.doc, MG.M2.today);
  assert.deepEqual(v2.entries.map(row), [
    [1, '09-01', 's-a1', 'set', 'hdfc', 100000, 'B'],
    [2, '09-01', 's-b1', 'set', 'sbi', 30000, 'B'],
    [3, '09-01', 's-c1', 'set', 'mf', 50000, 'B'],
    [4, '09-15', 's-a2', 'set', 'hdfc', 95000, ''],
    [5, '09-15', 's-b2', 'set', 'sbi', 28000, ''],
    [6, '09-15', 's-c2', 'set', 'mf', 52000, ''],
    [7, '09-20', 'c-sbi', 'set', 'sbi', 28000, ''],
    [8, '09-20', 'cm-sbi', 'move', 'sbi→hdfc', 28000, ''],
    [9, '09-25', 'c-mf', 'set', 'mf', 52000, ''],
    [10, '09-25', 'cm-mf', 'move', 'mf→hdfc', 52000, ''],
    [11, '09-30', 's-a3', 'set', 'hdfc', 160000, ''],
  ]);
  assert.deepEqual(v2.places.map((p) => [p.id, p.closedOn ?? null]), [['hdfc', null], ['sbi', '2026-09-20'], ['mf', '2026-09-25']]);
  near(L.spentIn('2026-09-02', '2026-09-15'), 7000, 'first interval');
  near(L.spentIn('2026-09-16', '2026-09-30'), 15000, 'second interval');
  assert.equal(monthSpent(L, '2026-09'), 22000);
  near(OLD.M2.months['2026-09'], 22000, 'old engine');
  assert.equal(L.period('month', '2026-09').status, 'complete');
  for (const [w, old] of Object.entries(OLD.M2.weeks)) near(weekSpent(L, w), old, `week ${w}`);
  assert.deepEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map((w) => weekSpent(L, w)), [2500, 3500, 6000, 7000, 3000]);
  // v2 keeps the closed accounts' money in HDFC (the old engine dropped it: 147000, 95000).
  assert.deepEqual(['2026-09-20', '2026-09-25', '2026-09-30'].map((d) => L.netWorthAt(d)), [175000, 175000, 160000]);
  assert.deepEqual([OLD.M2.nw['2026-09-20'], OLD.M2.nw['2026-09-25']], [147000, 95000]);
});

test('MG3 · sample parity with the frozen old engine', () => {
  const v1 = fixture('v1-sample.json');
  const exp = fixture('v1-sample-expected.json');
  const { v2, L, report } = run(v1, exp.today);

  const months = Object.entries(exp.months);
  assert.equal(months.length, 26);
  for (const [k, old] of months) near(monthSpent(L, k), old, `month ${k}`);
  near(months.reduce((s, [k]) => s + L.spentIn(fromDay(monthStartDay(k)), fromDay(monthEndDay(k))), 0), 1816391, 'total');
  const weeks = Object.entries(exp.weeks);
  assert.equal(weeks.length, 110);
  for (const [w, old] of weeks) near(weekSpent(L, w), old, `week ${w}`);

  assert.equal(exp.snapshotValues.length, 291);
  for (const s of exp.snapshotValues) assert.equal(L.valueAt(s.accountId, s.date), r2(s.value), `${s.accountId} ${s.date}`);
  assert.equal(exp.fdValues.length, 35);
  for (const f of exp.fdValues) near(L.valueAt(f.accountId, f.date), f.value, `${f.accountId} ${f.date}`);
  assert.equal(L.netWorth(), 3225645.99);
  near(L.netWorth(), exp.totalAtToday, 'net worth today');

  assert.equal(v2.places.length, 8);
  assert.equal(v2.entries.length, 397);
  const kinds = {};
  for (const e of v2.entries) { const k = e.kind + (e.baseline ? 'B' : ''); kinds[k] = (kinds[k] || 0) + 1; }
  assert.deepEqual(kinds, { setB: 7, set: 320, add: 43, move: 27 });
  assert.equal(report.estimatedFdValues, 36);
  assert.equal(report.droppedIncomeBeforeTracking, 1);
  assert.equal(v2.places.find((p) => p.id === 'mf').type, 'sip');
  assert.equal(v2.places.find((p) => p.id === 'epf').type, 'retirement');

  const fd1 = v2.entries.filter((e) => e.placeId === 'fd1' || e.fromId === 'fd1' || e.toId === 'fd1');
  assert.equal(fd1.length, 27);
  assert.deepEqual([fd1[0].id, fd1[0].kind, fd1[0].baseline, fd1[0].amount, fd1[0].date], ['fs-fd1', 'set', true, 211869.15, '2024-09-01']);
  const fd2 = v2.entries.filter((e) => e.placeId === 'fd2' || e.fromId === 'fd2' || e.toId === 'fd2');
  assert.equal(fd2.length, 10);
  assert.deepEqual([fd2[0].id, fd2[0].kind, fd2[0].fromId, fd2[0].amount, fd2[0].date], ['fo-fd2', 'move', 'hdfc', 150000, '2026-02-19']);

  const first = L.trend()[0];
  assert.deepEqual([first.date, first.nw], ['2024-09-01', 1271817.15]);
  near(first.nw, exp.totalAtFirst, 'trend start = old totalAt');
});

test('MG4 · the owner-shaped single-bank doc', () => {
  // Same shape and ids as the owner's real data/db.json (spec §2.5); data/ itself is never read by tests.
  const v1 = {
    rev: 7, savedAt: '2026-10-17T10:00:00.000Z',
    accounts: [{ id: 'a559a649aa0d', name: 'SBI', kind: 'bank' }],
    snapshots: [{ id: 'c026fa46b6b7', accountId: 'a559a649aa0d', date: '2026-10-17', value: 10000 }],
    income: [], settings: {}, meta: {},
  };
  const { v2, L } = run(v1, '2026-10-18');
  assert.deepEqual(v2, {
    version: 2, rev: 0,
    places: [{ id: 'a559a649aa0d', name: 'SBI', type: 'bank', createdOn: '2026-10-17' }],
    entries: [{ id: 's-c026fa46b6b7', kind: 'set', placeId: 'a559a649aa0d', date: '2026-10-17', amount: 10000, seq: 1, baseline: true }],
    legacyV1: {
      migratedAt: NOW,
      report: { ...ZERO_REPORT, places: 1, entries: 1 },
      doc: { accounts: v1.accounts, snapshots: v1.snapshots, income: [], settings: {}, meta: {} },
    },
  });
  assert.equal(L.netWorth(), 10000);
});

test('MG5 · short cuts and archive', () => {
  const sample = { ...fixture('v1-sample.json'), meta: { sample: true } };
  const { v2: s } = run(sample, '2026-10-17');
  assert.deepEqual([s.places, s.entries], [[], []]);
  assert.deepEqual(s.legacyV1.report.sampleRemoved, { accounts: 8, snapshots: 291, income: 44 });

  const mixed = { ...sample, accounts: [...sample.accounts, bank('mybank', 'My bank')], snapshots: [...sample.snapshots, snap('x1', 'mybank', '2026-10-17', 10000)] };
  const { v2: m, L } = run(mixed, '2026-10-17');
  assert.deepEqual(m.places.map((p) => p.id), ['mybank']);
  assert.deepEqual(m.entries.map(row), [[1, '10-17', 's-x1', 'set', 'mybank', 10000, 'B']]);
  assert.equal(L.netWorth(), 10000);
  assert.deepEqual(m.legacyV1.report.sampleRemoved, { accounts: 8, snapshots: 291, income: 44 });

  assert.deepEqual(migrate(v1doc([], []), '2026-10-18', NOW), emptyDoc());
  const goal = migrate({ ...v1doc([], []), settings: { goal: { target: 5000000 } } }, '2026-10-18', NOW);
  assert.deepEqual({ ...goal, legacyV1: undefined }, { ...emptyDoc(), legacyV1: undefined });
  assert.deepEqual(goal.legacyV1.doc.settings, { goal: { target: 5000000 } });

  const v2in = { version: 2, rev: 3, places: [], entries: [] };
  assert.equal(migrate(v2in, '2026-10-18', NOW), v2in);

  const input = { ...MG.M1.doc, savedAt: 'x' };
  const before = structuredClone(input);
  const out = migrate(input, MG.M1.today, NOW);
  assert.deepEqual(input, before, 'the input is never modified');
  const { rev, savedAt, ...rest } = input;
  assert.deepEqual(out.legacyV1.doc, rest);
  assert.deepEqual(migrate(input, MG.M1.today, NOW), out);
  assert.equal(migrate(out, MG.M1.today, NOW), out);
  assert.equal(isV1Shaped(out), false);
});

test('MG6 · edge cases', () => {
  const v1 = v1doc(
    [{ id: 'a b', name: '  Joint  ', kind: 'bank' }, { id: 'x', name: '', kind: 'bank' }, { id: 'w', name: 'Weird', kind: 'weird' }],
    [snap('s1', 'a b', '2026-10-01', 5000), snap('s2', 'a b', '2026-10-10', 4000), snap('s3', 'x', '2026-10-02', 100), snap('s4', 'x', '2026-10-25', 1)],
  );
  const { v2, report } = run(v1, '2026-10-18');
  assert.deepEqual(v2.places, [
    { id: 'mig-p1', name: 'Joint', type: 'bank', createdOn: '2026-10-01' },
    { id: 'x', name: 'Place', type: 'bank', createdOn: '2026-10-02' },
    { id: 'w', name: 'Weird', type: 'other', createdOn: '2026-10-18' },
  ]);
  assert.deepEqual(v2.entries.filter((e) => e.placeId === 'mig-p1').map((e) => e.id), ['s-s1', 's-s2']);
  assert.equal(report.droppedFutureDated, 1);
  assert.equal(v2.entries.some((e) => e.placeId === 'w'), false);
});

test('MG7 · income tagged to a not-yet-tracked bank', () => {
  const { v2, L, report } = run(MG.MG7.doc, MG.MG7.today);
  assert.equal(report.droppedIncomeBeforeTracking, 1);
  assert.equal(v2.entries.some((e) => e.id === 'i-i1'), false);
  assert.equal(monthSpent(L, '2026-08'), 9677.42);
  assert.equal(monthSpent(L, '2026-09'), 322.58);
  assert.equal(r2(L.spentIn('2026-08-02', '2026-09-01')), 10000);
  assert.equal(r2(OLD.MG7.intervals.reduce((s, i) => s + i.amount, 0)), 40000);
});

test('MG8 · carried-forward invested makes no adjustment move', () => {
  const { v2, L } = run(MG.MG8.doc, MG.MG8.today);
  assert.deepEqual(v2.entries.map((e) => e.id), ['s-h1', 's-m1', 'mig-sip-mf-2026-08', 's-h2', 's-m2']);
  assert.equal(r2(L.spentIn('2026-08-02', '2026-09-01')), 40000);
  assert.equal(monthSpent(L, '2026-08'), 38709.68);
  assert.equal(monthSpent(L, '2026-09'), 1290.32);
  assert.equal(OLD.MG8.intervals[0].amount, 50000);
});

test('MG9 · FD started before tracking', () => {
  const { v2, L } = run(MG.MG9.doc, MG.MG9.today);
  const fd = v2.entries.filter((e) => e.placeId === 'fd').map((e) => [e.id, e.date, e.amount, !!e.baseline]);
  assert.deepEqual(fd, [['fs-fd', '2026-09-01', 243891.47, true], ['fv-fd-2026-09', '2026-09-30', 245259.03, false], ['fv-fd-end', '2026-10-17', 246064.27, false]]);
  assert.equal(v2.places.find((p) => p.id === 'fd').createdOn, '2026-09-01');
  assert.deepEqual([L.trend()[0].date, L.trend()[0].nw], ['2026-09-01', 343891.47]);
  near(L.trend()[0].nw, OLD.MG9.nw['2026-09-01'], 'old engine');
});

test('MG10 · future FD', () => {
  const v1 = v1doc([bank('hdfc'), { id: 'fd', name: 'HDFC FD', kind: 'fd', fd: { principal: 100000, rate: 7, startDate: '2026-12-01', maturityDate: '2027-12-01' } }],
    [snap('h1', 'hdfc', '2026-10-01', 50000)]);
  const { v2, report } = run(v1, '2026-10-18');
  assert.equal(v2.places.find((p) => p.id === 'fd').createdOn, '2026-10-18');
  assert.equal(v2.entries.some((e) => e.placeId === 'fd' || e.toId === 'fd'), false);
  assert.deepEqual(report.futureFds, ['HDFC FD']);
});

test('MG11 · staggered bank updates: months match, weeks spread per place', () => {
  const a = run(MG.MG11a.doc, MG.MG11a.today).L;
  assert.equal(monthSpent(a, '2026-08'), 42000);
  near(OLD.MG11a.months['2026-08'], 42000, 'old Aug');
  const aw = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
  assert.deepEqual(aw.map((w) => weekSpent(a, w)), [9000, 10500, 10500, 10500, 1500]);
  assert.deepEqual(aw.map((w) => OLD.MG11a.weeks[w]), [3000, 3500, 15500, 17500, 2500]);

  const b = run(MG.MG11b.doc, MG.MG11b.today).L;
  assert.equal(monthSpent(b, '2026-10'), 40000);
  near(OLD.MG11b.months['2026-10'], 40000, 'old Oct');
  const bw = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  assert.deepEqual(bw.map((w) => weekSpent(b, w)), [4333.33, 9952.38, 9000, 9000, 7714.29]);
  assert.deepEqual(bw.map((w) => r2(OLD.MG11b.weeks[w])), [3333.33, 8095.24, 10000, 10000, 8571.43]);
});

const mg12 = () => v1doc(
  [bank('hdfc', 'HDFC', { closedOn: '2026-10-01' }), bank('sbi', 'SBI'), { id: 'mf', name: 'MF', kind: 'mutual_fund', sip: { amount: 5000, day: 15 } }],
  [
    snap('h1', 'hdfc', '2026-08-01', 100000), snap('h2', 'hdfc', '2026-09-01', 90000), snap('h3', 'hdfc', '2026-09-15', 80000),
    snap('b1', 'sbi', '2026-08-05', 20000), snap('b2', 'sbi', '2026-10-05', 95000), snap('m1', 'mf', '2026-08-01', 50000, 50000),
  ],
);

test('MG12 · closed primary bank', () => {
  const { v2 } = run(mg12(), '2026-10-18');
  const by = (id) => v2.entries.find((e) => e.id === id);
  assert.deepEqual([by('c-hdfc').kind, by('c-hdfc').amount, by('c-hdfc').date], ['set', 80000, '2026-10-01']);
  assert.deepEqual([by('cm-hdfc').fromId, by('cm-hdfc').toId, by('cm-hdfc').amount, by('cm-hdfc').date], ['hdfc', 'sbi', 80000, '2026-10-01']);
  assert.deepEqual([by('mig-sip-mf-2026-10').fromId, by('mig-sip-mf-2026-10').date], ['sbi', '2026-10-15']);
  assert.equal(by('mig-sip-mf-2026-09').fromId, 'hdfc');
});

test('MG13 · an invalid entry is dropped', () => {
  const v1 = mg12();
  v1.accounts.push({ id: 'loan', name: 'Car loan', kind: 'other' });
  v1.snapshots.push(snap('l1', 'loan', '2026-08-01', -300000));
  const { v2, report } = run(v1, '2026-10-18');
  assert.equal(report.droppedInvalid, 1);
  assert.deepEqual(v2.places.find((p) => p.id === 'loan'), { id: 'loan', name: 'Car loan', type: 'other', createdOn: '2026-10-18' });
  assert.equal(v2.entries.some((e) => e.placeId === 'loan'), false);
});
