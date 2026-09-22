# Lark Chapel Hill Shuttle Locator

Live positions from Lark’s Linktree Motive share links, a local history logger,
loop-matching, and a **Vercel-ready Next.js tracker** in `web/`.

## Web app (Vercel)

```bash
cd web
npm install
npm run dev
# http://localhost:3000
```

Deploy:

1. Import https://github.com/Thespaceblade/lark-chapel-hill-shuttle in Vercel
2. Set **Root Directory** to `web`
3. Framework: Next.js (auto) · Deploy

The site polls `/api/live` every 10s (server → Motive), draws intended loops, and
shows a crude next-stop ETA from loop distance ÷ speed.

## Python CLI

```bash
python3 lark_shuttle.py
python3 lark_shuttle.py log --interval 10
python3 lark_shuttle.py history express --hours 6
python3 lark_shuttle.py match regular
```

History is stored in `shuttle_history.db` (gitignored). Intended loops live in
`intended_routes.json` (copied into `web/data/` for the site).

## Commands

| Command | What it does |
|---|---|
| `now` (default) | Live lat/lon, address, speed |
| `log` | Poll forever and save new pings |
| `history` | Print saved trail |
| `match` | Snap pings to intended loop; infer legs |
| `discover` | Show Linktree UUIDs + Motive API endpoint |

## Notes

- Motive’s public share API only returns the **current** ping.
- Share links expire around `2027-07-01`.
- Be polite; don’t hammer the endpoint.
