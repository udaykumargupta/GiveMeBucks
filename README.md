# GiveMeBucks

Your net worth, your spending, and every place your money sits. It runs on your Mac with no dependencies (data in a JSON file in this folder), or on Vercel with Neon Postgres and Google sign-in.

## What it does

One page, three cards. Everything else opens in a sheet over it.

1. **Net worth.** The sum of every place's value, with "▲ ₹55,400 this month". One chart with two views: **Trend** (recorded net worth over time) and **Monthly** (growth per month). **History ›** lists every day anything changed, with net worth after that day.
2. **Spent** this week (Mon–Sun), this month and this financial year (1 Apr–31 Mar). You never enter expenses: spending is worked out from your balances. Tap a bar, or the selected tab, for **How this was worked out**.
3. **Places.** Bank accounts, cash, FDs, SIPs, mutual funds, stocks, PF/PPF/NPS, gold and others, grouped into "Bank & cash" and "Savings & investments". Each row has a sparkline, and each place has its own value chart and history.

## Start it

```bash
cd givemebucks
npm start            # opens http://localhost:4180
```

Requires Node 20.12 or newer.

## Using it

- **Update balances.** Type today's balance for any places you want (one save for the whole sheet). Each row shows what the app **expected** (last balance + money added + moved in − moved out) with a breakdown, a **Use expected** button, and a live line such as "→ Spent ₹54,000 since 1 Oct". Opened from a place, the sheet shows just that place.
- **+ Add money.** Salary, bonus, interest, gifts: money that came from outside into one of your places. **Same as last** repeats the previous one.
- **⇄ Move money.** Money between two of your own places, for example a SIP debit or an FD funded from your bank (⇅ swaps From and To). Moves are not spending.
- **Places.** **+ Add place** picks one of 9 types. A new place's opening balance is either money you already had (a starting balance), money moved from another place, or new money. Tap a place for its chart and history. Its ⋯ menu has **Edit**, **Close** (with where the money went: moved to another place, or spent/gone) and **Delete** (a confirm that offers **Close instead**). Closed places can be reopened. Tap any history entry to edit or delete it.
- Every save shows an **Undo** toast (6 seconds, 10 after a delete).
- Amounts accept Indian notation: `1,23,456`, `1.5L`, `45k`, `2cr`. Bank and cash balances may be negative (type a leading `-`).

## How spending is calculated

For each bank or cash place, between one balance update and the next:

```
spent = balance at start + money added + moved in − moved out − balance at end
```

For example 50,000 + 1,20,000 − 15,000 − 95,000 = **₹60,000**. Summed over all bank and cash places, moves between them cancel, and moves into investments are explicit, so the total is the money that left bank/cash and did not go to another of your places.

- **Spread over days.** Each gap's spending is spread evenly over the days between the two updates, so weeks, months and years add up correctly even when you update irregularly. A period still waiting for an update shows as "so far" or partial (hatched bars), and the caption says which place needs updating.
- **Investments** are not spending. A change in an investment's value counts as growth (or loss) in the Monthly view, spread the same way.
- **Monthly growth** = money added − spent ± investment change. Starting balances and corrections are never counted as spending or growth.
- **Unexpected rises.** If a bank or cash balance comes in at least ₹1,000 higher than expected, the app asks where it came from before saving, with no default:
  - **From my place**: a move from another of your places;
  - **Money came in**: an add (Salary, Bonus, Interest, Gift, Other);
  - **Refund or cashback**: counts as negative spending;
  - **Correction**: the balance becomes a new baseline and that gap's spending counts as ₹0.

  Rises under ₹1,000 count as refunds without asking.
