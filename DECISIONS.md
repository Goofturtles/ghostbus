# DECISIONS.md

Honest record of every non-obvious choice and every deviation from the brief.
Milestone 0 decisions are in §1–§9; Phase 2 (API + honest ETAs + ghost identity join — the join
is since deleted; see §29 and §33)
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

> **SUPERSEDED (2026-07-25) — see §29 and METHODS.md §3.5.** The *instinct* below was right and
> is worth preserving: "we do not synthesize a delay from predicted-time-minus-static when only
> a time is present — that would be an assumption dressed up as a measurement." That rule is now
> **exactly inverted**, and the inversion is the whole finding. Requiring an "explicit `delay`"
> was not a safeguard, because protobuf.js answers `0` for a field the feed never sent, so the
> requirement passed on 100% of events and recorded a fabrication. Meanwhile
> predicted-minus-our-own-scheduled is not an assumption at all: both sides are published data.
> The honest rule is now `delay_s = event_epoch_s − sched_epoch_s`, with `sched_epoch_s` from
> our own seeded `stop_times` and nothing reconstructed from the feed.

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
in §12 and a mass-ghost breaker. *(That replacement was itself replaced: the §12 join is
deleted. Ghost detection's "present" set now comes from the delay engine's live trip bindings.
See §29.)*

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
eviction, bogus-delay drop. *(Two of those are since obsolete rather than broken: §29 moved all
delay writing into `engine.ts`, so `poller.ts` writes nothing to `trip_delay_obs` and there is
no feed `delay` left to drop. The DB uniqueness constraint and the 14-day retention still
apply, and migration 004 added a sequence-aware key alongside them for loop routes.)*

## 12. Identity join — DEVIATION from the literal `(route_id, start_date, start_time)` key

> **SUPERSEDED (2026-07-25) — see §29 and §33.** This decision was genuinely made and is left
> here unedited, because the record of *why* we believed it is worth more than a tidy document.
> Two things in the text below are now known to be false:
>
> 1. **"an explicit `delay` … per StopTimeUpdate"** — the TTC publishes **no `delay` field at
>    all**. Own-property census: 0 of 23,476 StopTimeEvents on the snapshot recorded in
>    BLOCKERS.md (other snapshots read 23,165 / 23,335 / 23,371 — the total drifts run to run,
>    the zero does not). Protobuf.js materialises the
>    proto2 default on the decoded message's prototype, so it *reads* as `0` and we recorded it
>    as a measurement 314,742 times. See BLOCKERS.md entry 6 and METHODS.md §4.
> 2. **"The pure claim logic lives in `server/src/join.ts`"** — `join.ts` and `join.test.ts`
>    were **deleted** in commit `65e3843`. With `delay` always `0`, the reconstruction
>    `scheduled = predicted − delay` collapses to `scheduled = predicted`; the join was
>    comparing the feed's predictions against themselves, which is why its measured rate was 0%.
>
> What replaced it: `patterns.ts` → `xwalk.ts` → `bind.ts` → `delay.ts` → `gates.ts`, wired by
> `engine.ts`. Scheduled time now comes **only** from our own seeded `stop_times`, and no code
> path may reconstruct one from the realtime feed.

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

> **PARTLY SUPERSEDED (2026-07-25) — see §29 and §33.** The clock-vs-board reasoning below is
> correct and still holds: the loaded board covers `20260726..20260905`, there is no
> calendar-active service today, so there are 0 due trips and an honest 0 ghosts.
>
> **The attribution of the 0% join rate was wrong.** We had the right number and the wrong
> explanation. The join reconstructed `scheduled = predicted − delay`; the feed sends no
> `delay`; protobuf.js supplied `0`; the expression was `scheduled = predicted`. The 0% was a
> property of that arithmetic, not of the clock offset and not of the `trip_id` mismatch. Both
> of those are real problems — they are simply not what produced *that* zero. The final
> paragraph's prediction ("`predicted − delay` equals the loaded `departure_s` by definition
> and the join becomes near-exact") would therefore **never** have come true. `join.ts` is
> deleted; there is no join rate to measure any more, only a binding rate.

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
reload is in flight (`staticReloading`) so it never runs with a new trip map against a stale
index. *(§29: "the old join index" is now the delay engine's static pattern index, rebuilt by
`patterns.ts`. The reload-ordering hazard this guards against is unchanged.)*

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

- **Same-event time+delay** (`poller.ts`) — **SUPERSEDED, see §29 and §33.** The join
  reconstruction this describes no longer exists; nothing reads `delay` from the feed at all,
  because the feed does not publish it. Recorded because the *shape* of the fix was right and
  survived into the replacement: `delay.ts` still compares a departure event against the
  scheduled **departure** and an arrival event against the scheduled **arrival**, never crossing
  them. Measured on one snapshot: 22,391 stop-time updates carry arrival only, 602 departure
  only, and 0 carry both — so the pairing rule is load-bearing, just on the other side of the
  subtraction now.
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

*(Written 2026-07-24. Re-verified 2026-07-25: unchanged in substance — the service date in the
suppression string is now `20260725`, and the board still does not activate until 07-26. A
sixth gate, `boardIntegrity`, has since been added; see §34.)*

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

---

## §32 — Closing the last three reference gaps: chunkiness, palette, and the composition

§31 rebuilt the map against the reference and named what still differed. A side-by-side of a
**production** screenshot against the reference sheet then isolated three gaps that were not on
that list, and this section closes them. Everything here is in `web/src/map/**` except one
constant in `web/src/hooks/useLive.ts`, which is where the third gap actually lived.

### The measurement that made this tractable

The previous pass matched the reference's **dominant colours** — a top-N list off a hue×value
histogram — and the result still read as "greyer and flatter". A top-N list is the wrong
statistic: it says which tones appear, not how much of the frame each one covers.

The statistic that answers the actual complaint is the **value-decile histogram**, computed the
same way on both images: the reference's desktop map region, and our own GL canvas read back per
frame (`map.once('render', () => map.getCanvas().toDataURL())` — the drawing buffer is only
intact inside a render tick, because `preserveDrawingBuffer` is false). Percentage of map pixels
per 0.1 band of HSV value:

|            | v<0.1 | .1–.2 | .2–.3 | .3–.4 | .4–.5 | >0.5 | mean S | mean V | mean hue |
|------------|-------|-------|-------|-------|-------|------|--------|--------|----------|
| reference  |  0.1  | 22.5  | 43.1  | 16.9  | 12.7  |  5.7 | 0.574  | 0.290  | 230      |
| §31 build  |  0.0  | 13.4  | 37.3  |  2.9  | 43.4  |  3.0 | 0.480  | 0.345  | 231      |
| this build |  0.0  | 30.8  | 30.0  | 24.2  | 14.2  |  0.8 | 0.571  | 0.284  | 233      |

The §31 build was **bimodal** — dark walls at 0.25, bright roofs at 0.44, a hole between them —
where the reference is a continuous ramp. That hole is exactly what "flat" looks like on screen:
two tones and no modelling in between. And its mean saturation was 0.48 against 0.57, which is
the "greyer" half of the same sentence. Note the mean hue was already right; the problem was
never that the violet was the wrong colour.

### 1. Palette

