// §8.4 action vectors that survive the cut (no rules, duplicate guard, impact, ripple,
// fingerprints or prompt heuristics). Actions are pure: fn(doc, params) → { doc, message }.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlace, editPlace, updateBalances, previewBalances, addMoney, moveMoney, sameDayCheck, sameDayQuestion,
  editEntry, deleteEntry, closePlace, reopenPlace, deletePlace, suggestName, lastAdd, lastMove, planPrompts,
} from '../public/js/actions.js';
import { Ledger } from '../public/js/ledger.js';
import { validateDoc, emptyDoc } from '../public/js/model.js';
import {
  place, set, setB, add, move, doc, clone, r2, editPlaceIn, withEntries,
  fixtureA, fixtureB, fixtureH, TODAY_A, TODAY_B, TODAY_H,
} from './core-fixtures.js';

const month = (d, today, k = '2026-10') => r2(new Ledger(d, today).period('month', k).spent);
const growth = (d, today, k = '2026-10') => r2(new Ledger(d, today).period('month', k).growth);
const entry = (d, id) => d.entries.find((e) => e.id === id);
const valid = (d, today) => { const v = validateDoc(d, { today }); assert.ok(v.ok, v.error); };
/** Calls an action and checks it never mutates its input. */
function act(fn, d, params) {
  const before = clone(d);
  const out = fn(d, params);
  assert.deepEqual(d, before, `${fn.name} must not modify its input`);
  return out;
}

test('AC1 · addPlace "I already had it" as the first place; later places must say where it came from', () => {
  const { doc: d, message } = act(addPlace, emptyDoc(), { id: 'hdfc', type: 'bank', name: 'HDFC Savings', date: '2026-10-01', value: 50000, entryId: 'e1', today: '2026-10-01', at: '2026-10-01T03:50:00.000Z' });
  assert.deepEqual(d.places, [{ id: 'hdfc', name: 'HDFC Savings', type: 'bank', createdOn: '2026-10-01' }]);
  assert.deepEqual(d.entries, [{ id: 'e1', kind: 'set', placeId: 'hdfc', date: '2026-10-01', amount: 50000, seq: 1, baseline: true, at: '2026-10-01T03:50:00.000Z' }]);
  assert.equal(message, 'Added HDFC Savings');
  assert.throws(() => addPlace(d, { id: 'sbi', type: 'bank', date: '2026-10-01', value: 100, entryId: 'e2', today: '2026-10-01' }), { message: 'Choose where it came from', code: 'choose_source' });
  const had = addPlace(d, { id: 'sbi', type: 'bank', date: '2026-10-01', value: 100, source: 'had', entryId: 'e2', today: '2026-10-01' }).doc;
  assert.deepEqual(entry(had, 'e2'), { id: 'e2', kind: 'set', placeId: 'sbi', date: '2026-10-01', amount: 100, seq: 2, baseline: true });
  assert.equal(had.places[1].name, 'Bank');
  const zero = addPlace(d, { id: 'cash', type: 'cash', date: '2026-10-01', value: 0, today: '2026-10-01' }).doc;
  assert.deepEqual([zero.places.length, zero.entries.length], [2, 1]);
});

test('AC2 · addPlace "moved from" HDFC', () => {
  const { doc: d } = act(addPlace, fixtureH(), { id: 'sip', type: 'sip', name: 'Axis SIP', date: '2026-10-20', value: 15000, source: 'moved', fromId: 'hdfc', entryId: 'm1', today: TODAY_H });
  assert.deepEqual(d.entries.filter((e) => e.kind === 'move'), [{ id: 'm1', kind: 'move', fromId: 'hdfc', toId: 'sip', date: '2026-10-20', amount: 15000, seq: 3 }]);
  const L = new Ledger(d, TODAY_H);
  assert.deepEqual([L.current('sip'), L.current('hdfc'), L.netWorth()], [15000, 85000, 120000]);
});

test('AC3 · addPlace "new money"', () => {
  const { doc: d } = act(addPlace, fixtureH(), { id: 'gold', type: 'gold', date: '2026-10-20', value: 7000, source: 'new', entryId: 'g1', today: TODAY_H });
  assert.deepEqual(entry(d, 'g1'), { id: 'g1', kind: 'add', placeId: 'gold', date: '2026-10-20', amount: 7000, seq: 3, note: 'New money' });
  assert.equal(new Ledger(d, TODAY_H).netWorth(), 127000);
});

test('AC5 · suggestName', () => {
  assert.equal(suggestName(emptyDoc(), 'fd'), 'FD');
  const one = addPlace(emptyDoc(), { id: 'f1', type: 'fd', date: '2026-10-01', today: '2026-10-01' }).doc;
  assert.equal(one.places[0].name, 'FD');
  assert.equal(suggestName(one, 'fd'), 'FD 2');
  assert.equal(suggestName(one, 'mutual_fund'), 'Mutual funds');
});

