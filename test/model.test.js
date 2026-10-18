// §8.6 validation vectors (the rule rows are gone with monthly rules) plus the model basics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TYPES, GROUPS, typeInfo, isSpendable, emptyDoc, isV2, isV1Shaped, compareEntries, nextSeq, validateDoc,
} from '../public/js/model.js';
import { isDate, todayIST, todayLocal, dayLabel, monthLabel, weekLabel, fyRange, fromDay, toDay } from '../public/js/dates.js';
import { place, set, setB, add, move, doc, fixtureA, fixtureB, fixtureH, TODAY_A, TODAY_B, TODAY_H } from './core-fixtures.js';

test('TYPES: nine types in grid order, two groups, only bank and cash spendable', () => {
  assert.deepEqual(TYPES.map((t) => t.id), ['bank', 'cash', 'fd', 'sip', 'mutual_fund', 'stocks', 'retirement', 'gold', 'other']);
  assert.deepEqual(TYPES.map((t) => t.label), ['Bank account', 'Cash / wallet', 'FD / RD', 'SIP', 'Mutual funds', 'Stocks', 'PF / PPF / NPS', 'Gold', 'Others']);
  assert.deepEqual(GROUPS.map((g) => g.label), ['Bank & cash', 'Savings & investments']);
  assert.deepEqual(TYPES.filter((t) => t.spendable).map((t) => t.id), ['bank', 'cash']);
  assert.equal(isSpendable('cash'), true);
  assert.equal(isSpendable({ type: 'bank' }), true);
  assert.equal(isSpendable('fd'), false);
  assert.equal(isSpendable('car'), false);
  assert.equal(typeInfo('gold').group, 'invest');
});

test('emptyDoc, isV2 and isV1Shaped', () => {
  assert.deepEqual(emptyDoc(), { version: 2, rev: 0, places: [], entries: [] });
  assert.notEqual(emptyDoc(), emptyDoc());
  assert.equal(isV2(emptyDoc()), true);
  assert.equal(isV1Shaped({ accounts: [] }), true);
  assert.equal(isV1Shaped({ snapshots: [], rev: 3 }), true);
  assert.equal(isV1Shaped(emptyDoc()), false);
  assert.equal(isV1Shaped({}), false);
  assert.equal(isV1Shaped(null), false);
});

test('compareEntries orders by (date, seq, id); nextSeq is floor(max) + 1', () => {
  const es = [
    set('b', 'h', '2026-10-02', 1, 1), set('a', 'h', '2026-10-02', 1, 1), add('c', 'h', '2026-10-01', 1, 9), move('d', 'h', 'x', '2026-10-02', 1, 0.5),
  ];
  assert.deepEqual([...es].sort(compareEntries).map((e) => e.id), ['c', 'd', 'a', 'b']);
  assert.equal(nextSeq(emptyDoc()), 1);
  assert.equal(nextSeq({ entries: es }), 10);
  assert.equal(nextSeq({ entries: [set('a', 'h', '2026-10-02', 1, 6.67)] }), 7);
});

test('dates helpers', () => {
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(isDate('2026-1-01'), false);
  assert.equal(todayIST(new Date('2026-10-17T19:00:00Z')), '2026-10-18');
  assert.equal(todayIST(new Date('2026-10-17T18:00:00Z')), '2026-10-17');
  assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayLabel('2026-10-01'), '1 Oct');
  assert.equal(dayLabel(toDay('2026-10-01'), true), '1 Oct 2026');
  assert.equal(monthLabel('2026-10'), 'Oct 2026');
  assert.equal(monthLabel('2026-10', true), 'October 2026');
  assert.equal(weekLabel('2026-10-26'), '26 Oct – 1 Nov');
  assert.deepEqual(fyRange(2026).map(fromDay), ['2026-04-01', '2027-03-31']);
});

test('validateDoc accepts the empty doc and every ledger fixture', () => {
  assert.deepEqual(validateDoc(emptyDoc(), { today: TODAY_A }), { ok: true });
  for (const [d, today] of [[fixtureA(), TODAY_A], [fixtureB(), TODAY_B], [fixtureH(), TODAY_H]]) assert.deepEqual(validateDoc(d, { today }), { ok: true });
  const full = { ...fixtureA(), rev: 7, savedAt: '2026-10-31T16:02:11.000Z', legacyV1: { migratedAt: 'x', report: {}, doc: {} } };
  full.entries[0].at = '2026-10-01T03:50:00.000Z';
  full.entries[0].note = 'Opening';
  full.places[0].note = 'HDFC Bank';
  full.places[1].closedOn = '2026-10-31';
  assert.deepEqual(validateDoc(full, { today: TODAY_A }), { ok: true });
  // A bank may hold a negative balance.
  const od = fixtureH();
  od.entries.push(set('c', 'hdfc', '2026-10-31', -2500.5, 3));
  assert.equal(validateDoc(od, { today: TODAY_H }).ok, true);
});