Walls drop a step and gain chroma (`#1b203f` to `#12123a`); the ordinary roof drops out of the
top band into the mid-band (`#454670` to `#363458`) so the ramp fills in; the blue-slate and
violet families keep a brighter roof so the top band stays populated without owning the frame;
the violet and rose accents move warmer (hue 262 to 250, and a rose at hue ~308) so the
reference's "clear teal and mauve accent blocks" actually read as such.

Result above: mean saturation 0.571 vs 0.574, mean value 0.284 vs 0.290, mean hue 233 vs 230.

### 2. Chunkiness — an honest generalisation, and the lever that was NOT used

`MIN_HEIGHT_BY_ZOOM` at the diorama zoom went 8 m to 16 m. Swept 8/12/16/20/26/34 at the default
framing and measured: the lit-roof share of the frame falls 43% to 32% (reference ~30%) and the
dark ground/street share climbs 13% to 30% (reference 22.5%). 16 m is where the summary
statistics land closest while the block count stays high enough that the grid still reads as a
city.

What this removes is real, and it is removed the way every vector basemap removes its own small
features: some genuine OSM buildings are omitted at wide zoom, and all of them are back by z17.4.

**The lever deliberately not used:** merging neighbouring footprints into one "block". The
reference reads as one chunky cube per city block because it is an illustration; downtown
Toronto's real OSM footprints have a median area of ~600 m², several per block. Dissolving them
into a block-sized mass would draw a building that does not exist, on a map whose whole argument
is that it does not make things up. So the city stays finer-grained than the reference, and that
is a gap we accept rather than close.

### 3. Camera

Pitch 58 to 50, and `FRAME_START_ZOOM` 16.1 to 16.35.

The pitch note in §31 had the direction right — the reference is a comparatively top-down camera
— but stopped short. At 58 the perspective gradient is severe enough that the nearest blocks are
several times the on-screen size of the ones a street away, present mostly wall, and hide the
grid behind them. The reference is near-isometric: block size is roughly uniform top to bottom of
frame. 50 restores that, and with it the dark street gaps between blocks everywhere rather than
only near the horizon.

The zoom was measured off the reference rather than guessed. Its walk path is labelled
"4 min walk" (~250 m) and spans ~210 px of a ~1030 px map pane, which puts the reference camera
at ~0.95 m/px — z16.4 at Toronto's latitude — and at that scale its cubes are ~110 px, one city
block each. `frameCamera` only ever zooms OUT from `FRAME_START_ZOOM`, so a longer walk or a
phone-sized card still fits. z17 was tried and rejected: one whole-block footprint fills the pane
and the grid disappears, reproducing the "canyon" failure §31 already recorded.

### 4. The composition was a DATA problem, not a code problem

The reference's defining composition — stop marker card, purple stop pin, beaded walk path with
its walker-glyph node, You beacon — was absent from the default view. The cause was not the
marker code or the collision rules. `DEFAULT_LOCATION` sat **~30 m** from its nearest stop, so
You and the stop were effectively the same pixel: the walk was "1 min", the beaded path had no
length to draw, and `collide()` correctly suppressed the stop marker as a duplicate of the You
beacon. The reference shows a rider about four minutes from their stop, and that geometry simply
was not in the data the default produced.

The fix is the default location, not the drawing code. Candidates were found by gridding downtown
Toronto against the real `stops` table and keeping points whose **nearest** stop is a genuine
4-minute walk under the app's own arithmetic (`walkSeconds(d, 1.333 m/s, routeFactor 1.25)`,
i.e. d between 224 m and 288 m), restricted to stops actually served by a streetcar route:

    43.645, -79.38736  ->  stop 15644  King St West at John St East Side  (504 King, eastbound)
                           236 m  ·  4 min  ·  second-nearest stop 15643 at 283 m, also 4 min

Verified against a production build: the stop card, pin, beaded path, walker node and the You
card reading **"You / 4 min walk"** are all present and unsuppressed at 1280×800 and 390×844, in
light and dark, in `en` and `fr-CA` (`Vous / 4 min à pied`).

Nothing about this is faked. The stop, the distance and the walk time are computed by exactly the
code that runs on a real geolocation fix; no walk time is hardcoded and no path is drawn that the
data does not support. The point is a *starting viewpoint* shown only until the rider grants
location, and the UI says so on its face — "Using a default location — tap to use yours".

### Verification (production build, `vite build` + `npm start`, real browser)

`trueOverlaps: 0` and `hScroll: false` from §F's probe at 1280×800 and 390×844, light and dark,
`en` and `fr-CA`. Zero vertical-overflow clipping hits. The map-marker pairwise check (not
covered by §F) reports no intersections among the You beacon, stop marker, walker node, route
badge, control stack and attribution. 168 building features render at the default desktop
framing, which also proves the extrusions are live in production rather than a dev-only illusion.

### What still differs — added to the §31 list

8. **The city is finer-grained than the reference.** See §2 above: real footprints, several per
   block, and merging them is off the table. Measured residue: our v0.1–0.2 band is 30.8% against
   the reference's 22.5% (more visible ground) and our 0.2–0.3 band is 30.0% against 43.1%.
9. **The route still does not turn** — §31 item 1 is unchanged and still server-side.
10. **No live countdown, no `Live` pill on a row, and no alert card in the screenshots.** The
    static schedule board covers 2026-07-26 onward and today is before it, so the honest state of
    this stop is "No departures in the next 90 minutes" followed by the genuine next scheduled
    service. The reference's `7 min` / `9 min` / `Trip cancelled 7:26 PM` are illustrative and
    were not reproduced; a board was not invented to make a screenshot match a mockup.

---

## §33 — Two of our own audits were weaker than their names, and only one is fixed

Found on 2026-07-25 while fact-checking `METHODS.md` line by line against the source. Recorded
here at this length because the failure class is the same one as §29's, pointed at the honesty
machinery rather than at the product — and because it is the second time this project has
caught itself asserting something it had not verified.

### What was wrong

The learned stop crosswalk (`xwalk.ts`) is an **inference**. Nothing about it is measured
ground truth; stop identity is guessed from geometry and then propagated transitively. An
inference stack is only trustworthy if it carries tests that are able to fail, so the design
gave it two falsifiable self-audits, and `gates.ts` turns each into a publication gate. Both,
as wired in `runCycle`, were narrower than their names:

1. **`monotonicity` could not fail, on any input.** The audit is meant to catch a crosswalk that
   maps two realtime stops onto static stops that are out of order — the falsifiable property
   lives on the **static** side, where an error shows up as the static sequence going backwards
   while the realtime sequence goes forwards. `runCycle` passed
   `[...b.tracked.keys()].sort((a, c) => a - c)`: the binding's own **realtime** sequences,
   ascending by construction. `monotonicityViolations` was comparing a sorted list against
   itself and returning 0 violations always. The `monotonicity` gate and the `xwalk.unhealthy`
   flag could never trip on it.
2. **`crossRouteAgreement` audits geometry only.** `runCycle` builds its per-route map
   exclusively from `geoAnchors`. Propagated entries — which METHODS.md correctly calls "the
   multiplier" and which are the majority of confirmed crosswalk rows — are not covered. The
   reported ~93.8–93.9% is an accuracy estimate for the geometric anchors, not for the
   crosswalk as a whole.

Neither was publishing a wrong number. Both were **audits that would not have caught the error
they exist to catch**, which for this project is a worse defect than a missing feature: the
product's entire claim is that its refusals are mechanical rather than aspirational.

