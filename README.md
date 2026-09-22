# Lark Chapel Hill Shuttle Locator

Live Motive share polling (Python CLI) plus a **Vercel Next.js tracker** at the repo root.

## Web app (Vercel)

```bash
npm install
npm run dev
# http://localhost:3000
```

Deploy (Root Directory = repository root / leave blank — `package.json` is at the top level):

1. Import https://github.com/Thespaceblade/lark-chapel-hill-shuttle in Vercel
2. Deploy (Motive share key is built-in; optional env override below)

Optional env override **`MOTIVE_WEB_SHARE_API_KEY`** (paste the raw key — no quotes). A wrong value causes Motive `HTTP 403`. Get the current key with `python3 lark_shuttle.py discover`.

```bash
cp .env.example .env.local
# optional: MOTIVE_WEB_SHARE_API_KEY=...
```

The site polls `/api/live` every 1s, draws intended loops, and shows next-stop ETA.

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
for ETA model training (on-route + trip-context Lark stops only).
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
