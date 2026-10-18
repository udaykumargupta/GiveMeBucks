// §8.2 ledger vectors (prompt helpers suggestPlace / missingAdd / riseDefault /
// alreadyDropped / impact / ripple are not built, so only their money numbers are pinned).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../public/js/ledger.js';
import { validateDoc } from '../public/js/model.js';
import { toDay, fromDay, weekStartDay, fyStartYear, fyLabel, occurrenceDay, monthEndDay } from '../public/js/dates.js';
import {
  place, set, setB, add, move, doc, edit, editPlaceIn, withEntries, r2,
  fixtureA, fixtureB, fixtureH, TODAY_A, TODAY_B, TODAY_H,
} from './core-fixtures.js';

const near = (actual, expected, what = '') => assert.ok(Math.abs(actual - expected) <= 0.01, `${what}: ${actual} ≠ ${expected}`);
const month = (L, k) => r2(L.period('month', k).spent);
const growth = (L, k) => r2(L.period('month', k).growth);
const week = (L, monday) => r2(L.period('week', monday).spent);
const fy = (L, y) => r2(L.period('fy', y).spent);
const weeks = (L, from, n) => Array.from({ length: n }, (_, i) => week(L, fromDay(toDay(from) + 7 * i)));
const nearAll = (actual, expected, what) => expected.forEach((x, i) => near(actual[i], x, `${what}[${i}]`));
const ledger = (d, today) => {
  const v = validateDoc(d, { today });
  assert.ok(v.ok, `fixture invalid: ${v.error}`);
  return new Ledger(d, today);
};

test('L1 · A: spending, net worth, growth, statuses, trend', () => {
  const L = ledger(fixtureA(), TODAY_A);
  assert.equal(month(L, '2026-10'), 60000);
  assert.deepEqual(weeks(L, '2026-09-28', 6), [6000, 14000, 14000, 14000, 12000, 0]);
  assert.equal(fy(L, 2026), 60000);
  assert.deepEqual(['2026-10-01', '2026-10-03', '2026-10-09', '2026-10-31'].map((d) => L.netWorthAt(d)), [50000, 170000, 170000, 110000]);
  assert.equal(growth(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-11'), 0);

  const oct = L.period('month', '2026-10');
  assert.equal(oct.status, 'complete');
  assert.equal(oct.firstTracked, true);
  const nov = L.period('month', '2026-11');
  assert.equal(nov.status, 'current');
  assert.equal(nov.anyKnown, false);
  assert.equal(L.period('month', '2026-09').status, 'untracked');
  const w0 = L.period('week', '2026-09-28');
  assert.equal(w0.status, 'complete');
  assert.equal(w0.firstTracked, true);
  const wNow = L.period('week', '2026-11-02');
  assert.equal(wNow.status, 'current');
  assert.equal(wNow.anyKnown, false);

  assert.equal(L.valueAt('sip', '2026-10-09'), null);
  assert.equal(L.valueAt('sip', '2026-10-10'), 15000);
  assert.equal(L.completeThrough(), '2026-10-31');
  assert.deepEqual(L.lagging(), []);
  assert.deepEqual(L.trend().map((p) => [p.date, p.nw]), [
    ['2026-10-01', 50000], ['2026-10-03', 170000], ['2026-10-10', 170000], ['2026-10-31', 110000], ['2026-11-05', 110000],
  ]);
  assert.equal(L.trend()[0].baseline, 50000);
  assert.equal(L.trend()[0].starting, 50000);
});

test('L2 · B: two spendable places plus investments', () => {
  const L = ledger(fixtureB(), TODAY_B);
  assert.equal(month(L, '2026-10'), 61000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'hdfc')), 54000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'cash')), 7000);
  nearAll(weeks(L, '2026-09-28', 5), [6900, 16100, 14600, 12600, 10800], 'weeks');
  assert.equal(L.netWorthAt('2026-10-31'), 309400);
  assert.equal(r2(L.baselineIn('2026-10-01', '2026-10-31')), 254000);
  assert.equal(r2(L.growthIn('2026-10-01', '2026-10-31')), 55400);
  assert.equal(r2(L.addsIn('2026-10-01', '2026-10-31')), 120000);
  assert.equal(r2(L.investIn('2026-10-01', '2026-10-31')), -3600);
  assert.equal(L.setInfo('s1').adj, 400);
  assert.equal(L.setInfo('f2').adj, -4000);
  assert.equal(L.completeThrough(), '2026-10-15');
  assert.deepEqual(L.lagging(), ['cash']);
  const oct = L.period('month', '2026-10');
  assert.equal(oct.status, 'current');
  assert.equal(oct.completeSoFar, false);
  assert.deepEqual(L.trend().map((p) => [p.date, p.nw]), [
    ['2026-10-01', 254000], ['2026-10-03', 374000], ['2026-10-10', 374000], ['2026-10-12', 374000], ['2026-10-15', 367000], ['2026-10-31', 309400],
  ]);
  assert.deepEqual(L.history().map((r) => r.change), [-57600, -7000, 0, 0, 120000, 254000]);
  assert.equal(L.history().at(-1).baseline, 254000);
});

// Every (doc, today) used in this file that has months worth checking, for L3(a).
const IDENTITY_CASES = [];
const remember = (d, today) => { IDENTITY_CASES.push([d, today]); return ledger(d, today); };

test('L3 · growth identity', () => {
  remember(fixtureA(), TODAY_A);
  remember(fixtureB(), TODAY_B);
  remember(edit(fixtureA(), 'e4', { date: '2026-11-04', amount: 87000 }), TODAY_A);
  remember(withEntries(fixtureA(), set('e5', 'hdfc', '2026-10-15', 40000, 5)), TODAY_A);
  for (const [d, today] of IDENTITY_CASES) {
    const L = new Ledger(d, today);
    for (const k of ['2026-09', '2026-10', '2026-11']) {
      const p = L.period('month', k);
      near(p.growth, p.adds - p.spent + p.invest, `growth identity ${k}`);
    }
  }
  const B = new Ledger(fixtureB(), TODAY_B);
  assert.equal(r2(B.growthIn('2026-10-01', '2026-10-31')), r2(B.netWorthAt('2026-10-31') - B.netWorthAt('2026-09-30') - B.baselineIn('2026-10-01', '2026-10-31')));
  assert.equal(B.netWorthAt('2026-09-30'), 0);
  const L18 = new Ledger(edit(fixtureA(), 'e4', { date: '2026-11-04', amount: 87000 }), TODAY_A);
  assert.equal(r2(L18.growthIn('2026-10-01', '2026-11-04')), 52000);
  assert.equal(L18.netWorthAt('2026-11-04') - L18.netWorthAt('2026-09-30') - L18.baselineIn('2026-10-01', '2026-11-04'), 52000);
});