### Decision 1 — fix the monotonicity wiring, and prove the fix by making the gate fail

`crosswalkedStaticSeqs` (`xwalk.ts`) now resolves each tracked realtime stop, **in realtime
order**, to the static `stop_sequence` the crosswalk claims for it on the bound static pattern,
and `runCycle` feeds that to the audit.

Two deliberate leniencies, so that a reported violation is always a real one rather than a
modelling artifact:

- **Loops get the benefit of the doubt.** A static pattern can visit the same stop twice
  (turnbacks, on-street terminals). Where a stop has several occurrences we take the earliest
  one that still increases — the choice that maximises the remaining options — so a violation is
  reported only when **no** monotone assignment exists at all.
- **Unknowable stops are skipped, not counted as disorder.** Stops the crosswalk cannot name,
  and stops it names that are not on this pattern, are omitted. An absent identity is not
  evidence of disorder, and an off-pattern named stop is the per-trip consistency gate's
  business in `delay.ts`, which is stricter and voids the whole trip.

Only entries that could actually back a published row are audited, so the gate covers exactly
the crosswalk the product would be relying on. The regression test is named for what it
guarantees — `xwalk.test.ts`, **"REGRESSION (BLOCKERS 17): the monotonicity gate can actually
fail"** — because the property under test is not "the gate returns 0" but "the gate is capable
of returning non-zero."

### Decision 2 — do NOT quietly widen cross-route agreement, and do not restate its number

The tempting fix is to build the per-route map from the whole crosswalk instead of from
`geoAnchors`. It is not being done under time pressure, for one reason: geometric anchors are
**independent** observations of the same physical stop from different routes, so their
agreement is genuine corroboration. Propagated entries are **derived** — two routes can agree
because they inherited the same identity from a common ancestor resolution, not because they
independently measured it. Widening the input without first establishing independence would
turn a weak-but-honest audit into a strong-looking circular one, which is the §29 failure mode
wearing a different hat.

Until that is worked out, the correct action is disclosure, not a number that looks better:
**the 93.9% is labelled as a geometric-anchor figure everywhere it appears** — `METHODS.md`
§3.3e, `BLOCKERS.md` entry 17 (still OPEN), and `DEVPOST.md`. A reader who checks will find the
label before they find the limitation.

### The pattern this makes twice

| | §29 (the delay=0 bug) | §33 (the audit gap) |
|---|---|---|
| What was well-designed | The evidence gates: `n ≥ 8`, `n ≥ 20`, trust-grade tiers | The audits: falsifiable by construction, no ground truth needed |
| What was actually true | They were gating an input that was unanimously meaningless | One was fed the wrong side of the comparison; one covers a minority of its subject |
| What caught it | Re-measuring a believed-true assumption against the live wire | Re-reading a believed-true document against the source |
| What did **not** catch it | Every unit test, every build report, the type system | The gate's own output, which read "healthy" |

The common cause is not carelessness in either case — both were competent implementations of
correct designs. It is that **a system cannot audit its own inputs from the inside.** The only
thing that has worked twice is going back out to the source of truth (the wire, the code) and
re-deriving something already believed. That is a process claim, and this table is the evidence
for it.

---

## §34 — A calendar-active day with no seeded trips must not read as a clean day

Landed in the engine on 2026-07-25 (commit `e749a75`), recorded here because that commit's own
message says it belongs in this file and the engine workstream does not own it.

**The hole.** `seed_toronto.ts` loads `calendar` and `calendar_dates` whole, but filters `trips`
and `stop_times` through a rolling `GHOSTBUS_SEED_WINDOW_DAYS` window measured from the *seed
date* rather than from the *loaded board's* validity span. Those are different windows, so the
calendar can declare a service active on a date for which we hold no trips at all.

**The measurement.** Re-checked against both the database and the extracted feed: **7 of this
board's 42 days** are in that state.

| Dates | Service | Trips published | Trips loaded |
|---|---|---|---|
| 2026-08-01, -08, -15, -22, -29, 2026-09-05 (the six Saturdays) | 2 | 32,874 | **0** |
| 2026-08-03 (civic holiday; `calendar_dates` switches service 1 off) | 4 | 31,295 | **0** |

The remaining 35 days match the feed exactly, so the seeded board is not thin anywhere else.
Services 6702/6703/6704 carry no weekday flags and no `calendar_dates` rows and are never active
in the **feed** either — that gap is not ours.

**Why this needed a gate and not just a bug report.** On those seven days the engine passed
`boardActive`, found zero due trips, and wrote zero ghosts and zero delays — producing output
**identical** to a day on which the TTC ran a flawless service. That is the §29 failure in its
purest form: a zero that means *we don't know* rendering as a zero that means *nothing went
wrong*. For an accountability product, that specific confusion is the worst one available,
because it errs toward exonerating the agency using our own missing data as the evidence.

**The decision.** Add a `boardIntegrity` gate (`gates.ts`) that fires when the calendar
activates a service for the date and the loaded board holds no trips for it, with a reason
string that names the hole. `patterns.ts` gains `tripsByService` to answer the question.

**What this deliberately does NOT do.** It does not repair the seed, and it must not be
described as having done so. The seeding fix belongs in `seed_toronto.ts`: the trip/stop_time
filters must be derived from the loaded board's own validity span
(`min(start_date)..max(end_date)`), or at minimum unioned with it, so that a service the
calendar declares can never lack its trips. Filed as `BLOCKERS.md` entry 9, still **OPEN**.
Suppressing a misleading day is a smaller claim than fixing it, and only the smaller claim is
true.

---

## §35 — The crosswalk plateau was a leak, and the gate that was suspected of being wrong was right

Written 2026-07-25, the day before the static board activates. §33 covers the monotonicity
audit and §34 the blank-service-day gate; this section covers the other three findings from
the same pass — the cold start, the coverage plateau, and the map's decoder — and one
operational consequence of measuring them.

### The suspicion, and why it was the wrong one

`BLOCKERS.md` entry 10 recorded crosswalk occurrence coverage stuck at 36.5–37.2% against a
`MIN_XWALK_OCCURRENCE_COVERAGE` of 0.50, and asked the obvious question: is 0.50 simply the
wrong number for this feed? That framing is dangerous, because it puts the gate on trial when
the gate is the only thing standing between a thin crosswalk and a published delay. Reaching
for the threshold first is how a project talks itself into shipping.

So the threshold was left alone and the **metric** was taken apart instead. Two things fell
out immediately, and neither is about where the line is drawn.

**First: the curve was not flat, it was descending.** 36.4% at cycle 40, 30.9% at cycle 75,
30.6% at cycle 87. A learning system whose coverage *falls* while it accumulates evidence is
not plateauing. It is losing something it already had.

**Second: decomposing 23,636 live `StopTimeUpdate` occurrences showed the loss was not a
shortage of evidence.** 43.2% of occurrences resolved to an entry that had an identity and was
blocked only by a promotion rule; another 13.5% resolved to an entry that was `confirmed` and
under the confidence floor. Only 2.6% named a stop the system had never seen at all.

### The two leaks

**Corroboration was lowering confidence.** A geometric anchor *overwrote* a propagated entry
outright. Geometry carries a residual factor, `1 - resid/60`, that propagation does not — and
`nearestStopOnRoute` accepts anchors out to 80 m. The arithmetic follows: any residual over
24 m caps confidence below the 0.60 usability floor no matter how many cycles corroborate it.
So a stop that propagation supported at 0.85 fell to 0.33 the moment a bus was observed 40 m
away **agreeing about which stop it was**. In the production table, 1,018 of 1,535 geometric
entries carry a residual over 20 m and 522 of those are capped under 0.50 by arithmetic alone.