test('AC6 · updateBalances on a date that already has a balance replaces it (L25)', () => {
  const d = withEntries(fixtureA(), add('int', 'hdfc', '2026-10-31', 5000, 5));
  const pre = previewBalances(d, { date: '2026-10-31', today: TODAY_B, rows: [{ placeId: 'hdfc', amount: 100000, setId: 'new' }] });
  assert.equal(pre.ok, true);
  assert.equal(pre.rows[0].expected, 160000);
  assert.deepEqual(pre.rows[0].replaces, { id: 'e4', amount: 95000, starting: false });
  assert.equal(pre.rows[0].text, 'Spent ₹60,000 since 1 Oct');
  const { doc: out, message } = act(updateBalances, d, { date: '2026-10-31', today: TODAY_B, rows: [{ placeId: 'hdfc', amount: 100000, setId: 'new' }] });
  assert.equal(message, "Saved HDFC Savings's balance");
  assert.deepEqual(entry(out, 'e4'), { id: 'e4', kind: 'set', placeId: 'hdfc', date: '2026-10-31', amount: 100000, seq: 6 });
  assert.equal(out.entries.some((e) => e.id === 'new'), false);
  assert.equal(month(out, TODAY_B), 60000);
  assert.equal(growth(out, TODAY_B), 65000);
});

test('AC7 · updateBalances backfill becomes the new starting balance (I)', () => {
  const { doc: d } = act(updateBalances, fixtureA(), { date: '2026-09-21', today: TODAY_A, rows: [{ placeId: 'hdfc', amount: 60000, setId: 'b0' }] });
  assert.equal(d.places[0].createdOn, '2026-09-21');
  assert.deepEqual(entry(d, 'b0'), { id: 'b0', kind: 'set', placeId: 'hdfc', date: '2026-09-21', amount: 60000, seq: 5, baseline: true });
  assert.equal('baseline' in entry(d, 'e1'), false);
  assert.equal(month(d, TODAY_A, '2026-09'), 9000);
  assert.equal(month(d, TODAY_A), 61000);
  const pre = previewBalances(fixtureA(), { date: '2026-09-21', today: TODAY_A, rows: [{ placeId: 'hdfc', amount: 60000, setId: 'b0' }] });
  assert.equal(pre.rows[0].text, "This becomes HDFC Savings's new starting balance");
});