test('L4 · C: unexpected rise, three ways', () => {
  const base = doc([place('sbi', 'bank', '2026-10-01')], [setB('s1', 'sbi', '2026-10-01', 20000, 1)]);
  const a = ledger(withEntries(base, set('s2', 'sbi', '2026-10-31', 140000, 2)), '2026-10-31');
  assert.equal(month(a, '2026-10'), -120000);
  assert.equal(growth(a, '2026-10'), 120000);
  const b = ledger(withEntries(base, add('a1', 'sbi', '2026-10-31', 130000, 2, 'Salary'), set('s2', 'sbi', '2026-10-31', 140000, 3)), '2026-10-31');
  assert.equal(month(b, '2026-10'), 10000);
  assert.equal(growth(b, '2026-10'), 120000);
  const c = ledger(withEntries(base, setB('s2', 'sbi', '2026-10-31', 140000, 2)), '2026-10-31');
  assert.equal(month(c, '2026-10'), 0);
  assert.equal(growth(c, '2026-10'), 0);
  assert.equal(c.setInfo('s2').correction, true);
});

test('L5 · D: same day', () => {
  const d = edit(fixtureA(), 'e2', { date: '2026-10-01' });
  const L = ledger(d, TODAY_A);
  assert.equal(L.netWorthAt('2026-10-01'), 170000);
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-10'), 60000);
  const yes = ledger(withEntries(d, add('i1', 'hdfc', '2026-10-31', 5000, 2)), TODAY_A);
  assert.equal(month(yes, '2026-10'), 65000);
  assert.equal(yes.current('hdfc'), 95000);
  assert.equal(growth(yes, '2026-10'), 60000);
  const no = ledger(withEntries(d, add('i1', 'hdfc', '2026-10-31', 5000, 5)), TODAY_A);
  assert.equal(month(no, '2026-10'), 60000);
  assert.equal(no.current('hdfc'), 100000);
  assert.equal(growth(no, '2026-10'), 65000);
});

test('L6 · E: edits on A', () => {
  const del = ledger(edit(fixtureA(), 'e2', null), TODAY_A);
  assert.equal(month(del, '2026-10'), -60000);
  assert.equal(growth(del, '2026-10'), 60000);
  const up = ledger(edit(fixtureA(), 'e4', { amount: 100000 }), TODAY_A);
  assert.equal(month(up, '2026-10'), 55000);
  assert.equal(growth(up, '2026-10'), 65000);
  const noSip = fixtureA();
  noSip.places = noSip.places.filter((p) => p.id !== 'sip');
  noSip.entries = noSip.entries.filter((e) => e.id !== 'r1-2026-10');
  const L = ledger(noSip, TODAY_A);
  assert.equal(month(L, '2026-10'), 75000);
  assert.equal(growth(L, '2026-10'), 45000);
  assert.equal(L.netWorth(), 95000);
});

test('L7 · F: close Cash into HDFC', () => {
  let d = editPlaceIn(fixtureB(), 'cash', { closedOn: '2026-10-20' });
  d = withEntries(edit(d, 'e4', { amount: 98000 }), set('cx', 'cash', '2026-10-20', 3000, 11), move('cm', 'cash', 'hdfc', '2026-10-20', 3000, 12));
  const L = ledger(d, TODAY_B);
  assert.equal(month(L, '2026-10'), 61000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'hdfc')), 54000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'cash')), 7000);
  assert.equal(L.valueAt('cash', '2026-10-25'), 0);
  assert.equal(L.completeThrough(), '2026-10-31');
  assert.deepEqual(L.lagging(), []);
  assert.equal(L.netWorthAt('2026-10-31'), 309400);
  assert.equal(growth(L, '2026-10'), 55400);
  assert.equal(L.isOpen('cash'), false);
  assert.deepEqual(L.groups()[0].places.map((p) => p.id), ['hdfc']);
  assert.deepEqual(L.closedPlaces().map((p) => p.id), ['cash']);
});

test('L8 · G (rules expressed as plain moves)', () => {
  const d = withEntries(fixtureA(),
    add('n1', 'hdfc', '2026-11-03', 120000, 5, 'Salary'),
    move('m-2026-11', 'hdfc', 'sip', '2026-11-05', 10000, 6),
    set('n2', 'hdfc', '2026-11-30', 150000, 7));
  const L = ledger(d, '2026-12-07');
  assert.equal(month(L, '2026-11'), 55000);
  assert.equal(growth(L, '2026-11'), 65000);
  assert.equal(L.current('sip'), 25000);
  assert.equal(L.current('hdfc'), 150000);
  assert.equal(L.netWorth(), 175000);
  const L2 = ledger(withEntries(d, move('m-2026-12', 'hdfc', 'sip', '2026-12-05', 10000, 8)), '2026-12-07');
  assert.equal(L2.current('sip'), 35000);
  assert.equal(L2.current('hdfc'), 140000);
  assert.equal(L2.netWorth(), 175000);
  const dec = L2.period('month', '2026-12');
  assert.equal(r2(dec.spent), 0);
  assert.equal(dec.anyKnown, false);
});

