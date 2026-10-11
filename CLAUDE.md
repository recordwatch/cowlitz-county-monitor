# Cowlitz Jail Roster — Project Context

## What it is
A public jail roster monitor for Cowlitz County, WA, modeled on the Kitsap
monitor (`recordwatch/ksco-scraper`). Scrapes the Corrections Dept. roster every
30 minutes, tracks bookings and releases, and serves a static site.

## Source
https://apps.co.cowlitz.wa.us/CCCD/custody/default/Index.html — one static HTML
page. The roster table (`#basic-btn`) lists name, inmate number, booked-at time
and cell; each inmate's profile and charges sit in a hidden modal
(`#Modal-tab-<number>`) on the same page. One request gets everything.

## Architecture
- **Scraper:** `scrape.js` (orchestrator) + `scrapers/cowlitz.js` (Cheerio parsing), Node 20 built-in fetch
- **Schedule:** `.github/workflows/scrape.yml`, cron every 30 min (backup only — see Scheduling)
- **Storage:** JSON committed to `data/` — no server, no database
- **Frontend:** React + Vite in `frontend/`, built and pushed to the `gh-pages` branch

## Key facts / gotchas
- The roster's "Number" is a **per-person** inmate number, reused across
  bookings. A booking's `id` is `<inmateNumber>-<bookedAt digits>`.
- No release feed exists. `releasedAt` = the scrape where the person first
  went missing, so it's accurate to ~30 min (one run interval).
- No demographics (age/sex/race/height) are published.
- Entries present on the very first scrape have `baseline: true` — we didn't
  see those bookings happen. History hides their "booked" lines.
- Timestamps are Pacific local, `YYYY-MM-DDTHH:MM:SS` (same format as the
  roster), so they sort as strings.
- Safety: if the roster comes back empty or < 50% of the previous in-custody
  count, the run exits non-zero without marking anyone released.
- Cheerio's `.map().get()` drops `null` values — use `.toArray().map()` when
  empty cells matter.

## Scheduling (important)
- GitHub's own `schedule:` cron is unreliable for small repos — Kitsap's
  measured gaps were 3–9 hours (median ~5.5 h), not 30 minutes.
- The real trigger is an external **cron-job.org** job that POSTs every 30
  minutes to
  `https://api.github.com/repos/recordwatch/cowlitz-county-monitor/actions/workflows/scrape.yml/dispatches`
  with body `{"ref":"main"}`. The workflow's own `schedule:` stays as a backup.
- It authenticates with a fine-grained GitHub token (Actions: read & write on
  the county repos only). **The token expires in August 2027** — after that, runs
  silently fall back to GitHub's slow schedule. Renew the token and update
  the cron-job.org job before then.

## Data files
- `data/change_log.json` — every booking ever seen, newest `bookedAt` first;
  entries are updated in place (charges, location, release)
- `data/stats.json` — precomputed stats (`stats.js`)
- `data/status.json` — `{ inCustody, lastUpdated }`

## Local dev
- `ROSTER_HTML_FILE=page.html node scrape.js` parses a saved page instead of fetching
- Frontend: copy `data/*.json` into `frontend/public/data/`, then `cd frontend && npm run dev`