test('AC8 · rise choices', () => {
  const C = doc([place('sbi', 'bank', '2026-10-01', { name: 'SBI' })], [setB('s1', 'sbi', '2026-10-01', 20000, 1)]);
  const params = (row) => ({ date: '2026-10-31', today: TODAY_B, rows: [{ placeId: 'sbi', amount: 140000, setId: 's2', ...row }] });
  assert.throws(() => updateBalances(C, params({})), { code: 'choose_rise', message: "Choose where SBI's ₹1,20,000 came from" });
  const pre = previewBalances(C, params({}));
  assert.deepEqual([pre.ok, pre.rows[0].kind, pre.rows[0].rise, pre.rows[0].needsChoice], [false, 'rise', 120000, true]);

  const income = act(updateBalances, C, params({ choice: 'income', flowId: 'a1', flowAmount: 130000, flowNote: 'Salary' })).doc;
  assert.deepEqual([entry(income, 'a1').seq, entry(income, 's2').seq, entry(income, 'a1').note], [2, 3, 'Salary']);
  assert.deepEqual([month(income, TODAY_B), growth(income, TODAY_B)], [10000, 120000]);
  const byDefault = updateBalances(C, params({ choice: 'income', flowId: 'a1' })).doc;
  assert.equal(entry(byDefault, 'a1').amount, 120000);

  const refund = updateBalances(C, params({ choice: 'refund' })).doc;
  assert.deepEqual([refund.entries.length, month(refund, TODAY_B), growth(refund, TODAY_B)], [2, -120000, 120000]);

  const corr = updateBalances(C, params({ choice: 'correction' })).doc;
  assert.equal(entry(corr, 's2').baseline, true);
  assert.deepEqual([month(corr, TODAY_B), growth(corr, TODAY_B)], [0, 0]);
  assert.equal(previewBalances(C, params({ choice: 'correction' })).rows[0].text, "Spending for 2–31 Oct will count as ₹0, and the ₹1,20,000 won't count as growth");

  // Under ₹1,000 a rise is a refund without asking.
  const small = updateBalances(C, { date: '2026-10-31', today: TODAY_B, rows: [{ placeId: 'sbi', amount: 20400, setId: 's2' }] });
  assert.equal(small.doc.entries.length, 2);

  // From my place, with the source updated in the same sheet (L9b): move seq 3, sets 4 and 5.
  const both = act(updateBalances, fixtureH(), { date: '2026-10-31', today: TODAY_H, rows: [
    { placeId: 'hdfc', amount: 70000, setId: 'c' },
    { placeId: 'sbi', amount: 50000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' },
  ] }).doc;
  assert.deepEqual(['m', 'c', 'd'].map((id) => entry(both, id).seq), [3, 4, 5]);
  assert.deepEqual(entry(both, 'm'), { id: 'm', kind: 'move', fromId: 'hdfc', toId: 'sbi', date: '2026-10-31', amount: 30000, seq: 3 });
  assert.equal(month(both, TODAY_H), 0);
  assert.equal(new Ledger(both, TODAY_H).setInfo('c').spent, 0);
});

test('AC8 · "From my place" dating: before a saved source balance in the gap, else on the balance date', () => {
  // HDFC's 31 Oct balance is already saved: the move goes just before it.
  const saved = withEntries(fixtureH(), set('c', 'hdfc', '2026-10-31', 70000, 3));
  const out = updateBalances(saved, { date: '2026-10-31', today: TODAY_H, rows: [{ placeId: 'sbi', amount: 50000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' }] }).doc;
  assert.deepEqual([entry(out, 'm').date, entry(out, 'm').seq, entry(out, 'd').seq], ['2026-10-31', 1.5, 4]);
  const L = new Ledger(out, TODAY_H);
  assert.deepEqual([L.setInfo('c').adj, L.setInfo('d').adj, r2(L.spentIn('2026-10-01', '2026-10-31'))], [0, 0, 0]);

  // A saved HDFC balance earlier in SBI's gap moves the date back to it.
  const earlier = withEntries(fixtureH(), set('c', 'hdfc', '2026-10-20', 70000, 3));
  const out2 = updateBalances(earlier, { date: '2026-10-31', today: TODAY_H, rows: [{ placeId: 'sbi', amount: 50000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' }] }).doc;
  assert.deepEqual([entry(out2, 'm').date, entry(out2, 'm').seq], ['2026-10-20', 1.5]);

  // L9(d): no HDFC balance in the gap: dated on SBI's day, before SBI's set.
  const out3 = updateBalances(fixtureH(), { date: '2026-10-20', today: '2026-10-20', rows: [{ placeId: 'sbi', amount: 50000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' }] }).doc;
  assert.deepEqual([entry(out3, 'm').date, entry(out3, 'm').seq, entry(out3, 'd').seq], ['2026-10-20', 3, 4]);
  assert.equal(month(out3, '2026-10-20'), 0);
  assert.equal(new Ledger(out3, '2026-10-20').current('hdfc'), 70000);

  // K: value-0 cash place; its first balance is a normal rise that needs a choice.
  const K = doc([place('hdfc', 'bank', '2026-10-01'), place('cash', 'cash', '2026-10-01')], [setB('h1', 'hdfc', '2026-10-01', 50000, 1)]);
  assert.throws(() => updateBalances(K, { date: '2026-10-10', today: TODAY_B, rows: [{ placeId: 'hdfc', amount: 45000, setId: 'h2' }, { placeId: 'cash', amount: 5000, setId: 'c1' }] }), { code: 'choose_rise' });
  const k = updateBalances(K, { date: '2026-10-10', today: TODAY_B, rows: [{ placeId: 'hdfc', amount: 45000, setId: 'h2' }, { placeId: 'cash', amount: 5000, setId: 'c1', choice: 'from', fromId: 'hdfc', flowId: 'm1' }] }).doc;
  assert.deepEqual([month(k, TODAY_B), growth(k, TODAY_B)], [0, 0]);
});

test('updateBalances: skips blank rows, refuses an empty sheet, closed places and duplicate rows', () => {
  assert.throws(() => updateBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'hdfc', amount: '' }] }), { code: 'empty' });
  const out = updateBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'hdfc', amount: '' }, { placeId: 'cash', amount: 2500, setId: 'c3' }] });
  assert.equal(out.doc.entries.length, 11);
  assert.equal(out.message, "Saved Cash's balance");
  assert.throws(() => updateBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'cash', amount: 1, setId: 'x' }, { placeId: 'cash', amount: 2, setId: 'y' }] }), { code: 'duplicate_row' });
  assert.throws(() => updateBalances(fixtureB(), { date: '2026-11-01', today: TODAY_B, rows: [{ placeId: 'cash', amount: 1, setId: 'x' }] }), { code: 'future_date' });
  assert.throws(() => updateBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'mf', amount: -5, setId: 'x' }] }), { code: 'invalid_amount' });
  const od = updateBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'cash', amount: -500, setId: 'x' }] }).doc;
  assert.equal(entry(od, 'x').amount, -500);
  const pv = previewBalances(fixtureB(), { date: TODAY_B, today: TODAY_B, rows: [{ placeId: 'cash', amount: 2500, setId: 'c3' }, { placeId: 'sip', amount: 16400, setId: 's2' }] });
  assert.deepEqual(pv.rows.map((r) => r.text), ['Spent ₹500 since 15 Oct', 'Up ₹1,400 since 10 Oct']);
});

test('AC9 · addMoney "Yes, it\'s included" goes before the saved balance', () => {
  const d = clone(fixtureA());
  d.entries[1].date = '2026-10-01';
  assert.throws(() => addMoney(d, { id: 'i1', placeId: 'hdfc', amount: 5000, date: '2026-10-31', today: TODAY_A }),
    { code: 'same_day', message: 'Is ₹5,000 already included in the ₹95,000 you entered for HDFC Savings on 31 Oct?' });
  const yes = act(addMoney, d, { id: 'i1', placeId: 'hdfc', amount: 5000, date: '2026-10-31', note: 'Interest', included: true, today: TODAY_A });
  assert.equal(entry(yes.doc, 'i1').seq, 2);
  assert.equal(yes.message, 'Added ₹5,000 to HDFC Savings');
  assert.deepEqual([month(yes.doc, TODAY_A), new Ledger(yes.doc, TODAY_A).current('hdfc'), growth(yes.doc, TODAY_A)], [65000, 95000, 60000]);
  const no = addMoney(d, { id: 'i1', placeId: 'hdfc', amount: 5000, date: '2026-10-31', included: false, today: TODAY_A });
  assert.equal(entry(no.doc, 'i1').seq, 5);
  assert.deepEqual([month(no.doc, TODAY_A), new Ledger(no.doc, TODAY_A).current('hdfc'), growth(no.doc, TODAY_A)], [60000, 100000, 65000]);
  const plain = addMoney(fixtureA(), { id: 'n1', placeId: 'hdfc', amount: 120000, date: '2026-11-03', note: ' Salary ', today: TODAY_A }).doc;
  assert.deepEqual(entry(plain, 'n1'), { id: 'n1', kind: 'add', placeId: 'hdfc', date: '2026-11-03', amount: 120000, seq: 5, note: 'Salary' });
});

