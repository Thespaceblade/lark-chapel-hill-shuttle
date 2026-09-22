# Intended Lark shuttle routes

Stop coordinates are resident-provided GPS pins.
Route polylines were imported from Google My Maps KMZ exports
(`routes_from_maps/express.kmz`, `routes_from_maps/regular.kmz`).
KMZ direction waypoints are ignored; only the LineString path is used.

## Express
Lark → Memorial Hall (with campus loop as drawn in My Maps) → Lark

## Regular
Lark → Memorial Hall → Student Union → Business school → Health Sciences Library → Sitterson → Lark

## Daily vehicle roster (America/New_York)

| Time | Shuttle 1 | Shuttle 2 |
|------|-----------|-----------|
| Before 2:00 PM | usual Express | usual Regular |
| From 2:00 PM | usual Regular | usual Express |

**Vehicles** are numbered `1` / `2` (Motive trackers). History `shuttle_key`
is the vehicle number. **Routes** are `express` / `regular` (stored as
`route_key` from GPS). The roster above is only a soft “usual service” hint
for UI notes — either bus may run either route.

## Vehicle → route assignment

Default `mode` is **`auto`**: compare GPS to both loops. Pin with
`"1": "regular"` in `data/route_assignment.json` or `match 1 --on-route regular`.

Run `python3 lark_shuttle.py label` for training exports. Notes look like
`Shuttle 1 · running Regular`, not “Express is on Regular.”

Preview: `kmz_routes_preview.html`
Machine-readable: `intended_routes.json` (and `data/intended_routes.json` if present)
