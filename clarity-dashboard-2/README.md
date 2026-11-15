# Clarity dashboard

3D map of the Clarity water network, covering the whole US with Princeton as the home base: a real-scale water tank per node whose water level shows TDS and whose color shows the verdict, radio-link arcs to the base station, a faint illustrative water route, a before/after card with Gemini's explanation, a node drawer with pH / TDS / clarity / anomaly history, and a business view with filter-life gauges, replace alerts, investigator reports and a CSV export of the water log.

Stack: Vite + vanilla JS, MapLibre (no token) + deck.gl, Chart.js. All libraries are bundled, so the built page works without a CDN.

## The whole US

- **Every building, road and river in the US** comes from [Overture Maps](https://overturemaps.org) vector tiles (PMTiles on Overture's public S3, release 2026-10-21). No API key. Add `?offline=1` to use only the bundled Princeton data with no internet.
- **Buildings look like buildings:** walls get generated facade textures (windows with frames and sills, floor lines, front doors on houses, shop fronts with awnings on mid-rise streets, glass curtain walls on towers). Heights and floor counts are real where Overture has them. Roofs use the mapped roof color when there is one, tiles on houses and concrete on towers otherwise. See `src/facades.js`.
- **US water samples:** 13,890 Water Quality Portal sites (USGS, EPA and state agencies) with a TDS sample since January 2024, colored against the EPA 500 mg/L guideline. Hover for the site, value, date and agency. Rebuilt from WQP CSV downloads into `public/data/us_tds.json`.
- **USA button, city labels and search:** zoom out to the whole country; search any US city, address or place (OpenStreetMap geocoder, online). Street and building names anywhere come from the tiles on screen.
- **Simulated nodes** come from the gateway and are labeled on screen. Only nodes near the Princeton base station draw radio links.


## The Princeton map

The basemap is real Princeton data bundled in `public/data/` (about 2 MB gzipped), so the 3D map works with no internet and no API key:

- ~30,000 buildings with heights, roads and paths, the Dinky rail line, lakes, rivers and the D&R canal, parks, woods and golf courses, and ~1,100 businesses (cafes, restaurants, schools, clinics).
- Source: [Overture Maps](https://overturemaps.org) release 2026-10-21, which is built from OpenStreetMap. © OpenStreetMap contributors (ODbL).
- Regenerate with `python3 scripts/fetch.py <theme/type> <bbox> <columns>` then `python3 scripts/convert.py public/data`.

Online extras: hillshade from AWS Terrain Tiles and a satellite basemap from Esri. They are skipped quietly when offline.

Map features: drag, zoom, rotate and tilt (right-drag or Ctrl-drag); Dark (default) / Light / Satellite basemaps; 2D/3D switch; Orbit (slow camera spin); Tour sites (flies between every node, for the demo video); search for any node, USGS site, named building or business; layer toggles; hover a building for its name and height; hover a business to see its nearest Clarity node and that node's water; a replay slider that rewinds the columns through the day's readings; fullscreen and "my location".

## Water source

- **Water source tab:** Princeton is served by New Jersey American Water's Raritan System (PWSID NJ2004002). Facts come from the utility's 2025 water quality report: 92% surface water (Millstone River, Raritan River, D&R Canal) and 8% from 98 wells, chloramines for surface water and chlorine for groundwater, sodium 32 to 99 ppm, lead 2 ppb (54 sites) and copper 0.3 ppm at the 90th percentile. The 126 million gallons a day figure is from the 2023 report. The reports do not list TDS.
- **On the map:** the Raritan-Millstone and Canal Road treatment plants, 20 mapped water towers, fire hydrants, and the rivers and canal upstream. The blue route from the plants to the Princeton Ridge tower and on to each node is illustrative, since water main locations aren't public.
- **Follow the water:** a camera tour from the river intake, through both plants and the ridge tower, to the Clarity tank.
- **Themes:** Dark (default), Light (colored walls, tiled roofs, ~30,000 trees) and Satellite. The map opens on Princeton; the USA button or zooming out shows the whole country.

## Tests

`node tests/e2e.cjs` (with `npx vite preview --port 4173` running) clicks through the whole dashboard in a headless browser: 45 checks covering every theme, layer toggle, camera button, search, tabs, the node drawer, CSV export, replay, nationwide tiles (New York), the phone layout and offline mode, and fails on any JavaScript error. Set `SHOTS=<folder>` to save screenshots.

## Run

```bash
npm install
npm run dev          # http://localhost:5173, proxies /api and /ws to the gateway on :8000
```

Start the gateway first (`cd gateway && MOCK=1 python gateway.py`). The page shows only gateway data: the real tank plus the gateway's simulated nodes, which are labeled "simulated". If the gateway can't be reached, the top bar says **Gateway offline** and keeps retrying. There is no fake fallback.

```bash
npm run build        # emits dist/ with relative paths; the gateway can serve it as static files
```

URL options:

| Option | Meaning |
| --- | --- |
| `?api=http://192.168.1.20:8000` | Gateway on another machine (otherwise same origin, or the dev proxy) |
| `?mock=1` | Built-in demo data for UI work and tests only (no header label; the artifact build uses it too) |
| `?base=40.3502,-74.6522` | Base station location for the radio-link arcs |
| `?style=<url>` | Another MapLibre style. Default is CARTO Dark Matter; if it can't load (offline), the map falls back to a plain dark canvas and the data layers still render |

## Data it uses

Built against the gateway shapes: `GET /api/nodes`, `GET /api/readings?node=&limit=`, `GET /api/tests/{node}/{test}`, `GET /api/filters`, `GET /api/reference`, and `/ws` messages of type `reading`, `decision` and `report`. Until `/api/filters` and `/api/reference` exist on the gateway, those panels stay empty.

Decisions with `source: "gemini"` are labelled Gemini, `local_rule` as Local rule.

Filter rules shown in the UI: ZeroWater is REPLACE once an after-test reads 6 ppm or more; Brita Elite is rated for 450 L.
