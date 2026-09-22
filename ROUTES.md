# Intended Lark shuttle routes

Stop coordinates are resident-provided GPS pins.
Route polylines were imported from Google My Maps KMZ exports
(`routes_from_maps/express.kmz`, `routes_from_maps/regular.kmz`).
KMZ direction waypoints are ignored; only the LineString path is used.

## Express
Lark → Memorial Hall (with campus loop as drawn in My Maps) → Lark

## Regular
Lark → Memorial Hall → Student Union → Business school → Sitterson → Lark

## Vehicle → route assignment

Motive trackers keep a stable `shuttle_key` (`express` / `regular`) in history.
Which **geometry** to project onto is separate: see `data/route_assignment.json`.

Default `mode` is **`auto`**: compare recent pings to both loops and pick the
clearer fit (Express-on-Regular, both on home routes, etc.). Pin a vehicle with
`"express": "regular"` or pass `match express --on-route regular` when you want
a fixed mapping. Do **not** rewrite history keys.

For training / clean exports, run `python3 lark_shuttle.py label`. That writes
`route_key` on every ping and `data/train_pings.json` (`train_ok` only). An
Express tracker ping that sits on the Regular loop is labeled `route_key=regular`.

The web UI does the same live via GPS (`src/lib/service.ts` + `assignServices`).

Preview: `kmz_routes_preview.html`
Machine-readable: `intended_routes.json` (and `data/intended_routes.json` if present)