The principle being violated is not subtle: *evidence that agrees may never make us less
sure.* `corroboratedConfidence` takes the best of the agreeing sources. It admits nothing that
either source would have refused on its own — it is the removal of a penalty for having more
evidence, not a lowered bar. The residual still caps what geometry **alone** is worth, which
is the only question it can actually answer.

**Promotion was forgetting what it had already seen.** `distinctPatterns` — the count behind
"two independent RT patterns agree, therefore `confirmed`" — was recomputed every cycle from
the patterns resolved in *that* cycle. A stop corroborated by two patterns at 08:00 dropped
back to `candidate` at 03:00 when one of them was not running. Corroboration is a historical
fact; it does not stop having happened because a bus went to the garage. The log shows the
oscillation plainly: confirmed 3,043 → 3,031 → 3,019 → 3,025 → 3,042 across five consecutive
cycles.

Agreement now accumulates. It is keyed by **static** pattern id rather than RT pattern id, and
that detail is load-bearing: an RT pattern's id is a content hash, so extending a pattern
renames it, and accumulating RT ids would let a single line of evidence corroborate itself
under two names — exactly the kind of self-confirming arithmetic this project keeps catching
itself in. Two RT patterns that are really one resolve to the same static pattern and collapse
to a single vote.

### The result, and the point of it

With `MIN_XWALK_OCCURRENCE_COVERAGE` **unchanged at 0.50**, measured against the live feeds:
cycle-1 coverage **49.1%**, rising to **51.7%** by cycle 10; a second run 49.3% → 50.7%. The
binding gate is now `boardActive` rather than `xwalkOccurrenceCoverage`.

**The gate was right. The learning was broken.** That is the outcome worth having, and it was
only reachable because the threshold was not touched first. Had the gate been dropped to 0.35
on the grounds that "the real evidence is sound at lower coverage", the number would have gone
green, both leaks would still be there, and every published delay would have rested on a
crosswalk quietly shedding identities it had already earned.

### The change that was refused

The single largest coverage win available was **not taken**. 43.2% of occurrences are blocked
by the two-independent-patterns promotion rule alone, and 4,066 of those entries already clear
the confidence floor. Admitting one-pattern identities would roughly double coverage overnight.

The evidence for doing it was a held-out experiment: withhold a random fifth of the geometric
anchors, let propagation predict those stops from what remains, and compare against the
measurement that was hidden. It returned **88.57% agreement for one-pattern identities
(n=140) against 80.70% for two-or-more (n=57)** — i.e. the rule appears to buy no accuracy at
all.

That was not enough, for a reason visible in the disagreements themselves: they are
overwhelmingly *adjacent platform ids at a single intersection* — `1037` vs `1036`, `2034` vs
`2033`, `8349` vs `8348`, `6633` vs `6638`. The withheld "truth" is a nearest-stop match, and
at exactly this granularity it is about as likely to be the wrong one as the prediction is. The
experiment therefore cannot distinguish "propagation is wrong" from "geometry picked the other
side of the street", and a promotion rule protecting published delay measurements does not get
relaxed on a test that cannot tell those apart. The rule stands; the experiment is recorded so
the next attempt starts from it rather than from scratch.

### Cold start: written every cycle, read by nothing

`rt_stop_xwalk` was `INSERT`ed on every cycle and `SELECT`ed by no code path at all. Every
restart began from an empty crosswalk, and since a propagated entry needs eight corroborating
votes to clear the 0.60 floor, coverage read 0.0% for the first nine cycles of every process —
about eight minutes at the 45 s cadence. On a host that sleeps when idle, that warm-up is
longer than the uptime, so the deployment publishes nothing, ever.

`loadCrosswalk()` restores it at boot, scoped by board tag, and only when the in-memory
crosswalk is genuinely cold — a six-hourly same-board reload must not overwrite fresher state
with the row we ourselves wrote. Three merge properties earn their own regression tests,
because a warm start that lies is worse than a cold one: a loaded row **seeds** the vote count
rather than earning a vote for having been read; its stop id is seeded into the proposal set so
contradicting evidence still marks the stop conflicted instead of silently overwriting it; and
a row persisted as `conflicted` comes back conflicted, at confidence 0, and stays out of the
propagation seed. Cycle-1 coverage: **0.0% → 49.1%**. Warm-up: eight minutes → zero cycles.

### The restore that was built, measured, and reverted

`rt_stop_anchor` — the accumulated geometric centroids — is written and never read too, and
restoring it is the obvious completion of the same fix. It was implemented. It produced a real
cross-route agreement figure at boot (90.1%, on a proper denominator) where the crosswalk-only
warm start computes that audit over four stops and reads 75% — below its own 85% gate, on pure
noise. It also surfaced ~330 fresh contradictions between measured geometry and the restored
propagated crosswalk, and coverage read 44.6% → 45.3% over six cycles instead of 49.1% →
51.7%: **below the publish gate**.

Those contradictions are either geometry correctly retiring stale propagated identities — in
which case the lower number is the truer one and should ship — or stale anchors, since that
table is not board-scoped and its centroids never decay. Settling it needs a longer run, and
the longer run could not be completed (see below). **The change was reverted.** Shipping a
modification whose only measurement puts the engine under its own publish gate, on the strength
of "it would probably have recovered", is the move §29 and §33 exist to prevent. It is filed in
`BLOCKERS.md` entry 11 with both sets of numbers, so the next attempt begins from the evidence
rather than from the intuition.

### The decoder rule, and a finding corrected downward

`processVehicles` read `bearing`, `speed`, `timestamp`, `currentStopSequence` and
`trip.tripId` straight off the decoded protobuf with `!= null` and truthiness tests — the exact
pattern that produced 314,742 information-free delay observations in §29. All of it now goes
through `pb.ts`, and an absent bearing stays null rather than becoming 0, which the map already
handles by falling back to the bearing implied by the vehicle's own movement.

But the census does not support the symptom the blocker asserted. Across three live snapshots,
`bearing`, `speed` and `timestamp` are present on the wire for **every** vehicle that publishes
a position (1,224 / 1,236 / 1,246). No live vehicle is rendering a fabricated due-north
heading. The field that genuinely is absent — `currentStopSequence`, on 21–22% — was already
handled correctly by the old `> 0` guard. Two other defaults *were* reachable and are now
closed: an absent `timestamp` dated a ping 1970-01-01 and made the intended "unknown → now"
fallback unreachable, and an alert with an open-ended active period would have been published
as one starting 1970-01-01.

So this is a **latent** bug fixed, not a wrong number removed, and it is written down that way.
It is recorded at length in `BLOCKERS.md` 16 because an overstated finding corrected downward
is worth as much as a confirmed one, and this file's credibility depends on the corrections
being as loud as the discoveries.

### The cost of measuring: the Neon transfer quota, and the collector

Every one of these live measurements required a fresh pattern index — 2.15 million
`stop_times` rows, ~120 s over Neon. Four rebuilds in one afternoon **exhausted the free
tier's data-transfer quota**, which stopped the detached collector at cycle 88 with
`Your project has exceeded the data transfer quota`. That is a self-inflicted outage, and it is
recorded rather than quietly waited out, because it has two consequences worth naming.