- **Same day.** When you add or move money on a day that already has a balance for that place, the app asks once: "Is ₹X already included in the ₹Y you entered…?" (**Yes, it's included** / **No, it came after**), so nothing is counted twice.

## Google sign-in (optional on the Mac, required on Vercel)

Without setup, GiveMeBucks runs as a single-user app on this Mac with no sign-in ("This Mac · local data" in the account menu). To require **Sign in with Google**:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**.
   - Under **Authorized JavaScript origins**, add `http://localhost:4180` and `http://localhost`.
   - No redirect URI is needed.
2. Copy `.env.example` to `.env` and fill it in:
   ```bash
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   JWT_SECRET=<output of: openssl rand -base64 48>
   ALLOWED_EMAILS=you@gmail.com      # optional
   ```
3. Restart with `npm start`. The app now opens on a sign-in page.

How it works:
- The browser gets an ID token from Google. The server checks it against Google's published keys (signature, audience, issuer, expiry and verified email), then issues its own session token, valid for 30 days (`JWT_EXPIRATION_MS`, default `2592000000`).
- Sign-up is open: without `ALLOWED_EMAILS`, any Google account can sign in, and each gets its own private, empty data. List emails in `ALLOWED_EMAILS` (comma-separated, checked on every request) to restrict access.
- With `ALLOWED_EMAILS` set, the first allow-listed account to sign in takes over the data you entered before turning sign-in on. An account that already has its own data from the earlier version keeps that instead, and the local data stays where it is.
- Sign out from the account menu (your avatar, top right).

`.env` is git-ignored. Never commit it.

## Deploy to Vercel

The deployed app keeps data in **Neon Postgres** (free tier), because Vercel functions have no disk that survives between requests. It always requires Google sign-in.

1. **Import the repo.** On [vercel.com/new](https://vercel.com/new), import the repo and keep the **Other** framework preset. `vercel.json` already sets up the static site and the API.
2. **Set the environment variables** (Production):

   | Variable | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | Your OAuth client ID |
   | `JWT_SECRET` | A new random string: `openssl rand -base64 48` |
   | `ALLOWED_EMAILS` | Optional. Leave it out so anyone can sign in with Google (each account gets its own private data), or list emails to restrict access. |

3. **Add the database.** In the project, go to **Storage → Create Database → Neon** and connect it. This adds `DATABASE_URL` for you (`POSTGRES_URL` also works); the table is created on first use. Pick the region closest to you, for example Singapore. Alternatively, paste a connection string from your own Neon account as `DATABASE_URL`.
4. **Redeploy** so the variables take effect.
5. **Authorize the live URL.** In Google Cloud Console, open your OAuth client and add `https://<your-project>.vercel.app` to **Authorized JavaScript origins**. It can take a few minutes to apply.
6. **Move your data.** In the local app, use **account menu → Export backup**. In the deployed app, use **account menu → Import backup**.

Until `GOOGLE_CLIENT_ID`, `JWT_SECRET` and the database are set, the deployed sign-in page lists what's missing and serves no data. After that, every `git push` to `main` redeploys automatically.

## Your data

- **v2 is stored separately; v1 is never touched.** The first time you open this version, your old data is upgraded and saved as a new document: `data/db.v2.json` (no sign-in), `data/users/<google-id>.v2.json` (with sign-in), or the `givemebucks_v2` table on Neon. The old `data/db.json`, `data/users/<google-id>.json` and Neon table `givemebucks_user_data` are only read, never written, so redeploying the old version still shows your data as of the upgrade. A copy of the old document also travels inside the new one and inside every export.
- After the upgrade, FD values are no longer computed automatically: update an FD's value, or close it with its final amount.
- **Backups:** the account menu has **Export backup** (a JSON file) and **Import backup** (replaces your data; it offers to export the current data first). On the Mac, a dated copy is also kept in a `backups/` folder next to each file before the first change each day (the last 30 are kept); on Neon, use Neon's own restore history.
- Saves are checked against the version you loaded. If another device saved in between, the app reloads the data, keeps what you typed, and asks you to check and save again.
- The Mac server listens on `127.0.0.1` only and rejects requests addressed to other hosts. `data/` is git-ignored.

## Removing the old login item

Earlier versions could install a login item for reminders. Reminders are gone; if you installed it, remove it with:

```bash
launchctl bootout gui/$(id -u)/local.givemebucks
rm ~/Library/LaunchAgents/local.givemebucks.plist
```

`data/reminder-state.json` and `data/server.log`, if present, are no longer used and can be deleted.

## Development

```bash
npm test     # node --test test/
```

| File | Role |
|---|---|
| `local-server.js` | Mac server (`npm start`): settings from `.env`, file or Neon storage. Not named `server.js` so Vercel doesn't mistake it for the cloud app |
| `api/index.js`, `vercel.json` | Vercel function entry point and routing |
| `lib/app.js` | Request handler shared by both: static files, `/api/db` (migrates v1 on first read, validates every save), `/api/db/v1`, sign-in routes |
| `lib/storage.js`, `lib/store.js` | v2 storage (JSON files or Neon) and read-only access to v1 |
| `lib/auth.js` | Google ID-token verification, session tokens, allowlist |
| `public/js/dates.js`, `model.js` | Dates, the v2 document, validation and the v1 → v2 migration (shared by browser and server) |
| `public/js/ledger.js` | All money rules: values, net worth, spending, growth, coverage, explanations |
| `public/js/actions.js` | Pure changes to the document (add place, update balances, add/move money, edit, close, delete) |
| `public/js/views.js`, `sheets.js`, `app.js` | The overview page, every sheet, and the app shell (load, save, undo, routing, account menu) |
| `public/js/ui.js`, `charts.js`, `format.js` | DOM helpers, SVG charts, Indian number formatting |
