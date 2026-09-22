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
2. Add env var **`MOTIVE_WEB_SHARE_API_KEY`**
3. Deploy

Local secret:

```bash
cp .env.example .env.local
# paste Motive X-Web-Share-Api-Key
```

The site polls `/api/live` every 1s, draws intended loops, and shows next-stop ETA.

## Python CLI

```bash
python3 lark_shuttle.py
python3 lark_shuttle.py log --interval 10
python3 lark_shuttle.py history express --hours 6
python3 lark_shuttle.py match regular
```

History: `shuttle_history.db` (gitignored). Routes: `intended_routes.json` / `data/intended_routes.json`.

## Notes

- Motive’s public share API only returns the **current** ping.
- Share links expire around `2027-07-01`.