First, it bounds the confidence of everything above: the after-numbers rest on runs of 10 and 6
cycles, consistent with each other and both rising, but not a soak.

Second, and more important for tomorrow: **the index rebuild is the dominant data-transfer cost
in this system, and nothing in the design accounts for that.** It runs on every boot and every
six hours. On a free tier that is a budget, and a deployment that restarts often will spend its
quota rebuilding an index that has not changed. The warm-start work above makes restarts
cheaper for the *crosswalk*; it does nothing for the index. Caching the built index — or paging
it from a materialised table instead of `stop_times` — is the obvious next correction, and is
not attempted here.

---

## §36 — The index rebuild was the dominant transfer cost, and a boot no longer pays it

§35 ended by naming the next correction and not making it: *"the index rebuild is the dominant
data-transfer cost in this system, and nothing in the design accounts for that… Caching the
built index — or paging it from a materialised table instead of `stop_times` — is the obvious
next correction, and is not attempted here."* This is that correction.

It is not an optimisation. The deploy target is Render's free tier, which sleeps after 15
minutes of inactivity; every wake is a fresh boot, and every boot re-read 2.15M `stop_times`
rows. Four rebuilds in one afternoon had already exhausted the month's Neon transfer quota and
stopped the collector at cycle 88. Deployed as it stood, the app would have spent its quota
waking up and then stopped working. Everything below is a prerequisite, not a polish pass.

### What a rebuild actually cost, in bytes

The old figure for this was a wall-clock one (~109–120 s over Neon). Wall clock is not what the
quota meters, so the first thing worth having is the byte count. `node-postgres` reads results
in the **text** format, so each row arrives as a `DataRow` message: 1 byte tag, 4 bytes length,
2 bytes field count, then 4 bytes plus the text for each column. That is exactly computable
from the real feed's field widths, and computing it over the same 2,227,328-row window the
board holds gives:

| query | rows | wire bytes |
| --- | ---: | ---: |
| the paged build query (8 text columns) | 2,227,328 | **142.94 MiB** (mean 67.3 B/row) |
| the `routeStops` geometry query (4 columns) | 16,555 | 0.77 MiB |
| **per rebuild** | | **143.70 MiB** |

That is the number the design has to beat, and it is charged on every boot and again every six
hours.

### The shape of the fix: prove the board is unchanged, then don't read it

Three pieces, in the order a boot meets them.

**1. A one-row board fingerprint.** `boardFingerprint()` issues a single statement of scalar
sub-selects over `calendar`, `calendar_dates`, `trips`, `stop_times` and `stops`. It returns
five short text columns — about 250 bytes — however large the board is, so the check can never
grow into the cost it exists to avoid. It covers every column the index derives from: route,
direction and service on `trips`; sequence, stop, arrival and departure on `stop_times`; the
lat/lon on `stops` that become `routeStops`.

It also covers `calendar` and `calendar_dates`, which the index does **not** read. That is the
part worth arguing for. The board tag is only `min(start_date)..max(end_date)`, so a calendar
edit that leaves those two dates alone — a service withdrawn from Wednesdays, an exception
added for one date — changes which trips are active on a date while the tag stays
character-for-character identical. A tag-only check would serve a cached index against a
calendar that had moved underneath it. Two of the mutation tests are exactly those two edits,
and both fail a tag comparison and pass the fingerprint.

**And the first version of it was wrong, in the one way that matters.** It hashed each COLUMN
independently — `sum(H(stop_id))`, `sum(arrival_s)`, `sum(stop_sequence)`, and so on. Every one
of those totals is a *multiset* summary, so nothing in the fingerprint correlated two values
appearing in the same row, and any permutation that moved values between rows was invisible:

- swap two stops within a trip → same multiset of stop ids, same sequence sum, same time sums,
  **different `patternIdFor`**;
- swap the times of two stops on a trip → same sums, different schedule;
- two trips exchanging `service_id`, or two trips whose `direction_id` flips in opposite
  directions → same sums, different board.

Each of those is precisely the failure this whole mechanism exists to prevent — a cached index
served against a schedule that is no longer the schedule — and a review caught it before it
shipped. The fix costs the same shape of query: digest the **whole row** first
(`md5(trip_id||'|'||stop_sequence||'|'||stop_id||'|'||arrival||'|'||departure)`) and sum two
disjoint 32-bit slices of that one hash, which correlates the columns and buys ~64 bits of
collision resistance for one hash per row. There is now a regression test that applies the
stop swap, asserts that **every naive column aggregate is byte-for-byte unchanged** — so the
test is provably testing the blind spot — and then asserts the fingerprint changes anyway. Four
of the mutation cases are permutations for the same reason.

Three details that are correctness, not taste. Every sum is integer-typed: a `float8` sum is at
the mercy of whatever aggregation order a parallel plan picks, and a fingerprint that flapped
would rebuild every six hours forever and silently undo this whole entry. lat/lon are scaled to
integer microdegrees rather than rendered as float text, so the digest cannot depend on the
session's `extra_float_digits`. And when the fingerprint cannot be taken at all it returns
`null` rather than a guess — which disables both cache tiers and falls back to exactly today's
always-build behaviour. It retries once first, because "safe" here still means a 143.70 MiB
rebuild, and one flaky connection should not buy one.

**2. A serialised index.** `packIndex` writes a sealed blob: `'GBPX'`, a `u32` format version, a
sha256, then a compressed body of one interned string table, the patterns, the slots and the
route geometry. Nothing derivable is stored. Pattern ids, `byRoute`, `maxLenByRoute`,
`medianHeadwayS`, `stopsByTrip`, `serviceByTrip`, `tripsByService`, `tripIds` and the slot
ordering are all recomputed on load — by the *same* `insertTrip` and `finalizeIndex` the build
uses. That was the point of splitting them out of `foldTrip`: it makes "a restored index is
identical to a built one" a property of the construction rather than a claim a test has to take
on faith. In particular the pattern id is re-derived from the stops on both paths, so a cache
cannot introduce a pattern identity a rebuild would not have produced.

**3. Two cache tiers, file then Postgres.** Weighed against the actual failure modes:

- **The local file** is free to read and write and **dies with the container**. On Render's
  free tier the disk is ephemeral, so a cold wake never sees it. It is nonetheless the whole
  answer for a process restart on a live container and for the local collector, which restarts
  often — those boots cost the fingerprint row and nothing else.
- **The Postgres row** survives the container, so it is the only tier that helps the cold wake
  that was killing us — at the cost of transferring the blob back. That is the trade, and it is
  only a good one because the blob is two orders of magnitude smaller than the rows it replaces.

So: both, file first because it costs nothing, Postgres as the authority because it is the one
that survives. The Postgres lookup puts `board_tag`, `fingerprint` and `format` in the `WHERE`
clause rather than comparing them in JavaScript afterwards, so a row that no longer describes
the current board is filtered server-side and **is never downloaded to be rejected**. That is
the whole economics of the table; a `SELECT *` plus a JS check would have paid the transfer on
every boot and defeated the point.

`payload_b64` is base64 `TEXT` and not `BYTEA` for the same reason: node-postgres reads in the
text format, where a bytea comes back hex-encoded at 2.00x the payload against base64's 1.33x.
Measured on the real board that is 1.21 MiB against 1.81 MiB per cold wake, for a column type.