test('L9 · H: two banks, unrecorded transfer', () => {
  const a = ledger(withEntries(fixtureH(), set('c', 'hdfc', '2026-10-31', 70000, 3), set('d', 'sbi', '2026-10-31', 50000, 4)), TODAY_H);
  assert.equal(month(a, '2026-10'), 0);
  assert.equal(r2(a.spentIn('2026-10-01', '2026-10-31', 'hdfc')), 30000);
  assert.equal(r2(a.spentIn('2026-10-01', '2026-10-31', 'sbi')), -30000);
  assert.equal(growth(a, '2026-10'), 0);

  const b = ledger(withEntries(fixtureH(), move('m', 'hdfc', 'sbi', '2026-10-31', 30000, 3), set('c', 'hdfc', '2026-10-31', 70000, 4), set('d', 'sbi', '2026-10-31', 50000, 5)), TODAY_H);
  assert.equal(month(b, '2026-10'), 0);
  assert.equal(r2(b.spentIn('2026-10-01', '2026-10-31', 'hdfc')), 0);
  assert.equal(r2(b.spentIn('2026-10-01', '2026-10-31', 'sbi')), 0);

  const cDoc = withEntries(fixtureH(), set('d', 'sbi', '2026-10-20', 50000, 3));
  const c = ledger(cDoc, '2026-10-20');
  assert.equal(month(c, '2026-10'), -30000);
  assert.equal(c.period('month', '2026-10').status, 'current');
  assert.equal(c.completeThrough(), '2026-10-01');
  assert.deepEqual(c.lagging(), ['hdfc']);

  const dd = ledger(withEntries(edit(cDoc, 'd', { seq: 4 }), move('m', 'hdfc', 'sbi', '2026-10-20', 30000, 3)), '2026-10-20');
  assert.equal(month(dd, '2026-10'), 0);
  assert.equal(dd.current('hdfc'), 70000);
});

test('L10 · I: backfilled starting balance', () => {
  let d = editPlaceIn(fixtureA(), 'hdfc', { createdOn: '2026-09-21' });
  d = withEntries(edit(d, 'e1', { baseline: undefined }), setB('b0', 'hdfc', '2026-09-21', 60000, 5));
  const L = ledger(d, TODAY_A);
  assert.equal(month(L, '2026-09'), 9000);
  assert.equal(month(L, '2026-10'), 61000);
  assert.equal(growth(L, '2026-09'), -9000);
  assert.equal(growth(L, '2026-10'), 59000);
  const sep = L.period('month', '2026-09');
  assert.equal(sep.status, 'complete');
  assert.equal(sep.firstTracked, true);
});

test('L11 · J: FY boundary', () => {
  const d = doc([place('h', 'bank', '2026-03-30')], [setB('j1', 'h', '2026-03-30', 10000, 1), set('j2', 'h', '2026-04-01', 6000, 2)]);
  const L = ledger(d, '2026-04-10');
  assert.equal(fy(L, 2025), 2000);
  assert.equal(fy(L, 2026), 2000);
  assert.equal(L.period('fy', 2026).label, 'FY 26–27');
});

test('L12 · explain(Oct)', () => {
  const A = new Ledger(fixtureA(), TODAY_A);
  const ea = A.explain(A.period('month', '2026-10'));
  const hdfc = ea.places.find((p) => p.placeId === 'hdfc');
  assert.equal(r2(hdfc.spent), 60000);
  const { setId, ...gap } = hdfc.gaps[0];
  assert.equal(setId, 'e4');
  assert.deepEqual(gap, {
    anchorDate: '2026-10-01', setDate: '2026-10-31', start: 50000, added: 120000, movedIn: 0, movedOut: 15000,
    expected: 155000, entered: 95000, spent: 60000, days: 30, daysInPeriod: 30, inPeriod: 60000,
  });
  assert.deepEqual(ea.notCounted, []);
  assert.equal(r2(ea.spent), 60000);

  const B = new Ledger(fixtureB(), TODAY_B);
  const eb = B.explain('2026-10-01', '2026-10-31');
  const h = eb.places.find((p) => p.placeId === 'hdfc').gaps[0];
  assert.deepEqual([h.start, h.added, h.movedIn, h.movedOut, h.expected, h.entered, h.spent, h.days, h.daysInPeriod], [50000, 120000, 0, 21000, 149000, 95000, 54000, 30, 30]);
  const cash = eb.places.find((p) => p.placeId === 'cash');
  const c = cash.gaps[0];
  assert.deepEqual([c.anchorDate, c.start, c.movedIn, c.expected, c.entered, c.spent, c.days, c.daysInPeriod], ['2026-10-01', 4000, 6000, 10000, 3000, 7000, 14, 14]);
  assert.equal(cash.knownThrough, '2026-10-15');
  assert.equal(cash.lagging, true);
  assert.deepEqual(eb.notCounted.map((x) => [x.placeId, x.amount]), [['sip', 400], ['mf', -4000]]);
});

test('L13 · history() on A', () => {
  const L = new Ledger(fixtureA(), TODAY_A);
  const rows = L.history();
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-31', '2026-10-10', '2026-10-03', '2026-10-01']);
  assert.deepEqual(rows.map((r) => r.nw), [110000, 170000, 170000, 50000]);
  assert.deepEqual(rows.map((r) => r.change), [-60000, 0, 120000, 50000]);
  const cap = Object.fromEntries(rows.flatMap((r) => r.entries).map((x) => [x.id, x.caption.text]));
  assert.deepEqual(cap, {
    e4: 'Spent ₹60,000 since 1 Oct',
    'r1-2026-10': 'Moved ₹15,000 to Axis SIP',
    e2: 'Added ₹1,20,000 · Salary',
    e1: 'Starting balance',
  });
});

test('L16 · dates', () => {
  const ws = (iso) => fromDay(weekStartDay(toDay(iso)));
  assert.equal(ws('2026-10-01'), '2026-09-28');
  assert.equal(ws('2028-02-29'), '2028-02-28');
  assert.equal(ws('2027-01-01'), '2026-12-28');
  assert.equal(fyStartYear('2027-01-15'), 2026);
  assert.equal(fyLabel(2026), 'FY 26–27');
  assert.equal(fromDay(occurrenceDay('2026-11', 31)), '2026-11-30');
  assert.equal(fromDay(occurrenceDay('2028-02', 30)), '2028-02-29');
});