const T = '2026-10-31';
const base = () => doc(
  [place('hdfc', 'bank', '2026-10-01'), place('car', 'other', '2026-10-01', { closedOn: '2026-10-20' })],
  [setB('e1', 'hdfc', '2026-10-01', 50000, 1), setB('e2', 'car', '2026-10-01', 1000, 2)],
);
const BAD = [
  ['version: 1', (d) => { d.version = 1; }, 'version'],
  ['unknown top-level key', (d) => { d.exportedAt = 'x'; }, 'exportedAt'],
  ['monthly rules are not part of v2', (d) => { d.recurring = []; }, 'recurring'],
  ["type 'car'", (d) => { d.places[1].type = 'car'; }, 'places[1].type'],
  ['duplicate place id', (d) => { d.places[1].id = 'hdfc'; }, 'places[1].id'],
  ['closedOn before createdOn', (d) => { d.places[1].closedOn = '2026-09-30'; }, 'places[1].closedOn'],
  ['createdOn after today + 1', (d) => { d.places.push(place('x', 'bank', '2026-11-02')); }, 'places[2].createdOn'],
  ['name too long', (d) => { d.places[0].name = 'x'.repeat(61); }, 'places[0].name'],
  ['unknown place field', (d) => { d.places[0].kind = 'bank'; }, 'places[0].kind'],
  ['duplicate entry id', (d) => { d.entries.push(add('e1', 'hdfc', '2026-10-02', 5, 3)); }, 'entries[2].id'],
  ['two sets for one place on one date', (d) => { d.entries.push(set('e3', 'hdfc', '2026-10-01', 5, 3)); }, 'entries[2].date'],
  ['move with fromId === toId', (d) => { d.entries.push(move('m', 'hdfc', 'hdfc', '2026-10-02', 5, 3)); }, 'entries[2].toId'],
  ['add with amount 0', (d) => { d.entries.push(add('a', 'hdfc', '2026-10-02', 0, 3)); }, 'entries[2].amount'],
  ['amount 10.005', (d) => { d.entries.push(add('a', 'hdfc', '2026-10-02', 10.005, 3)); }, 'entries[2].amount'],
  ['set −10000 on an other place', (d) => { d.entries.push(set('a', 'car', '2026-10-02', -10000, 3)); }, 'entries[2].amount'],
  ['date 2026-02-30', (d) => { d.entries.push(add('a', 'hdfc', '2026-02-30', 5, 3)); }, 'entries[2].date'],
  ['date after today + 1', (d) => { d.entries.push(add('a', 'hdfc', '2026-11-02', 5, 3)); }, 'entries[2].date'],
  ["add before its place's createdOn", (d) => { d.entries.push(add('a', 'hdfc', '2026-09-30', 5, 3)); }, 'entries[2].date'],
  ['entry after closedOn', (d) => { d.entries.push(set('a', 'car', '2026-10-21', 5, 3)); }, 'entries[2].date'],
  ['baseline on an add', (d) => { d.entries.push({ ...add('a', 'hdfc', '2026-10-02', 5, 3), baseline: true }); }, 'entries[2].baseline'],
  ['baseline false', (d) => { d.entries[0].baseline = false; }, 'entries[0].baseline'],
  ['unknown placeId', (d) => { d.entries.push(add('a', 'nope', '2026-10-02', 5, 3)); }, 'entries[2].placeId'],
  ['ruleId is not part of v2', (d) => { d.entries.push(move('m', 'hdfc', 'car', '2026-10-02', 5, 3, { ruleId: 'r1' })); }, 'entries[2].ruleId'],
  ['non-finite seq', (d) => { d.entries[0].seq = null; }, 'entries[0].seq'],
  ['note too long', (d) => { d.entries[0].note = 'x'.repeat(121); }, 'entries[0].note'],
  ['at is not a time', (d) => { d.entries[0].at = 'yesterday'; }, 'entries[0].at'],
  ['legacyV1 not an object', (d) => { d.legacyV1 = []; }, 'legacyV1'],
  ['201 places', (d) => { for (let i = 0; i < 199; i++) d.places.push(place(`p${i}`, 'gold', '2026-10-01')); }, 'places'],
];

for (const [name, mutate, path] of BAD) {
  test(`validateDoc rejects: ${name} → ${path}`, () => {
    const d = base();
    assert.equal(validateDoc(d, { today: T }).ok, true);
    mutate(d);
    const v = validateDoc(d, { today: T });
    assert.equal(v.ok, false);
    assert.equal(v.path, path);
    assert.ok(v.error.includes(path), `message names the path: ${v.error}`);
  });
}

test('rangeLabel', async () => {
  const { rangeLabel } = await import('../public/js/dates.js');
  assert.equal(rangeLabel('2026-10-02', '2026-10-31'), '2–31 Oct');
  assert.equal(rangeLabel('2026-09-26', '2026-10-05'), '26 Sep–5 Oct');
  assert.equal(rangeLabel('2026-12-30', '2027-01-02'), '30 Dec 2026–2 Jan 2027');
  assert.equal(rangeLabel('2026-10-05', '2026-10-05'), '5 Oct');
});
