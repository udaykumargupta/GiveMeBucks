// Deterministic two-year sample history so the dashboard can be explored
// before any real data is entered. Simulates two bank accounts, salary with
// yearly hikes, a SIP, FDs, stocks, EPF and gold, with weekly check-ins.
import { toDay, fromDay, todayISO, addMonths, monthOf, monthEndDay, yearStartOf } from './calc.js';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleDb(today = todayISO()) {
  const R = mulberry32(20261017);
  const gauss = () => Math.sqrt(-2 * Math.log(R() || 1e-9)) * Math.cos(2 * Math.PI * R());
  const T = toDay(today);
  const startMonth = addMonths(monthOf(today), -25);
  const S = toDay(`${startMonth}-01`);
  const round = (v) => Math.round(v);

  const accounts = [
    { id: 'hdfc', name: 'HDFC Savings', kind: 'bank', institution: 'HDFC Bank' },
    { id: 'sbi', name: 'SBI Savings', kind: 'bank', institution: 'State Bank of India' },
    { id: 'mf', name: 'Mutual fund SIPs', kind: 'mutual_fund', institution: 'Groww', sip: { amount: 25000, day: 10 } },
    { id: 'stocks', name: 'Stock portfolio', kind: 'stocks', institution: 'Zerodha' },
    { id: 'epf', name: 'EPF', kind: 'epf', institution: 'EPFO' },
    { id: 'gold', name: 'Sovereign gold bonds', kind: 'gold' },
    {
      id: 'fd1', name: 'SBI FD · 3 yr', kind: 'fd', institution: 'State Bank of India',
      fd: { principal: 200000, rate: 7.1, startDate: fromDay(T - 1075), maturityDate: fromDay(T - 1075 + 1095) },
    },
    {
      id: 'fd2', name: 'HDFC FD · 3 yr', kind: 'fd', institution: 'HDFC Bank', openingFromBank: true,
      fd: { principal: 150000, rate: 7.25, startDate: fromDay(T - 240), maturityDate: fromDay(T - 240 + 1095) },
    },
  ];

  const bal = { hdfc: 185000, sbi: 92000 };
  const inv = {
    mf: { inv: 120000, val: 131500 },
    stocks: { inv: 150000, val: 161000 },
    epf: { inv: 305000, val: 318000 },
    gold: { inv: 60000, val: 66500 },
  };
  const snapshots = [];
  const income = [];
  let sid = 0;
  const snap = (accountId, day, value, invested) =>
    snapshots.push({ id: `s${++sid}`, accountId, date: fromDay(day), value: round(value), ...(invested != null ? { invested: round(invested) } : {}) });
  const earn = (day, amount, source, note) =>
    income.push({ id: `i${++sid}`, date: fromDay(day), month: monthOf(fromDay(day)), amount: round(amount), source, ...(note ? { note } : {}) });

  const fyStart = yearStartOf(startMonth, 'fy');
  const fd2Start = T - 240;

  for (let d = S; d <= T; d++) {
    const iso = fromDay(d);
    const [, m, dd] = iso.split('-').map(Number);
    const hikes = yearStartOf(monthOf(iso), 'fy') - fyStart;
    const salary = round(98000 * Math.pow(1.12, hikes) / 100) * 100;

    if (dd === 1) {
      bal.hdfc += salary;
      earn(d, salary, 'Salary');
      const epf = salary * 0.4 * 0.24;
      inv.epf.inv += epf; inv.epf.val += epf;
    }
    if (m === 3 && dd === 20) { const b = salary * 1.2; bal.hdfc += b; earn(d, b, 'Bonus', 'Annual performance bonus'); }
    if (dd === 5) bal.hdfc -= 18000; // rent
    if (dd === 10) { bal.hdfc -= 25000; inv.mf.inv += 25000; inv.mf.val += 25000; } // SIP
    if (dd === 12) { bal.hdfc -= 20000; bal.sbi += 20000; } // own transfer
    if (dd === 15) bal.sbi -= 4200; // bills
    if (d === fd2Start) bal.hdfc -= 150000;

    const weekend = (d + 3) % 7 >= 5;
    const spend = Math.max(150, (weekend ? 2100 : 1250) + gauss() * 450);
    bal.hdfc -= spend * 0.6; bal.sbi -= spend * 0.4;
    if (R() < 0.013) bal.hdfc -= 9000 + R() * 30000; // travel / shopping
    if (R() < 0.006) { const f = 15000 + R() * 30000; bal.sbi += f; earn(d, f, 'Freelance', 'Side project'); }
    if (dd === 28 && m % 3 === 0) { const i = bal.sbi * 0.0075; bal.sbi += i; earn(d, i, 'Interest', 'Savings interest'); }

    if (d === monthEndDay(monthOf(iso))) {
      inv.mf.val *= 1.011 + gauss() * 0.035;
      inv.stocks.val *= 1.012 + gauss() * 0.055;
      inv.gold.val *= 1.008 + gauss() * 0.03;
      inv.epf.val *= 1 + 0.0825 / 12;
    }

    const isSunday = (d + 3) % 7 === 6;
    if (d === S) {
      snap('hdfc', d, bal.hdfc); snap('sbi', d, bal.sbi);
      for (const k of Object.keys(inv)) snap(k, d, inv[k].val, inv[k].inv);
    } else if (isSunday) {
      const lastSunday = T - d < 7;
      if (lastSunday || R() > 0.1) { snap('hdfc', d, bal.hdfc); snap('sbi', d, bal.sbi); }
      if (dd <= 7) {
        snap('mf', d, inv.mf.val, inv.mf.inv);
        snap('epf', d, inv.epf.val, inv.epf.inv);
        if (T - d > 40) snap('stocks', d, inv.stocks.val, inv.stocks.inv);
        if (m % 3 === 1) snap('gold', d, inv.gold.val, inv.gold.inv);
      }
    }
  }

  return {
    rev: 0,
    accounts,
    snapshots,
    income,
    settings: {
      owner: '',
      title: 'Wealth Growth',
      goal: { target: 5000000, by: `${Number(today.slice(0, 4)) + 1}-12-31` },
    },
    meta: { sample: true, createdAt: new Date().toISOString() },
  };
}