test('L17 · value-0 place: first set is a normal rise', () => {
  const base = doc([place('hdfc', 'bank', '2026-10-01'), place('cash', 'cash', '2026-10-01')],
    [setB('h1', 'hdfc', '2026-10-01', 50000, 1), set('h2', 'hdfc', '2026-10-10', 45000, 2), set('c1', 'cash', '2026-10-10', 5000, 3)]);
  const L = ledger(base, TODAY_B);
  const c1 = L.setInfo('c1');
  assert.equal(c1.baseline, false);
  assert.equal(c1.adj, 5000);
  assert.equal(c1.anchorDate, '2026-09-30');
  assert.equal(L.hasStartingBalance('cash'), false);
  assert.equal(month(L, '2026-10'), 0);
  assert.equal(growth(L, '2026-10'), 0);
  assert.equal(L.netWorth(), 50000);
  nearAll(weeks(L, '2026-09-28', 2), [-333.33, 333.33], 'refund weeks');

  const from = ledger(withEntries(base, move('m1', 'hdfc', 'cash', '2026-10-10', 5000, 1)), TODAY_B);
  assert.deepEqual(weeks(from, '2026-09-28', 5), [0, 0, 0, 0, 0]);
  assert.equal(from.setInfo('h2').adj, 0);
  assert.equal(from.setInfo('c1').adj, 0);
  assert.equal(month(from, '2026-10'), 0);
  assert.equal(growth(from, '2026-10'), 0);
});

