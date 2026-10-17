# GiveMeBucks

A Grafana-style dashboard for your income, savings, investments and spending. It runs locally on your Mac, has no dependencies, and keeps your data in a JSON file in this folder.

## Start it

```bash
cd "givemebucks"
npm start            # opens http://localhost:4180
```

To keep it running in the background, so reminders arrive even when no terminal is open, install it as a login item:

```bash
npm run reminders:install     # starts at login and restarts if it stops
npm run reminders:uninstall   # removes it again
```

Requires Node 18 or newer.

## What you feed it

| How often | What | Where |
|---|---|---|
| Weekly (e.g. Sunday) | Balance of each bank account | **Update balances** |
| When paid | Salary, bonus, freelance, interest… | **Log income** (or the income rows in a check-in) |
| Monthly | Current value and invested amount of mutual funds, stocks, EPF/PPF, gold | **Update balances**, under Investments |
| Once | FDs: principal, rate, start and maturity dates | **Accounts → Add account → Fixed deposit** |

Amounts accept Indian notation: `1,23,456`, `1.5L`, `2cr`, `45k`.

FDs are valued automatically (quarterly compounding). SIPs are added automatically between your monthly updates once you set the SIP amount and day on the account.

## What the dashboard shows

- **Overview**: net worth, total bank balance, this month's earnings with month-over-month change, savings rate, each bank account with a freshness indicator, emergency-fund runway, investment gains, and a "Needs your input" alert list.
- **Growth**: progress toward your net-worth goal with a projected date, net worth by asset class over time, where your money sits, bank balances over time, invested vs. current value.
- **Earnings**: monthly earnings by source, month-over-month growth %, yearly earnings with year-over-year growth % (financial or calendar year), and a month-by-month table.
- **Spending**: this week and this month so far, average monthly and weekly spend, income vs. expenses per month, weekly expenses.
- **Investments**: a holdings table (invested, value, gain, return, last updated) and FD maturities.

Controls at the top:
- **Time range** picker (last 3/6/12 months, 2 or 5 years, this or last FY, all time).
- **Year**: financial year (Apr–Mar) or calendar year.
- **Income**: all sources, or salary only (removes bonus spikes from growth %).
- **Units**: Lakh/Crore or K/M.

Every panel's **⋮** menu has **View** (full screen) and **Inspect data** (table plus CSV download). The eye button, or the `p` key, blurs all amounts for screen sharing.

## How spending is calculated

You never enter expenses. For each stretch between two bank check-ins:

```
spent = balances at start + income received − money moved into investments − balances at end
```

That amount is spread evenly over the days in between, so weeks and months add up correctly even if you skip a check-in. Moving money into an FD, SIP or stocks counts as saving, not spending. EPF is excluded by default because it comes out of your salary before it reaches your bank.

If a week shows negative spending, your balances rose more than the income you logged, which usually means some income is missing.

## Reminders

The server checks once a day at your reminder time (default 20:00; change it in **Settings**). If anything is due, it sends one macOS notification:

- a bank balance is older than 7 days
- no income logged since payday (set your salary day in Settings)
- an investment value is older than 30 days
- an FD matures within 30 days or has matured

**Settings → Send test reminder** checks that notifications work. With `brew install terminal-notifier`, clicking a notification opens the check-in form directly.

## Your data

- Stored only in `data/db.json`. The server listens on `127.0.0.1` and rejects requests from other origins.
- A dated copy is kept in `data/backups/` before the first change each day (the last 30 are kept).
- **Settings** can export a JSON backup or CSV, and can import a backup.
- `data/` is git-ignored.

## Development

```bash
npm test     # calculation tests (node:test)
```

| File | Role |
|---|---|
| `server.js` | HTTP server, JSON API, daily reminder scheduler |
| `lib/store.js`, `lib/notify.js` | File storage with backups; macOS notifications |
| `public/js/calc.js` | All finance math (shared by browser and server) |
| `public/js/panels.js` | Dashboard rows and panels |
| `public/js/charts.js` | SVG charts (time series, bars, donut, gauge, sparkline) |
| `public/js/forms.js` | Check-in, income, accounts and settings drawers |
| `public/js/app.js` | App shell, time range, variables, routing |
