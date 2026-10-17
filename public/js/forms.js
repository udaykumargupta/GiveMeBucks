// Drawers for feeding data: check-in, income, accounts, settings.
import * as C from './calc.js';
import { money, moneyShort, parseAmount, daysAgoText } from './format.js';
import { h, icon, openDrawer, closeDrawer, openModal, closeModal, confirmDialog, toast, download, uid } from './ui.js';
import { sampleDb } from './sample.js';
import { api } from './auth.js';

// --------------------------------------------------------- field helpers
function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
/** Amount input that accepts 1,23,456 / 1.5L / 45k and previews the value. */
function amountInput({ value = '', placeholder = '', name, required = false } = {}) {
  const preview = h('span', { class: 'amount-preview money' });
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', name, placeholder, value: value === '' || value == null ? '' : String(value), class: 'amount', required });
  const update = () => {
    const v = parseAmount(input.value);
    preview.textContent = input.value.trim() === '' ? '' : v == null ? 'Not a number' : money(v);
    preview.classList.toggle('bad', input.value.trim() !== '' && v == null);
  };
  input.addEventListener('input', update);
  update();
  const wrap = h('div', { class: 'amount-wrap' }, h('span', { class: 'amount-prefix' }, '₹'), input, preview);
  wrap.input = input;
  return wrap;
}
const select = (name, options, value) => h('select', { name }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
const dateInput = (name, value, max) => h('input', { type: 'date', name, value, max });
const errorBox = () => h('div', { class: 'form-error', role: 'alert' });
function showError(box, msg) { box.textContent = msg; box.style.display = msg ? 'block' : 'none'; }

function upsertSnapshot(db, snap) {
  const i = db.snapshots.findIndex((s) => s.accountId === snap.accountId && s.date === snap.date);
  if (i >= 0) db.snapshots[i] = { ...db.snapshots[i], ...snap, id: db.snapshots[i].id };
  else db.snapshots.push(snap);
}

// ------------------------------------------------------------- check-in
export function openCheckin(app) {
  const L = app.ledger();
  const today = L.todayISO;
  const banks = L.banks.filter((a) => L.isActive(a));
  const invs = L.investments.filter((a) => L.isActive(a) && !L.isAuto(a));
  if (!banks.length && !invs.length) {
    toast('Add your accounts first', 'warning');
    return openAccounts(app);
  }
  const err = errorBox();
  const date = dateInput('date', today, today);
  const bankRows = banks.map((a) => {
    const last = (L.snaps.get(a.id) || []).slice(-1)[0];
    const inp = amountInput({ placeholder: last ? String(Math.round(last.value)) : 'Balance' });
    return { a, inp, el: h('div', { class: 'checkin-row' },
      h('div', { class: 'checkin-label' }, h('strong', {}, a.name),
        h('span', { class: 'muted' }, last ? h('span', {}, 'Last ', h('span', { class: 'money' }, money(last.value)), ` · ${daysAgoText(L.today - last.day)}`) : 'No balance yet')),
      inp) };
  });
  const invRows = invs.map((a) => {
    const last = (L.snaps.get(a.id) || []).slice(-1)[0];
    const estInv = L.investedAt(a, L.today);
    const val = amountInput({ placeholder: last ? String(Math.round(L.current(a))) : 'Current value' });
    const inv = amountInput({ value: estInv != null ? Math.round(estInv) : '', placeholder: 'Invested so far' });
    return { a, val, inv, el: h('div', { class: 'checkin-row inv' },
      h('div', { class: 'checkin-label' }, h('strong', {}, a.name),
        h('span', { class: 'muted' }, last ? h('span', {}, 'Last ', h('span', { class: 'money' }, money(last.value)), ` · ${daysAgoText(L.today - last.day)}${a.sip?.amount ? ' · SIP auto-added' : ''}`) : 'No value yet')),
      h('div', { class: 'checkin-pair' }, field('Current value', val), field('Invested so far', inv))) };
  });

  // Quick income rows
  const incomeList = h('div', { class: 'income-rows' });
  const incomeRows = [];
  const addIncomeRow = (preset = {}) => {
    const amt = amountInput({ value: preset.amount ?? '', placeholder: 'Amount' });
    const src = select('source', C.INCOME_SOURCES.map((s) => [s, s]), preset.source || 'Salary');
    const month = h('input', { type: 'month', value: preset.month || C.monthOf(today) });
    const row = { amt, src, month };
    const el = h('div', { class: 'income-row' }, amt, src, month,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', html: icon('x'), onclick: () => { el.remove(); incomeRows.splice(incomeRows.indexOf(row), 1); } }));
    row.el = el;
    incomeRows.push(row);
    incomeList.appendChild(el);
  };
  const since = L.lastCheckin;
  const recent = L.income.filter((i) => since == null || i.day > since);

  const body = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
    h('p', { class: 'muted lead' }, 'Enter today\'s balances. Leave a field blank to skip it. Your spending is worked out from how your balances changed.'),
    field('Check-in date', date),
    banks.length ? h('h3', { class: 'section-title' }, h('span', { html: icon('bank') }), 'Bank accounts') : null,
    bankRows.map((r) => r.el),
    invRows.length ? h('h3', { class: 'section-title' }, h('span', { html: icon('chart') }), 'Investments') : null,
    invRows.length ? h('p', { class: 'muted small' }, 'Update monthly from your app/statement. FDs are calculated automatically.') : null,
    invRows.map((r) => r.el),
    h('h3', { class: 'section-title' }, h('span', { html: icon('rupee') }), `Income received since ${since == null ? 'your first check-in' : C.dayLabel(since)}`),
    recent.length ? h('p', { class: 'muted small' }, `Already logged: ${recent.map((i) => `${i.source} ${moneyShort(i.amount)}`).join(', ')}`) : h('p', { class: 'muted small' }, 'Add any salary or other income that reached your bank so it is not mistaken for savings.'),
    incomeList,
    h('button', { type: 'button', class: 'btn link', onclick: () => addIncomeRow() }, h('span', { html: icon('plus') }), 'Add income'),
    err);

  const submit = () => app.save((db) => {
    const d = date.value;
    if (!d || d > today) throw new Error('Pick a date that is not in the future.');
    let n = 0;
    for (const r of bankRows) {
      if (!r.inp.input.value.trim()) continue;
      const v = parseAmount(r.inp.input.value);
      if (v == null) throw new Error(`Balance for ${r.a.name} is not a number.`);
      upsertSnapshot(db, { id: uid(), accountId: r.a.id, date: d, value: v });
      n++;
    }
    for (const r of invRows) {
      if (!r.val.input.value.trim()) continue;
      const v = parseAmount(r.val.input.value);
      const inv = r.inv.input.value.trim() ? parseAmount(r.inv.input.value) : null;
      if (v == null || (r.inv.input.value.trim() && inv == null)) throw new Error(`Check the numbers for ${r.a.name}.`);
      upsertSnapshot(db, { id: uid(), accountId: r.a.id, date: d, value: v, ...(inv != null ? { invested: inv } : {}) });
      n++;
    }
    let k = 0;
    for (const r of incomeRows) {
      if (!r.amt.input.value.trim()) continue;
      const v = parseAmount(r.amt.input.value);
      if (v == null || v <= 0) throw new Error('Income amounts must be positive numbers.');
      db.income.push({ id: uid(), date: d, month: r.month.value || C.monthOf(d), amount: v, source: r.src.value });
      k++;
    }
    if (!n && !k) throw new Error('Enter at least one balance or income.');
    return `Check-in saved — ${n} balance${n === 1 ? '' : 's'}${k ? `, ${k} income` : ''}`;
  }, { onError: (m) => showError(err, m) }).then((ok) => ok && closeDrawer());

  openDrawer({
    title: 'Update balances', subtitle: 'Weekly check-in', body, width: 600,
    footer: [h('button', { class: 'btn secondary', onclick: () => closeDrawer() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, 'Save check-in')],
  });
}

// --------------------------------------------------------------- income
export function openIncome(app, editId = null) {
  const L = app.ledger();
  const db = app.db();
  const today = L.todayISO;
  const editing = editId ? db.income.find((i) => i.id === editId) : null;
  const banks = L.banks.filter((a) => L.isActive(a));
  const err = errorBox();
  const date = dateInput('date', editing?.date || today, today);
  const amt = amountInput({ value: editing?.amount ?? '', placeholder: 'e.g. 1,25,000 or 1.25L', required: true });
  const src = select('source', C.INCOME_SOURCES.map((s) => [s, s]), editing?.source || 'Salary');
  const month = h('input', { type: 'month', value: editing?.month || C.monthOf(today) });
  const note = h('input', { type: 'text', placeholder: 'Optional', value: editing?.note || '' });
  const acct = select('account', [['', 'Not specified'], ...banks.map((a) => [a.id, a.name])], editing?.accountId || '');
  date.addEventListener('change', () => { if (!editing) month.value = C.monthOf(date.value || today); });

  const lastSalary = [...L.income].reverse().find((i) => i.source === 'Salary');
  const quick = lastSalary && !editing
    ? h('button', { type: 'button', class: 'btn secondary sm', onclick: () => {
      amt.input.value = String(lastSalary.amount); amt.input.dispatchEvent(new Event('input'));
      src.value = 'Salary'; acct.value = lastSalary.accountId || '';
    } }, h('span', { html: icon('history') }), `Same as last salary (${moneyShort(lastSalary.amount)})`)
    : null;

  const list = h('div', { class: 'entry-list' });
  const recent = [...db.income].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
  for (const i of recent) {
    list.append(h('div', { class: `entry ${i.id === editId ? 'editing' : ''}` },
      h('div', { class: 'entry-main' }, h('strong', { class: 'money' }, money(i.amount)), h('span', { class: 'chip' }, i.source),
        h('span', { class: 'muted' }, `${C.dayLabel(C.toDay(i.date), true)} · counts for ${C.monthLabel(i.month || C.monthOf(i.date))}`),
        i.note ? h('span', { class: 'muted' }, `· ${i.note}`) : null),
      h('div', { class: 'entry-actions' },
        h('button', { class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', html: icon('edit'), onclick: () => openIncome(app, i.id) }),
        h('button', { class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', html: icon('trash'), onclick: async () => {
          if (await confirmDialog({ title: 'Delete income?', message: `${money(i.amount)} ${i.source} on ${i.date} will be removed.`, confirmText: 'Delete', danger: true })) {
            await app.save((d) => { d.income = d.income.filter((x) => x.id !== i.id); return 'Income deleted'; });
            openIncome(app);
          }
        } }))));
  }

  const submit = () => app.save((d) => {
    const v = parseAmount(amt.input.value);
    if (v == null || v <= 0) throw new Error('Enter a positive amount.');
    if (!date.value || date.value > today) throw new Error('Pick a date that is not in the future.');
    const rec = { id: editing?.id || uid(), date: date.value, month: month.value || C.monthOf(date.value), amount: v, source: src.value, ...(note.value.trim() ? { note: note.value.trim() } : {}), ...(acct.value ? { accountId: acct.value } : {}) };
    if (editing) d.income = d.income.map((x) => (x.id === editing.id ? rec : x));
    else d.income.push(rec);
    return editing ? 'Income updated' : `Logged ${money(v)} ${src.value}`;
  }, { onError: (m) => showError(err, m) }).then((ok) => ok && (editing ? openIncome(app) : closeDrawer()));

  const body = h('div', {},
    h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
      quick,
      h('div', { class: 'grid-2' }, field('Amount', amt), field('Source', src)),
      h('div', { class: 'grid-2' },
        field('Received on', date),
        field('Counts toward month', month, 'e.g. September salary paid on 1 Oct')),
      h('div', { class: 'grid-2' }, field('Into account', acct), field('Note', note)),
      err),
    h('h3', { class: 'section-title' }, 'Recent income'),
    recent.length ? list : h('p', { class: 'muted' }, 'Nothing logged yet.'));

  openDrawer({
    title: editing ? 'Edit income' : 'Log income', subtitle: 'Salary, bonus, freelance, interest…', body, width: 600,
    footer: [
      editing ? h('button', { class: 'btn secondary', onclick: () => openIncome(app) }, 'Cancel edit') : h('button', { class: 'btn secondary', onclick: () => closeDrawer() }, 'Close'),
      h('button', { class: 'btn primary', onclick: submit }, editing ? 'Save changes' : 'Log income')],
  });
}

// ------------------------------------------------------------- accounts
export function openAccounts(app, focusId = null) {
  const L = app.ledger();
  if (focusId) return openAccountEditor(app, focusId);
  const list = h('div', { class: 'acct-list' });
  const groups = C.GROUPS.map((g) => ({ g, accts: L.accounts.filter((a) => a.meta.group === g.id) })).filter((x) => x.accts.length);
  for (const { g, accts } of groups) {
    list.append(h('h3', { class: 'section-title' }, g.label));
    for (const a of accts) {
      const active = L.isActive(a);
      const upd = L.lastUpdatedDay(a);
      list.append(h('div', { class: `entry ${active ? '' : 'closed'}` },
        h('div', { class: 'entry-main' },
          h('strong', {}, a.name), h('span', { class: 'chip' }, a.meta.label),
          active ? h('span', { class: 'money' }, money(L.current(a))) : h('span', { class: 'chip warn' }, `Closed ${a.closedOn}`),
          h('span', { class: 'muted' }, L.isAuto(a) ? `auto · ${a.fd.rate}%` : `updated ${daysAgoText(upd == null ? null : L.today - upd)}`)),
        h('div', { class: 'entry-actions' },
          h('button', { class: 'btn secondary sm', onclick: () => openAccountEditor(app, a.id) }, 'Edit')),
      ));
    }
  }
  const body = h('div', {},
    h('p', { class: 'muted lead' }, 'Everything you own: bank accounts, FDs, mutual funds, stocks, PPF/EPF/NPS, gold, crypto.'),
    L.accounts.length ? list : h('div', { class: 'empty-cta' }, h('p', {}, 'No accounts yet. Start with your two bank accounts.')));
  openDrawer({
    title: 'Accounts', subtitle: `${L.accounts.filter((a) => L.isActive(a)).length} active`, body, width: 620,
    footer: [h('button', { class: 'btn secondary', onclick: () => closeDrawer() }, 'Close'), h('button', { class: 'btn primary', onclick: () => openAccountEditor(app, null) }, h('span', { html: icon('plus') }), 'Add account')],
  });
}

function openAccountEditor(app, id) {
  const L = app.ledger();
  const db = app.db();
  const raw = id ? db.accounts.find((a) => a.id === id) : null;
  if (id && !raw) return openAccounts(app);
  const today = L.todayISO;
  const err = errorBox();
  const name = h('input', { type: 'text', value: raw?.name || '', placeholder: 'e.g. HDFC Savings', required: true });
  const kind = select('kind', Object.entries(C.KINDS).map(([k, v]) => [k, v.label]), raw?.kind || 'bank');
  const inst = h('input', { type: 'text', value: raw?.institution || '', placeholder: 'Optional' });
  // FD
  const principal = amountInput({ value: raw?.fd?.principal ?? '' });
  const rate = h('input', { type: 'number', step: '0.01', min: '0', value: raw?.fd?.rate ?? '', placeholder: '7.1' });
  const fdStart = dateInput('start', raw?.fd?.startDate || today);
  const fdEnd = h('input', { type: 'date', value: raw?.fd?.maturityDate || '' });
  // Opening value (new manual accounts)
  const openDate = dateInput('openDate', today, today);
  const openValue = amountInput({ placeholder: 'Current balance / value' });
  const openInvested = amountInput({ placeholder: 'Same as value if blank' });
  // SIP
  const sipAmt = amountInput({ value: raw?.sip?.amount ?? '', placeholder: 'Monthly SIP (optional)' });
  const sipDay = h('input', { type: 'number', min: '1', max: '28', value: raw?.sip?.day ?? '', placeholder: 'Day' });
  const paid = h('input', { type: 'checkbox', checked: raw ? (raw.paidFromBank ?? C.KINDS[raw.kind]?.paidFromBank) : true });
  const opening = h('input', { type: 'checkbox', checked: !!raw?.openingFromBank });

  const fdBox = h('div', { class: 'subform' },
    h('div', { class: 'grid-2' }, field('Principal', principal), field('Interest rate (% p.a.)', rate)),
    h('div', { class: 'grid-2' }, field('Start date', fdStart), field('Maturity date', fdEnd)),
    h('p', { class: 'muted small' }, 'Value is calculated daily with quarterly compounding — no manual updates needed.'));
  const openBox = h('div', { class: 'subform' },
    h('div', { class: 'grid-2' }, field('As of', openDate), field('Balance / current value', openValue)),
    h('div', { class: 'invested-only' }, field('Invested so far', openInvested, 'Total you have put in (cost). Used to compute gains.')));
  const sipBox = h('div', { class: 'subform sip' }, h('div', { class: 'grid-2' }, field('SIP amount', sipAmt), field('SIP day of month', sipDay)),
    h('p', { class: 'muted small' }, 'SIP installments are added automatically between your monthly value updates.'));
  const flowBox = h('div', { class: 'subform' },
    h('label', { class: 'check' }, paid, h('span', {}, 'Contributions come out of my bank accounts', h('span', { class: 'muted small block' }, 'So SIPs/deposits are treated as savings, not spending. Untick for EPF (deducted from salary).'))),
    h('label', { class: 'check' }, opening, h('span', {}, 'The opening amount was just moved from my bank account', h('span', { class: 'muted small block' }, 'Tick for a brand-new FD/investment funded today; leave unticked for older holdings.'))));

  const sync = () => {
    const k = C.KINDS[kind.value];
    const isFd = kind.value === 'fd';
    fdBox.style.display = isFd ? '' : 'none';
    openBox.style.display = !raw && !isFd ? '' : 'none';
    openBox.querySelector('.invested-only').style.display = k.liquid ? 'none' : '';
    sipBox.style.display = !k.liquid && !isFd ? '' : 'none';
    flowBox.style.display = k.liquid ? 'none' : '';
    if (!raw) paid.checked = k.paidFromBank;
  };
  kind.addEventListener('change', sync);

  const history = raw && !L.isAuto(L.byId.get(raw.id)) ? historySection(app, raw) : null;

  const submit = () => app.save((d) => {
    const nm = name.value.trim();
    if (!nm) throw new Error('Give the account a name.');
    const k = kind.value;
    const rec = { ...(raw || {}), id: raw?.id || uid(), name: nm, kind: k, institution: inst.value.trim() || undefined };
    if (!C.KINDS[k].liquid) {
      rec.paidFromBank = paid.checked;
      rec.openingFromBank = opening.checked;
    } else { delete rec.paidFromBank; delete rec.openingFromBank; }
    if (k === 'fd') {
      const p = parseAmount(principal.input.value);
      if (!p || p <= 0) throw new Error('Enter the FD principal.');
      if (!fdStart.value) throw new Error('Enter the FD start date.');
      if (fdEnd.value && fdEnd.value <= fdStart.value) throw new Error('Maturity must be after the start date.');
      rec.fd = { principal: p, rate: Number(rate.value) || 0, startDate: fdStart.value, maturityDate: fdEnd.value || '' };
    } else delete rec.fd;
    const sa = parseAmount(sipAmt.input.value);
    if (!C.KINDS[k].liquid && k !== 'fd' && sa) rec.sip = { amount: sa, day: Math.min(28, Math.max(1, Number(sipDay.value) || 1)) };
    else delete rec.sip;
    if (raw) d.accounts = d.accounts.map((a) => (a.id === raw.id ? rec : a));
    else {
      d.accounts.push(rec);
      if (k !== 'fd') {
        const v = parseAmount(openValue.input.value);
        if (openValue.input.value.trim() && v == null) throw new Error('Opening balance is not a number.');
        if (v != null) {
          const inv = parseAmount(openInvested.input.value);
          d.snapshots.push({ id: uid(), accountId: rec.id, date: openDate.value || today, value: v, ...(!C.KINDS[k].liquid && inv != null ? { invested: inv } : {}) });
        }
      }
    }
    return raw ? 'Account updated' : `Added ${nm}`;
  }, { onError: (m) => showError(err, m) }).then((ok) => ok && openAccounts(app));

  const closeAcct = async () => {
    const when = await promptDate(`Close ${raw.name}`, 'Its value becomes zero from this date. Move the money to another account in your next check-in.');
    if (!when) return;
    await app.save((d) => { d.accounts = d.accounts.map((a) => (a.id === raw.id ? { ...a, closedOn: when } : a)); return `${raw.name} closed`; });
    openAccounts(app);
  };
  const reopen = async () => {
    await app.save((d) => { d.accounts = d.accounts.map((a) => { if (a.id !== raw.id) return a; const { closedOn, ...rest } = a; return rest; }); return `${raw.name} reopened`; });
    openAccounts(app);
  };
  const del = async () => {
    const n = db.snapshots.filter((s) => s.accountId === raw.id).length;
    if (!(await confirmDialog({ title: `Delete ${raw.name}?`, message: `This removes the account and its ${n} recorded balance${n === 1 ? '' : 's'} from all history. To keep history, close the account instead.`, confirmText: 'Delete account', danger: true }))) return;
    await app.save((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== raw.id);
      d.snapshots = d.snapshots.filter((s) => s.accountId !== raw.id);
      return `${raw.name} deleted`;
    });
    openAccounts(app);
  };

  const body = h('div', {},
    h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); submit(); } },
      h('div', { class: 'grid-2' }, field('Name', name), field('Type', kind)),
      field('Bank / platform', inst),
      fdBox, openBox, sipBox, flowBox, err),
    raw ? h('div', { class: 'danger-zone' },
      L.isActive(L.byId.get(raw.id))
        ? h('button', { class: 'btn secondary sm', onclick: closeAcct }, 'Close account…')
        : h('button', { class: 'btn secondary sm', onclick: reopen }, 'Reopen account'),
      h('button', { class: 'btn danger-outline sm', onclick: del }, 'Delete…')) : null,
    history);
  openDrawer({
    title: raw ? `Edit ${raw.name}` : 'Add account', subtitle: raw ? C.KINDS[raw.kind]?.label : 'Bank account, FD, mutual fund…', body, width: 620,
    footer: [h('button', { class: 'btn secondary', onclick: () => openAccounts(app) }, 'Back'), h('button', { class: 'btn primary', onclick: submit }, raw ? 'Save changes' : 'Add account')],
  });
  sync();
}