test('L18 · update after month end', () => {
  const L = ledger(edit(fixtureA(), 'e4', { date: '2026-11-04', amount: 87000 }), TODAY_A);
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(L.period('month', '2026-10').status, 'complete');
  assert.equal(month(L, '2026-11'), 8000);
  assert.equal(L.period('month', '2026-11').status, 'current');
  assert.deepEqual(weeks(L, '2026-09-28', 6), [6000, 14000, 14000, 14000, 14000, 6000]);
  assert.equal(fy(L, 2026), 68000);
  assert.equal(L.netWorthAt('2026-10-31'), 170000);
  assert.equal(L.netWorthAt('2026-11-05'), 102000);
  assert.equal(growth(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-11'), -8000);
});

test('L19 · update on 2 Nov', () => {
  const L = ledger(edit(fixtureA(), 'e4', { date: '2026-11-02', amount: 93000 }), TODAY_A);
  assert.equal(month(L, '2026-10'), 58125);
  assert.equal(month(L, '2026-11'), 3875);
  assert.equal(L.netWorthAt('2026-10-31'), 170000);
  assert.equal(L.netWorthAt('2026-11-02'), 108000);
  assert.equal(growth(L, '2026-10'), 61875);
  assert.equal(growth(L, '2026-11'), -3875);
});

test('L20 · forgotten salary on a drop', () => {
  const d = doc([place('hdfc', 'bank', '2026-09-01')], [
    setB('a', 'hdfc', '2026-09-01', 50000, 1), add('b', 'hdfc', '2026-09-03', 120000, 2, 'Salary'),
    set('c', 'hdfc', '2026-10-01', 50000, 3), set('d', 'hdfc', '2026-10-31', 30000, 4),
  ]);
  const L = remember(d, TODAY_B);
  assert.equal(month(L, '2026-09'), 116000);
  assert.equal(month(L, '2026-10'), 24000);
  assert.equal(growth(L, '2026-09'), 4000);
  assert.equal(growth(L, '2026-10'), -24000);
  const x = ledger(withEntries(d, add('x', 'hdfc', '2026-10-03', 120000, 5)), TODAY_B);
  assert.equal(month(x, '2026-10'), 144000);
  assert.equal(growth(x, '2026-10'), -24000);
  assert.equal(x.netWorth(), 30000);
});

test('L21 · money came in', () => {
  const a = doc([place('hdfc', 'bank', '2026-10-01')], [setB('a', 'hdfc', '2026-10-01', 50000, 1)]);
  for (const [amount, spent] of [[90000, 0], [120000, 30000]]) {
    const L = ledger(withEntries(a, add('x', 'hdfc', '2026-10-31', amount, 2), set('b', 'hdfc', '2026-10-31', 140000, 3)), TODAY_B);
    assert.equal(month(L, '2026-10'), spent);
    assert.equal(growth(L, '2026-10'), 90000);
    assert.equal(L.netWorth(), 140000);
  }
  const b = doc([place('hdfc', 'bank', '2026-09-01')], [
    setB('a', 'hdfc', '2026-09-01', 50000, 1), add('b', 'hdfc', '2026-09-03', 120000, 2, 'Salary'),
    set('c', 'hdfc', '2026-09-30', 54000, 3), set('d', 'hdfc', '2026-10-31', 114000, 4),
  ]);
  assert.equal(new Ledger(b, TODAY_B).setInfo('d').adj, 60000);
  const withSalary = ledger(withEntries(b, add('x', 'hdfc', '2026-10-03', 120000, 5, 'Salary')), TODAY_B);
  assert.equal(month(withSalary, '2026-09'), 116000);
  assert.equal(month(withSalary, '2026-10'), 60000);
  assert.equal(growth(withSalary, '2026-10'), 60000);
  const withRise = ledger(edit(withEntries(b, add('x', 'hdfc', '2026-10-31', 60000, 4)), 'd', { seq: 5 }), TODAY_B);
  assert.equal(month(withRise, '2026-10'), 0);
  assert.equal(growth(withRise, '2026-10'), 60000);
});

test('L22 · only bank stale', () => {
  const L = ledger(edit(fixtureA(), 'e4', null), '2026-10-20');
  const oct = L.period('month', '2026-10');
  assert.equal(r2(oct.spent), 0);
  assert.equal(oct.status, 'current');
  assert.equal(oct.anyKnown, false);
  assert.equal(oct.completeSoFar, false);
  assert.equal(L.period('week', '2026-10-19').anyKnown, false);
  assert.equal(L.completeThrough(), '2026-10-01');
  assert.deepEqual(L.lagging(), ['hdfc']);
  assert.equal(r2(oct.growth), 120000);
});

test('L23 · insert a mid-month balance', () => {
  const L = ledger(withEntries(fixtureA(), set('e5', 'hdfc', '2026-10-15', 40000, 5)), TODAY_A);
  nearAll(weeks(L, '2026-09-28', 5), [24642.86, 57500, 22544.64, -24062.5, -20625], 'weeks');
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-10'), 60000);
  assert.equal(L.setInfo('e4').adj, 55000);
});

test('L24 · cash fed by moves', () => {
  const d = doc([place('hdfc', 'bank', '2026-10-01'), place('cash', 'cash', '2026-10-05')], [
    setB('a', 'hdfc', '2026-10-01', 50000, 1), move('m', 'hdfc', 'cash', '2026-10-05', 10000, 2), set('b', 'hdfc', '2026-10-31', 25000, 3),
  ]);
  const L = ledger(d, '2026-11-20');
  assert.equal(month(L, '2026-10'), 15000);
  assert.equal(L.period('month', '2026-10').status, 'partial');
  assert.equal(L.completeThrough(), '2026-10-04');
  assert.equal(L.knownThrough('cash'), '2026-10-04');
  assert.deepEqual(L.lagging(), ['hdfc', 'cash']);
  assert.equal(L.netWorth(), 35000);
  assert.deepEqual(L.pending('cash'), { sinceDate: null, start: 0, firstDate: '2026-10-05', added: 0, movedIn: 10000, movedOut: 0, value: 10000 });

  const L2 = ledger(withEntries(d, set('c', 'cash', '2026-10-31', 0, 4)), '2026-11-20');
  assert.equal(month(L2, '2026-10'), 25000);
  assert.equal(L2.period('month', '2026-10').status, 'complete');
  assert.equal(L2.completeThrough(), '2026-10-31');
  assert.deepEqual(L2.lagging(), ['hdfc']);
  assert.equal(L2.netWorth(), 25000);
});

test('L25 · same-day replace', () => {
  const d = withEntries(fixtureA(), add('int', 'hdfc', '2026-10-31', 5000, 5));
  const L = ledger(d, TODAY_B);
  assert.equal(L.valueAt('hdfc', '2026-10-31'), 100000);
  const pre = L.expectedAt('hdfc', '2026-10-31');
  assert.equal(pre.expected, 160000);
  assert.deepEqual(pre.replaces, { id: 'e4', amount: 95000, starting: false });
  assert.equal(pre.sinceDate, '2026-10-01');
  assert.deepEqual(L.previewSet('hdfc', '2026-10-31', 100000).spent, 60000);
  const after = ledger(edit(d, 'e4', { amount: 100000, seq: 6 }), TODAY_B);
  assert.equal(after.setInfo('e4').spent, 60000);
  assert.equal(after.current('hdfc'), 100000);
  assert.equal(month(after, '2026-10'), 60000);
  assert.equal(growth(after, '2026-10'), 65000);
});

test('L26 · float tolerance', () => {
  const d = doc([place('w', 'cash', '2026-10-01')], [setB('a', 'w', '2026-10-01', 0.1, 1), add('b', 'w', '2026-10-02', 0.2, 2), set('c', 'w', '2026-10-03', 0.3, 3)]);
  const L = ledger(d, '2026-10-05');
  assert.ok(Object.is(L.setInfo('c').adj, 0));
  assert.equal(L.setInfo('c').caption.text, 'As expected');
  assert.equal(month(L, '2026-10'), 0);
});

test('L27 · entry after today is ignored', () => {
  const d = doc([place('hdfc', 'bank', '2026-10-18')], [setB('a', 'hdfc', '2026-10-18', 50000, 1)]);
  const L = ledger(d, '2026-10-17');
  assert.equal(L.netWorth(), 0);
  assert.equal(growth(L, '2026-10'), 0);
  assert.equal(month(L, '2026-10'), 0);
  assert.deepEqual(L.history(), []);
  assert.deepEqual(L.upcoming().map((x) => x.id), ['a']);
});

test('L28 · leap February', () => {
  const d = doc([place('h', 'bank', '2028-01-31')], [setB('a', 'h', '2028-01-31', 100000, 1), set('b', 'h', '2028-03-03', 68000, 2)]);
  const L = ledger(d, '2028-03-10');
  assert.equal(month(L, '2028-02'), 29000);
  assert.equal(L.period('month', '2028-02').status, 'complete');
  assert.equal(month(L, '2028-03'), 3000);
  assert.equal(L.period('month', '2028-03').status, 'current');
  assert.deepEqual(weeks(L, '2028-01-31', 5), [6000, 7000, 7000, 7000, 5000]);
  assert.equal(fy(L, 2027), 32000);
  assert.equal(growth(L, '2028-02'), -29000);
  assert.equal(growth(L, '2028-03'), -3000);
});

test('L29 · year-boundary week', () => {
  const d = doc([place('h', 'bank', '2026-12-30')], [setB('a', 'h', '2026-12-30', 10000, 1), set('b', 'h', '2027-01-02', 7000, 2)]);
  const L = ledger(d, '2027-01-10');
  assert.equal(month(L, '2026-12'), 1000);
  assert.equal(month(L, '2027-01'), 2000);
  assert.equal(week(L, '2026-12-28'), 3000);
  assert.equal(fy(L, 2026), 3000);
});

test('L30 · 31-day month', () => {
  const d = doc([place('h', 'bank', '2026-09-30')], [setB('a', 'h', '2026-09-30', 62000, 1), set('b', 'h', '2026-10-31', 31000, 2)]);
  const L = ledger(d, '2026-11-02');
  assert.equal(month(L, '2026-10'), 31000);
  assert.equal(L.period('month', '2026-10').status, 'complete');
  assert.equal(L.period('month', '2026-09').status, 'untracked');
  assert.deepEqual(weeks(L, '2026-09-28', 6), [4000, 7000, 7000, 7000, 6000, 0]);
  assert.equal(L.netWorthAt('2026-10-31'), 31000);
});

test('L31 · outflow already recorded on the source', () => {
  const d = doc([place('hdfc', 'bank', '2026-09-20'), place('mf', 'mutual_fund', '2026-09-20')], [
    setB('h1', 'hdfc', '2026-09-20', 50000, 1), setB('m1', 'mf', '2026-09-20', 100000, 2), set('m2', 'mf', '2026-09-30', 60000, 3),
    set('h2', 'hdfc', '2026-10-01', 50000, 4), set('h3', 'hdfc', '2026-10-08', 90000, 5),
  ]);
  const cameIn = ledger(withEntries(edit(d, 'h3', { seq: 6 }), add('x', 'hdfc', '2026-10-08', 40000, 5)), '2026-10-08');
  assert.equal(cameIn.current('mf'), 60000);
  assert.equal(cameIn.netWorth(), 150000);
  assert.equal(month(cameIn, '2026-10'), 0);
  assert.equal(growth(cameIn, '2026-09'), -40000);
  assert.equal(growth(cameIn, '2026-10'), 40000);
  const wrong = ledger(withEntries(edit(d, 'h3', { seq: 6 }), move('x', 'mf', 'hdfc', '2026-10-08', 40000, 5)), '2026-10-08');
  assert.equal(wrong.current('mf'), 20000);
  assert.equal(wrong.netWorth(), 110000);
});

test('L32 · wallet counts as spendable', () => {
  const d = doc([place('hdfc', 'bank', '2026-10-01'), place('wal', 'cash', '2026-10-01', { name: 'Paytm wallet' })], [
    setB('a', 'hdfc', '2026-10-01', 50000, 1), setB('b', 'wal', '2026-10-01', 5000, 2),
    set('c', 'hdfc', '2026-10-31', 40000, 3), set('d', 'wal', '2026-10-31', 1000, 4),
  ]);
  const L = remember(d, TODAY_B);
  assert.equal(month(L, '2026-10'), 14000);
  assert.equal(growth(L, '2026-10'), -14000);
});

const fixtureL33 = () => doc(
  [place('hdfc', 'bank', '2026-10-01', { name: 'HDFC Savings' }), place('sip', 'sip', '2026-10-10', { name: 'Axis SIP' }), place('fd', 'fd', '2026-10-01', { closedOn: '2026-10-31' })],
  [
    setB('e1', 'hdfc', '2026-10-01', 50000, 1), setB('f1', 'fd', '2026-10-01', 100000, 2), add('e2', 'hdfc', '2026-10-03', 120000, 3, 'Salary'),
    move('r1-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 4), set('fx', 'fd', '2026-10-31', 107000, 5),
    move('fm', 'fd', 'hdfc', '2026-10-31', 107000, 6), set('e4', 'hdfc', '2026-10-31', 202000, 7),
  ],
);

test('L33 · FD maturity through the rise prompt', () => {
  const L = ledger(fixtureL33(), TODAY_A);
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-10'), 67000);
  assert.equal(L.current('fd'), 0);
  assert.equal(L.netWorthAt('2026-10-31'), 217000);
  let locked = editPlaceIn(fixtureL33(), 'fd', { closedOn: undefined });
  locked = edit(edit(edit(locked, 'fx', null), 'fm', { amount: 47000, seq: 5 }), 'e4', { seq: 6 });
  const R = ledger(locked, TODAY_A);
  assert.equal(month(R, '2026-10'), 0);
  assert.equal(growth(R, '2026-10'), 120000);
  assert.equal(R.current('fd'), 53000);
  assert.equal(R.netWorthAt('2026-10-31'), 270000);
});

test('L34 · a closed FD, before and after removing it', () => {
  const d = withEntries(
    edit({ ...fixtureA(), places: [...fixtureA().places, place('fd', 'fd', '2026-10-01', { closedOn: '2026-10-20' })] }, 'e4', { amount: 202000 }),
    setB('g1', 'fd', '2026-10-01', 100000, 5), set('g2', 'fd', '2026-10-20', 107000, 6), move('g3', 'fd', 'hdfc', '2026-10-20', 107000, 7),
  );
  const L = ledger(d, TODAY_A);
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(growth(L, '2026-10'), 67000);
  assert.equal(L.netWorthAt('2026-10-31'), 217000);
  const gone = { ...d, places: d.places.filter((p) => p.id !== 'fd'), entries: d.entries.filter((e) => !['g1', 'g2', 'g3'].includes(e.id)) };
  const G = ledger(gone, TODAY_A);
  assert.equal(month(G, '2026-10'), -47000);
  assert.equal(growth(G, '2026-10'), 167000);
  assert.equal(G.netWorthAt('2026-10-31'), 217000);
});

test('L35 · new bank funded from HDFC', () => {
  const base = doc([place('hdfc', 'bank', '2026-10-01'), place('sbi', 'bank', '2026-10-15')], [setB('a', 'hdfc', '2026-10-01', 100000, 1)]);
  const check = (L, spent, g) => {
    assert.equal(month(L, '2026-10'), spent);
    assert.equal(growth(L, '2026-10'), g);
    assert.equal(L.netWorth(), 100000);
  };
  const a = withEntries(base, setB('s', 'sbi', '2026-10-15', 20000, 2), set('b', 'hdfc', '2026-10-15', 80000, 3));
  check(ledger(a, TODAY_B), 20000, -20000);
  check(ledger(withEntries(a, move('m', 'hdfc', 'sbi', '2026-10-15', 20000, 1)), TODAY_B), 0, 0);
  check(ledger(withEntries(base, move('s', 'hdfc', 'sbi', '2026-10-15', 20000, 2), set('b', 'hdfc', '2026-10-15', 80000, 3)), TODAY_B), 0, 0);
});

test('L36 · "moved from" after a same-day balance', () => {
  const base = doc([place('hdfc', 'bank', '2026-10-01'), place('fd', 'fd', '2026-10-31')],
    [setB('a', 'hdfc', '2026-10-01', 150000, 1), set('b', 'hdfc', '2026-10-31', 95000, 2)]);
  const yes = ledger(withEntries(base, move('m', 'hdfc', 'fd', '2026-10-31', 50000, 1)), TODAY_B);
  assert.equal(yes.current('hdfc'), 95000);
  assert.equal(yes.current('fd'), 50000);
  assert.equal(yes.netWorth(), 145000);
  assert.equal(month(yes, '2026-10'), 5000);
  assert.equal(growth(yes, '2026-10'), -5000);
  const no = ledger(withEntries(base, move('m', 'hdfc', 'fd', '2026-10-31', 50000, 3)), TODAY_B);
  assert.equal(no.current('hdfc'), 45000);
  assert.equal(no.netWorth(), 95000);
  assert.equal(month(no, '2026-10'), 55000);
  assert.equal(growth(no, '2026-10'), -55000);
});

test('L37 · a move recorded after a same-day balance', () => {
  const d = doc([place('hdfc', 'bank', '2026-10-01'), place('sip', 'sip', '2026-10-10')], [
    setB('a', 'hdfc', '2026-10-01', 50000, 1), add('b', 'hdfc', '2026-10-03', 120000, 2), set('c', 'hdfc', '2026-10-10', 170000, 3),
    move('r1-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 4), set('d', 'hdfc', '2026-10-31', 95000, 5),
  ]);
  const L = ledger(d, TODAY_A);
  assert.equal(L.netWorthAt('2026-10-10'), 170000);
  assert.equal(L.setInfo('c').adj, 0);
  nearAll(weeks(L, '2026-09-28', 5), [0, 2857.14, 20000, 20000, 17142.86], 'weeks');
  assert.equal(month(L, '2026-10'), 60000);
});

test('L38 · SIP place backdated with monthly moves', () => {
  const d = doc([place('hdfc', 'bank', '2026-09-01'), place('sip', 'sip', '2026-09-01')], [
    setB('a', 'hdfc', '2026-09-01', 100000, 1), setB('s0', 'sip', '2026-09-01', 30000, 2),
    move('r-2026-09', 'hdfc', 'sip', '2026-09-10', 15000, 3), move('r-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 4),
    set('b', 'hdfc', '2026-10-31', 40000, 5),
  ]);
  const L = remember(d, TODAY_B);
  assert.equal(month(L, '2026-09'), 14500);
  assert.equal(month(L, '2026-10'), 15500);
  assert.equal(L.current('sip'), 60000);
  assert.equal(L.netWorth(), 100000);
  assert.equal(growth(L, '2026-09'), -14500);
  assert.equal(growth(L, '2026-10'), -15500);
});

test('L39 · starting balance re-dated earlier', () => {
  const d = edit(editPlaceIn(fixtureA(), 'hdfc', { createdOn: '2026-09-25' }), 'e1', { date: '2026-09-25' });
  const L = remember(d, TODAY_A);
  assert.equal(month(L, '2026-09'), 8333.33);
  assert.equal(month(L, '2026-10'), 51666.67);
  assert.equal(L.netWorthAt('2026-09-30'), 50000);
  assert.equal(L.netWorthAt('2026-10-31'), 110000);
  assert.equal(growth(L, '2026-09'), -8333.33);
  assert.equal(growth(L, '2026-10'), 68333.33);
});

test('L40 · close with a final amount below the value', () => {
  let d = editPlaceIn(fixtureB(), 'cash', { closedOn: '2026-10-20' });
  d = withEntries(d, set('cx', 'cash', '2026-10-20', 2000, 11), move('cm', 'cash', 'hdfc', '2026-10-20', 2000, 12));
  const L = ledger(d, TODAY_B);
  assert.equal(month(L, '2026-10'), 64000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'hdfc')), 56000);
  assert.equal(r2(L.spentIn('2026-10-01', '2026-10-31', 'cash')), 8000);
  assert.equal(L.netWorth(), 306400);
  assert.equal(growth(L, '2026-10'), 52400);
});

function fixtureL41() {
  const entries = [setB('h0', 'hdfc', '2025-12-31', 100000, 1)];
  let seq = 2, bal = 100000;
  for (let m = 1; m <= 12; m++) {
    const k = `2026-${String(m).padStart(2, '0')}`;
    bal += 35000;
    entries.push(add(`a${m}`, 'hdfc', `${k}-01`, 100000, seq++), move(`m${m}`, 'hdfc', 'sip', `${k}-10`, 15000, seq++), set(`s${m}`, 'hdfc', fromDay(monthEndDay(k)), bal, seq++));
  }
  return doc([place('hdfc', 'bank', '2025-12-31'), place('sip', 'sip', '2026-01-10')], entries);
}

test('L41 · a year of SIPs, with and without the SIP place', () => {
  const d = fixtureL41();
  const L = ledger(d, '2026-12-31');
  for (let m = 1; m <= 12; m++) assert.equal(month(L, `2026-${String(m).padStart(2, '0')}`), 50000);
  assert.equal(fy(L, 2025), 150000);
  assert.equal(fy(L, 2026), 450000);
  assert.equal(L.netWorth(), 700000);
  assert.equal(growth(L, '2026-12'), 50000);
  const gone = { ...d, places: d.places.filter((p) => p.id !== 'sip'), entries: d.entries.filter((e) => e.kind !== 'move') };
  const G = ledger(gone, '2026-12-31');
  for (let m = 1; m <= 12; m++) assert.equal(month(G, `2026-${String(m).padStart(2, '0')}`), 65000);
  assert.equal(fy(G, 2025), 195000);
  assert.equal(fy(G, 2026), 585000);
  assert.equal(G.netWorth(), 520000);
  assert.equal(growth(G, '2026-12'), 35000);
});

test('L42 · a skipped SIP', () => {
  const L = ledger(edit(edit(fixtureA(), 'r1-2026-10', null), 'e4', { amount: 110000 }), TODAY_A);
  assert.equal(month(L, '2026-10'), 60000);
  assert.equal(L.current('sip'), null);
  assert.equal(L.netWorth(), 110000);
  assert.equal(growth(L, '2026-10'), 60000);
});

test('L43 · no monthly move recorded', () => {
  const d = doc([place('hdfc', 'bank', '2026-10-01'), place('sip', 'sip', '2026-10-01')], [
    setB('h1', 'hdfc', '2026-10-01', 100000, 1), setB('s1', 'sip', '2026-10-01', 30000, 2), set('h2', 'hdfc', '2026-10-31', 70000, 3),
  ]);
  const L = ledger(d, TODAY_B);
  assert.equal(month(L, '2026-10'), 30000);
  assert.equal(L.current('sip'), 30000);
  assert.equal(L.netWorth(), 100000);
  assert.equal(growth(L, '2026-10'), -30000);
});

test('L44 · a duplicate move saved anyway', () => {
  const L = ledger(withEntries(fixtureA(), move('m', 'hdfc', 'sip', '2026-10-10', 15000, 5)), TODAY_A);
  assert.equal(month(L, '2026-10'), 45000);
  assert.equal(L.current('sip'), 30000);
  assert.equal(L.netWorthAt('2026-10-31'), 125000);
  assert.equal(growth(L, '2026-10'), 75000);
});

test('L3(a) · identity over every month of the remembered fixtures', () => {
  assert.ok(IDENTITY_CASES.length >= 8);
  for (const [d, today] of IDENTITY_CASES) {
    const L = new Ledger(d, today);
    for (const p of L.periods('month', 14)) near(p.growth, p.adds - p.spent + p.invest, `${p.key}`);
  }
});

// ---------------------------------------------------------------- UI helpers
test('place series, sparkline and place history on B', () => {
  const L = new Ledger(fixtureB(), TODAY_B);
  assert.deepEqual(L.placeSeries('hdfc'), [
    { date: '2026-10-01', value: 50000, set: true }, { date: '2026-10-03', value: 170000, set: false },
    { date: '2026-10-10', value: 155000, set: false }, { date: '2026-10-12', value: 149000, set: false },
    { date: '2026-10-31', value: 95000, set: true },
  ]);
  assert.deepEqual(L.placeSeries('cash').at(-1), { date: '2026-10-31', value: 3000, set: false });
  const spark = L.sparkline('cash', 20);
  assert.deepEqual(spark[0], { date: '2026-10-12', value: 10000, set: false });
  assert.equal(spark.length, 3);
  const h = L.placeHistory('hdfc');
  assert.deepEqual(h.map((x) => [x.id, x.value]), [['e4', 95000], ['m2', 149000], ['r1-2026-10', 155000], ['e2', 170000], ['e1', 50000]]);
  assert.equal(h[0].caption.text, 'Spent ₹54,000 since 1 Oct');
  assert.equal(h[1].caption.text, 'Moved ₹6,000 to Cash');
  assert.equal(L.placeHistory('cash').find((x) => x.id === 'm2').caption.text, 'Moved ₹6,000 from HDFC Savings');
  assert.equal(L.placeHistory('sip')[0].caption.text, 'Up ₹400');
});

test('groups, place summaries and freshness', () => {
  const L = new Ledger(fixtureB(), TODAY_B);
  const g = L.groups();
  assert.deepEqual(g.map((x) => [x.id, x.label, x.total]), [['cash', 'Bank & cash', 98000], ['invest', 'Savings & investments', 211400]]);
  assert.deepEqual(g[1].places.map((p) => p.id), ['sip', 'mf']);
  const cash = L.placeSummary('cash');
  assert.equal(cash.daysSinceSet, 16);
  assert.equal(cash.stale, true);
  assert.equal(L.placeSummary('hdfc').stale, false);
  assert.equal(L.latestSetDate(), '2026-10-31');
  assert.equal(L.lastSetDate('cash'), '2026-10-15');
});

test('previewSet: the live line under an Update-balances row', () => {
  const A = new Ledger(fixtureA(), TODAY_A);
  assert.equal(A.previewSet('hdfc', '2026-11-05', 80000).text, 'Spent ₹15,000 since 31 Oct');
  assert.equal(A.previewSet('hdfc', '2026-11-05', 95000).kind, 'asExpected');
  const refund = A.previewSet('hdfc', '2026-11-05', 95400);
  assert.deepEqual([refund.kind, refund.rise, refund.needsChoice], ['refund', 400, false]);
  const rise = A.previewSet('hdfc', '2026-11-05', 125000);
  assert.deepEqual([rise.kind, rise.rise, rise.needsChoice], ['rise', 30000, true]);
  assert.equal(A.previewSet('sip', '2026-11-05', 16200).text, 'Up ₹1,200 since 10 Oct');
  const back = A.previewSet('hdfc', '2026-09-21', 60000);
  assert.deepEqual([back.kind, back.backfill], ['starting', true]);
  const B = new Ledger(fixtureB(), TODAY_B);
  const row = B.expectedAt('hdfc', '2026-10-31');
  assert.equal(row.expected, 149000);
  assert.deepEqual(row.breakdown, { startDate: '2026-10-01', start: 50000, added: 120000, movedIn: 0, movedOut: 21000 });
});

test('an empty document', () => {
  const L = new Ledger({ version: 2, rev: 0, places: [], entries: [] }, TODAY_A);
  assert.equal(L.netWorth(), 0);
  assert.deepEqual(L.trend(), [{ date: TODAY_A, nw: 0, change: 0, baseline: 0, starting: 0 }]);
  assert.deepEqual(L.history(), []);
  assert.equal(L.currentPeriod('month').status, 'none');
  assert.equal(L.completeThrough(), null);
  assert.deepEqual(L.lagging(), []);
  assert.equal(L.trackingStart(), null);
  assert.equal(L.latestSetDate(), null);
  assert.deepEqual(L.groups().map((g) => g.places.length), [0, 0]);
  assert.equal(L.hasSpendingData(), false);
});

test('periods() and currentPeriod() windows', () => {
  const L = new Ledger(fixtureA(), TODAY_A);
  assert.deepEqual(L.periods('month', 3).map((p) => [p.key, p.label, p.status]), [['2026-09', 'Sep 2026', 'untracked'], ['2026-10', 'Oct 2026', 'complete'], ['2026-11', 'Nov 2026', 'current']]);
  assert.deepEqual(L.periods('week', 2).map((p) => [p.key, p.label]), [['2026-10-26', '26 Oct – 1 Nov'], ['2026-11-02', '2 Nov – 8 Nov']]);
  const fy = L.currentPeriod('fy');
  assert.deepEqual([fy.key, fy.start, fy.end, fy.label, r2(fy.spent)], [2026, '2026-04-01', '2027-03-31', 'FY 26–27', 60000]);
  const oct = L.period('month', '2026-10');
  assert.deepEqual([oct.nwBefore, oct.nwAfter, r2(oct.adds), r2(oct.baseline)], [0, 110000, 120000, 50000]);
  assert.equal(L.trackingStart(), '2026-10-01');
});

test('R2 · a place closed during a period is not "behind" after its close', () => {
  let d = editPlaceIn(fixtureB(), 'cash', { closedOn: '2026-10-20' });
  d = withEntries(edit(d, 'e4', { amount: 98000 }), set('cx', 'cash', '2026-10-20', 3000, 11), move('cm', 'cash', 'hdfc', '2026-10-20', 3000, 12));
  const L = ledger(d, '2026-11-05');
  const p = L.period('month', '2026-10');
  assert.deepEqual([p.status, p.anyKnown], ['complete', true]);
  const cash = L.explain(p).places.find((x) => x.placeId === 'cash');
  assert.deepEqual([cash.knownThrough, cash.behind], ['2026-10-20', false]);
  assert.deepEqual(L.explain(p).places.map((x) => x.behind), [false, false]);
  // A place that really is behind still says so.
  const B = ledger(fixtureB(), '2026-11-05');
  const oct = B.period('month', '2026-10');
  assert.equal(oct.status, 'partial');
  assert.deepEqual(B.explain(oct).places.map((x) => [x.placeId, x.behind]), [['hdfc', false], ['cash', true]]);
});
