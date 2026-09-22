# Lark Chapel Hill Shuttle Locator

Live positions from Lark’s Linktree Motive share links, plus a local history logger
and loop-matching against the intended route.

## Quick start

```bash
# Where is it right now?
python3 lark_shuttle.py
python3 lark_shuttle.py express

# Start recording history (Ctrl+C to stop)
python3 lark_shuttle.py log
python3 lark_shuttle.py log --interval 10

# Ask where it’s been
python3 lark_shuttle.py history
python3 lark_shuttle.py history express --hours 6
python3 lark_shuttle.py history --geojson > trail.geojson

# Snap pings onto the predetermined loop; infer travel between them
python3 lark_shuttle.py match regular
python3 lark_shuttle.py match express --hours 6 --limit 40
python3 lark_shuttle.py match express --from-id 10 --to-id 40 --json
python3 lark_shuttle.py match regular --geojson > matched.geojson
```

History is stored in `shuttle_history.db` (SQLite) next to the script. Duplicate Motive timestamps are skipped, so parked buses don’t fill the DB.

The intended loops live in `intended_routes.json`. `match` projects each GPS ping onto that polyline (even when the ping is far off the road) and treats the **forward** arc between two snaps as the path the bus travelled.

## Commands

| Command | What it does |
|---|---|
| `now` (default) | Live lat/lon, address, speed |
| `now --save` | Live query and append to the DB |
| `log` | Poll forever and save new pings |
| `history` | Print saved trail |
| `match` | Snap pings to intended loop; infer legs between them |
| `discover` | Show Linktree UUIDs + Motive API endpoint |

## How live location works

1. Linktree → Motive share URLs (`#/share/v/<uuid>`)
2. Motive SPA JS → `https://api.keeptruckin.com/api/s1/live_shares` + public `X-Web-Share-Api-Key`
3. GET that endpoint for each shuttle

Motive’s public share API only returns the **current** ping. Past locations come from our logger.

## Notes

- Default poll interval is 10s so we catch Motive updates that can arrive every few seconds while moving.
- Share links expire around `2027-07-01` (see `discover` / live JSON).
- Be polite; don’t hammer the endpoint.
