import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, dueItems, toDay, monthStartDay, monthEndDay } from '../public/js/calc.js';
import { parseAmount, money } from '../public/js/format.js';

const bank = (id, name = id) => ({ id, name, kind: 'bank' });
const snap = (accountId, date, value, invested) => ({ id: `${accountId}-${date}`, accountId, date, value, ...(invested != null ? { invested } : {}) });
const income = (date, amount, source = 'Salary', month) => ({ id: `i-${date}-${amount}`, date, amount, source, ...(month ? { month } : {}) });
const db = (over = {}) => ({ accounts: [], snapshots: [], income: [], settings: {}, ...over });

test('spending = opening balance + income − closing balance', () => {
  const L = new Ledger(db({
    accounts: [bank('a'), bank('b')],
    snapshots: [snap('a', '2026-09-06', 100000), snap('b', '2026-09-06', 50000), snap('a', '2026-09-13', 160000), snap('b', '2026-09-13', 40000)],
    income: [income('2026-09-10', 80000)],
  }), '2026-09-20');
  // 150k + 80k − 200k = 30k spent across 7 days
  const e = L.expenseIn(toDay('2026-09-07'), toDay('2026-09-13'));
  assert.equal(Math.round(e.amount), 30000);
  assert.equal(e.complete, true);
});

test('money moved into an investment is saving, not spending', () => {
  const L = new Ledger(db({
    accounts: [bank('a'), { id: 'mf', name: 'MF', kind: 'mutual_fund' }],
    snapshots: [snap('a', '2026-09-01', 100000), snap('mf', '2026-09-01', 50000, 50000), snap('a', '2026-09-08', 80000), snap('mf', '2026-09-08', 70500, 70000)],
  }), '2026-09-10');
  const e = L.expenseIn(toDay('2026-09-02'), toDay('2026-09-08'));
  assert.equal(Math.round(e.amount), 0);
  assert.equal(Math.round(e.invested), 20000);
});

test('SIP installments are added between manual updates', () => {
  const L = new Ledger(db({
    accounts: [{ id: 'mf', name: 'MF', kind: 'mutual_fund', sip: { amount: 10000, day: 10 } }],
    snapshots: [snap('mf', '2026-08-01', 100000, 90000)],
  }), '2026-10-17');
  const mf = L.byId.get('mf');
  assert.equal(L.investedAt(mf, L.today), 90000 + 3 * 10000); // Aug 10, Sep 10, Oct 10
});

test('opening holdings are not mistaken for new money', () => {
  const L = new Ledger(db({
    accounts: [bank('a'), { id: 'st', name: 'Stocks', kind: 'stocks' }],
    snapshots: [snap('a', '2026-09-01', 100000), snap('a', '2026-09-08', 95000), snap('st', '2026-09-05', 300000, 250000)],
  }), '2026-09-10');
  assert.equal(Math.round(L.expenseIn(toDay('2026-09-02'), toDay('2026-09-08')).amount), 5000);
});

test('FD grows with quarterly compounding and is frozen at maturity', () => {
  const L = new Ledger(db({
    accounts: [{ id: 'fd', name: 'FD', kind: 'fd', fd: { principal: 100000, rate: 8, startDate: '2025-01-01', maturityDate: '2026-01-01' } }],
  }), '2026-06-01');
  const fd = L.byId.get('fd');
  const atMaturity = L.valueAt(fd, toDay('2026-01-01'));
  assert.ok(Math.abs(atMaturity - 100000 * 1.02 ** 4) < 1);
  assert.equal(L.current(fd), atMaturity);
});

test('closing an FD returns its full value to the bank without phantom spending', () => {
  const L = new Ledger(db({
    accounts: [bank('a'), { id: 'fd', name: 'FD', kind: 'fd', closedOn: '2026-03-05', fd: { principal: 100000, rate: 8, startDate: '2025-03-01', maturityDate: '2026-03-01' } }],
    snapshots: [snap('a', '2026-03-01', 20000), snap('a', '2026-03-08', 20000 + 108243)],
  }), '2026-03-10');
  const e = L.expenseIn(toDay('2026-03-02'), toDay('2026-03-08'));
  assert.ok(Math.abs(e.amount) < 5, `expected ~0, got ${e.amount}`);
});

test('due items: stale banks, missing income, stale investments', () => {
  const items = dueItems(db({
    accounts: [bank('a'), { id: 'mf', name: 'MF', kind: 'mutual_fund' }],
    snapshots: [snap('a', '2026-10-01', 1000), snap('mf', '2026-08-01', 1000)],
    income: [income('2026-09-01', 1000)],
  }), '2026-10-17');
  assert.deepEqual(items.map((i) => i.id).sort(), ['bank', 'income', 'investments']);
  assert.equal(items.find((i) => i.id === 'bank').severity, 'critical');
});

test('no reminders when everything is fresh', () => {
  assert.deepEqual(dueItems(db({
    accounts: [bank('a')],
    snapshots: [snap('a', '2026-10-15', 1000)],
    income: [income('2026-10-01', 1000)],
  }), '2026-10-17'), []);
});

test('amount parsing understands Indian shorthand', () => {
  assert.equal(parseAmount('1,23,456'), 123456);
  assert.equal(parseAmount('₹ 1.5L'), 150000);
  assert.equal(parseAmount('2cr'), 20000000);
  assert.equal(parseAmount('45k'), 45000);
  assert.equal(parseAmount('abc'), null);
  assert.equal(money(1234567), '₹12,34,567');
});

test('monthly expense covers full months only when checked in', () => {
  const L = new Ledger(db({ accounts: [bank('a')], snapshots: [snap('a', '2026-09-15', 1000), snap('a', '2026-10-15', 500)] }), '2026-10-17');
  const sep = L.expenseIn(monthStartDay('2026-09'), monthEndDay('2026-09'));
  assert.equal(sep.complete, false);
  assert.equal(sep.covered, 15);
});
