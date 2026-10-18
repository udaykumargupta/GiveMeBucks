// §8.7 format vectors (F), plus the sign and age rules the cards rely on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, moneyShort, signed, pctFmt, parseAmount, daysAgoText, dateText } from '../public/js/format.js';

test('F parseAmount accepts Indian grouping and L/Cr/K suffixes', () => {
  assert.equal(parseAmount('1,23,456'), 123456);
  assert.equal(parseAmount('₹ 1.5L'), 150000);
  assert.equal(parseAmount('2cr'), 20000000);
  assert.equal(parseAmount('45k'), 45000);
  assert.equal(parseAmount('-5,000'), -5000);
  assert.equal(parseAmount('1.2', 'L'), 120000);
  assert.equal(parseAmount('1.5L', 'K'), 150000, 'a typed suffix wins');
  assert.equal(parseAmount('abc'), null);
});

test('F parseAmount edge cases', () => {
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('   '), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('1.2.3'), null);
  assert.equal(parseAmount('L'), null);
  assert.equal(parseAmount('Rs. 2,500'), 2500);
  assert.equal(parseAmount('−3,000'), -3000, 'U+2212 minus');
  assert.equal(parseAmount('1.5 lakh'), 150000);
  assert.equal(parseAmount('0.333'), 0.33);
  assert.equal(parseAmount('-0'), 0);
  assert.ok(!Object.is(parseAmount('-0'), -0));
  assert.equal(parseAmount('1e5'), null, 'no exponent notation');
});

test('F money: full Indian format, U+2212, never −₹0', () => {
  assert.equal(money(1234567), '₹12,34,567');
  assert.equal(money(-3000), '−₹3,000');
  assert.equal(money(-0.001), '₹0');
  assert.equal(money(-0.4), '₹0');
  assert.equal(money(0), '₹0');
  assert.equal(money(99.5), '₹100');
  assert.equal(money(null), '—');
  assert.equal(money(NaN), '—');
});

test('F signed', () => {
  assert.equal(signed(62000), '+₹62,000');
  assert.equal(signed(-57600), '−₹57,600');
  assert.equal(signed(0), '₹0');
  assert.equal(signed(-0.2), '₹0');
  assert.equal(signed(150000, { short: true }), '+₹1.5L');
});

test('F moneyShort: Indian L / Cr / K', () => {
  assert.equal(moneyShort(123456), '₹1.23L');
  assert.equal(moneyShort(1234567), '₹12.3L');
  assert.equal(moneyShort(24563000), '₹2.46Cr');
  assert.equal(moneyShort(45000), '₹45K');
  assert.equal(moneyShort(99999), '₹1L');
  assert.equal(moneyShort(500), '₹500');
  assert.equal(moneyShort(0), '₹0');
  assert.equal(moneyShort(-0.3), '₹0');
  assert.equal(moneyShort(-250000), '−₹2.5L');
});

test('F pctFmt', () => {
  assert.equal(pctFmt(0.123), '+12.3%');
  assert.equal(pctFmt(-0.05), '−5.0%');
  assert.equal(pctFmt(0), '0.0%');
  assert.equal(pctFmt(-0.00001), '0.0%');
});

test('F daysAgoText and dateText', () => {
  assert.equal(daysAgoText(0), 'today');
  assert.equal(daysAgoText(1), 'yesterday');
  assert.equal(daysAgoText(16), '16 days ago');
  assert.equal(daysAgoText(null), 'never');
  assert.equal(daysAgoText(null, '2026-10-15', '2026-10-31'), '16 days ago');
  assert.equal(daysAgoText(40, '2026-09-12', '2026-10-22'), '12 Sep');
  assert.equal(dateText('2026-10-31', '2026-11-02'), '31 Oct');
  assert.equal(dateText('2025-10-31', '2026-11-02'), '31 Oct 2025');
});