### Measuring the payload, and being wrong twice on the way

Neon refuses even `SELECT 1` while the quota is out, so none of this could be measured against
it. It could be measured against the **same GTFS feed the database was seeded from**
(`.data/gtfs/extracted`), folded through the same `foldTrip`: 70,986 trips, 2,227,328
`stop_times` rows, 1,195 patterns, 222 routes with geometry. That window is 3.8% larger than the
seeded board's 68,401 trips, so every payload figure below is very slightly conservative.

The first serialisation was the obvious one — every integer as a little-endian `int32`, gzipped.
It produced **6.46 MiB**, and it was wrong twice.

The body is 19.17 MiB, of which the times and arrivals are **16.99 MiB**. So the layout of that
one section decides the answer, and absolute seconds-since-midnight is a poor way to write it:
every value is a five-digit number whose bytes vary. Written as **per-trip deltas** — a running
sum inverts them exactly, including the `-1` "no time" sentinel — the gap between two stops is
two or three minutes and its top two bytes are zero. That section alone:

| times/arrivals layout | gzip 6 | brotli q5 |
| --- | ---: | ---: |
| absolute int32 | 5.74 MiB | 3.70 MiB |
| **delta int32** | **0.56 MiB** | **0.45 MiB** |
| delta + byte-plane transpose | 0.61 MiB | 0.43 MiB |

Ten times smaller, and *faster* to compress and to inflate than the absolute form. The byte-plane
transposition on top — a classic columnar trick — was measured and does not pay: it is worse
under gzip and 0.02 MiB better under brotli, which does not buy its complexity.

The second mistake was reaching for gzip by habit. On the identical delta-coded body:

| compressor | payload | compress | decompress |
| --- | ---: | ---: | ---: |
| gzip level 1 | 1.44 MiB | 26 ms | 21 ms |
| gzip level 6 | 1.31 MiB | 97 ms | 18 ms |
| gzip level 9 | 1.31 MiB | 234 ms | 17 ms |
| **brotli q5** | **0.90 MiB** | **96 ms** | **19 ms** |
| brotli q9 | 0.90 MiB | 305 ms | 18 ms |
| brotli q11 | 0.78 MiB | 27,620 ms | 28 ms |

Brotli q5 is 31% smaller than the best gzip for the same time in both directions — strictly
better on every axis, so there is nothing to trade. q11 buys a further 0.12 MiB for 27.6 seconds,
which is not something to put on a boot path. Both findings are the reason the code comments
carry the numbers: "use gzip" and "int32 is compact" are both reasonable-sounding instincts and
both were wrong here by 5x and 1.5x respectively.

### What it costs now

| | before | after |
| --- | ---: | ---: |
| cold boot, fresh container | 143.70 MiB | **1.21 MiB** (fingerprint + blob) |
| boot with the container's disk intact | 143.70 MiB | **~250 B** (fingerprint only) |
| the 6-hourly reload, board unchanged | 143.70 MiB | **~250 B** (fingerprint only) |
| time to a usable index | 109–120 s (Neon) | **312 ms** to restore |

**118x fewer bytes on the worst case**, and the same transfer budget that bought four rebuilds
now buys roughly 475 cold wakes. Packing costs 169 ms and happens only when the board actually
changes.

The 6-hourly reload deserves its own line, because it is the case a cache alone would not have
fixed. `reloadStatic` now fingerprints *first* and returns early — keeping the very same index
object — when the board is unchanged. A reload of an unchanged board issues **two statements**,
which a regression test asserts by counting them: the fingerprint, and the crosswalk-restore
retry that the reload has always been responsible for. That retry was briefly lost to the early
return and put back; `loadCrosswalk` swallows its own errors, so the 6-hourly reload is the only
thing that ever tries a failed boot-time restore again, and it reads `rt_stop_xwalk` — thousands
of rows, not 2.15M.

And the check does not smuggle the cost back in as compute. Against 2,227,328 synthetic rows on
PGlite — WebAssembly, so slower than Neon's native Postgres and therefore an upper bound rather
than a prediction — the fingerprint query runs in **2.97–3.09 s**, repeatably, against **2.87 s
for a single one** of the build's twelve 200,000-row pages: the whole check costs about what one
twelfth of the build costs, and returns 250 bytes instead of 12 MiB. Correlating the columns
per row roughly doubled that (it was 1.29–1.42 s while the digest was column-wise and wrong),
which is the right way round to spend 1.5 seconds.

### How it is proved, without a database to prove it against

The tests run on PGlite: real Postgres, real migrations, on disk, no quota. The fixture is a
432-trip board across six patterns and three services, not 2.15M rows — scale is not what makes
a cache correct, round-tripping is, and 432 trips reach every branch: a short turn sharing a
prefix, both directions, a null departure, a null arrival, and a trip with a hole in its
`stop_sequence` that the build refuses (so the two paths must agree about what is *not* in the
index too).

The comparison is structural, never a row count: pattern ids, the pattern *order*, every slot's
times and arrivals, the slot ordering, the derived headways, and every by-trip map. A cache that
got the count right and the times wrong fails. Fifteen tests cover: a cold boot writing both
tiers; a second boot restoring from disk while touching the database zero times; a wiped disk
restoring from Postgres and re-landing on disk; thirteen board mutations each forcing a rebuild,
four of them permutations invisible to column sums; eight kinds of damaged blob — truncation, a
flipped payload byte, a flipped checksum byte, wrong magic, a future format version, empty,
garbage — each **falling back rather than throwing or part-loading**; a truncated Postgres
payload; a blob for another agency, board or fingerprint; a `null` fingerprint caching nothing
at all; and the two engine-level regressions above. At real scale the round trip was verified
exact over all 70,986 trips and all 4,454,656 integers.

One class of test is there because the obvious tests could not reach it. Every damaged-file case
is rejected by the magic, the format or the sha256 — all of which run *before* the inflate — so
none of them exercise the structural checks inside `unpackIndex` at all. Those checks exist for a
different failure: a blob that is internally inconsistent yet perfectly sealed, which is what a
bug in `packIndex` would produce, not what a corrupted disk produces. So a separate test tampers
with the **decompressed body** and re-seals it with a correct checksum — a trailing byte, four
bytes short, each of the four metadata counts inflated by one, a metadata length running off the
end, unparseable metadata — and asserts all eight are refused.

`unpackIndex` has exactly one failure mode: `null`. Every rejection — bad magic, wrong format,
failed checksum, truncation, a length field running off the end, a count disagreeing with the
metadata, trailing bytes, a fingerprint that is not the one asked for — returns `null` so the
caller rebuilds. Nothing may hand a partial index back, because a board short of trips would
bind realtime vehicles against a schedule with holes in it, and a slow boot is enormously
preferable to that.

### What could not be verified, and what is still open

The database is down, so these are honest gaps rather than omissions:

- **No number here was taken from Neon.** The 143.70 MiB is *computed* exactly from the
  Postgres v3 `DataRow` framing over the real feed's field widths — not captured from a socket.
  TLS framing and any Neon proxy overhead sit on top of it, so it understates the true saving
  slightly. The 109–120 s build time is quoted from the earlier runs recorded in §35, not
  re-measured.
- **Neon's own compute time for the fingerprint scan is unmeasured.** The 1.3 s PGlite figure is
  a conservative upper bound, not a prediction.