test('AC10 · addMoney "included" in a starting balance saves nothing', () => {
  const d = fixtureA();
  const out = act(addMoney, d, { id: 'i1', placeId: 'hdfc', amount: 5000, date: '2026-10-01', included: true, today: TODAY_A });
  assert.equal(out.doc, d);
  assert.equal(out.message, "Already counted in HDFC Savings's starting balance");
  // A move is still saved before a starting balance: the other side changes.
  const mv = moveMoney(fixtureH(), { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 5000, date: '2026-10-01', included: true, today: TODAY_H }).doc;
  assert.equal(entry(mv, 'm').seq, 0.5);
});

test('moveMoney: same-day check covers both places; refusals', () => {
  const d = withEntries(fixtureH(), set('c', 'hdfc', '2026-10-31', 70000, 3), set('d', 'sbi', '2026-10-31', 50000, 4));
  assert.throws(() => moveMoney(d, { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 30000, date: '2026-10-31', today: TODAY_H }),
    { code: 'same_day', message: 'Is ₹30,000 already included in the balances you entered for HDFC and SBI on 31 Oct?' });
  const yes = act(moveMoney, d, { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 30000, date: '2026-10-31', included: true, today: TODAY_H });
  assert.equal(entry(yes.doc, 'm').seq, 1.5);
  assert.equal(yes.message, 'Moved ₹30,000 to SBI');
  assert.equal(month(yes.doc, TODAY_H), 0);
  assert.equal(entry(moveMoney(d, { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 30000, date: '2026-10-31', included: false, today: TODAY_H }).doc, 'm').seq, 5);
  assert.throws(() => moveMoney(d, { id: 'm', fromId: 'hdfc', toId: 'hdfc', amount: 1, date: '2026-10-31', today: TODAY_H }), { code: 'invalid_place' });
  assert.throws(() => moveMoney(d, { id: 'c', fromId: 'hdfc', toId: 'sbi', amount: 1, date: '2026-10-20', today: TODAY_H }), { code: 'bad_id' });
  assert.throws(() => moveMoney(d, { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 0, date: '2026-10-20', today: TODAY_H }), { code: 'invalid_amount' });
  assert.throws(() => moveMoney(d, { id: 'm', fromId: 'hdfc', toId: 'sbi', amount: 1, date: '2026-09-20', today: TODAY_H }), { code: 'before_created' });
});

test('AC16 · actions never modify their input, so Undo is restoring the before-doc', () => {
  const A = fixtureA();
  const snapshot = clone(A);
  const after = deleteEntry(A, { id: 'e4', today: TODAY_A }).doc;
  const later = addMoney(after, { id: 'x', placeId: 'hdfc', amount: 10, date: '2026-11-01', today: TODAY_A }).doc;
  assert.deepEqual(A, snapshot);
  assert.equal(later.entries.length, 4);
});

test('AC17 · closePlace', () => {
  const { doc: d, message } = act(closePlace, fixtureB(), { placeId: 'cash', date: '2026-10-20', to: 'hdfc', final: 3000, setId: 'cx', moveId: 'cm', today: TODAY_B });
  assert.equal(message, 'Closed Cash');
  assert.deepEqual(entry(d, 'cx'), { id: 'cx', kind: 'set', placeId: 'cash', date: '2026-10-20', amount: 3000, seq: 11 });
  assert.deepEqual(entry(d, 'cm'), { id: 'cm', kind: 'move', fromId: 'cash', toId: 'hdfc', date: '2026-10-20', amount: 3000, seq: 12 });
  assert.equal(d.places.find((p) => p.id === 'cash').closedOn, '2026-10-20');
  const L7 = editEntry(d, { id: 'e4', amount: 98000, today: TODAY_B }).doc;
  assert.deepEqual([month(L7, TODAY_B), new Ledger(L7, TODAY_B).completeThrough(), new Ledger(L7, TODAY_B).netWorth()], [61000, '2026-10-31', 309400]);

  const defaultFinal = closePlace(fixtureB(), { placeId: 'cash', date: '2026-10-20', to: 'hdfc', setId: 'cx', moveId: 'cm', today: TODAY_B }).doc;
  assert.equal(entry(defaultFinal, 'cm').amount, 3000);

  const after = withEntries(fixtureB(), move('late', 'hdfc', 'cash', '2026-10-25', 100, 11));
  assert.throws(() => closePlace(after, { placeId: 'cash', date: '2026-10-20', to: 'hdfc', setId: 'cx', moveId: 'cm', today: TODAY_B }),
    { message: 'Cash has entries after 20 Oct', code: 'entries_after' });

  const gone = closePlace(fixtureB(), { placeId: 'cash', date: '2026-10-20', setId: 'cx', today: TODAY_B }).doc;
  assert.deepEqual(entry(gone, 'cx'), { id: 'cx', kind: 'set', placeId: 'cash', date: '2026-10-20', amount: 0, seq: 11 });
  assert.equal(gone.entries.length, 11);

  const lower = closePlace(fixtureB(), { placeId: 'cash', date: '2026-10-20', to: 'hdfc', final: 2000, setId: 'cx', moveId: 'cm', today: TODAY_B }).doc;
  const L = new Ledger(lower, TODAY_B);
  assert.deepEqual([r2(L.spentIn('2026-10-01', '2026-10-31')), L.netWorth(), growth(lower, TODAY_B)], [64000, 306400, 52400]);

  const S = withEntries(fixtureB(), set('S', 'hdfc', '2026-10-20', 100000, 20));
  assert.throws(() => closePlace(S, { placeId: 'cash', date: '2026-10-20', to: 'hdfc', setId: 'cx', moveId: 'cm', today: TODAY_B }), { code: 'same_day' });
  const yes = closePlace(S, { placeId: 'cash', date: '2026-10-20', to: 'hdfc', setId: 'cx', moveId: 'cm', included: true, today: TODAY_B }).doc;
  assert.deepEqual([r2(entry(yes, 'cx').seq), r2(entry(yes, 'cm').seq)], [6.67, 13.33]);
  const no = closePlace(S, { placeId: 'cash', date: '2026-10-20', to: 'hdfc', setId: 'cx', moveId: 'cm', included: false, today: TODAY_B }).doc;
  assert.deepEqual([entry(no, 'cx').seq, entry(no, 'cm').seq], [21, 22]);

  // A balance already on the closing day is replaced (same id).
  const sameDay = withEntries(fixtureB(), set('c3', 'cash', '2026-10-20', 2800, 11));
  const replaced = closePlace(sameDay, { placeId: 'cash', date: '2026-10-20', to: 'hdfc', final: 2800, setId: 'cx', moveId: 'cm', today: TODAY_B }).doc;
  assert.deepEqual([entry(replaced, 'c3').amount, entry(replaced, 'c3').seq, replaced.entries.some((e) => e.id === 'cx')], [2800, 12, false]);

  assert.throws(() => closePlace(d, { placeId: 'cash', date: '2026-10-25', setId: 'z', today: TODAY_B }), { code: 'closed' });
  const reopened = act(reopenPlace, d, { placeId: 'cash', today: TODAY_B });
  assert.equal('closedOn' in reopened.doc.places.find((p) => p.id === 'cash'), false);
  assert.equal(reopened.message, 'Reopened Cash');
});

