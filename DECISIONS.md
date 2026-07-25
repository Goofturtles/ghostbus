# DECISIONS.md

Honest record of every non-obvious choice and every deviation from the brief.
Milestone 0 decisions are in §1–§9; Phase 2 (API + honest ETAs + ghost identity join)
begins at §10.

## 1. Pre-existing scaffold was preserved, not overwritten (deviation from Deliverable 1)

When work started, `ghostbus/` already contained a **different, more advanced
scaffold**: a Fastify "voxel transit" API (`server/index.ts`, `feeds.ts`, `live.ts`,
`scene.ts`), a full hand-built React frontend under `web/`, shared types, i18n, and
a multi-city coverage engine — all created the same day. The brief assumed a
greenfield (`Project root (create it)`), and asked for `/web` to be "just a
`npm create vite` skeleton, untouched placeholder."

**Decision:** preserve the existing work and layer Milestone 0 in additively rather
than delete a hand-built app. Deleting is irreversible; the existing code is
clearly intended later-phase work (its `server/live.ts` even references a
`BLOCKERS.md` noting that live rendering "needs the static GTFS seed … loaded into
Postgres" — which is exactly what M0 delivers).

**Consequences / honest deviations:**
- `/web` is **not** an untouched Vite skeleton — it already holds a real React app.
- `/server` contains both the pre-existing `server/*.ts` and the new `server/src/*.ts`
  (db, tz, gtfs, seed_toronto, collect) plus `server/migrations/`.
- `package.json` was **merged** (existing fastify/react/three deps kept; the four M0
  runtime deps + two type packages added; `seed:toronto` repointed to the new seeder;
  `collect` added). The old `seed:toronto` pointed at a non-existent
  `server/scripts/seed.ts`, so nothing working was lost.
- `gtfs-realtime-bindings` left at the pre-existing `^1.1.1` (see TOOLKIT.md).

## 2. Dual DB driver: pg + PGlite (the approved deviation)

The spec assumed `DATABASE_URL` is always set. We added an embedded-Postgres local
fallback so the app runs with zero signup:

- `DATABASE_URL` set → `pg` Pool (production). A **real Neon Postgres (us-east-2)**
  was provisioned for this milestone, so **pg is the primary path** and all shipped
  proof metrics come from it.
- `DATABASE_URL` unset → `@electric-sql/pglite`, persisting to `ghostbus/.data/pglite`.

The same standard-Postgres SQL runs on both (`server/src/db.ts`). Honest trade-offs:
- PGlite is single-threaded WASM — large loads are slower and it has no network pool.
  This is one reason the seed windows the data (see §3).
- Neon free tier: the pool is capped small (`max: 4`) and `sslmode=require` is used as
  given. Batched multi-row INSERTs (1000 rows/statement) keep the network round-trips
  down; loads commit in 40k-row chunks rather than one giant transaction.
- The PGlite path stays in the codebase and is a first-class, tested fallback.

## 3. Seed windows to service active in the next N days (the granted latitude)

By default the seeder loads `trips`, `stop_times`, and `shapes` **only** for
`service_id`s active within the next `GHOSTBUS_SEED_WINDOW_DAYS` days (default **7**).
`routes`, `stops`, `calendar`, `calendar_dates`, and `cities` are always loaded in full.

- Rationale: TTC `stop_times.txt` is millions of rows. Windowing keeps this week's
  ETAs and ghost detection exact while making the load fast on both PGlite and Neon.
- Re-seeding refreshes the window (`seed:toronto` is truncate-and-reload per table).
- `GHOSTBUS_SEED_FULL=1` disables the filter and loads the entire feed.
- Honest downside: schedules beyond the window are not present until you re-seed. The
  collector only needs today's (and yesterday's, for after-midnight trips) schedule,
  which is always inside the window.

## 4. GTFS time storage

Times are stored as **seconds-past-service-midnight INTEGERs** (`arrival_s`,
`departure_s`), so a GTFS time like `25:30:00` becomes `91800` and stays valid for
trips that run past midnight. Parsing lives in `server/src/gtfs.ts::parseGtfsTime`.

## 5. `shapes.points` encoding

Stored as **JSONB**: an ordered array of `[lat, lon]` pairs sorted by
`shape_pt_sequence`. Chosen over a polyline string for zero-dependency
readback (`points[i][0]=lat`, `points[i][1]=lon`) by the future map layer.

## 6. Timezone / DST handling

All agency-local time math uses the built-in `Intl` API against IANA
`America/Toronto` (`server/src/tz.ts`) — no manual UTC offsets anywhere. `hour_of_week`
(0..167, Monday 00:00 = 0), service-day midnight epochs, and GTFS `>24:00:00` times are
all resolved through it, so EST/EDT and the DST transitions are handled by the tz
database, not by us.

## 7. Schema hardening adopted from review

- `stop_times` PRIMARY KEY `(agency, trip_id, stop_sequence)`; the redundant
  `(agency, trip_id)` index was dropped (the PK prefix covers it) to cut write cost on
  the multi-million-row load. Kept `(agency, stop_id, departure_s)`.