- **Migration 005 has not been applied to Neon**, only to PGlite. It is one `CREATE TABLE IF NOT
  EXISTS` of plain types, but it is unrun there.
- **The 1.21 MiB round trip has not been timed over the wire.**
- The restored index was verified structurally and through the engine's boot path, **not against
  a live realtime feed** — no feed run was possible in this state.

One window worth naming because it is now closed. The build is keyset-paged and takes ~110 s
over Neon, so a re-seed landing mid-build is real rather than theoretical: the pages before it
describe one board and the pages after it another. The index is therefore **re-fingerprinted
after the build**, and if the board moved it is served (there is nothing better to hand back,
and rebuilding immediately could loop against a still-running re-seed) but not cached, with its
fingerprint cleared so the next reload rebuilds instead of keeping it.

One thing deliberately left alone. When the board *content* changes but the tag does not, the
crosswalk is still carried across, because `boardChanged` keys on the tag exactly as it did
before. The fingerprint now makes detecting that case possible, and arguably a content change
should invalidate the learned stop identities too. It is not changed here: that is a crosswalk
decision with its own evidence to gather, the behaviour is identical to what shipped before, and
widening this change into it would have been scope this entry cannot justify. Filed, not done.

Also unchanged, and worth naming because it is now the largest remaining static read:
`loadStaticContext()` in `poller.ts` still returns one row per trip on every boot and every
reload (a `DISTINCT ON` over `trips` joined to `stop_times`). At 68,401 rows that is roughly 3%
of what the index rebuild used to cost, so it is no longer the dominant term — but it is not
free, and `poller.ts` belongs to another workstream.

---

## §37 — Six reference gaps, measured: two closed, two closed by correcting the brief, one closed by the user, one handed on

A repair pass was briefed with six visual gaps between the production build and
`ghostbus-design-reference.png`. Three of the six turned out to be described backwards,
and finding that out took the same measurement that fixed the ones that were real. What
follows is what each one actually measured, because a number that contradicts a brief is
the most useful thing in the entry.

### 0. The database was down, and PGlite is how the whole pass ran

Neon has exhausted its free-tier transfer quota and refuses `SELECT 1`, so every number
below came from the project's own embedded-Postgres fallback holding the real TTC GTFS:
233 routes, 9,361 stops, 68,369 trips, 2,150,321 stop_times, 1,369 shapes.

The reproduction step that is easy to get wrong: `db.ts` calls `loadEnvOnce()`, which runs
`process.loadEnvFile('.env')` at boot, so deleting `DATABASE_URL` from the shell
environment does not reach it — `.env` puts it straight back and the server dies against
the dead Neon host. But `process.loadEnvFile` does **not** overwrite a variable already
present in `process.env`, including one set to the empty string, and `db.ts` branches on
`url ? makePg(url) : makePglite()` — empty string is falsy. So:

    DATABASE_URL= npm start        # the trailing '=' is load-bearing: set-but-empty, not unset

logs `GhostBus API — driver=pglite` and serves the real board off `.data/pglite`. Unsetting
the variable, or `unset DATABASE_URL`, does not work. This is the documented fallback's
first real end-to-end exercise and it held for the whole pass: the poller, the crosswalk,
the pattern index and every API route ran on it unmodified.

One operational note for anyone screenshotting against it. The API is rate-limited to 120
requests/minute per IP and a single cold page load spends roughly half of that (health,
nearby, arrivals, up to eight next-service day probes, alerts, ghosts, and a 5 s vehicle
poll). Two browser contexts back to back get a 429 — and a 429 renders the honest
"feed unavailable" state, which is a page with almost no DOM in it and therefore scores a
perfect zero on the §F overlap probe. **Assert that the app rendered before trusting any
probe.** The harness for this pass reads the stop name out of the DOM and retries after
waiting out the window rather than screenshotting a rate-limited page.

### 1. The route line does not turn at King & Spadina, and it now never will