test('AC18 · deletePlace removes its entries, both sides of its moves', () => {
  const { doc: d, message } = act(deletePlace, fixtureA(), { placeId: 'sip', today: TODAY_A });
  assert.equal(message, 'Deleted Axis SIP');
  assert.deepEqual(d.entries.map((e) => e.id), ['e1', 'e2', 'e4']);
  assert.deepEqual([month(d, TODAY_A), growth(d, TODAY_A), new Ledger(d, TODAY_A).netWorth()], [75000, 45000, 95000]);
});

test('L34 / L41 · deletePlace through the action', () => {
  const A = fixtureA();
  A.places.push(place('fd', 'fd', '2026-10-01', { closedOn: '2026-10-20' }));
  A.entries[3].amount = 202000;
  A.entries.push(setB('g1', 'fd', '2026-10-01', 100000, 5), set('g2', 'fd', '2026-10-20', 107000, 6), move('g3', 'fd', 'hdfc', '2026-10-20', 107000, 7));
  valid(A, TODAY_A);
  const d = deletePlace(A, { placeId: 'fd', today: TODAY_A }).doc;
  assert.deepEqual([month(d, TODAY_A), growth(d, TODAY_A), new Ledger(d, TODAY_A).netWorthAt('2026-10-31')], [-47000, 167000, 217000]);
});

test('AC19 · a starting balance cannot be deleted while other entries exist', () => {
  assert.throws(() => deleteEntry(fixtureA(), { id: 'e1', today: TODAY_A }), { message: 'Delete the place instead', code: 'starting_balance' });
  const only = doc([place('h', 'bank', '2026-10-01')], [setB('a', 'h', '2026-10-01', 5, 1)]);
  assert.deepEqual(deleteEntry(only, { id: 'a', today: TODAY_A }).doc.entries, []);
  const out = act(deleteEntry, fixtureA(), { id: 'e2', today: TODAY_A });
  assert.equal(out.message, 'Added money deleted');
  assert.equal(month(out.doc, TODAY_A), -60000);
});

