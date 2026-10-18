// Shared builders and the §8.1 fixtures for the core tests (not a test file itself).
export const place = (id, type, createdOn, extra = {}) => ({ id, name: id, type, createdOn, ...extra });
export const set = (id, placeId, date, amount, seq, extra = {}) => ({ id, kind: 'set', placeId, date, amount, seq, ...extra });
export const setB = (id, placeId, date, amount, seq, extra = {}) => set(id, placeId, date, amount, seq, { baseline: true, ...extra });
export const add = (id, placeId, date, amount, seq, note) => ({ id, kind: 'add', placeId, date, amount, seq, ...(note ? { note } : {}) });
export const move = (id, fromId, toId, date, amount, seq, extra = {}) => ({ id, kind: 'move', fromId, toId, date, amount, seq, ...extra });
export const doc = (places, entries) => ({ version: 2, rev: 0, places, entries });
export const clone = (x) => structuredClone(x);
export const r2 = (x) => (x == null ? x : Math.round(x * 100) / 100 || 0);

/** Fixture A (today 2026-11-05). The monthly SIP move is a plain move (rules are not part of v2). */
export const TODAY_A = '2026-11-05';
export function fixtureA() {
  return doc(
    [place('hdfc', 'bank', '2026-10-01', { name: 'HDFC Savings' }), place('sip', 'sip', '2026-10-10', { name: 'Axis SIP' })],
    [
      setB('e1', 'hdfc', '2026-10-01', 50000, 1),
      add('e2', 'hdfc', '2026-10-03', 120000, 2, 'Salary'),
      move('r1-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 3),
      set('e4', 'hdfc', '2026-10-31', 95000, 4),
    ],
  );
}

/** Fixture B (today 2026-10-31). */
export const TODAY_B = '2026-10-31';
export function fixtureB() {
  return doc(
    [
      place('hdfc', 'bank', '2026-10-01', { name: 'HDFC Savings' }),
      place('sip', 'sip', '2026-10-10', { name: 'Axis SIP' }),
      place('cash', 'cash', '2026-10-01', { name: 'Cash' }),
      place('mf', 'mutual_fund', '2026-10-01', { name: 'Mutual funds' }),
    ],
    [
      setB('e1', 'hdfc', '2026-10-01', 50000, 1),
      setB('c1', 'cash', '2026-10-01', 4000, 2),
      setB('f1', 'mf', '2026-10-01', 200000, 3),
      add('e2', 'hdfc', '2026-10-03', 120000, 4),
      move('r1-2026-10', 'hdfc', 'sip', '2026-10-10', 15000, 5),
      move('m2', 'hdfc', 'cash', '2026-10-12', 6000, 6),
      set('c2', 'cash', '2026-10-15', 3000, 7),
      set('e4', 'hdfc', '2026-10-31', 95000, 8),
      set('s1', 'sip', '2026-10-31', 15400, 9),
      set('f2', 'mf', '2026-10-31', 196000, 10),
    ],
  );
}

/** Fixture H (today 2026-10-31): two banks with starting balances. */
export const TODAY_H = '2026-10-31';
export function fixtureH() {
  return doc(
    [place('hdfc', 'bank', '2026-10-01', { name: 'HDFC' }), place('sbi', 'bank', '2026-10-01', { name: 'SBI' })],
    [setB('a', 'hdfc', '2026-10-01', 100000, 1), setB('b', 'sbi', '2026-10-01', 20000, 2)],
  );
}

/** Merge `patch` into the entry with `id` (an undefined value drops that field), or remove it with `null`. */
export function edit(d, id, patch) {
  const next = clone(d);
  const i = next.entries.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`no entry ${id}`);
  if (patch === null) { next.entries.splice(i, 1); return next; }
  const e = { ...next.entries[i], ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete e[k];
  next.entries[i] = e;
  return next;
}
export function editPlaceIn(d, id, patch) {
  const next = clone(d);
  const p = next.places.find((x) => x.id === id);
  Object.assign(p, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete p[k];
  return next;
}
export const withEntries = (d, ...entries) => ({ ...clone(d), entries: [...clone(d).entries, ...entries] });
