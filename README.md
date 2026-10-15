# Lark Chapel Hill Shuttle Locator

Live Motive share polling (Python CLI) plus a **Vercel Next.js tracker** at the repo root.

**Production:** https://lark-shuttle.vercel.app

## Web app (Vercel)

```bash
npm install
npm run dev
# http://localhost:3000
```

Deploy (Root Directory = repository root / leave blank — `package.json` is at the top level):

1. Import https://github.com/thespaceblade/lark-chapel-hill-shuttle in Vercel
2. Deploy (Motive share key is built-in; optional env override below)

Optional env override **`MOTIVE_WEB_SHARE_API_KEY`** (paste the raw key — no quotes). A wrong value causes Motive `HTTP 403`. Get the current key with `python3 lark_shuttle.py discover`.

```bash
cp .env.example .env.local
# optional: MOTIVE_WEB_SHARE_API_KEY=...
```

The site polls `/api/live` every 1s, draws intended loops, and shows next-stop ETA.

### Home Screen + arrival alerts (Web Push)

The tracker is installable as a home-screen web app. On **iPhone (iOS 16.4+)**, open the site in Safari → Share → **Add to Home Screen**, launch from the icon, then use **Notify** on the board (pick line + stop; alerts at **5 min** and **2 min**).

Server setup (Vercel env):

1. `npx web-push generate-vapid-keys` → set `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:…`)
2. Create a free [Upstash Redis](https://upstash.com/) DB → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
3. Set `CRON_SECRET` to a long random string (Vercel Cron calls `/api/notify/tick` every minute with `Authorization: Bearer …`). **Minute crons require Vercel Pro**; on Hobby change `vercel.json` to a daily/hourly schedule or call the tick URL from an external cron.

Without those env vars the board still works; Notify stays off with a short setup hint.

## Python CLI

```bash
python3 lark_shuttle.py
python3 lark_shuttle.py log --interval 10
python3 lark_shuttle.py history express --hours 6
python3 lark_shuttle.py match express          # auto: GPS fit → express or regular loop
python3 lark_shuttle.py match express --on-route regular
python3 lark_shuttle.py match regular
python3 lark_shuttle.py label                 # backfill route_key; write data/train_pings.json
```

`match` loads pings by Motive vehicle (`shuttle_key`) and projects them onto the
auto-inferred (or overridden) route geometry. No history migration needed when
a bus swaps routes.

`label` marks every ping with `route_key` (passenger loop), `route_status`, and
`train_ok`. Vehicle identity stays in `shuttle_key`. Use `data/train_pings.json`
for trajectory features.

The live logger also stores **ETA predictions** (`predictions` table →
`data/predictions.json`) and, when the bus reaches the target stop, the
**actual travel time** + error (`data/train_predictions.json`). Display ETA uses
a clamped cruise speed (min 8 mph) so crawls do not inflate estimates.
History: live logger writes `shuttle_history.db` (gitignored). Snapshots are
committed to `data/shuttle_history.db` + `data/history.json` by
`scripts/push_history.sh` (also runs every 2h via `scripts/push_history_loop.sh`).

```bash
bash scripts/push_history.sh          # snapshot + push now
bash scripts/push_history_loop.sh     # every 2 hours
```

## Notes

- Motive’s public share API only returns the **current** ping.
- Share links expire around `2027-07-01`.
- **Daily roster (Chapel Hill time):** Shuttle 1 runs **Express** until **2:00 PM**, then **Regular**. Shuttle 2 swaps the other way. Motive UUIDs and history `shuttle_key` stay fixed (morning paint); live UI “usual home” remaps in `src/lib/roster.ts`.