function historySection(app, raw) {
  const db = app.db();
  const L = app.ledger();
  const snaps = db.snapshots.filter((s) => s.accountId === raw.id).sort((a, b) => b.date.localeCompare(a.date));
  const liquid = C.KINDS[raw.kind]?.liquid;
  const d = dateInput('d', L.todayISO, L.todayISO);
  const v = amountInput({ placeholder: liquid ? 'Balance' : 'Value' });
  const inv = amountInput({ placeholder: 'Invested (optional)' });
  const err = errorBox();
  const add = () => app.save((x) => {
    const val = parseAmount(v.input.value);
    if (val == null) throw new Error('Enter a value.');
    const iv = !liquid && inv.input.value.trim() ? parseAmount(inv.input.value) : null;
    upsertSnapshot(x, { id: uid(), accountId: raw.id, date: d.value, value: val, ...(iv != null ? { invested: iv } : {}) });
    return `Recorded ${money(val)} on ${d.value}`;
  }, { onError: (m) => showError(err, m) }).then((ok) => ok && openAccountEditor(app, raw.id));
  return h('div', { class: 'history' },
    h('h3', { class: 'section-title' }, h('span', { html: icon('history') }), 'History'),
    h('p', { class: 'muted small' }, 'Backfill past balances here (e.g. from old statements) to get history in the charts right away.'),
    h('div', { class: 'history-add' }, d, v, liquid ? null : inv, h('button', { class: 'btn secondary sm', onclick: add }, 'Add')),
    err,
    snaps.length ? h('table', { class: 'grid-table compact' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, liquid ? 'Balance' : 'Value'), liquid ? null : h('th', { class: 'num' }, 'Invested'), h('th', {}))),
      h('tbody', {}, snaps.map((s) => h('tr', {},
        h('td', {}, s.date),
        h('td', { class: 'num money' }, money(s.value)),
        liquid ? null : h('td', { class: 'num money' }, s.invested != null ? money(s.invested) : '—'),
        h('td', { class: 'num' }, h('button', { class: 'icon-btn', 'aria-label': `Delete ${s.date}`, html: icon('trash'), onclick: async () => {
          if (!(await confirmDialog({ title: 'Delete this entry?', message: `${raw.name}: ${money(s.value)} on ${s.date}`, confirmText: 'Delete', danger: true }))) return;
          await app.save((x) => { x.snapshots = x.snapshots.filter((y) => y.id !== s.id); return 'Entry deleted'; });
          openAccountEditor(app, raw.id);
        } })))))) : h('p', { class: 'muted' }, 'No entries yet.'));
}

