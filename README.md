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

## Google sign-in (optional)

Without setup, GiveMeBucks runs as a single-user app on this Mac with no sign-in. To require **Sign in with Google**, which works the same way as in Kairos:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
   - Under **Authorized JavaScript origins**, add `http://localhost:4180` and `http://localhost`.
   - No redirect URI is needed.
2. Copy `.env.example` to `.env` and fill it in:
   ```bash
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   JWT_SECRET=<output of: openssl rand -base64 48>
   ALLOWED_EMAILS=you@gmail.com
   ```
3. Restart with `npm start`. The dashboard now opens on a sign-in page.

How it works:
- The browser gets an ID token from Google.
- The server checks that token against Google's published keys (signature, audience, issuer, expiry and verified email). It then issues its own session token, valid for 7 days, which is stored in the browser and sent as `Authorization: Bearer …`.
- Each Google account gets its own data file, `data/users/<google-id>.json`.
- `ALLOWED_EMAILS` limits who can sign in, and is checked on every request. The first allow-listed account to sign in takes over the data you entered before turning sign-in on.
- Sign out from the avatar at the bottom of the sidebar.

`.env` is git-ignored. Never commit it.

## Your data

- Stored only on this Mac: `data/db.json` without sign-in, `data/users/<google-id>.json` with it. The server listens on `127.0.0.1` and rejects requests from other origins.
- A dated copy is kept in a `backups/` folder next to each file before the first change each day (the last 30 are kept).
- **Settings** can export a JSON backup or CSV, and can import a backup.
- `data/` is git-ignored.

## Development

```bash
npm test     # calculation, sign-in and API tests (node:test)
```

| File | Role |
|---|---|
| `server.js` | Local server: settings from `.env`, daily reminder scheduler |
| `lib/app.js` | Request handler: static files, JSON API, sign-in routes |
| `lib/auth.js` | Google ID-token verification, session tokens, allowlist |
| `lib/store.js`, `lib/notify.js` | File storage with backups (one file per account); macOS notifications |
| `public/js/calc.js` | All finance math (shared by browser and server) |
| `public/js/panels.js` | Dashboard rows and panels |
| `public/js/charts.js` | SVG charts (time series, bars, donut, gauge, sparkline) |
| `public/js/forms.js` | Check-in, income, accounts and settings drawers |
| `public/js/app.js` | App shell, time range, variables, routing |