test('AC20 · editEntry date rules', () => {
  assert.throws(() => editEntry(fixtureA(), { id: 'e1', date: '2026-10-05', today: TODAY_A }),
    { message: "HDFC Savings's starting balance can't be after its first other entry (3 Oct)", code: 'start_after_first' });
  const { doc: d } = act(editEntry, fixtureA(), { id: 'e1', date: '2026-09-25', today: TODAY_A });
  assert.equal(d.places[0].createdOn, '2026-09-25');
  valid(d, TODAY_A);
  assert.deepEqual([month(d, TODAY_A, '2026-09'), month(d, TODAY_A)], [8333.33, 51666.67]);
  // Re-dated onto the day of its first other entry it stays first.
  const onFirst = editEntry(fixtureA(), { id: 'e1', date: '2026-10-03', today: TODAY_A }).doc;
  assert.deepEqual([onFirst.places[0].createdOn, entry(onFirst, 'e1').seq], ['2026-10-03', 1]);

  const e5 = withEntries(fixtureA(), set('e5', 'hdfc', '2026-10-15', 40000, 5));
  assert.throws(() => editEntry(e5, { id: 'e5', date: '2026-10-31', today: TODAY_A }),
    { message: 'HDFC Savings already has a balance on 31 Oct — edit that one', code: 'set_exists' });
  assert.throws(() => editEntry(fixtureA(), { id: 'e4', date: '2026-09-30', today: TODAY_A }), { code: 'before_created' });
  assert.throws(() => editEntry(fixtureA(), { id: 'e2', date: '2026-09-30', today: TODAY_A }), { code: 'before_created' });

  const moved = editEntry(fixtureA(), { id: 'e4', date: '2026-11-04', amount: 87000, today: TODAY_A }).doc;
  assert.deepEqual([entry(moved, 'e4').seq, month(moved, TODAY_A, '2026-11')], [5, 8000]);
  const amountOnly = editEntry(fixtureA(), { id: 'e4', amount: 100000, today: TODAY_A }).doc;
  assert.deepEqual([entry(amountOnly, 'e4').seq, month(amountOnly, TODAY_A), growth(amountOnly, TODAY_A)], [4, 55000, 65000]);
  const corr = editEntry(fixtureA(), { id: 'e4', baseline: true, today: TODAY_A }).doc;
  assert.deepEqual([entry(corr, 'e4').baseline, month(corr, TODAY_A)], [true, 0]);
  const uncorr = editEntry(corr, { id: 'e4', baseline: false, note: '', today: TODAY_A }).doc;
  assert.equal('baseline' in entry(uncorr, 'e4'), false);
  assert.equal(editEntry(fixtureA(), { id: 'e1', baseline: false, today: TODAY_A }).doc.entries[0].baseline, true);
  assert.throws(() => editEntry(fixtureA(), { id: 'r1-2026-10', fromId: 'sip', toId: 'sip', today: TODAY_A }), { code: 'invalid_place' });
  const toSip = editEntry(fixtureA(), { id: 'e2', placeId: 'sip', date: '2026-10-12', today: TODAY_A }).doc;
  assert.equal(new Ledger(toSip, TODAY_A).current('sip'), 135000);
});

test('AC21 · the same-day check runs on every flow path', () => {
  // L36: Add place "Moved from…" after a same-day balance.
  const L36 = doc([place('hdfc', 'bank', '2026-10-01', { name: 'HDFC' })], [setB('a', 'hdfc', '2026-10-01', 150000, 1), set('b', 'hdfc', '2026-10-31', 95000, 2)]);
  const fdParams = { id: 'fd', type: 'fd', date: '2026-10-31', value: 50000, source: 'moved', fromId: 'hdfc', entryId: 'm', today: TODAY_B };
  assert.throws(() => addPlace(L36, fdParams), { code: 'same_day', sets: [{ id: 'b', placeId: 'hdfc', name: 'HDFC', amount: 95000, date: '2026-10-31', seq: 2, starting: false }] });
  const yes = addPlace(L36, { ...fdParams, included: true }).doc;
  assert.equal(entry(yes, 'm').seq, 1);
  assert.deepEqual([new Ledger(yes, TODAY_B).netWorth(), month(yes, TODAY_B), growth(yes, TODAY_B)], [145000, 5000, -5000]);
  const no = addPlace(L36, { ...fdParams, included: false }).doc;
  assert.equal(entry(no, 'm').seq, 3);
  assert.deepEqual([new Ledger(no, TODAY_B).netWorth(), month(no, TODAY_B)], [95000, 55000]);

  // Close to HDFC on 31 Oct.
  assert.deepEqual(sameDayCheck(fixtureA(), { placeId: 'hdfc', date: '2026-10-31' }).map((s) => s.id), ['e4']);
  const A = edit2(fixtureA());
  assert.throws(() => closePlace(A, { placeId: 'sip', date: '2026-10-31', to: 'hdfc', setId: 'x', moveId: 'y', today: TODAY_A }), { code: 'same_day' });

  // e2 re-dated to 31 Oct: "Yes" gives seq 2.
  assert.throws(() => editEntry(fixtureA(), { id: 'e2', date: '2026-10-31', today: TODAY_A }), { code: 'same_day' });
  assert.equal(entry(editEntry(fixtureA(), { id: 'e2', date: '2026-10-31', included: true, today: TODAY_A }).doc, 'e2').seq, 2);
  assert.equal(entry(editEntry(fixtureA(), { id: 'e2', date: '2026-10-31', included: false, today: TODAY_A }).doc, 'e2').seq, 5);

  // A move recorded on a balance date (L37).
  const L37 = doc([place('hdfc', 'bank', '2026-10-01'), place('sip', 'sip', '2026-10-10')],
    [setB('a', 'hdfc', '2026-10-01', 50000, 1), add('b', 'hdfc', '2026-10-03', 120000, 2), set('c', 'hdfc', '2026-10-10', 170000, 3), set('d', 'hdfc', '2026-10-31', 95000, 4)]);
  assert.deepEqual(sameDayCheck(L37, { fromId: 'hdfc', toId: 'sip', date: '2026-10-10' }).map((s) => s.id), ['c']);
  const rec = moveMoney(L37, { id: 'r', fromId: 'hdfc', toId: 'sip', amount: 15000, date: '2026-10-10', included: false, today: TODAY_A }).doc;
  assert.equal(entry(rec, 'r').seq, 5);
  assert.equal(month(rec, TODAY_A), 60000);
  assert.equal(sameDayQuestion(15000, []), null);
});
const edit2 = (d) => { const x = clone(d); x.places[1].createdOn = '2026-10-10'; return x; };