function promptDate(title, message) {
  return new Promise((resolve) => {
    let done = false;
    const inp = h('input', { type: 'date', value: C.todayISO(), max: C.todayISO() });
    const finish = (v) => { if (!done) { done = true; closeModal(); resolve(v); } };
    openModal({
      title,
      body: h('div', {}, h('p', { class: 'confirm-text' }, message), field('Closed on', inp),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn secondary', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => finish(inp.value || null) }, 'Close account'))),
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
  });
}

// ------------------------------------------------------------- settings
export function openSettings(app) {
  const db = app.db();
  const s = C.withDefaults(db).settings;
  const err = errorBox();
  const title = h('input', { type: 'text', value: s.title });
  const owner = h('input', { type: 'text', value: s.owner, placeholder: 'Your name' });
  const goal = amountInput({ value: s.goal.target || '', placeholder: 'e.g. 50L' });
  const goalBy = h('input', { type: 'date', value: s.goal.by || '' });
  const enabled = h('input', { type: 'checkbox', checked: s.reminders.enabled });
  const at = h('input', { type: 'time', value: s.reminders.notifyAt });
  const bankEvery = h('input', { type: 'number', min: '1', max: '60', value: s.reminders.bankEveryDays });
  const invEvery = h('input', { type: 'number', min: '1', max: '365', value: s.reminders.investmentEveryDays });
  const payDay = h('input', { type: 'number', min: '1', max: '28', value: s.reminders.incomeDay });
  const status = h('span', { class: 'muted small' });
  api('/api/reminder/status').then((r) => r.json()).then((st) => {
    status.textContent = st.lastSentAt ? `Last reminder sent ${new Date(st.lastSentAt).toLocaleString()}` : 'No reminder sent yet';
  }).catch(() => {});

  const save = () => app.save((d) => {
    d.settings = {
      ...(d.settings || {}),
      title: title.value.trim() || 'Wealth Growth',
      owner: owner.value.trim(),
      goal: { target: parseAmount(goal.input.value) || 0, by: goalBy.value || '' },
      reminders: {
        enabled: enabled.checked,
        notifyAt: at.value || '20:00',
        bankEveryDays: Math.max(1, Number(bankEvery.value) || 7),
        investmentEveryDays: Math.max(1, Number(invEvery.value) || 30),
        incomeDay: Math.min(28, Math.max(1, Number(payDay.value) || 1)),
      },
    };
    return 'Settings saved';
  }, { onError: (m) => showError(err, m) }).then((ok) => ok && closeDrawer());

  const testReminder = async () => {
    const r = await api('/api/reminder/test', { method: 'POST' }).then((x) => x.json()).catch(() => ({ ok: false }));
    toast(r.ok ? 'Reminder sent — check your notifications' : 'Could not send a notification (see server log)', r.ok ? 'success' : 'error');
  };
  const exportJson = () => download(`givemebucks-backup-${C.todayISO()}.json`, JSON.stringify(app.db(), null, 2), 'application/json');
  const exportCsv = () => {
    const d = app.db();
    const name = new Map(d.accounts.map((a) => [a.id, a]));
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = ['type,date,account,kind,value,invested,source,counts_toward,amount,note'];
    for (const x of [...d.snapshots].sort((a, b) => a.date.localeCompare(b.date))) {
      const a = name.get(x.accountId);
      lines.push(['balance', x.date, a?.name, a?.kind, x.value, x.invested, '', '', '', ''].map(q).join(','));
    }
    for (const i of [...d.income].sort((a, b) => a.date.localeCompare(b.date))) {
      lines.push(['income', i.date, '', '', '', '', i.source, i.month, i.amount, i.note].map(q).join(','));
    }
    download(`givemebucks-${C.todayISO()}.csv`, lines.join('\n'), 'text/csv');
  };
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onchange: async () => {
    const f = fileIn.files[0];
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast('That file is not valid JSON', 'error'); }
    if (!['accounts', 'snapshots', 'income'].every((k) => Array.isArray(data[k]))) return toast('That file is not a GiveMeBucks backup', 'error');
    if (!(await confirmDialog({ title: 'Replace all data?', message: `Import ${data.accounts.length} accounts, ${data.snapshots.length} balances and ${data.income.length} income entries? This replaces what you have now (a backup of the current file is kept in data/backups).`, confirmText: 'Replace', danger: true }))) return;
    await app.replace(data, 'Backup imported');
    closeDrawer();
  } });
  const loadSample = async () => {
    const d = app.db();
    if (d.accounts.length && !(await confirmDialog({ title: 'Load sample data?', message: 'This replaces your current data with two years of sample data. Your current file is kept in data/backups.', confirmText: 'Load sample', danger: true }))) return;
    await app.replace(sampleDb(C.todayISO()), 'Sample data loaded');
    closeDrawer();
  };
  const erase = async () => {
    if (!(await confirmDialog({ title: 'Erase all data?', message: 'Removes every account, balance and income entry. Settings are kept. A copy of the current file stays in data/backups.', confirmText: 'Erase everything', danger: true }))) return;
    const d = app.db();
    await app.replace({ accounts: [], snapshots: [], income: [], settings: d.settings, meta: {} }, 'All data erased');
    closeDrawer();
  };

  const body = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); save(); } },
    h('h3', { class: 'section-title' }, 'Dashboard'),
    h('div', { class: 'grid-2' }, field('Title', title), field('Your name', owner)),
    h('h3', { class: 'section-title' }, 'Net-worth goal'),
    h('div', { class: 'grid-2' }, field('Target', goal), field('Reach it by', goalBy)),
    h('h3', { class: 'section-title' }, h('span', { html: icon('bell') }), 'Reminders'),
    h('label', { class: 'check' }, enabled, h('span', {}, 'Send me a macOS notification when data is due')),
    h('div', { class: 'grid-2' },
      field('Daily reminder time', at, 'Sent once a day if anything below is due.'),
      field('Salary day of month', payDay, 'Reminds you to log income 2 days after.')),
    h('div', { class: 'grid-2' },
      field('Bank check-in every (days)', bankEvery),
      field('Investment update every (days)', invEvery)),
    h('div', { class: 'inline-actions' }, h('button', { type: 'button', class: 'btn secondary sm', onclick: testReminder }, h('span', { html: icon('bell') }), 'Send test reminder'), status),
    h('p', { class: 'muted small' }, 'Reminders come from the local server, so it must be running. Run ', h('code', {}, 'npm run reminders:install'), ' once to start it automatically at login.'),
    err,
    h('h3', { class: 'section-title' }, 'Your data'),
    h('p', { class: 'muted small' }, 'Stored only on this Mac, in the givemebucks/data folder, with a daily backup.'),
    h('div', { class: 'inline-actions wrap' },
      h('button', { type: 'button', class: 'btn secondary sm', onclick: exportJson }, h('span', { html: icon('download') }), 'Export backup (JSON)'),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: exportCsv }, h('span', { html: icon('table') }), 'Export CSV'),
      h('button', { type: 'button', class: 'btn secondary sm', onclick: () => fileIn.click() }, h('span', { html: icon('upload') }), 'Import backup'),
      fileIn),
    h('div', { class: 'inline-actions wrap' },
      h('button', { type: 'button', class: 'btn secondary sm', onclick: loadSample }, 'Load sample data'),
      h('button', { type: 'button', class: 'btn danger-outline sm', onclick: erase }, 'Erase all data…')));

  openDrawer({
    title: 'Settings', body, width: 600,
    footer: [h('button', { class: 'btn secondary', onclick: () => closeDrawer() }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save settings')],
  });
}
