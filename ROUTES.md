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

When the Express bus is running the Regular loop, leave pings as
`shuttle_key=express` and set `"express": "regular"` in that file (or pass
`match express --on-route regular`). Do **not** rewrite history keys.

The web UI also infers service from GPS (`src/lib/service.ts`); the assignment
file is the data/CLI override when you want a fixed mapping.

Preview: `kmz_routes_preview.html`
Machine-readable: `intended_routes.json` (and `data/intended_routes.json` if present)