The brief said the 504 King turns at Spadina and that recovering that dogleg was the
highest-value gap. Measured against the polyline the app actually draws
(`/api/routes/:id/shape` — the agency's published shape), the largest accumulated heading
change within 320 m of King & Spadina is:

| route | dir 0 | dir 1 |
|---|---|---|
| 504 King / 304 King | 1° | 1° |
| 510 Spadina / 310 Spadina | 3° | 3° |

King Street and Spadina Avenue are both dead straight through that intersection and
neither route turns off the other. The mockup's dogleg is illustrator's licence.

A genuine right-angle turn *is* reachable: at 43.6618, -79.35456 the 505 Dundas turns onto
Broadview 80 m from the frame centre, with the same honest four-minute walk, and it was
built and screenshotted. It was not shipped, because it is a different intersection from
the one the reference shows and the user asked for theirs by name.

Offered the choice between focusing the 510 to manufacture a turn in frame and keeping the
straight 504, **the user chose the straight 504: "keep 504 straight, it's the honest
one."** So this gap is closed by decision rather than left open. No geometry was bent,
smoothed or spliced, and the focused route was not swapped to buy a bend.

### 2. The default location: King & Spadina, and the walk time is whatever it computes to

`DEFAULT_LOCATION` = **43.64354, -79.39699** — on Wellington St W, south-west of the
intersection. It is not a round number, for a reason. King & Spadina is ringed by four
stops, so nearly every standing point near it is one or two minutes from one of them; a
13 m grid over ±450 m, keeping only points whose *nearest* stop is one of those four, has
exactly one member that reaches a four-minute walk.

    nearest   stop 15647  King St West at Spadina Ave West Side   230 m  ->  4 min
    runner-up stop 15649  King St West at Portland St East Side   227 m  ->  4 min

The four minutes is never written down. It is `walkSeconds(d, 1.333 m/s, routeFactor 1.25)`
applied to the distance `/api/stops/nearby` returns for the real stop, by the same code
that runs on a real geolocation fix. Two metres closer and the app would say three
minutes, and three minutes is what would have shipped.

### 3. The framing rule: a proportion, measured on both breakpoints

A start zoom is a constant, and what the reference holds constant is a ratio. Marker
centroids pulled out of the reference sheet by pixel scan:

|  | You beacon | stop pin | apart | pane / card | ratio |
|---|---|---|---|---|---|
| desktop | (728.1, 499.3) | (672.9, 308.7) | 198.4 px | 744 px | **0.267** |
| mobile | (328.7, 970.9) | (297.4, 903.7) | 74.1 px | 288 px | **0.257** |

Two very different card sizes, one ratio: the walk occupies about a quarter of the card's
width and the city fills the other three quarters. Ours measured 0.347 on desktop and
0.528 on a phone — 1.3x and 2.1x too close. `frameCamera` now projects the two real points,
measures the span the camera actually produces (pitch-aware for free, unlike any
ground-resolution formula) and corrects the zoom by the log2 of its ratio to the target,
clamped between the existing ceiling and floor. Desktop now lands at 0.29.

**The phone cannot reach it.** 0.26 of a 390 px card needs roughly z14.7, and
`FRAME_MIN_ZOOM` is 15.4 because the diorama's own opacity ramp only reaches 1 at z15.3 —
below it the card renders a half-transparent city, the failure §31 already recorded. The
phone therefore sits at 0.43 against the reference's 0.26, and at that framing `collide()`
suppresses the stop bubble and the walker node, so the phone shows You + route + badge
where the reference shows five floating elements. Not closed; named.

### 4. A zoom expression inside a FILTER is evaluated at the integer zoom

This is the one worth remembering. `MIN_HEIGHT_BY_ZOOM` had its first step boundary at
15.2 and had been tuned three times — 8 to 16 to 8 metres — by three passes that were all
tuning a number the camera never reached. `frameCamera` lands the diorama between z15.4
and z16.0, which floors to **15**, and 15 < 15.2, so the filter took the *first* branch and
applied the 22 m "wide out, substantial massing only" floor to the entire diorama.

Downtown that is survivable, which is why it hid for so long: Toronto's core has almost
nothing under 22 m. Framed on a low-rise neighbourhood it deleted the neighbourhood
outright — ground, trees and a road, with the buildings reappearing only past z17.4 where
the ladder's last step drops the floor to zero.

Moving the boundary to `VOXEL_MIN_ZOOM` (14.6) is what put the city in. HSV value deciles
over the desktop map region, computed identically on the reference sheet and on our own
production frame:

|  | v<.1 | .1–.2 | .2–.3 | .3–.4 | .4–.5 | >.5 | mean S | mean V |
|---|---|---|---|---|---|---|---|---|
| reference | 0.1 | 25.2 | 41.9 | 15.9 | 12.4 | 4.5 | 0.566 | 0.284 |
| boundary 15.2 | 0.1 | **64.3** | 25.4 | 3.5 | 4.4 | 2.4 | 0.604 | 0.219 |
| boundary 14.6, floor 8 | 0.1 | 28.6 | 36.7 | 10.4 | 21.4 | 2.9 | 0.554 | 0.287 |

Two thirds of the frame in the darkest band is what "the city is missing" looks like as a
number. With the boundary fixed the floor was swept at the real default framing — 4 / 8 /
14 / 20 m give summed deviations of 27.3 / 23.1 / 26.7 / 30.4 across the four middle bands
— and 8 m is the minimum of that trade. It is a real trade, not a dial: raising the floor
pulls the over-bright .4–.5 band down, because the buildings it removes are small ones
presenting almost pure roof, and pushes the darkest band up, because what is left is
ground.

The filter's missing-height fallback was also corrected. It coalesced `render_height` to
**0** while the geometry coalesces it to `DEFAULT_HEIGHT_M`; a great many OSM buildings
carry no height at all, and the filter was calling those zero-metre buildings and deleting
them at every threshold above zero. It does not invent a height — 8 m is the height those
buildings are already drawn at.

### 5. Two gaps that were described backwards

**"The mobile map card is too short — the reference is roughly 4:3."** It is not.
Edge-detected by pixel scan across both phone panels of the reference sheet: the light
phone's screen runs x 194..482 and its map card y 829..1005, i.e. 288 x 176 = **1.636**;
the dark phone agrees at 290 x 176 = 1.648. Ours is 5:3 = 1.667 — a three-pixel difference
on a 390 px card. 4:3 would be 1.33, which is 58 px *taller* than the reference. Left at
5/3 and the measurement recorded in `app.css` so the next pass does not re-litigate it.

**"The trees are too small — scale them up."** They were already the right size and there
were five times too many. Same run-length scan on both images — horizontal runs of olive
pixels across the desktop map region, converted to CSS pixels by each panel's own scale:

|  | median canopy | p75 | p90 | olive share of the map region |
|---|---|---|---|---|
| reference | 15.5 px | 21.9 | 29.7 | 0.98 % |
| ours, before | 16.0 px | 20.0 | 24.0 | 4.91 % |

Canopy width matched to within half a pixel. `CANOPY_PX` was therefore left alone and the
count came down instead (spacing 30 to 48 px, keep 0.30 to 0.20), landing coverage at
1.11% and median canopy at 14.0 px. Two earlier notes in `voxelTrees.ts` were corrected in
passing: both came from a narrow green-hue filter that discarded the reference's dark
olive *side* faces and kept only its lit tops, which is how "ours cover twice the
reference's area" was concluded about trees that were in fact five times too numerous.

Also recorded there, because it will bite someone: `metresPerPixel()` in that module uses
the 256-px-tile Web Mercator constant while MapLibre's world is 512-px tiles, so it returns
twice the true value and every `_PX` constant in the module renders at twice its nominal
size. Left alone deliberately — the numbers are tuned against the current behaviour, and
"fixing" the constant would silently double every tree in the app.

### 6. The palette drift was the location, not the palette

A reviewer read an intermediate frame as steel-blue against the reference's violet.
Measured on **building surfaces only** — mid-value, saturated pixels, so that parks, water
and road fill cannot drag the mean — the drift was real and its cause was not the colours:

|  | mean building hue | 180–210 | 210–240 | 240–270 |
|---|---|---|---|---|
| reference | 229.6 | 2.8 % | 81.6 % | 13.7 % |
| low-rise frame | **219.7** | 7.2 % | 79.9 % | 7.8 % |
| King & Spadina | **230.6** | 3.7 % | 69.5 % | 24.5 % |

Small buildings present almost pure *roof*, and the blue-slate roof is the bluest surface
in the set; a frame full of two-storey houses is therefore a frame full of that one tone.
Moving back to the reference's own intersection put the mean building hue within a degree
of it with no palette value changed.

Worth naming for whoever measures this next: the 240–270 column is brittle. Our ordinary
roof sits at hue exactly 240.0 and the reference's sampled one at 238.6, so a 1.4°
difference flips about a fifth of the frame between two bins while the eye sees nothing.
Trust the circular mean and the by-eye comparison over the bin split.

### 7. Saved Places, and what "real data" means for a screenshot

The section renders empty because nothing has ever been starred on this device, which is
correct — a seeded "Home · 12 min walk" is exactly the decorative fiction this app does not
ship. To populate it for the comparison shots, the harness presses **the app's own star
button** at two real stops: it gives the browser a real position near
`15648 King St West at Spadina Ave East Side`, waits for the board, clicks the star,
revokes the geolocation permission so the app falls back to `DEFAULT_LOCATION`, and clicks
the star again on `15647`. `gb.saved` then reads `["15648","15647"]` because the app's own
store put it there. No fixture is written and no row is invented; both are real stops and
both rows draw their sub-line from real nearby/arrivals data.

### 8. Still open

- **The phone framing and its suppressed markers** (§3 above). The reference's phone shows
  five floating elements; ours shows three, because the diorama floor stops the camera
  short and `collide()` then does its job correctly.
- **The lit-roof share.** Our .4–.5 value band is 21.4% against the reference's 12.4% at the
  best floor available. Every lever tried trades it against the darkest band.
- **The renderer itself.** The user's verdict on the buildings was that they look nothing
  like the reference, and the diagnosis is architectural rather than tonal: MapLibre's
  `fill-extrusion` shades by a vertical height gradient, while the reference shades by face
  orientation — lit top, mid left wall, dark right wall — in a near-isometric projection
  with contact shadows. No palette or floor value can produce that, which is why several
  passes in a row kept nearly matching the histograms and missing the picture. That work is
  handed to a replacement renderer; the measurements above are the acceptance targets for
  it.
- **No live countdown, no `Live` pill, no alert card**, and this remains correct: the static
  board covers 2026-07-26 onward and today is 2026-07-25, so the honest empty state plus the
  genuine next scheduled service is what the screenshots show. Nothing was invented to make
  a frame resemble a mockup.