test('AC26 (adapted) · FD maturity: close the FD into HDFC, then update HDFC (L33)', () => {
  const start = doc(
    [place('hdfc', 'bank', '2026-10-01', { name: 'HDFC Savings' }), place('sip', 'sip', '2026-10-10'), place('fd', 'fd', '2026-10-01', { name: 'FD' })],
    [setB('e1', 'hdfc', '2026-10-01', 50000, 1), setB('f1', 'fd', '2026-10-01', 100000, 2), add('e2', 'hdfc', '2026-10-03', 120000, 3),
      move('r1-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 4)],
  );
  const closed = closePlace(start, { placeId: 'fd', date: '2026-10-31', to: 'hdfc', final: 107000, setId: 'fx', moveId: 'fm', today: TODAY_A }).doc;
  const d = updateBalances(closed, { date: '2026-10-31', today: TODAY_A, rows: [{ placeId: 'hdfc', amount: 202000, setId: 'e4' }] }).doc;
  assert.deepEqual(['fx', 'fm', 'e4'].map((id) => entry(d, id).seq), [5, 6, 7]);
  assert.equal(d.places[2].closedOn, '2026-10-31');
  const L = new Ledger(d, TODAY_A);
  assert.deepEqual([month(d, TODAY_A), growth(d, TODAY_A), L.current('fd'), L.netWorthAt('2026-10-31')], [60000, 67000, 0, 217000]);
});

test('editPlace: name, note and type (refused when a negative balance would land on an investment)', () => {
  const { doc: d, message } = act(editPlace, fixtureB(), { id: 'cash', name: ' Wallet ', note: 'Paytm', today: TODAY_B });
  assert.deepEqual(d.places[2], { id: 'cash', name: 'Wallet', type: 'cash', createdOn: '2026-10-01', note: 'Paytm' });
  assert.equal(message, 'Saved Wallet');
  assert.equal('note' in editPlace(d, { id: 'cash', note: '', today: TODAY_B }).doc.places[2], false);
  const t = editPlace(fixtureB(), { id: 'cash', type: 'gold', today: TODAY_B }).doc;
  assert.equal(month(t, TODAY_B), 54000);
  assert.throws(() => editPlace(fixtureB(), { id: 'cash', name: '  ', today: TODAY_B }), { code: 'invalid_name' });
  const neg = withEntries(fixtureH(), set('n', 'sbi', '2026-10-31', -500, 3));
  assert.throws(() => editPlace(neg, { id: 'sbi', type: 'fd', today: TODAY_H }), { code: 'negative_balance' });
});

test('lastAdd and lastMove feed "Same as last"', () => {
  assert.equal(lastAdd(fixtureB()).id, 'e2');
  assert.equal(lastMove(fixtureB()).id, 'm2');
  assert.equal(lastAdd(fixtureH()), null);
  const closed = editPlaceIn(fixtureB(), 'cash', { closedOn: '2026-10-20' });
  assert.equal(lastMove(closed).id, 'r1-2026-10');
});

// ---------------------------------------------------------------- review regressions

test('R1 · a rise made by another row\'s "From my place" move is prompted and can be answered', () => {
  const rows = [
    { placeId: 'hdfc', amount: 75000, setId: 'c' },
    { placeId: 'sbi', amount: 50000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' },
  ];
  const base = { date: '2026-10-31', today: TODAY_H };
  // HDFC alone looks like spending; after SBI's ₹30,000 move out of it, it is ₹5,000 above expected.
  const pv = previewBalances(fixtureH(), { ...base, rows });
  assert.deepEqual(pv.problems.map((x) => [x.placeId, x.code, x.message]), [['hdfc', 'choose_rise', "Choose where HDFC's ₹5,000 came from"]]);
  const plan = planPrompts(fixtureH(), { ...base, rows });
  assert.deepEqual(Object.fromEntries(plan.prompts), { sbi: 30000, hdfc: 5000 });
  assert.equal(plan.preview.ok, false);
  // The answer for HDFC is now sent and accepted.
  const answered = planPrompts(fixtureH(), { ...base, rows: [{ ...rows[0], choice: 'refund' }, rows[1]] });
  assert.equal(answered.preview.ok, true);
  assert.equal(answered.params.rows[0].choice, 'refund');
  assert.deepEqual(Object.fromEntries(answered.prompts), { sbi: 30000, hdfc: 5000 }, 'the prompt stays open once answered');
  const out = updateBalances(fixtureH(), answered.params).doc;
  assert.equal(r2(new Ledger(out, TODAY_H).setInfo('c').adj), 5000);
  // "Money came in" with no amount defaults to the planned rise (₹5,000), not HDFC's raw −₹25,000.
  const income = planPrompts(fixtureH(), { ...base, rows: [{ ...rows[0], choice: 'income', flowId: 'n' }, rows[1]] });
  assert.equal(income.preview.ok, true);
  assert.equal(income.params.rows[0].flowAmount, 5000);
  const L = new Ledger(updateBalances(fixtureH(), income.params).doc, TODAY_H);
  assert.deepEqual([L.setInfo('c').adj, L.setInfo('d').adj], [0, 0]);
});

test('R1 · planPrompts drops a choice that is no longer needed', () => {
  const base = { date: '2026-10-31', today: TODAY_H };
  // SBI is as expected: its leftover choice is not sent.
  const plan = planPrompts(fixtureH(), { ...base, rows: [{ placeId: 'sbi', amount: 20000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' }] });
  assert.deepEqual([plan.params.rows[0].choice, plan.prompts.size, plan.preview.ok], [undefined, 0, true]);
  // Without SBI's move HDFC has no rise, so HDFC's stale answer is dropped too.
  const chain = planPrompts(fixtureH(), { ...base, rows: [
    { placeId: 'hdfc', amount: 75000, setId: 'c', choice: 'refund' },
    { placeId: 'sbi', amount: 20000, setId: 'd', choice: 'from', fromId: 'hdfc', flowId: 'm' },
  ] });
  assert.deepEqual([chain.params.rows.map((r) => r.choice), chain.prompts.size, chain.preview.ok], [[undefined, undefined], 0, true]);
});

test('R3 · closePlace "Yes, it\'s included" is refused when the closing place has later same-day entries', () => {
  const S = withEntries(fixtureB(), set('S', 'hdfc', '2026-10-20', 100000, 11), add('x', 'cash', '2026-10-20', 500, 12));
  const params = { placeId: 'cash', date: '2026-10-20', to: 'hdfc', final: 3500, setId: 'cx', moveId: 'cm', today: TODAY_B };
  assert.throws(() => closePlace(S, { ...params, included: true }), { code: 'close_order' });
  // "No" puts the close after everything that day, so the place ends at ₹0.
  const no = closePlace(S, { ...params, included: false }).doc;
  assert.equal(new Ledger(no, TODAY_B).current('cash'), 0);
  // Entries of the closing place before the target's balance are fine.
  const early = withEntries(fixtureB(), add('x', 'cash', '2026-10-20', 500, 11), set('S', 'hdfc', '2026-10-20', 100000, 12));
  const yes = closePlace(early, { ...params, included: true }).doc;
  const L = new Ledger(yes, TODAY_B);
  assert.deepEqual([L.current('cash'), entry(yes, 'cx').seq > 11, entry(yes, 'cm').seq < 12], [0, true, true]);
});

test('R4 · the rise choice on the day a value-0 place starts makes a starting balance', () => {
  const d0 = doc([place('hdfc', 'bank', '2026-10-01', { name: 'HDFC' }), place('cash', 'cash', '2026-10-10', { name: 'Cash' })], [setB('h1', 'hdfc', '2026-10-01', 50000, 1)]);
  const row = { placeId: 'cash', amount: 5000, setId: 's1', choice: 'correction' };
  const pv = previewBalances(d0, { date: '2026-10-10', today: TODAY_B, rows: [row] });
  assert.deepEqual([pv.ok, pv.rows[0].kind, pv.rows[0].text], [true, 'starting', 'Starting balance']);
  const out = updateBalances(d0, { date: '2026-10-10', today: TODAY_B, rows: [row] }).doc;
  const info = new Ledger(out, TODAY_B).setInfo('s1');
  assert.deepEqual([info.starting, info.correction], [true, false]);
  // On a later day the same choice is a Correction.
  const later = updateBalances(d0, { date: '2026-10-12', today: TODAY_B, rows: [{ ...row, setId: 's2' }] }).doc;
  assert.deepEqual([new Ledger(later, TODAY_B).setInfo('s2').correction], [true]);
});

test('R5 · an entry dated tomorrow can still be edited without changing its date', () => {
  const d = withEntries(fixtureH(), add('x', 'hdfc', '2026-11-01', 50, 3), set('y', 'sbi', '2026-11-01', 20000, 4), move('z', 'hdfc', 'sbi', '2026-11-01', 10, 5));
  assert.equal(entry(editEntry(d, { id: 'x', amount: 60, today: TODAY_H }).doc, 'x').amount, 60);
  assert.equal(entry(editEntry(d, { id: 'x', note: 'Gift', today: TODAY_H }).doc, 'x').note, 'Gift');
  assert.equal(entry(editEntry(d, { id: 'y', amount: 21000, today: TODAY_H }).doc, 'y').amount, 21000);
  assert.equal(entry(editEntry(d, { id: 'z', amount: 20, today: TODAY_H }).doc, 'z').amount, 20);
  // Moving an entry onto tomorrow is still refused.
  assert.throws(() => editEntry(fixtureA(), { id: 'e2', date: '2026-11-06', today: TODAY_A }), { code: 'future_date' });
});

test('R6 / R8 · a missing place is "Choose a place", and "Moved to…" without a target never closes as spent', () => {
  const before = clone(fixtureB());
  assert.throws(() => closePlace(fixtureB(), { placeId: 'cash', date: '2026-10-20', to: null, final: 3000, setId: 'cx', moveId: 'cm', today: TODAY_B }),
    { message: 'Choose the place it went to', code: 'choose_place' });
  assert.deepEqual(fixtureB(), before);
  assert.throws(() => addMoney(fixtureH(), { id: 'n', placeId: null, amount: 5000, date: '2026-10-31', today: TODAY_H }), { message: 'Choose a place', code: 'choose_place' });
  assert.throws(() => moveMoney(fixtureH(), { id: 'n', fromId: 'hdfc', toId: undefined, amount: 5000, date: '2026-10-31', today: TODAY_H }), { message: 'Choose a place', code: 'choose_place' });
  assert.throws(() => addPlace(fixtureH(), { id: 'gold', type: 'gold', date: '2026-10-20', value: 7000, source: 'moved', fromId: '', entryId: 'g1', today: TODAY_H }), { message: 'Choose a place', code: 'choose_place' });
  assert.throws(() => addMoney(fixtureH(), { id: 'n', placeId: 'nope', amount: 5000, date: '2026-10-31', today: TODAY_H }), { code: 'missing' });
});