- `ghosts` PRIMARY KEY `(agency, trip_id, scheduled_start)`.
- `trip_delay_obs` gained a `service_date INTEGER` column and
  `UNIQUE (agency, trip_id, stop_id, service_date)` so idempotency is **DB-enforced**
  (`ON CONFLICT DO NOTHING`) rather than trusted only to the collector's in-memory
  dedupe (which is also kept, so restarts don't hammer the DB).

## 8. Delay observations — what counts as an honest observation

From the TripUpdates feed, a `trip_delay_obs` row is written only when:
- the stop has been **passed** (its `stop_sequence` is behind the vehicle's
  `current_stop_sequence`, or its predicted event time is already in the past), **and**
- the `StopTimeUpdate` carries an **explicit `delay`** (departure delay preferred, else
  arrival). We do **not** synthesize a delay from predicted-time-minus-static when only a
  time is present — that would be an assumption dressed up as a measurement.
- Delays with `|delay| > 24h` are dropped as bogus.
- `hour_of_week` is computed from the event time (Toronto-local); `service_date` comes
  from the feed's `trip.start_date` when present, else the observation's Toronto date.

## 9. Ghost detection is gated on a measured trip_id match rate

RT ghost detection only makes sense if realtime `trip_id`s line up with static
`trip_id`s. On the first cycle with real trip_ids the collector measures the match rate;
if it is below 50%, ghost/cancelled emission is **suppressed** (otherwise every scheduled
trip would look like a ghost) and the mismatch is reported. See BLOCKERS.md for the
empirical result on live TTC data. **Phase 2 replaces this gate** with the identity join
in §12 and a mass-ghost breaker.

---

# Phase 2 — Toronto API + honest ETAs + ghost identity join

## 10. Deletions executed (old "voxel transit" generation)

Per the Phase-2 cleanup mandate, the pre-existing old-generation server was removed
(the hand-built `web/` app is deliberately untouched — it is Phase 3's to salvage):

- **`server/scene.ts`** — deleted. Synthetic/derived demo scene; honestly labeled but has
  no future (the spec's Demo Mode must replay REAL recorded data, a later phase).
- **`server/feeds.ts`** — deleted. Vancouver/multi-city feed catalog; Tier 0 is Toronto-only.
- **`server/index.ts`** — deleted. Multi-city `/api/:city` API bound to the synthetic scene.
- **`server/live.ts`** — deleted. Its protobuf decode is superseded by the collector/poller.
- **`three` + `@types/three`** — removed from `package.json` (imported nowhere; dead).
- Old scripts `dev:server` (pointed at the deleted `server/index.ts`) removed; `dev` and
  `start` rewired to the new `server/src/server.ts`. `concurrently` is retained in devDeps
  (unused by the new `dev`, but a general dev tool Phase 3 may use for web+api together).
- **`shared/types.ts`** — contents replaced with the new API request/response contract
  (same file path, imported by Phase 3's web app). The old voxel/i18n types were dropped.

## 11. One deployable service: in-process poller (Deliverable 2)

The GTFS-realtime poll cycle + in-memory stores were extracted from the old monolithic
`collect.ts` into **`server/src/poller.ts`** (`createPoller(db)` → start/stop + getters).
`collect.ts` is now a thin standalone wrapper (same `npm run collect`, `GHOSTBUS_MAX_CYCLES`
intact). The API (`server/src/server.ts`) starts the same poller in-process, so `/api/vehicles`
and `/api/health` read live state from memory — one process, per spec. All Phase-1 honesty
guards are intact: feedsFresh gate, per-stop dedupe (+ DB unique), 14-day retention, vehicle
eviction, bogus-delay drop.

## 12. Identity join — DEVIATION from the literal `(route_id, start_date, start_time)` key

The spec's proposed join key could not be built as written because **the TTC RT feed
provides neither `start_time` nor `start_date`** — both are empty strings on every entity
(measured, all 1200 vehicles / 1876 trip updates). What the feed does carry, measured live:

- `route_id` — matches the static `route_id` (174/175 distinct present in `routes`).
- `stop_id` (per StopTimeUpdate) — ~60–70% present in static `stops` (partial namespace).
- an explicit `delay` and a predicted `time` per StopTimeUpdate.
- `trip_id` — RT-internal, does NOT match static (~0.1%, confirmed again).

So the join uses the only sound handle — the schedule itself. For each stop a trip update
covers, `scheduled_time_at_stop = predicted_time − delay` (delay is *defined* relative to the
static schedule), converted to seconds-past-service-midnight. A static trip is claimed when
several such `(route_id, stop_id, scheduled-second)` points agree (±75s, **≥2 stops**). This
is a strict generalization of the spec's `(route_id, start_time)` key (many stops, not just the
first) and is **exact by the GTFS definition of `delay`** when the RT feed and the loaded static
are the same board period. The pure claim logic lives in `server/src/join.ts` and is unit-tested
(exact / tolerance / double-claim / unmatched / wrap / ambiguous).

- **`minVotes = 2`** deliberately: a single coincidental stop-time alignment must not claim a
  trip (that would fabricate presence and hide real ghosts). One vote is noise; two agreeing
  stops on the same route is signal.
- The index is built over **all loaded static trips** (not just calendar-active), so the join
  operates against everything we have; ghost detection then intersects claims with the
  calendar-active, due set.

## 13. Measured live join rate = 0% right now — the honest reason (clock vs board offset)

The machine clock is **2026-07-24 (Fri)** but this TTC GTFS feed's calendar validity is
**2026-07-26 … 2026-09-05** — the schedule board begins two days in the *future*. Consequences,
all honest and all documented rather than papered over:

- **0 calendar-active service today** → 0 "due" trips → **ghosts = 0** (an honest 0: there is no
  scheduled service today in this feed, so nothing can be a no-show). The mass-ghost breaker
  never trips (0/0).
- The currently-running RT trips reference the *pre-Jul-26* board, which is not in our static
  data, so `predicted − delay` doesn't line up with the loaded Jul-26+ timetable within ±75s.
  With the ≥2-stop safety threshold the live join rate is **0.0%** (corroborated by an
  independent probe: 3.8% of trips get exactly one coincidental vote, 0% get two).

The mechanism is correct and proven by unit tests; when the clock falls inside the feed's board
period (Jul 26+), `predicted − delay` equals the loaded `departure_s` by definition and the join
becomes near-exact, activating genuine ghost detection. See BLOCKERS.md for the full addendum.

## 14. `mass-ghost` sanity breaker

If a cycle would flag ghosts for **> 30%** of that cycle's due trips, emission is suppressed and
logged loudly (a mass no-show is almost certainly a feed outage or our bug, not reality). This
sits alongside the retained global `feedsFresh` guard (never scan for ghosts on a stale feed).

## 15. Honest ETAs + evidence thresholds (Deliverable 1 arrivals)

Every departure carries an evidence object `{ n, windowDays, bucket }`. The estimate is
`scheduled + median historical delay`, band P25–P75, chosen by hard thresholds (`server/src/eta.ts`):
`(route, stop, hour_of_week)` needs **n ≥ 8** (`stop-hour`); else `(route, hour_of_week)` needs
**n ≥ 20** (`route-hour`); else the estimate is **null** with `bucket:'none'` (schedule-only).
A confident estimate is never returned without its evidence. The `(route, hour_of_week)` rollup
is a new table, **`agg_delay_route`** (migration `003_phase2.sql`).

- **Arrivals `?at=` parameter (default = now):** a truthful "what is scheduled at time T"
  affordance (many transit APIs have one). It computes real scheduled departures from real
  static data for the given instant; it does not synthesize anything. It also makes the endpoint
  demonstrable despite the clock/board offset above: querying `at = now + 7d` lands inside the
  feed's validity at the *same hour_of_week* as the freshest observations, so real Friday-afternoon
  departures show real evidence. `liveEtaMs` is only attached when `at` is within 10 min of now
  (a live prediction is meaningless against a different-time scheduled slot).

- **Phase 4 amendment — "Next scheduled service" probe now walks day-by-day (honesty fix):**
  The Nearby view's "next scheduled service" probe (`web/src/hooks/useLive.ts`) previously fired a
  single `at = now + 7d` query, so with today = 2026-07-24 it surfaced **Fri Jul 31** — a real
  scheduled day, but *not* the true next one. The board actually activates **Sun Jul 26**. The probe
  now walks forward day-by-day from tomorrow (offsets d = 1…8, each a 24h `windowMin` window) and
  uses the **first** day that returns departures, so the section header's date stamp
  (`fmtServiceDate`) is the genuine next service day. Verified live: the header now reads
  **"SUN, JUL 26"** and shows real departures (e.g. `310 Spadina 5:12 AM`). Sequential, aborts if the
  rider switches stops mid-walk. The server `at=` demonstration technique above is unchanged.

## 16. Aggregation computed in JS (percentiles), verified on the driver

`server/src/aggregate.ts` recomputes `agg_delay` and `agg_delay_route` over a trailing 14-day
window and runs on API boot + hourly (and via `npm run aggregate`). Percentiles use
`percentileCont` (matching Postgres `percentile_cont`, unit-tested) computed **in JS** so the
numbers are byte-identical on the pg and PGlite drivers. `percentile_cont` was verified present
(logged each run: `true` on pg); JS is still used for cross-driver determinism. Each table is
rebuilt atomically inside a transaction so a reader never sees a half-written aggregate.

## 17. API security / hygiene

`@fastify/helmet` (security headers; CSP disabled here so Phase 3's SPA can set its own),
`@fastify/cors` locked to same-origin + `localhost`/`127.0.0.1` dev origins, `@fastify/rate-limit`
120/min on all routes. Every param is validated (bbox parse + 3°/side cap, radius cap 3 km, q ≤ 64
chars, lat/lon ranges, windowMin cap). Errors are uniform JSON — no stack traces. Static `web/dist`
is served only if it exists (it doesn't yet — Phase 3), with a JSON 404 for `/api/*`. The API binds
`127.0.0.1:8799` by default. `/api/vehicles` sets `isGhost:false` on every vehicle (a present
vehicle cannot be a ghost; the field exists for the map layer's stable contract).

## 18. Ghost confirmation + retraction (post-review hardening)

A ghost is a promise the app makes; a never-reconciled false positive would break that promise, so
ghosts are now both *confirmed* and *retractable* (`poller.ts`):
- **Confirmation:** a due trip must be absent for **≥2 consecutive cycles** (`ghostMissStreak`) before
  a ghost row is written — a single missed poll (or a trip claimed one cycle late) never emits.
- **Retraction:** every ghost this process writes is tracked (`ghostInserted`); if that trip is later
  claimed while still inside the due window, the ghost row is **DELETEd** and the retraction counted
  and logged. Both maps are pruned when a trip leaves the due window, so neither grows unbounded.

## 19. Static context reload on rollover / every 6h (post-review hardening)

`calendar`, `tripStarts`/`staticTripIds`, and the join index were loaded once forever, so a re-seed or
GTFS board swap needed a restart. Now `maybeReloadStatic()` reloads them on **service-day rollover** or
every **6h**, in the background (index rebuild is heavy), one at a time. `loadStaticContext()` builds
fresh structures and swaps them in atomically (`tripStarts` is now a reassignable binding), clears the
active-service cache, and **logs the board coverage** (`min..max` calendar date) each load so a board
change is visible. `/api/health` exposes `boardCoverage`. The ghost scan is additionally skipped while a
reload is in flight (`staticReloading`) so it never runs with a new trip map against the old join index.

**Known limitation (accepted):** the *API read-path* caches (`api.ts` `calendar`/`calendarDates`/
`routeMeta`) are still loaded once at boot, so after a board re-seed `/api/stops/:id/arrivals` can serve
stale schedule/route metadata until the API process restarts. The poller hot-reloads; the read-path does
not yet. Out of this phase's scope (the mandate was the collector's staleness) and low-impact for Tier 0
where a re-seed is operator-driven, but flagged here for a later phase.

## 22. CANCELED trips are excluded from the ghost path (post-review fix)

A trip the feed explicitly CANCELED (and that we identified) is also absent, so without care it would
enter the ghost `confirmed` set; because the ghost insert runs before the cancelled insert and both use
`ON CONFLICT (agency, trip_id, scheduled_start) DO NOTHING`, the ghost row would win and the cancellation
would be dropped (inflating `ghostsThisWeek`, undercounting `cancelledThisWeek`). Fixed: a due trip in
`canceledStatic` is skipped in the confirmation loop and, if a ghost row was already written for it, that
row is retracted so the `kind='cancelled'` insert wins. Dormant on TTC today (0 identifiable CANCELED
entities) but correct for any feed where identification works.

## 20. Mass-ghost breaker is now per-route AND global (post-review hardening)

The global >30%-of-due breaker stays, plus a **per-route** breaker: if a route with **≥4 due trips**
would emit ghosts for >30% of them, that route is suppressed and logged. A board update touching only a
few routes would slip past a global-only breaker; the per-route breaker catches it.

## 21. Small post-review fixes

- **Same-event time+delay** (`poller.ts`): the join reconstruction reads `time` and `delay` from the
  *same* `StopTimeEvent` (departure preferred, else arrival) — never a departure time with an arrival
  delay, which would corrupt the reconstructed schedule second.
- **arrivals `dayList` sized to the window** (`api.ts`): was a fixed 3 days; now spans one day before
  through one day after `[at, at+window]`, so a large `windowMin` (up to the 4320-min cap) never
  silently truncates.
- **`at=` sanity floor** (`api.ts`): timestamps before 2020-01-01 or more than 30 days in the future
  are rejected with a 400.
- **`WINDOW_DAYS` single source** — exported from `aggregate.ts` and imported by `api.ts`, so the
  `windowDays` in every evidence object can never drift from the window aggregates are actually computed
  over.
- **CANCELED identification + 304 behavior** — see BLOCKERS.md (measured: 0 standard-CANCELED entities;
  feed never sends 304).

---

# Phase 4 — the real map (MapLibre voxel-sprite map + marker system)

## 23. Tier 0 map: flat stylized MapLibre, voxel sprites, no 3D

The Phase 3 placeholder map-card is replaced by a real, hand-styled 2D MapLibre map. **No 3D buildings
and no three.js** — that's a deliberately deferred, highest-risk/lowest-function later tier. The
reference's isometric diorama is translated to a flat 2D look: deep violet-charcoal ground, muted
purple-slate quiet streets, minimal labels, and the active route line as the only loud (red) stroke.

- **Package:** `maplibre-gl` (verified `npm view` latest stable = **6.0.0**). **Code-split**: the map
  lives in `web/src/map/MapCard.tsx`, lazy-loaded via `React.lazy` behind `<Suspense>` (fallback = the
  styled placeholder), so maplibre stays out of the initial bundle. Measured after build: **initial JS
  79.6 KB gzip** (Phase 3 was 78 KB), **lazy MapCard chunk 256.6 KB JS + 10.0 KB CSS gzip**.
- **Tiles (zero-key, license-clean):** **OpenFreeMap** vector tiles (OpenMapTiles schema). Verified
  reachable at build time — style `…/styles/liberty` 200, TileJSON `…/planet` 200, fonts
  `…/fonts/Noto Sans Regular|Bold` 200 (Medium 404, so unused). We do **not** ship OpenFreeMap's default
  style; two styles are hand-built in `web/src/map/mapStyle.ts` painting every vector layer to our tokens
  (dark = indigo night; light = Daylight with real navigational contrast — gray ground, lighter road
  ribbons). The MapLibre `AttributionControl` is always enabled, forced expanded, and themed
  ("OpenFreeMap · OpenMapTiles · © OpenStreetMap") — never hidden (license requirement). CARTO
  dark-matter/positron was the documented fallback if OpenFreeMap were unreachable; it was reachable, so
  OpenFreeMap is used. **Runtime tile failure** (map `error` event on the vector source) flips a clean
  "Map tiles unavailable — showing list only" overlay; the card background is the ground color so a slow
  tile never flashes a checkerboard.
- **Palette in JS, not read from CSS vars:** the two style palettes mirror `tokens.css` but are kept as
  literals in `mapStyle.ts` so the style builds instantly (no CSS-var resolution timing) and MapLibre gets
  concrete colors. Theme switch calls `map.setStyle(buildStyle(theme))` and re-installs custom
  sources/layers/images on the next `styledata` — verified instant (data-theme flip → restyled map, no
  reload, ~50 ms).

## 24. Voxel vehicle sprites — one symbol layer, ~1,500 vehicles at 60fps

- Sprites are drawn **procedurally on an offscreen canvas** (`web/src/map/sprites.ts`): a chunky
  isometric-voxel body (route-colored roof + darker extruded side, dark window band, yellow headlight
  pixels, soft contact shadow), bus vs streetcar by `route_type`, pointing north so the symbol layer's
  `icon-rotate = heading` aims the front down the direction of travel. One sprite per **(kind, color)**,
  cached and registered as MapLibre images — the live TTC feed has only **4 distinct colors** (ED1C24
  red, 3C4A5B slate fallback, 00A651 green, E472AC pink), so ≤ 8 images total. Vehicles render as **one
  data-driven symbol layer** (`icon-image`/`icon-rotate` from feature props), never DOM markers.
- **Selection scale is a data-driven feature *property* (`sel`), not feature-state** — feature-state is
  paint-only and silently rejects a symbol `icon-size` layout expression (this cost a debugging cycle; the
  whole vehicles layer failed to add until moved to a property). Opacity fades stay in paint via
  feature-state `op`.
- **Animation:** each poll eases vehicles old→new over ~1.2 s with `requestAnimationFrame` mutating a
  **single reused GeoJSON FeatureCollection** in place (no per-frame allocation) and one `setData`/frame;
  the rAF stops when no animation is active. A jump **> 500 m** snaps to the destination and fades back in
  via feature-state opacity — never a visible slide across the city. Heading from the feed, else bearing
  of movement. `prefers-reduced-motion` → position animations become instant + fade, camera flights become
  cuts.
- **Live polling is self-contained in the map** (Phase 3's `useLive` deliberately had none): every 5 s it
  polls `/api/vehicles?bbox=<current viewport>` (debounced on `moveend`), **paused when `document.hidden`**
  and on unmount. Proven: over 11 s hidden, **0** vehicle fetches (+ log lines), **1** fetch on resume.

## 25. Marker system + the active route line (new server endpoint)

- **You beacon / boarding pin / selected-vehicle badge are DOM `maplibregl.Marker`s** (few, need rich
  styling + pulse); the walk path, route line, and route stop dots are GL layers.
- **Label discipline (max 3 on mobile):** You pill, boarding stop card, selected-vehicle badge. A simple
  rect-overlap collision hides the lower-priority label on overlap, and also hides any label that would sit
  under the map controls (app chrome). The **walk time lives on the You pill** ("You · X min walk", exactly
  as the reference) rather than as a separate inline chip, to stay within the 3-label budget.
- **Walk path is a straight-line beaded (dotted) path** from You to the boarding stop, accent-purple — Tier
  0 has no routing engine, so it is an honest as-the-crow-flies indicator, not a real walking route.
- **Active route line (the only loud stroke):** when a vehicle is selected (or, absent a selection, the top
  departure at the boarding stop is focused) the route's **real** shape is drawn in red following the
  streets, with real intermediate **stop dots** at desktop zoom. This required a new server endpoint
  **`GET /api/routes/:routeId/shape?dir=`** (`server/src/api.ts`, typed `RouteShapeResponse` in
  `shared/types.ts`): it picks the most representative shape (the `shape_id` used by the most trips for that
  route/direction), returns it Douglas–Peucker-simplified (~1.7 m tolerance) as `[lon,lat]` GeoJSON
  coordinates plus the ordered real stops of a representative trip on that shape. Parameterized SQL; `dir`
  validated to `0|1`. Note: `applyRoute`/`applyWalk` call only `source.setData` and are **not** gated on
  `isStyleLoaded()` (which flips false transiently while tiles reload — that gate had swallowed the route
  line until removed).

## 26. Vite dev fix required by maplibre (config touch)

Adding maplibre-gl surfaced a Vite dev-server incompatibility: its web worker (`maplibre-gl-worker.mjs`)
404s under the dep optimizer, so tiles never load in `npm run dev:web`. Fix (in `vite.config.ts`):
`optimizeDeps: { exclude: ['maplibre-gl'] }` — the documented remedy; production build is unaffected. This
is the only change to a Phase-3 config file, and it is a direct consequence of this phase's dependency.

**Pre-existing issue flagged (not fixed — out of scope):** `vite.config.ts` builds to `ghostbus/dist`
while `server/src/api.ts` serves `ghostbus/web/dist`, so the Fastify "one deployable service" can't serve
the built SPA today (root `/` 404s in production). This mismatch predates Phase 4; left for a follow-up so
this phase stays isolated to the map.

## 27. PWA layer: installability, and a service worker that refuses to cache the truth

Tier 0 required an installable app; `web/public/` had a favicon and nothing else. Added
`manifest.webmanifest`, an icon set, `web/public/sw.js`, and `web/src/pwa.ts`, plus the manifest/meta
links in `web/index.html`. No new dependency, no `vite.config.ts` change, no build step.

**Icons are generated, not hand-drawn.** The mark is a voxel ghost — a 13x14 cell grid, four purple
shading bands lit from the top (`#c07ce6` down to `#6f358d`) on `#0B0E1A`, with a 9% gap between cells so
it reads as blocks rather than a silhouette. Committed at `web/public/icons/icon.svg` (glyph = 70% of the
canvas) and `icon-maskable.svg` (54%); the PNGs were rasterised from those SVGs by the Playwright Chromium
already present in the global npx cache, so nothing was added to `package.json`. Regenerating is just
"render these two SVGs at size N". Verified by measurement, not assumption: each PNG decoded in-browser and
its intrinsic size read back (192x192, 512x512, 180x180), and for the maskable variant every glyph pixel
was scanned — the furthest sits 200.3px from centre against a 204.8px safe-zone radius, so nothing clips
when Android crops to a circle.

**Precache strategy: derived at install time, not hardcoded, not code-generated.** Vite content-hashes
everything into `/assets/`, so a hardcoded list would 404 and break installation, and a build-time
generator would need a `package.json` script that could silently stop running. Instead the worker fetches
`index.html` during `install` and parses its `/assets/*` references — the precache always matches the build
actually being served. Lazily-imported chunks (the map) never appear in `index.html`, so those are cached
on first fetch at runtime; hashed names are immutable, which makes cache-first safe with nothing to
revalidate. Because `sw.js` is byte-identical across builds its `activate` does not re-run on deploy, so
the asset cache is keyed to a **build id** (FNV-1a over the sorted asset URL set). A new build changes the
id and drops the previous build's assets wholesale, dynamic chunks included — bounded growth without
pruning by "is it referenced right now?", which would have deleted the map chunk on every single load.

**`/api/*` is network-only. This is a product decision, not a performance one.** No cache read, no cache
write, no stale fallback. A cached arrival time replayed from disk looks exactly like a live one — same UI,
same countdown — while being a lie, which is the precise failure this app exists to prevent. Offline, API
requests fail and the UI says "Offline". Cross-origin tile requests pass through untouched; the browser's
HTTP cache already honours the tile server's freshness headers, and a second, dumber cache is how you end
up accidentally caching live data later.

**Dev safety.** Registration is guarded on `import.meta.env.PROD`, so the worker never runs under
`vite dev` — a dev-time worker would serve stale assets to everyone in this repo and quietly invalidate
screenshot/QA runs. The `!PROD` branch actively unregisters any worker it finds, so an origin polluted by a
local `vite preview` heals itself. Navigations are network-first (cached shell only as the offline
fallback) and the worker `skipWaiting()`s and claims clients, so a stale shell cannot pin anyone to an old
build.

**Guard against the SPA fallback.** `server/src/api.ts` answers any non-`/api/` 404 with `index.html` at
HTTP **200 text/html**. Without a check, a request for a missing hashed asset would return "successfully"
and the worker would cache HTML under a `.js` URL — permanently, since hashed URLs are never revalidated.
Any non-shell response with an HTML content-type is therefore refused.

**§26 correction — the maplibre worker 404 is NOT dev-only.** §26 states the production build is
unaffected by the `maplibre-gl-worker.mjs` problem. Measured: it is not. `dist/assets/MapCard-*.js`
requests `/assets/maplibre-gl-worker.mjs`, Vite emits no such file, and in production the SPA fallback
answers it with `index.html` at HTTP 200 — so maplibre receives HTML where it expects a module worker.
This is pre-existing and outside the PWA layer's ownership, but it is real and should be picked up by
whoever owns the map/build config. The service worker's HTML guard is what surfaced it, and is also what
stops it from becoming permanent.

**What this does NOT give you.** Shell survival only. The app's data-offline story — a cached schedule
slice so a cold offline start can show *something* honest about when buses are meant to run — is a
separate, unbuilt tier. Nothing in this layer may be read as offline live data.

## 28. The map was dead in every production build (worker emit, SPA fallback, error storm)

**Measured, not inferred.** A real `npx vite build` + `npm start` + Chromium load showed: canvas and WebGL
context present, no basemap, no vehicles, the "Map tiles unavailable — showing list only" fallback, and
**528 identical console errors** on a cold load (`The source 'vehicles' does not exist in the map's style.`
from `setFeatureState`). Every screenshot in this repo was taken against `vite dev`, where the bug does
not exist, so the failure shipped invisibly through several phases. §27 already flagged the worker 404 as
a §26 correction; this section is the root cause and the fix.

**Root cause.** maplibre-gl v6 does not let a bundler see its worker. It resolves the URL at *runtime*:

```js
let e = import.meta.url;
let t = e.endsWith('-dev.mjs') ? 'maplibre-gl-worker-dev.mjs' : 'maplibre-gl-worker.mjs';
return new URL(`./${t}`, e).href;
```

A bare `new URL(..., import.meta.url)` that is never passed to `new Worker()` at the same site is invisible
to Rollup, so `vite build` emitted no worker at all. In the built bundle `import.meta.url` is
`/assets/MapCard-<hash>.js`, so maplibre asked the server for `/assets/maplibre-gl-worker.mjs` — which does
not exist. The SPA fallback answered it `200 text/html`, the module worker refused the MIME type, tile
processing never started, `map.on('load')` never fired, and the app's tile-failure fallback misreported
the cause. Dev worked because Vite serves maplibre from `node_modules` right next to its real worker file.

**`optimizeDeps.exclude` was NOT implicated.** It was the leading suspect (added in §26 for a dev-only
worker 404) but `optimizeDeps` is a dev-server dep-optimizer setting; it has no effect on the production
emit. Verified against the built output and left untouched — removing it would have re-broken dev without
fixing prod.

**Fix 1 — emit the worker and tell maplibre where it is.** `MapCard.tsx` imports the worker through
`?worker&url`, which makes Rollup bundle it (inlining `maplibre-gl-shared.mjs`, which the worker imports —
this is why simply copying the 19 KB worker file would not have worked) into a real hashed chunk, and hands
that URL to the supported `maplibregl.setWorkerUrl()`. `vite.config.ts` sets `worker.format: 'es'` because
maplibre constructs the worker with `{ type: 'module' }` and the Vite default of `iife` would not survive
that. Chosen over vendoring maplibre's dist files into `public/` because the worker then tracks the
installed version automatically instead of silently going stale on the next upgrade. No new dependency.

**Fix 2 — the SPA fallback must stop lying.** `server/src/api.ts` answered *every* non-`/api/` miss with
`index.html` at 200. Paths under `/assets/` or carrying a known asset extension now return a real 404;
the shell is served only for genuine GET/HEAD navigations (no file extension, or `Accept: text/html`).
Asset-ness is tested *before* `Accept` so a browser navigating straight to a dead bundle URL still gets the
404 rather than a reassuring page. This matters beyond the map: per §27 the service worker would otherwise
have cached an HTML document under an immutable hashed `.js` URL permanently. `wildcard: true` is
untouched — the §26 regression (stale startup enumeration) does not come back, and real assets still serve
with correct content types.

Review also caught that the guard was `req.url.startsWith('/api/')`, so a bare `GET /api` — no trailing
slash, no extension — read as a navigation and answered an API client with the SPA shell at 200. Fixed.
Four regression tests now cover the whole handler in `server/src/api.test.ts` (missing asset 404s, the 404
survives `Accept: text/html`, bare `/api` stays JSON, a client-side route still gets the shell). This bug
class is invisible to every existing test and to a casual curl, which is exactly why it needs assertions.

**Fix 3 — the error storm was a real race, not just fallout.** It survived Fix 1. The 5s poll and the first
geo recenter (`easeTo` → `moveend` → `scheduleFetch`) both reach `ingest()` well before `load` installs the
`vehicles` source, and a theme swap drops that source mid-animation. Because the rAF loop writes
feature-state *per vehicle per frame*, one early poll became hundreds of errors. All vehicle writes now go
through one `vehSource()` guard: `ingest()` drops the tick silently (the next poll rebuilds the fleet) and
the rAF loop re-checks every frame and stops instead of erroring.

**Fix 3b — say what actually failed.** The fallback blamed the tile server for a failure it had never
observed, and that misdirection is exactly what hid the worker bug. The component now tracks whether the
style ever loaded and distinguishes `'tiles'` (style up, vector source never usable) from `'engine'` (the
map never loaded at all). The tile server was independently cleared: `fetch('https://tiles.openfreemap.org/
styles/liberty')` and `/planet` both returned 200 from the failing page.

**Outstanding — one string, owned by the i18n team.** `'engine'` currently borrows `map.loading`, the only
existing key that makes no false claim about cause. It needs `map.engineUnavailable` in all three locales
(Dict parity is compiler-enforced, so en cannot be edited alone). Proposed EN: *"Map can't load right
now — the list below is still live."* There is a TODO at the fallback render site in `MapCard.tsx`.

**Proof.** Production build served by `npm start`: `/` 200 html; `/api/health` 200 json; hashed `.js` 200
`application/javascript`; hashed `.css` 200 `text/css`; `/assets/nonexistent-abc123.js` **404**;
`/assets/maplibre-gl-worker.mjs` (the old guess) **404**; the emitted worker 200 `application/javascript`.
Chromium against that build: basemap renders, attribution present, 16 tile requests / 0 failures, worker
loaded from `/assets/maplibre-gl-worker-<hash>.js`, 68 vehicles in view of 1,352 fleet-wide, and
**0 console errors** (from 528). Same probe against `vite dev`: also 0 errors — the guard fixed the race in
dev too. Screenshot: `screenshots/prod/map-production-build.png`. Initial-load gzip is unchanged by this
work (97.9 KB against a 550 KB budget): the worker is a lazy sibling of the already-lazy MapCard chunk, and
`maplibre` appears zero times in the initial chunk.

## §29 — The delay engine: measuring lateness against our own schedule

**The defect.** Every delay observation this project had accumulated was zero, and the identity join
that produced them had a measured match rate of 0%. Both had one cause: the TTC feed publishes no
`delay` field, protobuf.js's proto2 defaults made an absent field read as `0`, and the join
reconstructed `scheduled = predicted − delay`, which with `delay = 0` is `scheduled = predicted`. The
join was comparing predictions against predictions. See BLOCKERS.md for the census and the wire-level
proof.

**The replacement.** `delay_s = event_epoch_s − sched_epoch_s`, where the scheduled time comes only
from our own seeded `stop_times`. That requires knowing which static trip a realtime trip is running,
without a usable `trip_id` and without a shared stop-id namespace. Five new modules do it:
`pb.ts` (presence-aware protobuf reads), `patterns.ts` (static pattern index), `xwalk.ts` (learned
stop crosswalk), `bind.ts` (origin lock), `delay.ts` (settle and emit), plus `gates.ts` and the
DB-facing `engine.ts`.

### Why the legacy rows are marked, not deleted

`trip_delay_obs` was already empty when this work began (a prior step had truncated it), so
migration 004's `UPDATE ... SET method='legacy_feed_delay_zero' WHERE method IS NULL` affected **0
rows** — but the statement stays, because it is what makes `method IS NULL` impossible for any row
that predates the engine, on any database this migration is applied to.

Had the rows still been present, the decision would have been the same: **mark and filter, never
delete.** They are the forensic record that the feed publishes no delay; `aggregate.ts` excludes them
so they can never enter a percentile; and the existing 14-day retention prune ages them out without a
destructive statement on a shared production database. A table that mysteriously emptied teaches a
future reader nothing.

### What is deliberately NOT done, and why

**No day-long FIFO slot chaining.** It is the tempting design and it is a trap: one missed collector
cycle phase-slips an entire (route, pattern) for the rest of the service day, producing delays wrong
by exactly one headway that are perfectly self-consistent and invisible to every internal check.
Slot claiming is kept only as a uniqueness constraint and a ghost signal. The accept rule is instead
a per-trip, memoryless margin test with no cross-trip state to corrupt.

**No order-preserving assignment.** TTC bunching means a late bus gets overtaken, so observed order
does not preserve scheduled order. Order preservation was measured strictly worse than independent
selection (64.7% against 77.0%).

**No re-solving a binding, and no band after the lock.** A binding is written once and never
revisited. Re-solving under a "plausible delay" window would truncate the delay distribution and bias
the published p75 low — the app would systematically under-report exactly the lateness it exists to
expose. Post-lock, values beyond ±5400 s are dropped and counted, never clamped.

### One deviation from the specified design, forced by measurement

The design calls for binding a trip in the cycle it is born. That is not achievable: a newborn
publishes a **median of one stop**, which can never clear the three-shared-sequence floor that stops
the pattern merge from fusing distinct branches. So a birth is **captured** immediately — including
its first predicted departure — and **bound** in a later cycle, once its RT pattern has become
resolvable. Crucially the binding still uses the **anchors captured at birth**, which are never
refreshed. The property the whole design rests on (the origin measurement is taken before any live
drift accumulates) is preserved; only the moment of the database write moves.

### The bias, stated plainly rather than buried in a constant

The origin band is asymmetric, `[−180, +420]` s: a trip published ~29 minutes before it departs
cannot be meaningfully early, so the early edge only covers clock and rounding slop while the late
edge covers a genuinely late block handoff.

That asymmetry, **together with headway aliasing** — a bus more than half a headway late is
shape-identical to the next bus departing on time — means our *errors* skew toward matching a late
bus to a later slot, which reads as **less** lateness than reality. **Our errors flatter the TTC.**
That is the wrong direction for an accountability product, and it cannot be engineered away; it can
only be bounded and disclosed. It is bounded by refusing the sub-300 s headway band outright (~4.9%
of trips, measured, and the regime where aliasing is worst) and by the 120 s runner-up margin test.
It is disclosed here and in every row, which carries `method`, `confidence`, `xwalk_conf`,
`match_margin_s` and `headway_s`.

### Every delay passes through an inferred stop crosswalk

Because the two stop-id namespaces are disjoint (BLOCKERS.md), stop identity is learned from
geometry and propagated transitively. **The UI must be able to say so.** Each observation carries
`xwalk_conf`, and `getJoinStats().delayEngine.xwalk.crossRouteAgreement` is the crosswalk's honest,
falsifiable accuracy estimate — an rt stop seen from two or more routes must resolve identically from
each, and it can fail.

### Measured behaviour, 2026-07-24 (crosswalk warming, board inactive)

Live cycles from an empty crosswalk, real TTC feed, real Neon:

- Static pattern index: **1,252 distinct patterns** from 68,401 trips (p50 4 patterns/route, max 31;
  p50 16 trips/pattern, max 586). Keyset-paged build: **109–183 s, 71 MB heap delta** — slower than
  an unpaged read but a third of the memory, and it runs in the background, never on a request path.
- Median scheduled headway p10 540 s / p50 1,140 s / p90 1,800 s. Trip-weighted band shares on
  service 1: **<300 s 4.9%**, 300–600 s 20.7%, 600–1200 s 46.4%, ≥1200 s 28.0%.
- Geometry: a STOPPED_AT vehicle sits a median **17.9 m** from the correct static stop on its route
  (p90 44 m, 90 of 93 within 50 m). Only ~100 of ~1,400 vehicles per cycle are usable anchors.
- **Transitive propagation is the multiplier**, and `rt_pattern.resolve_iter` proves it: on an
  eight-cycle run, 569 of 1,106 RT patterns resolved, at iterations 0 through 7 — 503 at iteration 0
  and 66 reachable only by iterating to a fixpoint.

### Honest state today

The loaded board covers **20260726..20260905** and the machine date is 2026-07-24, so **no static
service is calendar-active**. The `boardActive` gate fires, the engine emits **zero** delay rows, and
`getJoinStats().delayEngine.suppressionReason` reads *"no calendar-active schedule for 20260724; the
loaded board covers 20260726..20260905"* — a string deliberately distinct from both "no data yet" and
"0 min delay". No trust grade, percentile or ETA adjustment is produced from zero observations. On
2026-07-26 the existing service-day reload flips the gate and the engine self-enables.

### Three bugs found by running it against the live feed, not by reading it

1. **Votes could never accumulate.** `resolvePatterns` reported only *newly* learned stops, but a
   stop discovered on cycle 1 is in the seed on every later cycle — so its vote count froze at one,
   permanently below the 0.60 confidence floor. The crosswalk could never have backed a single delay
   row. Fixed by also reporting re-derivations (`implied`), which is what corroboration actually is.
2. **Propagated entries were penalised twice** — once by the 0.85 source discount and again by a
   missing-residual factor — capping them at 0.595, just under the same floor. The residual factor
   for an unknown residual is now 1; the source discount alone encodes "derived, not measured".
3. **A duplicated conflict key aborted the whole batch.** Postgres rejects an
   `INSERT ... ON CONFLICT DO UPDATE` whose own `VALUES` list names a key twice, and it rejects the
   entire statement — the crosswalk persist failed on three of eight cycles. RT patterns are keyed by
   a content hash, so two objects can legitimately carry one identity; writes now collapse on the
   conflict key and clustering collapses converged patterns in memory.

### Where the inherited design was wrong when it met reality

- The design asserted the RT `(route, stopSequence) → stopId` map is "perfectly self-consistent
  (10,838 agreements, 0 conflicts)". Re-measured at route level it is **not**: 6,340 agreements
  against **11,728 conflicts**, because opposite directions and branches put different stops at the
  same sequence number. This does not invalidate the merge rule — it is precisely why pattern
  clustering must split those apart rather than trust a route-wide sequence map. The supporting
  statistic was wrong; the rule it was cited for is right, and is doing real work.
- The design's route-52 example claims that route's longest static pattern is 73 stops. Measured
  against this board it is **80**. The length cap is still correct as a rule; the specific numbers in
  that anecdote do not hold, so the regression test states the mechanism explicitly instead of
  relying on them.
- The design describes the pre-existing `trip_delay_obs` as holding 308,586 rows to be marked. The
  table was **already empty** when this work began.

### Notes for other owners

- **`api.ts`**: `getJoinStats()` now returns a `delayEngine` field (`DelayEngineStats`, exported from
  `poller.ts`). `/api/health` currently reads only `boardCoverage` off that object. The new stats —
  especially `suppressionReason`, `xwalk.occurrenceCoverage` and `xwalk.crossRouteAgreement` — should
  be surfaced. No change to `api.ts` was made by this workstream.
- **`tsconfig.json`**: `npm run typecheck` includes only `web/src` and `shared`, so it does **not**
  typecheck the server. Server types were verified separately with `tsc -p tsconfig.node.json`, which
  is clean. Whoever owns the build config should consider making `typecheck` cover both.
- **`seed_toronto.ts`**: `trips.txt` carries a `block_id` that the seeder drops. Persisting it would
  give a free, independent confirmation of every trip binding — two trips in the same block cannot
  both be running — and would materially strengthen the weakest part of this design. Filed, not done.
- **`METHODS.md` / `ARCHITECTURE.md`** describe the old reconstruct-from-delay algorithm and are now
  wrong. They are not owned by this workstream; they need updating to match this section.

---

## §30 — Rebuilding the shell to the reference mockup, and reading a headsign like a rider

The user supplied a full reference mockup (desktop + mobile light + mobile dark) with two
instructions: *"there's a lot of overlapping stuff fix it there should be absolutely nothing
overlapping"* and *"do not stop until you can exactly replicate those pictures with everything."*
`DESIGN-TARGET.md` is the transcription; `ghostbus-design-reference.png` is the image itself and
wins wherever the two differ.

### One DOM, two shapes

The shell is now `topbar / app-body(pane-map + pane-side) / tabbar`, and CSS — not JavaScript —
reflows it at a single 880px breakpoint:

- **Phone** — one scrolling column: header, search + filter row, a full-bleed map card, the stop
  header, compact three-column departure rows, the alert card, saved places. `.app-body` is the
  scroll container; `.tabbar` is an opaque flex sibling *outside* it.
- **Desktop** — a fixed 320px sidebar with the tab bar absolutely placed at **its** foot, and the
  map full-bleed to the window's right and bottom edges, no gap and no rounded card.
  `.pane-side` reserves exactly `--tab-clear`, so `.side-scroll` ends where the tab bar begins.

The breakpoint utilities (`.only-desktop` / `.only-mobile`) are declared **only inside the two
media queries**, as exact complements (`not all and (min-width: 880px)` / `min-width: 880px`), so
there is no width at which both variants of a control render — and the save control is one button
with two glyphs rather than two buttons.

### The overlap complaint was real; the mechanism was not DOM overlap

The first shared probe compared `getBoundingClientRect()` directly. An element scrolled past a
scroll container's edge still reports a position down there, so every row below the fold read as
"overlapping" the tab bar beneath it. Three separate measurements settled it:

- geometry: `.app-body` is `[124, 784]` with `scrollTop 0`, `scrollHeight 935`; `.tabbar` is
  static at `[784, 844]`. They never intersect. The "overlaps" were all one card straddling the
  clip boundary.
- a control experiment (`overflow:auto` / `overflow:clip` / `contain:paint` /
  `content-visibility:auto`): **no** CSS clipping mechanism alters a descendant's layout rect, so
  no implementation could have driven that probe to zero. It penalised any scrolling list next to
  a bar and rewarded short content.
- the corrected probe (rects intersected with every clipping ancestor) returns `trueOverlaps: 0`.

What the user actually saw was **a scroll edge with no affordance**: a card guillotined at the bar
reads as sliding underneath it. Fixed with a decorative `.app::after` fade over the scroll
container's bottom edge — window-wide on the phone, sidebar-width on desktop. A pseudo-element, so
it adds nothing to the DOM and nothing to the a11y tree.

Two genuine overlaps *were* found and fixed along the way:

- `.topbar-right` was `flex: 1 1 auto` **and** width-capped, which parks a grow item beside its
  sibling with dead space to its right: at 1280px the Live pill and avatar sat at `x=184..614`,
  directly under the centred search pill. `margin-left: auto` eats the slack instead.
- `.sr-only` briefly dropped `overflow:hidden` for `clip-path`. The nowrap text then contributed
  its full width to the document's scroll area — 911px of `scrollWidth` in a 390px viewport, mostly
  from the map's own sr-only description. It keeps `overflow:hidden`, and takes `height:auto` so a
  deliberately-unpainted box is not also a box whose content is cut off.

### Reading the headsign (`web/src/lib/headsign.ts`)

The TTC publishes one string that packs three facts: `"South - 310 Spadina towards Union Station"`.
Rendered whole, the only part a rider is reading for — the destination — got whatever width was
left after the part that repeats the badge, and was measured cut mid-word at `South - 310 Spa…` in
96px. So the string is split at the agency's own separators:

- `direction` — the leading cardinal, **only** when followed by a real separator, so a destination
  that merely starts with a compass word ("West Mall") is not mistaken for one.
- `destination` — what follows `towards`/`toward`. Deliberately not a bare `to`, which occurs
  inside real place names.
- anything that does not match is returned **verbatim**. This never guesses and never drops a fact
  it cannot account for.

`stopDirection()` prints a direction on a *stop* only when every departure on that board agrees on
one cardinal. A stop serving both directions has no single direction, and printing one of them
sends a rider to the wrong side of King St. The four cardinals are translated (`direction.*` in all
three locales) because translating the agency's compass word is not inventing a fact.

### No ellipsis on any line that carries a fact

Reserved column widths already make collision impossible, so the text simply wraps at word
boundaries. `overflow-wrap: break-word` only ever splits a word wider than its whole column.
Each fact in the stop's sub-line is an atomic `.stop-fact` (`white-space: nowrap`), so the line
breaks *between* facts and "1 min walk" can never wrap as "1 min" / "walk".

### Where the reference is not followed, and why

- **`Track` on scheduled rows.** The mockup labels every row action `Track`. On a live row the
  vehicle is genuinely in the feed and `Track` is a promise the data keeps, so live rows use it.
  Schedule-only rows keep `View route`: offering to track a vehicle no feed can see is the one
  thing this app refuses to do. The colour carries the same claim — solid brand when live, quiet
  when not.
- **The evidence row stays.** The mockup's illustrative rows have no evidence layer. Deleting ours
  to match the picture would delete the thing GhostBus exists to do, so it stays, quiet, on its own
  full-width line.
- **Saved Places is not seeded.** `savedStops` defaulted to `['union']`, which made the section look
  populated on a device that had saved nothing. It now defaults to `[]` (and is sanitised on read,
  for the same reason `pace` is), so an empty list ships the honest empty state.
- **The stop's sub-line is not the mockup's.** It leads with the direction in the accent colour as
  the reference does, but the remaining facts are the real ones for the real stop.
- **The traffic lights are decoration.** No button element, no handler, `aria-hidden` — nothing
  there can be mistaken for a window control that does not exist.
- **`--accent`.** `--brand` (`#8944ab`) is a fill colour; as 12–13px text on the near-black
  background it only reaches ~4:1, and the reference's accent reads visibly brighter than the
  wordmark fill. `--accent` (`#b168e0` dark / `#7b2f9e` light) is the one used for words.

## §31 — The voxel map, rebuilt against the reference image (and what still differs)

The reference mockup existed only as prose (`DESIGN-TARGET.md`) for the first half of this
work; then the image itself landed on disk. Everything below is measured off the image.
Where the prose and the image disagreed, the image won — twice materially. (Example: §A4 says
"a SEPARATE locate button, then a SEPARATE layers button"; the image plainly groups them into
a second pill with a hairline between, exactly like the `+`/`−` pair. The image is what shipped.)

### The finding that mattered most
`voxelCity.ts` was complete, tested and **imported by nothing except the dev lab**. Production
shipped the flat 2D map. Every "voxel map" screenshot in the repo came from `web/voxel-lab.html`.
Wiring it into `MapCard.tsx` is the single biggest change here.

Alongside it, `MapCard` stopped carrying its own copy of `maplibregl.setWorkerUrl()` and now
imports `./mapWorker`. Two copies of the §28 fix would drift, and drift there means a blank grey
box in production and a perfect map in dev — the worst possible failure shape.

### Colour: the light source was eating the palette
MapLibre's fill-extrusion fragment shader ends with
`v_color.rgb += clamp(color.rgb * directional * u_lightcolor, …)` — the style's light colour
**multiplies** every authored channel. The old light was `#cdc6ff`, i.e. `(0.80, 0.78, 1.00)`,
so every block rendered with red and green scaled down ~20% and blue untouched. That is the
entire explanation for "too light and too blue": the palette was never the problem, the lamp
was. The light is now white and the authored values are the measured ones.

Measured from the reference (hue x value histogram of the map region, both themes agreeing):

- dark: wall `#1b203f` (28% of all pixels), roof `#454670`, blue-slate `#14213c` / `#384d6f`,
  violet accent `#382e56` / `#574687`, teal accent `#23383d`, ground `#0e142b`
- light: `#f3f0ea` (30%), walls `#d7d3cd` / `#c4c0bb`, and the trees carrying nearly all the chroma
- trees: dark `#363f34` sides / `#555a42` tops; light `#8da48a` / `#b2c69d` — olive-sage in both,
  which is what "muted, never saturated" means in practice

The streets went the other way and needed reverting mid-pass. §C's "streets one step lighter
than the ground" was read literally, the roads were dropped to `#1A2340` on a `#0C1229` ground,
and the grid vanished — the render came back as one continuous mass of rooftops. In the image
the ground is the *darkest* surface in the frame and the streets are a clearly readable lattice
several steps above it. "One step lighter" is about hue family, not contrast.

### Camera: a fixed zoom is the wrong shape of answer
Two fixed zooms failed review in a row — 17.0 read as "a canyon of towers", 16.6 still cropped
the stop card off a 390px card. No constant can be right, because the correct framing depends
on the walk distance (a 2-minute walk and a 12-minute walk are different pictures) and on the
card size (a full-bleed desktop pane vs a 4:3 phone card). `frameCamera` now centres on the
walk and **measures**: it steps the zoom out until every marker's real DOM box is inside the
card and clear of the control stack and the attribution. The loop uses `jumpTo`, which moves
markers synchronously but defers rendering, so the intermediate steps never paint.

Consequence: the zoom is an output, not an input (~15.4 on a phone, ~16.1 on desktop). That is
why `ZOOM_HEIGHT_GAIN` and the screen-space tree sizing exist — both hold apparent proportions
constant as the framing moves, which is what a diorama does when you step back from it.

### Trees are extrusions, and that is not an implementation detail
A symbol or circle layer would have been one line, but symbols do not depth-test against
`fill-extrusion`: every tree behind a tower would draw through it. Real boxes share the depth
buffer. They are **decorative set dressing** — OpenMapTiles carries no `natural=tree` — placed
deterministically (hashed on the quantised coordinate, so they never crawl between tiles) on the
verge of real road geometry, and documented as such in the module header. Nothing in GhostBus
derives a datum from them.

### Two production-only bugs, both invisible in dev
1. **The You beacon was hidden by its own stylesheet.** MapLibre positions a marker root with
   `.maplibregl-marker { position: absolute }` (one class). `app.css`'s `.you-beacon` also
   declared `position: relative` and lost the tie only because maplibre-gl.css is imported
   later. The new `map.css` is later *and* two-class, so it won — the marker became a static
   block stretching the full card width, and the collision pass correctly hid a 960px-wide
   "marker". Fixed by not declaring `position` at all.
2. **The beaded walk path was written empty and never rewritten.** `applyWalk` closed over
   `geo`. Its effect fires before `map.on('load')`, finds no source and returns; then
   `installLayers` calls it from the load handler holding the *first* render's closure, where
   `geo` was null, and writes an empty FeatureCollection. The deps never change again, so the
   beads were absent forever. Both callers now read refs.

### Zero-overlap, where it actually had to be earned
The §F DOM probe excludes everything inside `.map-card`, so the map's own overlaps are invisible
to it. Implemented there instead:

- Priority chain You > stop > badge > walker node, with **degrade-before-hide**: the stop marker
  gives up its text bubble and keeps its pin before it disappears entirely.
- The You card flips to the other side of its disc before anything is hidden.
- At phone width, at most three floating labels at once (§D).
- **`marker-blockers`**: an invisible symbol layer publishing one transparent icon per visible
  marker, sized to that marker's measured box and anchored at the ground point under its centre.
  The DOM cannot join MapLibre's collision index, so this is the only way street names can be
  kept off the cards. It must be the last symbol layer — `PauseablePlacement.continuePlacement`
  walks the style order from the end downward, so the last layer is placed first and wins every
  collision. An early `liftBasemapLabels` used a name blocklist and silently relocated it; it now
  selects basemap layers by their source instead.
- `label-place` is capped at z14.5. "Fashion District" and "Queen West" were landing on the stop
  pin, and the reference's map carries no place labels at all — only street names.
- The attribution is `compact: false` (the compact control renders a 29px info button beside the
  text; the pair wrapped to three lines and covered a corner of the city) and is allowed to wrap
  rather than `nowrap`. `nowrap` stopped the wrapping but then ran off the right edge, where the
  card's `overflow: clip` ate "…OpenStreetMa" — text that wraps is readable, text that is clipped
  is a licence breach.

### MapLibre constraint worth writing down
A `['zoom']` expression may only be the **outermost** function of a property value. Multiplying
a stepped height by a nested `['interpolate', …, ['zoom'], …]` is rejected, `addLayer` throws,
and the entire city vanishes silently — `queryRenderedFeatures({layers:['voxel-body']})` returns
0 while every other layer keeps rendering perfectly. `withZoomGain` keeps the interpolation
outermost and puts the data-driven expression in each stop output, which is the legal
"zoom-and-property function" form.

### Verified against a production build, never dev
`npx vite build` + `npm start`, real Chrome driven by Playwright. Frame timings at the final
camera (pitch 58, `map.triggerRepaint()` every frame for 4s):

- desktop 1280x800, 177 blocks + 215 trees in frame: **p50 4.2 ms, p95 6.5 ms, worst 15.4 ms**
- phone 390x844, 83 blocks + 103 trees: **p50 4.2 ms, p95 5.0 ms, worst 12.1 ms**

Extrusions confirmed absent at Reduced and Lite (`voxel-body`, `voxel-cap`, `voxel-tree-body`
all missing, pitch and bearing 0, layers button `disabled`). `trueOverlaps: 0`, zero
map-internal collisions and zero marker spill at both viewports, both themes, `en` and `fr-CA`.
No console or page errors. Map chunk 985.9 kB / **262.1 kB gzipped** (was ~256 kB).

### What still differs from the reference — honestly
1. **The route does not turn.** `/api/routes/:id/shape` returns 36 points over 9.6 km for 504
   King: p90 segment length 994 m, max 1437 m. At the diorama zoom that is a straight slash that
   cuts corners rather than a line following the street. The endpoint's own `simplify` runs at
   ~1.7 m, so the coarseness is upstream of it, in the seeded `shapes` rows. Server-owned; not
   touched here. Until it is fixed, §C's "follows the streets with real turns" cannot be met —
   the King St W stretch in frame happens to be genuinely straight, which hides it.
2. **Blocks cannot have true dark gaps between them.** `fill-extrusion` has no inset or
   footprint-shrink property — the entire paint spec is opacity, color, translate, pattern,
   height, base, vertical-gradient. Two abutting OSM footprints at the same tier cannot be
   pulled apart. The substitute is `SEPARATION_M`: five sub-tiers inside each 22 m step, so
   neighbours land on different roof heights and their lit cap bands step against each other.
3. **The camera is not north-up.** `VOXEL_BEARING = -18` reproduces the reference's diagonal
   grid and gives every block a second visible wall. There is no compass rose on the map.
4. **The map's expand/fullscreen button is gone.** The reference's third control slot is the
   layers button, and it groups locate+layers into one pill. `mapExpanded` still works if
   anything sets it (the Escape handler and the resize effect are untouched), but nothing in the
   map sets it now, so `map.expand` / `map.collapse` are unused strings and `.map-expanded` is
   unused CSS. The layers button toggles the 3D city instead.
5. **The stop bubble's small blue accessibility chip is omitted.** The reference shows one; we
   have no data behind it, so drawing it would be decoration pretending to be information.
6. **Trees have no trunk.** A trunk is sub-pixel at every framing the app uses.
7. **Street-name density is close but not equal.** The reference shows two names in a 715px
   frame; we show four to six, thinned with `symbol-spacing: 900` and `text-padding: 34`.
   Pushing further starts dropping the name of the street the rider is actually standing on.
