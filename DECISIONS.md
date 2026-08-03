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

---

## §38 — The city is a Three.js custom layer now, and the diagnosis that sent it there was half wrong

The user's instruction was blunt: *"the buildings and shading looks nothing like what the
reference … use 3d models to make this like real shading and textures using voxel art … it
just has to look 1:1 with this."* Four side-by-side comparisons had already agreed that the
buildings were the last gap. This section replaces the renderer and, first, corrects the
reasoning that justified replacing it.

### The commissioning diagnosis was two-thirds wrong, and saying so is the useful part

The pass was commissioned on three claims about `fill-extrusion`. Two do not survive contact
with MapLibre's source.

1. **"It shades by a vertical height gradient, not by face orientation."** False. The
   fill-extrusion vertex shader in `maplibre-gl@6.0.0` reads, verbatim:

   ```glsl
   float directional = clamp(dot(normalForLighting, u_lightpos), 0.0, 1.0);
   directional = mix((1.0 - u_lightintensity),
                     max((1.0 - colorvalue + u_lightintensity), 1.0), directional);
   ```

   That is per-face directional shading off the face normal. It can even be driven to the
   exact ratio measured below. With light intensity `i` the factor spans `[1-i, ~1]`; solving
   for the measured 1 : 0.641 : 0.491 gives `i ~= 0.51`, a light at polar 48.5 deg and the lit
   wall 75 deg off the light azimuth. So face shading was never the blocker.
2. **"The reference is near-isometric; MapLibre renders in perspective."** True but not a
   blocker: MapLibre v6 ships `map.setVerticalFieldOfView()`. `cameraToCenterDistance` is
   `0.5 * height / tan(fov/2)`, so narrowing the FOV pushes the camera back while holding the
   scale at the map centre — the perspective gradient flattens and nothing about pan, zoom,
   pitch or rotate changes. That lever works just as well under `fill-extrusion`.
3. **"It has no ambient occlusion / contact darkening."** This one is correct, and it is one
   of four real limits.

The four things `fill-extrusion` genuinely cannot do, which are why `voxelMesh.ts` exists:

- **No footprint inset.** The entire paint spec is opacity / color / translate / pattern /
  height / base / vertical-gradient. Two abutting OSM footprints cannot be pulled apart, so
  the reference's dark gap between blocks — its strongest "separate solid cubes" cue — is
  unreachable. §31 item 2 already recorded this; the sub-tier roof offset it substituted buys
  a step in the skyline, not a gap on the ground.
- **No AO.** `fill-extrusion-vertical-gradient` ramps over the *whole* wall, floors at
  `mix(0.7, 0.98, 1-intensity)` so it can darken by at most ~16%, and is scaled by
  `pow(height/150, 0.5)` so short buildings get almost none. It is also what makes blocks read
  as smooth prisms, which is why it was switched off.
- **No per-face texture.** The reference is a *voxel* render: blocks are visibly built from
  stacked cubes. `fill-extrusion-pattern` tiles in tile space, not per-face UV space.
- **No independent roof and wall colour.** One `fill-extrusion-color` per layer. The old
  two-layer "cap band" is a coplanar-wall z-fighting hazard dodged by tiling heights exactly.

### The measurement: how the face ratios were actually derived

Sampling at guessed coordinates produced inconsistent garbage on an earlier attempt, and
connected-component segmentation was no better — the reference's faces carry soft AO, so they
are not regions of constant colour and a component labeller fragments them.

What works is the geometry. The reference is an orthographic render, so **every block presents
a near-vertical edge where its two visible walls meet**, and that edge pins all three faces at
once: left wall immediately left of it, right wall immediately right, roof directly above its
top endpoint. Finding the edge needs no segmentation — it is a run of consecutive rows at one
column where the horizontal colour step exceeds a threshold.

37 such edges in the desktop map region (x 360-1069, y 88-689) after masking the route, trees,
marker cards and labels. 24 have the roof brightest, which is the sanity condition for a
lit-from-above render; the other 13 are edges whose "roof" sample landed on ground behind the
building, and are discarded. Over those 24, Rec.709 relative luminance:

|              | TOP   | LEFT  | RIGHT | notes |
|--------------|-------|-------|-------|-------|
| medians      | 1.000 | 0.641 | 0.491 | IQR L/T 0.568-0.739, R/T 0.454-0.590 |
| trimmed mean | 1.000 | 0.646 | 0.513 | LEFT is the brighter wall in 73% of all 37 edges |

Two top-face families split out of the same samples: indigo `#21294b` (lum 42, n=12) and
lavender `#484a72` (lum 76, n=12), top-face hue centred 232 deg.

The daylight panel, measured identically on the light phone card (280x166, upscaled 4x Lanczos
so the run-length thresholds still bite), yields 3 edges agreeing to within 0.008:
**1.000 : 0.808 : 0.983**, top `#f3f1ec`. The **handedness flips** — confirmed by eye at 8x on
single blocks before it was believed. The night render is lit from screen-left; the daylight
render from screen-right, so its left wall is the shaded one and its right wall is within 2% of
the roof. That is why daylight leans on ground contact shadows for block separation where night
leans on wall tone.

**Camera pitch is now derived rather than judged**, which settles three passes of 58 -> 50 -> 52
argument. Under orthographic projection a horizontal direction at plan-angle phi from
screen-right projects to screen slope `tan(phi) * sin(e)`, e being elevation above the horizon.
A gradient-orientation histogram over the reference's map region peaks at **+/-0.675 and is
symmetric**, which forces phi = 45 deg and `sin(e) = 0.675`, e = 42.5 deg. MapLibre measures
pitch from straight down, so **pitch = 48**. FOV drops 36.87 deg -> **16 deg**.

### Three bugs, each of which produced a *completely* black map

Worth recording because two of them are invisible in code review and only a rendered frame
shows them.

1. **Merging a feature's rings into one oriented box.** The first version grouped every ring of
   a feature — on the theory that a building straddling a tile boundary arrives as one clipped
   piece per tile. Measured: of ~700 building features loaded at the default framing, **112 have
   a per-feature bounding box wider than 300 m and the worst is 1825 m**, which is exactly a z14
   tile at Toronto's latitude. OpenFreeMap's `building` layer stops at z14, so the diorama's
   z16.4 is an overscaled z14 tile, and at z14 OpenMapTiles emits multipolygons whose parts are
   scattered across the tile. Unioned, each became one near-black cube the size of a
   neighbourhood. **One box per polygon ring, never merged**, is both the fix and the more
   honest reading — merging was the thing inventing geometry.
2. **three's ColorManagement.** Since r152 `new THREE.Color('#21294b')` stores the *linear*-sRGB
   value (0.0144), not 0.129, expecting the renderer's output pass to encode it back. A raw
   `gl_FragColor` shader with no `<colorspace_fragment>` chunk never encodes it back, so every
   measured tone rendered about **nine times too dark**. The palette values were sampled off a
   finished PNG — they are already sRGB — so the correct handling is no conversion at all, and
   `srgb()` parses the hex directly.
3. **`transparent: true` on the contact-shadow material.** Three sorts transparent objects into
   a second list drawn *after* all opaque objects, so hundreds of overlapping shadow quads were
   painted over the blocks themselves and compounded into a black wash. Declaring the material
   opaque with explicit `CustomBlending` keeps it in the first list where `renderOrder` decides,
   so shadows land on the ground and blocks draw on top of them.

### "Reads steel blue, not violet" — the mean was right and the shape was wrong

A reviewer called the result blue against a violet reference. Measured on *building surfaces
only* (luminance 34-150, saturation > 0.15, route and trees masked), using the **circular** mean
for hue:

|               | circular mean hue | mean sat | hue distribution, 10 deg bins over 210-280 |
|---------------|-------------------|----------|--------------------------------------------|
| reference     | 233.5             | 0.490    | 3 / 5 / 31 / 35 / 19 / 6 / 2 |
| ours (before) | 230.0             | 0.543    | 0 / 1 / 77 / 17 / 1 / 3 / 1 |
| ours (after)  | 235.3             | 0.503    | 0 / 1 / 25 / 52 / 18 / 4 / 1 |

The mean was 3.5 deg out — i.e. the mean was never the problem. The **shape** was: a single
spike of 77% in one bin, against a reference that spreads 60% of its building pixels at hue
>= 240. A narrow spike centred on 230 is what "steel blue" looks like as a number even when the
average says violet. Fixed by moving the family hues up and adding a deterministic +/-11 deg
per-block hue jitter so the population spreads instead of stacking.

Luminance-band deviation from the reference over the same region fell **44.9 -> 27.8** (summed
absolute difference across six 16-level bands).

### "Faces look meshy / subdivided"

That was the voxel lattice, and the reviewer was right. The reference's cube seams sit on blocks
the size of a city block; drawing the same fixed-metre lattice on a 20 m infill shophouse puts a
full cross through a face two cells wide, which reads as wireframe panelling. The lattice now
fades in only once a block is a few cells across (`smoothstep(1.9*cell, 3.4*cell, min(width,
depth))`), cell size went 14 -> 17 m and strength 0.16 -> 0.085. The reference's small blocks are
flat single tones too, so this matches it rather than compromising with it.

### What is drawn, and what is not invented

Every block is one real OSM footprint from the same OpenFreeMap tiles the basemap already loads.
Nothing is hand-modelled, AI-generated or merged. Three decorative transforms, all the same
class as the height quantisation this project has always used and all documented in the module:
each footprint is drawn as its **PCA-oriented bounding box** (one block per real building, real
position, real orientation, real extent); that box is **inset 1.2 m** so abutting buildings show
the reference's gap; heights are **quantised** onto a shared lattice. A sanity guard drops any
ring whose half-extent exceeds 300 m — no Toronto building is 600 m across, so such a ring is a
tile-generalisation artifact, and the count is exposed in `stats()` (currently **0**).

### Verification (production build, `npx vite build` + `npm start`, real Chrome)

Running the app needs a note, because the Neon database is over its free-tier transfer quota and
`server/src/db.ts` calls `loadEnvOnce()`, which reads `.env` at *runtime* — so unsetting
`DATABASE_URL` in the shell does not work. **Setting it to the empty string does**, because
Node's `process.loadEnvFile()` does not override a variable already present in `process.env`,
and `''` is falsy where `getDb()` chooses its driver:

    DATABASE_URL= PGLITE_DIR=<abs path> node --import tsx server/src/server.ts

The pre-existing `.data/pglite` was left unreadable by a hard kill (`PANIC: could not locate a
valid checkpoint record`; PGlite ships no `pg_resetwal`), so a fresh directory was seeded from
the already-downloaded GTFS extract — 41 s, 9,361 stops, 68,369 trips, 2,150,321 stop_times,
1,369 shapes. **PGlite must be shut down cleanly or `postmaster.pid` removed before restarting.**

All 8 combinations — 390x844 and 1280x800, light and dark, `en-CA` and `fr-CA`:

- §F overlap probe **`trueOverlaps: 0`, `hScroll: false`** everywhere.
- Map-marker pairwise check (not covered by §F): **0 collisions, 0 spill, attribution visible.**
- Clipping audit: **0 hits.**
- **0 console and page errors.**
- **2,059 blocks, 0 dropped, from 494 tile features**, in one `InstancedMesh` draw call plus one
  for the shadows. Zero per-frame allocation; geometry rebuilds on `idle` only, because the
  blocks live in world space and panning needs no rebuild.
- Frame timings with `triggerRepaint()` every frame for 4.5 s: **p50 4.2 ms** at every
  combination, **p95 4.8-5.9 ms**, worst 12.3-20.1 ms — unchanged from the fill-extrusion build's
  p50 4.2 / p95 5.0-6.5.
- 3D confirmed **absent at Reduced and Lite** (`voxel-city-3d` and `voxel-tree-body` missing,
  pitch and bearing 0, FOV restored to 36.87, layers button `disabled`), and
  `prefers-reduced-motion` cuts to final state with no drift.
- `npm test`: **208 passing, 0 failing.**

**Bundle cost of `three@0.185.1`:** the map chunk goes 988.5 kB -> 1,504.8 kB raw and
**263.0 kB -> 395.2 kB gzipped, a delta of +132.2 kB gzipped.** That is the honest price of
`WebGLRenderer`; it is lazily loaded with the map chunk, not on the initial route.

### What still differs from the reference — updated

11. **The city is still finer-grained than the reference** (§32 item 8, unchanged and now
    quantified). The reference reads as one chunky cube per city block because it is an
    illustration; Toronto's real footprints are several per block, and merging them stays off the
    table. The generalisation floor was re-swept at the new renderer — 8 / 16 / 24 m gave
    luminance-band deviations of 22.7 / 24.1 / 32.1 — so raising it makes the match *worse*, not
    better: what it removes are lit roofs and what it leaves behind is ground. **8 m stands.**
12. **Our luminance ramp is still lumpy.** After tuning we sit at 0.5 / 37.4 / 34.3 / 20.4 / 4.3 /
    3.2 against a reference of 3.2 / 38.1 / 27.6 / 13.2 / 12.3 / 5.6: we spike where the reference
    spreads. Root cause is item 11 — with smaller blocks, less of the frame is lit roof, so
    matching the frame statistic exactly would need face colours brighter than the ones actually
    measured off the reference. The palette deliberately stops at the measured hues and family
    structure and accepts the residue rather than over-brightening to chase a histogram.
13. **Trees are close but sparse.** Measured over the same region: reference hue 113 deg, sat
    0.214, mean RGB (65, 77, 63), covering 0.68% of the frame; ours hue 106 deg, sat 0.174, RGB
    (60, 69, 57), covering 0.25%. Colour is within 7 deg of hue and 7 luminance levels — the
    density is the real difference, at roughly a third of the reference's. `voxelTrees.ts` was
    deliberately tuned in §31 against its own measurement, so this pass reports the number rather
    than churning it.
14. **The route still does not turn** (§31 item 1, §H) — server-side shape geometry, untouched.

## §39 — The one gap left, tested against the provider's own coarse tier: chunkier is reachable, closer is not

§38 closed every reference gap except one and named it item 11: *the city is still finer-grained
than the reference.* Its conclusion was that the reference "reads as one chunky cube per city
block because it is an illustration", that Toronto's real footprints are several per block, and
that merging them stays off the table. That conclusion survives. The reasoning behind it did not,
because §38 only re-swept the **generalisation floor** (drop buildings under 8 / 16 / 24 m) — and
a floor cannot make a block bigger. It can only delete small ones.

This section pulls the lever §38 never pulled, and a second one, and reports both verdicts.
**Nothing shipped changed.** The renderer at HEAD draws exactly what it drew at `924adba`.

### The lever: render the provider's z13 building tier, not its z14 one

Vector tile providers generalise geometry at lower zooms. Drawing what a provider published for a
zoom is ordinary cartography — the dissolve is theirs, not ours — so it is categorically unlike
merging footprints ourselves. §38 already noticed in passing that "OpenFreeMap's `building` layer
stops at z14". It does, but that is the layer's **maxzoom**; its **minzoom is 13**, and z13 is a
different, coarser publication of the same buildings.

`https://tiles.openfreemap.org/planet` TileJSON, read directly: tileset `maxzoom: 14`;
`vector_layers` gives `building 13 14`. z12 was checked too — four tiles fetched, **no `building`
layer in any of them** — so 13 is the floor.

Nine tiles per tier around King & Spadina were fetched and decoded with a hand-written MVT reader
(scratchpad `mvt.mjs`; the project has no vector-tile dependency, and `pbf` is vendored by
MapLibre). Every ring was reduced to the same PCA-oriented box the renderer draws, then clipped to
one **900 x 900 m window** so the two tiers are compared over identical ground:

| tier | rings in window | rings/km2 | median span | median area | p90 span |
|------|-----------------|-----------|-------------|-------------|----------|
| z14  | 742             | 916       | 21.8 m      | 475 m2      | 47 m     |
| z13  | 57              | 72        | **93.4 m**  | **8,720 m2**| 165 m    |

**13x fewer blocks at 4.3x the span.** And it is a genuine dissolve, not a filter that drops small
buildings: the nine z13 tiles carried exactly **nine features** — one MultiPolygon per tile, with
7,161 rings between them — and their ring vertex counts (median 19, p90 36) are those of merged
clusters, against z14's median 5. Toronto's downtown blocks run 100–150 m. z13 is city-block scale.

Two further checks, because "the provider over-claims ground" and "an oriented box round a blob is
a lie" were both live objections:

- **The dissolve barely over-claims.** Rasterised at 1 m over the same window, published z14
  footprints cover 40.2% of the ground and published z13 polygons 46.1% — a ratio of **1.15**.
- **The box transform is no worse at z13 than at z14.** Box-area / polygon-area aggregates
  **1.467 at z14 and 1.504 at z13** (medians 1.17 and 1.44). Whatever licence the oriented box
  takes, it takes about the same amount at both tiers.

### The price: z13 publishes no attributes at all — not fewer, none

| tier | property key sets observed |
|------|----------------------------|
| z14  | `{render_height, render_min_height}`, `+colour`, `+hide_3d` — **all 2,194 features carry `render_height`** (median 33 m, p90 163 m, max 553 m) |
| z13  | `{}` — **empty, on every feature** |

So a naive z13 city has no skyline whatsoever: every block falls to `DEFAULT_HEIGHT_M`. The fix is
a **height join** back onto the tier that does carry heights, and it is well defined: every one of
the 57 z13 rings in the window contains at least one z14 building (median 10, p90 28, max 69).
Joining by `max` — a block is as tall as the tallest real building standing on it, which is a real
measured height of a real structure at that address, where a mean would be a number no building
has — gives median 52 m, p90 165 m.

`voxelMesh.ts` implements all of this behind `coarseBlocks`, **default off**. Three things it
learned the hard way, all recorded in the module:

1. **A source with no layer never fetches a tile.** MapLibre's `SourceCache.update()` early-returns
   unless `used` is true, and `used` comes from the style's layers. The first coarse build rendered
   an empty city for exactly this reason. A `fill` layer at `fill-opacity: 0` marks the source used;
   the fill painter early-returns on a constant zero opacity, so it costs a tile fetch and no draw.
   `visibility: 'none'` does **not** work — that un-uses the source again.
2. **The tile template must be read from the live source, never hardcoded.** OpenFreeMap's TileJSON
   points at a dated snapshot (`/planet/20260621_080001_pt/{z}/{x}/{y}.pbf`) that rotates, and the
   undated path answers **200 with a zero-byte body** — a hardcoded URL would render an empty city
   silently on the day the snapshot rolled. Pinning `maxzoom: 13` on the sibling source is the whole
   point; with the TileJSON's own 14, MapLibre just refetches z14.
3. **A lazily-added source needs its own rebuild trigger.** Its tiles land *after* the build that
   asked for them, and MapCard rebuilds the city on `idle`, which has already fired. Without a
   `sourcedata` listener the app renders no city at all — measured, not theorised.

### The verdict: it is chunkier, and it measures worse

Measured in the **production build**, real Chrome, at the app's real default framing — which the
probe reports as **zoom 16.182, pitch 48, FOV 16, a 960 x 740 pane covering 732 m of ground**.
Reference figures are §32's: a 708 px pane at 0.95 m/px, i.e. 673 m of ground, with ~110 px cubes,
which rescales to **149 px on a 960 px pane**.

| | blocks in frame | median on-screen span | **area-weighted median span** | area-weighted median area | **luminance-band deviation** |
|---|---|---|---|---|---|
| reference | — | — | **149 px** (~105 m) | 22,240 px2 | — |
| **z14, shipping** | **651** | 17 px | **44 px** (~44 m) | 1,923 px2 | **28.1** |
| z13, 1.2 m inset | 43 | 80 px | 128 px | 16,434 px2 | 48.1 |
| z13, proportional inset | 43 | 80 px | **128 px** (~109 m) | 16,434 px2 | **41.3** |

The area-weighted median — the span of the block covering the median *building pixel* — is the
honest statistic here; a plain median is dominated by laneway sheds nobody looks at.

**On block size the lever works, and not marginally: 44 px against the reference's 149 becomes
128.** On §38's metric it loses by 13 points, and the six bands say exactly why:

| | 0-16 | 16-32 | 32-48 | 48-64 | 64-80 | >80 |
|---|---|---|---|---|---|---|
| reference | 3.2 | **38.0** | 27.3 | 13.1 | 12.3 | 6.1 |
| z14 shipping | 0.2 | **37.8** | 34.1 | 20.4 | 4.3 | 3.3 |
| z13 first cut | 0.1 | **20.0** | 28.8 | 35.0 | 12.9 | 3.1 |
| z13 + proportional inset | 0.2 | **25.7** | 30.4 | 30.7 | 9.9 | 3.2 |

Band 16-32 is ground and street in the night theme, and the reference gives it **38%** of the
frame — wide, continuous canyons. The shipping build matches that to within 0.2 points. **The
coarse blocks eat the streets**, taking it to 20.0.

That was our transform, not the provider's — recall the published z13 polygons claim only 1.15x
the ground. A fixed 1.2 m inset is 11% of a fine block's ~11 m half-extent but only 2.6% of a
coarse block's ~46 m, so `COARSE_INSET_FRAC = 0.11` makes the inset proportional and holds the
gap-to-block ratio constant. It recovers 5.7 points of ground and 6.8 of deviation — and stops
there. Band 48-64 is still 30.7 against 13.1, and that residue is structural, not tunable:

> **The reference's largest connected same-tone region is 0.38% of the frame. Ours is 1.97% at
> z14 and 4.63% at z13.** The reference's cubes are big *and* carry per-face gradient and ambient
> occlusion, so no single tone ever owns much of the frame. Our faces are three flat measured
> tones (§38's 1.000 : 0.641 : 0.491), so a bigger block is simply a bigger flat region. Making
> blocks chunkier without also making each face non-uniform moves the histogram the wrong way.

By eye (`screenshots/reference-match/final4/SCALE-MATCHED-ref-vs-z14-vs-z13.png`, all three panels
resampled to 620 m across so block sizes compare directly) the trade is legible: z13 gets the
block *scale* right and loses the street grid. Its blocks also inherit their yaw from the PCA of a
dissolved cluster rather than from the street, so they sit off-axis and cross roads, where the
reference's cubes are strictly grid-aligned with clean canyons between them.

Two further costs, both real: **17 of 434 coarse rings had no z14 building inside them and were
dropped**, because the two tiers' loaded tiles cover different ground at the frame edge, so the
coarse city thins at the margins; and the second source is a real fetch, though a cheap one — z13
tiles average **109 KB against z14's 388 KB**, and only 1–2 of them cover the default view.

### The other lever: move the camera in. It is already where the reference's is.

The reference's blocks are city-block sized, so a closer camera would make ours occupy more screen
— at the cost of `FRAME_START_ZOOM`, which §37 calibrated off the reference's own marker
composition (walk span / pane width = 0.267 desktop, 0.257 mobile).

The measurement kills the idea before the trade-off is even reached:

- **The reference's map pane covers 673 m of ground; the app's covers 732 m.** The two cameras are
  within **8.8%** of each other. §32's calibration already landed on the reference's framing, and
  the fine grain is not a camera error — it is Toronto having smaller buildings than an
  illustrator drew.
- To take our 44 m area-weighted block from 0.046 of the pane to the reference's 0.156, the camera
  must come in **2.39x**, to **zoom 17.44**, leaving a pane 306 m across. The walk-span fraction
  goes **0.26 -> 0.62**, i.e. **2.4x the reference's own measured ratio** — the stop bubble and the
  You beacon stop fitting, and `frameCamera`'s step-2 loop would simply zoom back out again.
- There is no useful partial trade either. A 1.5x nudge (z16.77) leaves blocks at 0.069 — 44% of
  target — while the walk is already at 0.39, 46% over the reference.

### What this settles

**§38 item 11's conclusion stands, and now for a measured reason rather than an assumed one.** It
is not that coarser real geometry is unavailable — OpenMapTiles publishes it at z13, it is exactly
city-block scale (area-weighted median 109 m against the reference's ~105 m), and drawing it is
not fabrication. It is that the reference's chunkiness is inseparable from two other things it has
and real data cannot supply: **street canyons at 38% of the frame with strictly grid-aligned
blocks**, and **faces that are not flat**. Take the provider's chunky geometry and you lose the
first; keep our flat measured face tones and you lose the second. The illustration is internally
consistent in a way a real city at real coordinates is not.

That conclusion is correct as far as it goes, and it is also **not the interesting one**, because
the premise it shares with �38 � that the gap was about how BIG a building is � turned out to be
wrong. See the next part.

**The `coarseBlocks` implementation was reverted and is NOT in the tree.** It worked, it is fully
specified above (sibling source pinned to `maxzoom: 13` with its tile template read off the live
source, a zero-opacity carrier layer so MapLibre actually fetches it, a `sourcedata` listener to
rebuild when those tiles land, and a max-height join by point-in-polygon), and a review of it found
a real bug in the base-height join � but it lost on every measure that mattered, so shipping ~120
lines of dead code to preserve a negative result was the wrong trade. The numbers above are the
record.

**And the whole line of enquiry was superseded.** Magnifying the reference to 5x showed that
granularity was never the gap at all � see below.

### Verification (production build, `npx vite build`, real Chrome, PGlite-backed API)

The shipping path is unchanged, and it was re-measured rather than assumed, because this pass did
refactor the ring walk that both paths share:

- **2,059 blocks from 494 features, 0 dropped** — identical to §38.
- **Luminance-band deviation 28.1**, against 28.2 measured on the pre-change build in the same
  session. (Worth recording: **§38 item 11's "22.7" is not reproducible.** Item 12's own band
  figures in that section sum to 27.7, and two independent captures here give 28.1 and 28.2. The
  8 m floor is still the right choice — it just never measured 22.7.)
- **§F overlap probe `trueOverlaps: 0`, `hScroll: false`** at 1280x800 and 390x844, light and dark.
  **0 page errors** in all four.
- Frame timings over 4.5 s of `requestAnimationFrame`, foregrounded: **p50 4.2 ms, p95 5.3 ms,
  worst 14.6 ms** (§38: p50 4.2, p95 4.8–5.9). Note the tab must be brought to the front — a
  backgrounded Chrome throttles rAF to ~1 Hz and reports a meaningless p50 of 999 ms.
- `npm test`: **208 passing, 0 failing.**
- Bundle: the MapCard chunk goes 1,505.77 -> 1,507.83 kB raw and **395.69 -> 396.48 kB gzipped,
  +0.79 kB** for the opt-in coarse path.

---

### THE ACTUAL GAP, found at 5x: every reference building is a CLUSTER of cubes

Everything above — and §38, and §32 before it — compared *frame statistics*. The frame statistics
kept agreeing while the picture kept looking wrong, and that is the failure mode this part records.

Magnifying the reference to 5x settles it in one look. **No building in the reference is one
extruded prism.** Every mass resolves into four to six discrete cubes at differing heights, packed
together, with real seams between them, visible ambient occlusion in the crevices where a tall cube
meets a short one, edges that are softened rather than razor-sharp, and faces that carry a gradient
instead of one flat tone. The trees are built the same way: several green cubes over a brown trunk
cube. **That** is what makes it read as voxel art. §38 drew one smooth prism per footprint and
painted a lattice on its faces to suggest cubes, which is architecture with a grid on it.

It is also what the original project spec asked for — "one box (or a few stacked boxes) with
footprint and height quantised to a chunky voxel grid" — and it was lost somewhere between there
and §38.

### What is drawn now

`voxelMesh.ts` still starts from exactly one real OSM footprint per drawn mass, PCA-oriented and
inset. What changed is that the footprint is then **divided into a whole number of cells** as close
to `CELL_M` as it can manage, and **one cube is emitted per cell**:

- The grid is laid out in the **footprint's own frame**, not in world space. A world grid would give
  every off-grid building a staircase silhouette and cells hanging over its edges; laying it out in
  the building's frame means the cubes tile the real outline exactly — no partial cell at the far
  edge, nothing outside the true footprint.
- Each cell's height is a whole number of courses of the shared lattice, either the footprint's own
  quantised height or **exactly one course below it**, chosen by a hash of the stable feature id so
  it never changes when a tile refetches. **At least one cell is always at full height**, so the
  mass still reads as the building's real height, and a single-course footprint gets no variation
  at all because it has none to express. This never adds height to anything.
- Colour is **per footprint**, not per cube, so a cluster reads as one building. The contact shadow
  is likewise one per footprint — a shadow quad per cube would stack alpha in the middle of every
  cluster and burn a dark core into it.

Three shader additions carry the rest of the character:

1. **Crevice occlusion.** Each cube carries its four neighbours' heights as an instance attribute
   (`iNbr`), so a wall knows the roofline of whatever is pressed against it and darkens just above
   it, fading upward. This is the strongest voxel cue in the reference after the cluster itself.
2. **Bevel.** A rounded edge does not change a face's colour, it rotates its normal toward the
   neighbouring face — so the shader blends the tone across the last ~1.4 m instead, at zero
   geometry cost (12 extra triangles times 4,459 instances was not worth paying).
3. **Across-face gradient**, small: walls brighten toward the top, roofs away from the light.

### The three numbers that were wrong, and how each was fixed

**1. Cubes were tall and thin, because the height step was not tied to the cell size.** At matched
190 m scale the reference's cubes are roughly as tall as they are wide; ours were several courses
tall and one cell wide. The derivation that fixes it has to account for the zoom height gain,
because that scales height *without* scaling footprint:

    drawn cube height = HEIGHT_STEP_M * zoomHeightGain(z)
    drawn cube width  = CELL_M
    cubic  =>  HEIGHT_STEP_M = CELL_M / zoomHeightGain(z)

At the app's measured default framing (z 16.182) the gain is 1.386, so **`HEIGHT_STEP_M` goes 24 ->
17** and a course draws 23.6 m against a 24 m cell. This does **not** shorten buildings — a finer
step yields *more* courses for the same real height (raw 41 m: two 24 m courses = 48 m before,
three 17 m courses = 51 m now). The tower is the same height and is now built of three cubes
instead of two slabs.

**2. Needles.** Toronto's tiles carry plenty of 6–8 m laneway footprints, and a quantised two or
three courses on one of those renders as a spike; the reference contains nothing of the kind, and
at 5x they were the loudest artefact in the first cluster build. `MAX_ASPECT = 2.2` caps a
cluster's courses at its own narrowest span measured in cells. It is a rule about how a real height
is **drawn**, in the same class as the sqrt compression `quantizeHeightM` has always applied, and
it only ever draws a building shorter than its data, never taller.

**3. Under-lit.** Running §38's own vertical-edge sampler over **both** images with one code path
put the reference's median top-face luminance at **61–63** and ours at **55**. The frame histogram
agreed: our two brightest bands held 4.1% and 3.4% of the frame against the reference's 12.3% and
6.1%. The dark palette's top tones are lifted **1.28x** in value only — hue and saturation
untouched — and the trees **1.09x**, which is the gap §38 item 13 had already measured between the
reference's tree pixels (mean RGB 65, 77, 63) and ours (60, 69, 57).

### Measured, before and after (production build, real Chrome, app default framing)

Camera unchanged and measured: **z 16.182, pitch 48, FOV 16, a 960 x 740 pane covering 732 m**.

| | before (§38) | after |
|---|---|---|
| drawn instances | 2,059 prisms | **4,459 cubes** from the same 2,059 footprints |
| footprints producing a multi-cube, multi-height cluster | 0 | **418** |
| oversize rings dropped | 0 | **0** |
| median top-face luminance (ref 61–63) | 55 | **62** |
| six-band luminance deviation from the reference | 28.1 | **21.1** |
| frame timings, foregrounded, 4.5 s | p50 4.2 / p95 5.3 / worst 14.6 ms | **p50 4.2 / p95 6.2 / worst 18.1 ms** |

Bands, against the reference's 3.2 / 38.0 / 27.3 / 13.1 / 12.3 / 6.1:

| | 0-16 | 16-32 | 32-48 | 48-64 | 64-80 | >80 | deviation |
|---|---|---|---|---|---|---|---|
| before | 0.2 | 37.8 | 34.1 | 20.4 | 4.3 | 3.3 | 28.1 |
| clusters, before the lift | 0.2 | 32.1 | 33.7 | 19.6 | 9.8 | 4.6 | 25.8 |
| clusters + 1.28x lift | 0.2 | 30.5 | 29.5 | 17.5 | **15.0** | **7.4** | **21.1** |

The bright tail now slightly *overshoots* the reference (15.0 / 7.4 against 12.3 / 6.1), which is
the signal that the lift has gone far enough and the next increment would start moving away again.

**Cell size was swept at 17 / 20 / 24 / 30 m**, all four built and rendered:

| CELL_M | cubes in frame | clustered footprints | p50 | p95 |
|--------|----------------|----------------------|-----|-----|
| 17 | 7,419 | 504 | 4.3 | 6.3 |
| 24 | 4,459 | 418 | 4.2 | 6.2 |
| 30 | 3,364 | 264 | 4.3 | 6.1 |

**Performance is flat across the whole sweep** — the extra instances cost nothing measurable, which
is what one `InstancedMesh` and one draw call buys. So cell size was chosen on the reference, not on
the budget: at 5x, a reference mass ~120 px across resolves into 4 roof cells and one ~80 px across
into 3, i.e. a cube pitch of ~27 px, and at §32's 0.95 m/px that is **~25 m of ground**. `CELL_M =
24` is that number, and it is also a near-exact match for the height step above, which is what makes
each emitted box an actual cube.

### What is still not matched, honestly

- **Face separation.** The two wall tones measure 0.663 : 0.682 against the reference's 0.504 :
  0.422 — our walls are bunched where the reference's are 20% apart. The shader is *configured* to
  §38's measured 1.000 : 0.641 : 0.491 and computes exactly that at a face centre, so the likeliest
  explanation is that the measurement is now confounded: a cluster has many internal step edges
  where one cube's wall abuts another's roof, our render has roughly twice the reference's detected
  edge count (83 vs 43), and `leftBrighterPct` has fallen to a coin-flip 48% against the
  reference's 67%. **This is unresolved**, and the next pass should restrict the sampler to convex
  outer corners before drawing any conclusion from it.
- **The cube-pitch autocorrelation is not trustworthy at this signal level.** Run identically on
  both images it reports 17.1 m for the reference and 8.4 m for ours, where ours is 24 m by
  construction; it is picking a sub-harmonic. The direct 5x measurement (~25 m) is the one relied
  on above.
- **Granularity, still** — the whole first half of this section. Our masses are 44 m where the
  reference's are ~105 m, and that gap is unchanged.
- **Trees.** Colour is lifted to §38's measured target, but size and count are left where their own
  measurement put them, and that measurement is in direct conflict with a reviewer's read at
  matched scale. `voxelTrees.ts` has now been tuned in three passes against three different
  measurements of the same quantity; the next pass should re-measure coverage once, carefully,
  before moving either knob again.

### Verification

- `npm test`: **208 passing, 0 failing.**
- **§F overlap probe `trueOverlaps: 0`, `hScroll: false`, 0 page errors** at 1280x800 and 390x844,
  light and dark.
- **2,059 footprints, 0 dropped**, one `InstancedMesh` draw call for the cubes plus one for the
  shadows; no per-frame allocation, geometry rebuilt on `idle` only.
- Bundle: the MapCard chunk goes 1,505.77 -> 1,510.06 kB raw and **395.69 -> 397.47 kB gzipped,
  +1.8 kB** — the cluster expansion and the three shader additions together.
- Evidence images in `screenshots/reference-match/final4/`:
  `STRUCT-190m-ref-before-c17-after.png` (four panels, all resampled to 620 px across 190 m of
  ground so cube sizes compare directly — the single most useful artefact of this whole effort),
  `ZOOM-ref-5x-a.png` and `ZOOM-ours-BEFORE-5x.png` / `ZOOM-ours-c24-5x.png` at 5x, and
  `final-{desktop,mobile}-{dark,light}.png`.

## §40 — The two open measurements, closed: one sampler was broken, one mask was throwing away our own lit faces

§39 left two things unresolved and said so. This section closes both, and the shape of both
answers is the same: **the instrument was wrong, not the render.** One of the two still ends in a
change, because once the instrument was fixed it found a real and large gap that every previous
reading had hidden.

Nothing about the projection, the cube-cluster structure, the derived height step, the markers,
the King & Spadina framing or the 230 m / 4 min walk moves here. The only shipped file is
`voxelTrees.ts`.

---

### 1. FACE SEPARATION — the shader was right; §38's sampler could not survive a cube cluster

§39 reported our walls at **0.663 : 0.682** against the reference's **0.504 : 0.422** and
suspected the measurement. It was right to. §38's `corners.py` — "a run of >=14 consecutive rows
at one column where the horizontal colour step exceeds 16; sample the left wall at x-6..x-2, the
right wall at x+3..x+7, the roof 4..11 px above" — rests on three assumptions, and the
cube-cluster renderer broke all three.

1. **It locks the edge to one column.** The reference is an orthographic illustration, so every
   vertical world line is exactly vertical on screen. Our camera is a perspective one whose
   vertical vanishing point sits ~2,370 px above the pane centre (FOV 16 gives a camera-to-centre
   distance of 0.5 * 740 / tan 8 deg = 2,632 px; pitch 48 puts the vanishing point at
   2,632 / tan 48 deg). An edge 480 px off-centre therefore leans ~0.2 px per row: a 19-row corner
   shatters into 5-row fragments, and every surviving sample is biased toward the middle column of
   the frame.
2. **It assumes every detected edge is a convex outer corner.** On one extruded prism per building
   that is true. A cluster is mostly INTERNAL edges — a cube's wall abutting a neighbour's ROOF, a
   seam between coplanar cubes at different heights, a silhouette against the street — where "left
   wall | right wall | roof above" samples a roof or the road as a wall. That is what put a face at
   0.98 of its own roof and dragged the pair together.
3. **It assumes the corner is one pixel wide.** Measured on the reference itself, its corners blend
   over 6-8 px, so the same corner is detected at several columns, none of them the true one, and a
   patch 3 px from the detected column is partly ON the blend.

**The discriminator** (scratchpad `sampler42.py`) is geometric and needs no depth, normals or plan
angle. At a convex outer corner both visible walls recede from the viewer, so the corner's top
endpoint is the LOWEST point of the roofline: the wall/roof boundary rises AWAY from the corner on
BOTH sides. At a concave corner it falls away on both sides; at a wall-meets-neighbour's-roof step
there is no wall/roof boundary on the roof side at all. So walk up the image from the middle of the
wall a short way either side of the corner, find the first strong horizontal boundary, and require
both strictly above the apex. The same walk enforces "nothing occluding either face" for free —
anything in front of the wall puts an edge below the roofline.

Two mechanical rejections come with it, both symmetric, both stated as loose bounds rather than as
targets: a "wall" within summed-RGB 26 of the image's own modal dark tone is the ROAD (that tone is
one sharp mode in both panels — 17.3% of our frame, 8.0% of the reference's); and a "wall" brighter
than **0.90** of its own roof is another ROOF, since a wall lit from above cannot be. Both images'
true corners sit at 0.43-0.70; the pairs this removes sat at 0.95-1.00.

**Validated against the reference first, as it had to be.** Across a 3x3 sweep of the two
thresholds that could plausibly bias the answer — minimum corner height 8 / 11 / 14 px, face
uniformity 7 / 10 / 14:

| | reference | ours |
|---|---|---|
| LEFT / TOP, range over the sweep | 0.610 – 0.642 | 0.668 – 0.686 |
| RIGHT / TOP, range over the sweep | 0.463 – 0.507 | 0.507 – 0.520 |
| median over the sweep | **1.000 : 0.611 : 0.491** | **1.000 : 0.674 : 0.507** |
| `leftBrighterPct` | 75 – 100% | 92 – 100% |

The reference recovers **§38's own published 1.000 : 0.641 : 0.491** — to within 0.03 on the lit
wall and exactly on the shaded one. That is the gate, and it passes.

**So the answer on our render is that nothing is wrong with it.** Our walls are 0.674 : 0.507 —
**0.167 apart, against the reference's 0.120.** They are not bunched; if anything they are slightly
more separated than the reference's. And `leftBrighterPct` goes from §39's coin-flip **48% to
100%**: with a lamp anchored to the viewport at 225 deg the screen-left wall is always the lit one,
so 100% is what a sampler that is actually finding corners must report, and 48% was the signature
of the contamination.

Hand-checked at 8x before any of it was believed, on the corner at (169, 179-202) of the
0.950 m/px render: TOP 59.4, LEFT 41.2, RIGHT 31.7, i.e. **0.694 : 0.533** against the shader's
configured 0.641 : 0.491 plus its own +/-5% across-face gradient (`uGrad` 0.10) — which is the
whole of the residual. `TONES` is unchanged.

**The AO question, answered.** §39's brief asked whether the crevice occlusion was stacking on top
of the wall shading and compressing the faces toward each other. Measured as each wall's tone
relative to its own middle band:

| | top third | middle | bottom third | ramp |
|---|---|---|---|---|
| reference | 1.027 | 1.000 | 0.935 | 0.092 |
| ours | 1.027 | 1.000 | 0.980 | **0.047** |

**Our vertical wall contouring is half the reference's.** The crevice fires only where `iNbr > 0`
and only over the 8 m above a shorter neighbour's roofline; the ground AO reaches
`min(9 m, 0.30 * height)`. Neither is a whole-face multiplier, and the measurement agrees. It
shapes the seams. Nothing changed.

### The related question — "make it lighter, like the reference" — measured, and it says no

Same two images, same 0.950 m/px, everything but the city masked out:

| surface class | reference | ours | |
|---|---|---|---|
| ground band (lum < 24) | 22.6% of frame at **19.5** | 23.0% at **20.6** | ours lighter |
| street / shaded-wall band (24-48) | **49.4%** at 34.3 | **38.5%** at 38.0 | ours lighter, 11 pts less of it |
| lit-wall band (48-70) | 17.0% at 58.2 | 24.5% at 58.9 | ours lighter, more of it |
| roof band (> 70) | 11.0% at 78.5 | 14.0% at 79.5 | ours lighter, more of it |
| whole frame, mean luminance | **39.9** | **44.9** | ours 1.13x |
| modal roof colour | `#484870` (74.9) | `#404880` (74.3) | matched to 1% |
| luminance p90 / p95 | 71.3 / 77.6 | 73.8 / 79.7 | ours lighter |
| five-class luminance ladder | 21.0 / 32.4 / 45.5 / 62.7 / 79.1 | 21.8 / 37.4 / 49.7 / 65.8 / 83.3 | ours lighter at every class |

**Every surface class already sits at or above the reference's absolute level, and the frame mean
is 13% above it.** A global lift would move away from the reference on every one of these numbers;
matching its band profile exactly would mean going *darker*, not lighter.

What differs is the **share**, not the level: the reference gives 49.4% of its frame to the 24-48
band and we give 38.5%, redistributed into more lit wall and more roof. That is §39 item 11 — the
granularity gap — arriving in the histogram. One big lavender mass reads as "light"; the same tones
cut into a fine mosaic of small roofs, walls and gaps read as "busy", and the eye calls busy dark.
The lever for that is block size, and §39 measured it to exhaustion and closed it.

Recorded so the next pass does not re-open it: **making the render lighter than it is would be a
preference and a deliberate departure from the reference, not a step toward it.** It is one
constant either way; what it is not is a match.

---

### 2. TREES — settled once, and the method written down

`voxelTrees.ts` had been tuned three times against three readings of the same quantity, which
cannot all be true. They disagreed because each measured something different:

- **§31** used a narrow green-hue filter that kept only the reference's LIT TOPS and discarded its
  dark olive SIDE faces.
- **§37** scanned horizontal runs of olive pixels and compared them **in CSS pixels across two panes
  of different scale** — the reference's covers 673 m of ground, ours 731 m — then compared an
  "olive share of the map region", which counts pixels, not canopies. It concluded "the right size,
  five times too many" and cut the count.
- **§38** used `(G > R+6) && (G > B+6)`. **Our lit cap is `#5c6248` = (92, 98, 72): G is exactly
  R+6, and the test is strict.** Every lit top face we draw was thrown away. It therefore compared
  our side faces against the reference's sides AND tops, read our coverage as a third of the
  reference's and our trees as darker — and **§39 lifted the palette 1.09x on that basis**, which
  pushed us further from the reference, not closer.

**THE METHOD** (scratchpad `trees40.py`), one code path over both images:

- **Scale.** Both panels resampled to **0.950 m/px** (§32's reference scale) with a box filter, so
  one pixel is the same patch of ground in both. Ground area is corrected for the oblique view: a
  W x H px pane covers `W*mpp` by `H*mpp / sin(e)` metres, e being camera elevation above the
  horizon — 42.5 deg for the reference (§38's gradient-orientation derivation), 42.0 deg for ours
  (pitch 48 from nadir). The two cameras agree to within half a degree.
- **Segmentation.** A canopy pixel is one whose green channel leads both others by a margin
  **relative to the pixel's own brightness**: `G - max(R,B) > 0.03 * (R+G+B)/3`. That threshold is
  calibrated, not guessed — every authored tree colour in either theme scores +0.062 to +0.173 (our
  dark wall `#3a4438` +0.165, our lit cap `#5c6248` +0.069, light `#8ba482` +0.173 / `#b2c69d`
  +0.118) and every non-tree surface scores **negative** (our teal top `#2f4b52` -0.103, our ground
  `#0e142b` -0.896, the reference's indigo `#21294b` -0.685, its lavender `#484a72` -0.462). 0.03
  sits in a gap two orders wide, and it is exactly what §38 got wrong.
- **Objects, not pixels.** A 3x3 closing so a cluster of cubes counts as ONE canopy, then connected
  components. Blobs over 1,600 px are greenspace polygons and are reported separately rather than
  folded into either statistic.
- **Size** is the **area-weighted median on-screen width** — the width of the canopy covering the
  median canopy pixel. Both images split into a full population plus a tail of slivers (a tree
  half-hidden behind a block), and a plain median is dominated by the slivers. Same statistic §39
  used for block spans.
- **Density** is canopies per km2 of ground, counting only canopies >= 10 px (9.5 m) wide, so the
  number cannot be moved by how many slivers the mask happens to catch.
- **Colour** is HSV over canopy pixels only, split into its two tone modes (shaded sides, lit tops)
  so a change of geometry — which changes how much of each face is visible — cannot be mistaken for
  a change of palette.
- **Checked by eye at 4x** on a contact sheet of every segmented canopy in both images before any
  number from it was used. That is what showed the actual gap.

**THE MEASUREMENT**, and it agrees with none of the three earlier readings:

| | reference | ours, before | ours, after |
|---|---|---|---|
| canopy width, area-weighted median | **31.0 px = 29.4 m** | 17.0 px = 16.1 m (**0.55x**) | **29.0 px = 27.5 m (0.94x)** |
| canopies >= 10 px, per km2 | 29.9 | 27.6 (0.92x) | 34.1 (1.14x) |
| canopy pixels, share of the pane | 1.51% | 0.94% | 1.98% |
| canopy mean RGB / luminance | 62 / 74 / 62, **70.2** | 78 / 85 / 67, **82.0** | 65 / 76 / 62, **72.4** |
| hue / saturation | 121.1 deg / 0.235 | 91.0 deg / 0.213 | 114.1 deg / 0.213 |
| shaded sides | `#323f38` lum 59.6 hue 142 | `#3b4235` lum 63.2 hue 101 | `#303a33` lum 55.6 hue 133 |
| lit tops | `#4b5644` lum 82.3 hue 98 | `#6e7459` lum **112.9** hue 75 | `#515d49` lum 88.8 hue 97 |

**The count was already right. The size was 0.55x. The colour was 1.17x too BRIGHT and 30 deg too
YELLOW** — the exact opposite of what §38 measured and §39 acted on.

**And the size gap is structural, not a constant** — the same answer §39 reached about the
buildings, one level down. The reference's canopy is a CLUSTER of four to six green cubes, each
about 15-18 px across. Ours was a single cube of 17 px. **Per cube we were already the right size;
we were drawing one of theirs.** Scaling the single box to 31 px would have produced a 29 m
monolith taller than a one-course building, which §31's own "never focal" rule forbids.

**THE ONE CHANGE SET**

- **`canopyCubes()`** — each tree centre now emits a centre cube at the old full size plus four
  satellites at 0.42 canopy offset and 0.92 canopy side, at 0.60-0.84 of the centre's height, dealt
  by the coordinate hash so a given verge always grows the same tree and no two neighbours match.
  Overall span 1.76 canopies against the single box's 1.00. The centre cube is exactly what the
  module drew before, so a cluster can never be shorter or narrower than the box it replaces.

  **The first version of that deal was dead, and only review caught it.** It read
  `hashCoord(lon, lat)` — the same hash `KEEP` already uses to decide whether a tree exists at
  all. Every centre that survives the gate therefore has a hash in `[0, KEEP]` = `[0, 0.20]`,
  `floor(h * 4)` is always 0, and every canopy in the city came out as the same stamp in the same
  corner order. Nothing in a screenshot says so at a glance. The deal now reads
  `hashCoord(lat, lon)` — the two coordinates go into different multiplies inside that function,
  so swapping them decorrelates it from the gate while staying exactly as deterministic — and
  `web/src/map/voxelTrees.test.ts` now asserts that a sample of >50 actually-planted centres
  produces more than one height profile. **The general lesson: a hash used as a survival gate must
  never also be used to shape the survivors.**
- **`DARK_TREES` retuned per face, in two passes** — because the cluster changes the mix (a single
  box shows 62% side / 38% lit top; a cluster of five shows 46% / 54%), so a correction fitted to
  the canopy MEAN would have been wrong the moment the geometry changed. Pass 1 scaled by the mean
  ratio and re-rendered; pass 2 read each face off that render and scaled again. `#3a4438` /
  `#5c6248` becomes **`#2c3b37` / `#3b4535`**, which **reverses §39's 1.09x lift** and then some.

Also checked, because a cluster can do things a single box cannot: at zoom 15.0, inside
`OPACITY_RAMP`'s 14.8-15.3 fade, the overlapping satellites blend to a soft green wash rather than
the mottled dark seams a stack of semi-transparent faces can produce. Captured and looked at; no
artefact, and the app only passes through that band while zooming.

**Deliberately not changed.** `CANOPY_PX` (right per cube — a third pass leaving it alone, now for
a measured reason), `SPACING_PX`, `KEEP`, `MAX_TREES`, and `LIGHT_TREES`. On density: at n ~= 20
canopies the Poisson standard error is +/-22%, so 0.92x before and 1.14x after are both
indistinguishable from 1.0, and moving `KEEP` again would be fitting noise. On the light theme: the
reference's only daylight panel is a 280x166 phone card whose trees are 4-6 px across, which cannot
support a size or colour measurement — so the geometry change applies to both themes and the
palette change only to the one that was measured.

**Still not matched, and recorded rather than fixed:** the reference's canopy sits on a visible
brown trunk (~4 px wide at 0.950 m/px) and ours has none. §31 item 6 called a trunk "sub-pixel at
every framing", which is not true at this framing. It is neither size, density nor colour, so it
stayed out of this change set.

---

### Verification (production build `npx vite build`, real Chrome, PGlite-backed API)

- `npm test`: **214 passing, 0 failing** — the 208 as before, plus six new guards in
  `web/src/map/voxelTrees.test.ts` (the first tests this module has ever had), one of which is the
  one that would have caught the dead hash deal above.
- All four combinations — 1280x800 and 390x844, dark and light: **`trueOverlaps` 0, `hScroll`
  false, map-marker collisions 0, marker spill 0, attribution visible, clipping audit 0 hits, 0
  console and page errors.**
- Camera unchanged and measured: **zoom 16.182, pitch 48, FOV 16** on desktop; 15.4 / 48 / 16 on
  mobile. **King St West at Spadina and "230 m / 4 min walk" present in all four.**
- Face ratios on the shipped build, same sampler: **1.000 : 0.668 : 0.507**, `topBrightest` 100%,
  `leftBrighterPct` 100%.
- Tree cubes in frame: **227 desktop, 46 mobile** (45 and 9 canopies).
- Frame timings, foregrounded, 4.5 s of `requestAnimationFrame` with `triggerRepaint`:
  **p50 4.2 / p95 5.8 / worst 23.2 ms**, and 4.1 / 5.0 / 17.4 on a second run (§39: 4.2 / 6.2 /
  18.1). Flat, which is what one GeoJSON source over 227 small quads costs.
- Six-band luminance deviation from the reference: **26.5**, against 26.1 measured on the
  pre-change build in the same session with the same instrument. (Worth recording, as §39 did for
  §38's figure: **§39's "21.1" is not reproducible here.** Two captures of the unchanged build give
  26.1 and 26.5. Band edges and masking are the same; the difference is that this pass measures a
  2x capture box-filtered down to 0.950 m/px rather than a 1x capture, which is the more faithful
  comparison to an antialiased illustration. The figure to compare against in future is this
  instrument's, not §39's.)
- Bundle: the MapCard chunk goes 1,510.06 -> **1,510.49 kB raw and 397.47 -> 397.65 kB gzipped,
  +0.19 kB** for the cluster.
- Evidence in `screenshots/reference-match/final5/` (written, not committed):
  `SCALE-MATCHED-620m-ref-before-after.png` and the 190 m version — three panels resampled to the
  same metres across so canopy and cube sizes compare directly; `tree_sheet_REF.png` /
  `tree_sheet_FINAL.png`, every segmented canopy at 4x; `corners_REFERENCE.png`, every accepted
  convex corner.

**Two operational notes, both of which cost time here.**

1. **A 429 scores a perfect zero on the overlap probe.** The first pass of the gate ran four full
   page loads inside one minute, tripped `@fastify/rate-limit` (`max: 120, timeWindow: '1 minute'`),
   and mobile/light came back with `trueOverlaps: 0`, `clip: 0` and a blank map — because the app
   had rendered an error state with almost nothing in it to overlap. The probe now asserts that the
   app rendered — stop name, walk text, all three voxel layers present, no 429 in the page — before
   any of its numbers are believed, and the re-run after the rate-limit window is what is reported
   above. Each of the four combinations was finally run in its own rate-limit window.
2. **`.data/pglite2` is corrupt too**, with the same `PANIC: could not locate a valid checkpoint
   record` that killed `.data/pglite`. PGlite ships no `pg_resetwal`, so it is not recoverable.
   **`.data/pglite3` was reseeded from the already-downloaded GTFS extract** (9,361 stops, 68,401
   trips, 2,151,105 stop_times) and is the good directory now. The lesson is the one §38 already
   wrote down and this pass re-learned the hard way: shut PGlite down cleanly, and never touch
   `postmaster.pid` under a live server.

## §41 — The metric was wrong, not the render: density is structural, and the banding was a depth-buffer tie

§40 closed on a defensible-sounding conclusion — every absolute tone matches or exceeds the
reference, so the render matches and a global lift would move *away* from it. The user, looking at
the two images side by side, said the buildings still looked nothing like theirs. **They were right,
and the reason §40 could not see it is that a luminance histogram is blind to structure.** Ours and
the reference can hold the same ground tone, the same lit-wall tone and the same roof tone while one
is a carpet of 796 small footprints with no visible street and the other is a handful of clean
masses with wide ones between them. §40 even measured the cause and did not name it: the reference
gives 49.4% of its frame to the mid band and ours 38.5% — that is density, written as a histogram.

So this section changes the instrument first and the code second. **Nothing about the projection,
the cube-cluster structure, the derived height step, `TONES`, `PALETTES`, the trees, the markers,
King & Spadina or the 230 m / 4 min walk moves here.** The shipped files are `voxelCity.ts` and
`voxelMesh.ts`.

---

### 1. A structural instrument, because the tonal one had nothing left to say

`structure.py` runs one code path over both images, at the reference's own 0.950 m/px, cropped to
the same 709 x 570 px so a count is a count of the same amount of Toronto. Pixels are classed by
absolute luminance — legitimate here *precisely because* §40 established that the absolute tones
already match — at the midpoints of the measured levels: ground < 30, shaded wall < 48, lit wall
< 68, roof above. Four statistics:

* **open ground** — the ground mask eroded by a 6 px (5.7 m) disk, so only ground wide enough to
  read as a *street* counts;
* **separated masses per hectare** — connected components of the building mask after severing every
  bridge narrower than ~6 m, which is narrower than any real street;
* **roof blobs per hectare** — connected components of the roof mask, i.e. distinct tops in frame;
* **edge density** — share of pixels on a strong Sobel edge. The single number for "reads busy":
  dozens of small buildings put an edge everywhere; a few large clean masses do not.

| | reference | **ours before** | **ours after** |
|---|---|---|---|
| ground share of frame | 37.8% | **28.3%** | **37.1%** |
| open, street-wide ground | 7.7% | **5.6%** | **8.0%** |
| separated masses / ha | 1.29 | **0.83** | **1.08** |
| median separated mass | 1366 m2 | 1274 m2 | 1032 m2 |
| p90 separated mass | 4162 m2 | **18,897 m2** | **11,203 m2** |
| roof blobs / ha | 3.30 | **4.34** | **3.20** |
| median roof blob | 163 m2 | 194 m2 | 245 m2 |
| edge density | 15.0% | **17.4%** | **17.0%** |

Read the p90 row first, because it is the user's complaint in one number: before, the largest single
connected mass in our frame was **18,897 m2** — dozens of separate buildings welded into one
continuous carpet because there was no visible ground between them — against the reference's
4,162 m2. The frame did not read as "many buildings"; it read as "one lump".

### 2. The height floor was never a size floor. A census says so.

`census.mjs` reads every building ring the source has loaded, computes the same PCA oriented box
`voxelMesh` does, and keeps the ones on screen. **796 rings in the 731 x 563 m default frame**,
median short span 12.9 m, median ring area 267 m2.

Against that population, `minHeightForZoom`'s 8 m floor — the lever three previous passes swept at
8 / 16 / 24 m — keeps 63% of the rings, 68% of their footprint area, and moves the median short span
only from 12.9 m to 16.0 m. **It drops low buildings of every size roughly uniformly.** That is why
sweeping it never changed how busy the frame reads, and why the earlier rejection of that sweep was
right for the wrong reason.

Footprint **area** is the proxy that works:

| floor | rings kept | footprint area kept | median short span |
|---|---|---|---|
| none | 796 (100%) | 100% | 12.9 m |
| 400 m2 | 380 (48%) | 90% | 24.8 m |
| 900 m2 | 218 (27%) | 74% | 31.1 m |
| 1600 m2 | 103 (13%) | 52% | 39.9 m |

Keep the massing, drop the noise. That is the definition of cartographic generalisation, and it is
the honest lever: **nothing is merged, dissolved, unioned or moved; no building is drawn that does
not exist; every surviving block is one real OSM ring at its real place, orientation and extent.**
Some real small buildings are omitted while the camera is far enough away that they would render as
specks — exactly as OSM Carto, Google and Apple all omit small footprints until you zoom in, and
exactly as `minHeightForZoom` already did.

**The floor is keyed to SCREEN pixels, not to zoom** (`minFootprintAreaM2(metresPerPixel)`,
860 px2 — a footprint under about 29 x 29 screen pixels). "Too small to read" is a statement about
the screen, not about the ground: the same shed is noise at 1.31 m/px on a phone and architecture at
0.33 m/px. A constant screen area is scale-invariant across every framing `frameCamera` can produce,
and it is continuous in the camera, so nothing ever pops in or out and the step-boundary bug §32
documents in `minHeightForZoom` has no way to recur. The first draft of this WAS a stepped ladder
with a hard cut to zero at the top, on the argument that below ~120 m2 the floor excludes nothing
real. The census refutes that — 48% of the rings here are under 400 m2 — so the cut was removed and
the floor now simply shrinks with the camera: 500 m2 at the desktop diorama, 92 m2 at z17.4, 40 m2
at z18.

**The value was swept structurally, on production builds, one browser window each:**

| diorama-tier floor | ground | open | masses/ha | roofs/ha | edge | sum of relative deviations |
|---|---|---|---|---|---|---|
| reference | 37.8% | 7.7% | 1.29 | 3.30 | 15.0% | — |
| 0 (banding fixes only) | 34.1% | 6.6% | 1.10 | 3.68 | 18.3% | 0.75 |
| **500 m2** | **37.0%** | **8.0%** | **1.07** | **3.16** | **17.0%** | **0.41** |
| 600 m2 | 38.4% | 8.4% | 1.07 | 2.85 | 16.7% | 0.53 |
| 700 m2 | 39.3% | 8.8% | 1.30 | 2.75 | 16.5% | 0.46 |
| 900 m2 | 42.9% | 10.7% | 1.30 | 2.32 | 15.9% | 0.89 |
| 1200 m2 | 48.7% | 14.2% | 1.30 | 1.71 | 14.8% | — |
| 2500 m2 | 64.1% | 24.1% | 0.98 | 0.44 | 12.4% | — |

500 m2 at the desktop diorama's 0.763 m/px — hence 860 px2. Past 900 the city stops being busy and
starts being *depopulated*, which is a new wrongness rather than a smaller one: at 2500 m2 only 7%
of the rings survive and two thirds of the frame is road.

### 3. A floor tuned downtown needs a cap, and the cap was measured, not assumed

An absolute size floor is calibrated where it was measured. The obvious way for it to go wrong is a
finer-grained neighbourhood, where the same floor takes everything — §32 hit the mirror image of that
failure once already. So the floor is capped by RANK as well as by size: drop the smallest
footprints until the screen-size floor is satisfied **or** `MAX_OMIT_FRACTION` (0.65) of the loaded
neighbourhood has gone, whichever comes first. 0.65 is measured, not chosen: on the population this
code actually sees — the 2,059 loaded rings that survive `minHeightForZoom` at the default framing —
the settled 499 m2 floor omits **58.6%** of them, so the cap sits just above downtown and cannot
disturb it. Selection by rank is the older of the two
generalisation operators — Töpfer's radical law is exactly this — and like the size floor it only
ever omits.

Measured on three real Toronto framings at the diorama zoom, as built coverage of the pane, with the
size floor off / on-uncapped / on-capped:

| | floor off | uncapped | **capped (shipped)** |
|---|---|---|---|
| King & Spadina (downtown) | 66.4% | 63.5% | **63.5%** |
| Roncesvalles (low-rise) | 35.4% | 27.8% | **31.6%** |
| Greenwood & Danforth (low-rise) | 25.5% | 24.9% | **25.2%** |

Downtown the cap never binds, so nothing about the framing the whole of this section was measured on
changes. At Roncesvalles it halves the loss.

**And the Greenwood row corrected an assumption of mine before it became a change.** That frame
looks nearly empty with the new floor — but it looks nearly as empty with the floor switched off
entirely (25.5%), because most of those houses carry a `render_height` under `minHeightForZoom`'s
8 m and never reach this code at all. The sparseness there is pre-existing and belongs to the HEIGHT
floor. I had begun writing the cap as a fix for a regression that, measured, was not one; it stays
because the Roncesvalles row shows it doing real work, not because of the row that prompted it.

### 4. The horizontal banding was two roofs at exactly the same height

**It is not the old five sub-tiers of roof height.** That workaround belonged to the
`fill-extrusion` renderer and died with it; `quantizeHeightM` is one `ceil(raw/17)*17` lattice, and
`voxelMesh` emits one box per cell rather than stacking a box per course, so there are no coplanar
course faces to fight either. The line in `voxelMesh.ts`'s header that mentions sub-tiers is a
historical note on why fill-extrusion was abandoned, not a description of live behaviour.

**The evidence.** Dumping the pixels under one band (rows 665-679, columns 1360-1400 of the
1920 x 1480 card) shows rows alternating incoherently between `#474b8d` (luminance 74, a roof) and
`#2d345f` (luminance 51, a *different building's* roof). Two surfaces trading pixels is a
depth-buffer tie, not a texture.

**The cause.** The PCA box *circumscribes* the ring, so it over-covers every footprint that is not a
rectangle — measured on those 796 rings, the ring fills its own box to a median of 0.888, a mean of
0.806 and a p10 of 0.498. Boxes that over-cover into each other overlap: **2,252 overlapping ring
pairs in view, and 1,360 of them carry the same quantised roof height**, because the shared lattice
has only four values in this frame (17 / 34 / 51 / 68 m). Two exactly coplanar roof quads, no answer
from the depth test, one comb per pair.

**Two fixes, in that order.**

1. **The area-true box.** Scale the box about its own centre until it covers the same ground the ring
   does: `k = sqrt(ringArea / boxArea)`, clamped never to enlarge and never to shrink past 0.55.
   This is a fidelity fix that happens to remove most of the overlaps — a block now stands on as much
   ground as its building does. `INSET_M` is consequently now the GAP and only the gap; the half of
   its old justification that was "counterweight to the circumscribed box" has been transferred to
   this and the comment says so.
2. **A coplanar tie-break.** Some OSM buildings genuinely overlap (a tower over its own podium, a
   building and its parts, a block digitised twice across two overscaled z14 tiles). A deterministic
   per-footprint offset of at most 22 cm, keyed off the same id as the tint, gives the depth test a
   definite answer, so the pair reads as one roof lying on another. At 0.38 m/px that is well under
   one pixel of height; it moves no measured tone and no silhouette.

**Measured** by `zfight.py`, which looks for *horizontal* banding specifically: a pixel differing
from the row above and the row below by more than 12, in the same direction, inside a horizontal run
of at least 7 px. The run-length condition is what separates a stripe from a thin laneway building
seen edge-on — which is what the first draft of the detector was actually counting, and it reported
"the fix did nothing" until that was corrected. Worth recording, because it is the same failure as
§40's: **the instrument was wrong twice in this pass before the render was.**

| | banded pixels | patches >= 40 px | patches >= 150 px |
|---|---|---|---|
| reference | 43 (0.012%) | 2 | 0 |
| ours before | **1,235 (0.048%)** | **43** | **11** |
| area-true + tie-break, no floor | 301 (0.012%) | 16 | 3 |
| **ours after (shipped)** | **245 (0.010%)** | **12** | **2** |

The two fixes alone take it to the reference's own share of the frame; the generalisation floor then
takes it below. `FACES-4x-banding-before-after.png` is the same 105 m of ground at 4x, before and
after, beside the reference.

### 5. What the luminance metric did — and it is not what was expected

The brief said a worse luminance number would be an acceptable trade for structure. **It did not
happen; the tonal metric improved sharply**, and the reason is the same lesson as everything above.
Same instrument as §40 (`surfaces.py`), same masking, both captures resampled to 0.950 m/px:

| | reference | ours before | ours after |
|---|---|---|---|
| six-band deviation | — | **26.4** | **9.7** |
| frame mean luminance | 39.9 | 45.1 (1.13x) | **40.6 (1.02x)** |
| modal ground tone's share of frame | 35.5% | 23.7% | **31.4%** |
| corner-sampled TOP / LIT / SHADE | 70.5 / 42.4 / 35.2 | 58.0 / 39.5 / 30.2 | **71.1 / 45.0 / 33.9** |

Our frame was never *tinted* too bright — it was too **built**. Wall-to-wall massing put mid-tone
building surface where the reference has road, and the frame mean followed it up. Fix the structure
and the histogram follows for free. `TONES` is untouched.

### 6. Three hash bugs, one fixed and two deliberately left

A review of the new code found that `coplanarEps`'s final `h ^= h >>> 13` re-enters signed int32
space, and JS `%` keeps the dividend's sign — so the offset ran `(-0.22, 0.22]` rather than
`[0, 0.22)`: twice the intended spread, with half the roofs sitting *below* the lattice
`quantizeHeightM` is supposed to guarantee. Fixed, and the numbers above are all post-fix.

**The identical missing `>>> 0` is present in `cellRand` and `pickTint`, and neither is fixed here.**
Their consequences are real and measurable:

* `cellRand` goes negative about half the time, so the cell height drop fires at roughly **71%**, not
  the documented `CELL_DROP_CHANCE` of 42%;
* `pickTint` returns index 0 for every negative hash, so the palette shares are roughly
  **67 / 15 / 13 / 3 / 1 / 1** against the documented 34 / 30 / 26 / 6 / 2 / 2.

Both predate this pass. Fixing either re-deals every block's colour and height across the whole
city, which would invalidate the render every measurement in §38-§41 was taken against — so they are
recorded here rather than changed in the same pass that measured this one. The same caveat applies
to `tintKey`, which mixes in a counter over the whole `querySourceFeatures` result rather than a
per-feature ring index, so the deal is not in fact stable across a change in the loaded tile set.
**That is the next piece of work in this file, and it should be done on its own with its own
before/after.**

### 7. Verification

Production build, real Chrome, **each of the four combinations in its own rate-limit window**, and
every probe gated on the app having actually rendered before its numbers are believed:

```
desktop/dark : zoom 16.182 pitch 48 fov 16 | layers 3/3 | stop true walk "230m 4min"
               | overlaps 0 | markerCollisions 0 spill 0 | clip 0 | errors 0
desktop/light: same
mobile/dark  : zoom 15.4 | same
mobile/light : same
```

`npm test` **214 / 214**. `tsc --noEmit` clean. Bundle: the MapCard chunk goes 1,510.49 ->
**1,511.21 kB raw**, 397.66 -> **397.99 kB gzipped, +0.33 kB**.

Evidence in `screenshots/reference-match/final6/`:
`SCALE-MATCHED-190m-ref-before-after.png` and the 620 m version (reference, before and after, each
resampled to the same metres across, so a cube in one is the same size on screen as a cube in the
other); `FACES-4x-banding-before-after.png`; and the production cards.

**Operational note, and it cost an hour.** `.data/pglite3` was corrupted mid-pass by a hard kill of
the backgrounded server — the same `PANIC: could not locate a valid checkpoint record` that took
`pglite` and `pglite2`, and clearing the stale `postmaster.pid` does not recover it. It was reseeded
from the already-downloaded GTFS extract in 46 s (9,361 stops, 68,401 trips, 2,151,105 stop_times)
and is good again. Two things follow: **never background the server in a way that can be killed**,
and note that PowerShell's `$env:DATABASE_URL = ''` DELETES the variable rather than emptying it, so
the server falls through to the quota-blocked Neon instance. The variable has to be present and
empty, which needs a spawn with an explicit env.

### 8. What is still unreachable, stated plainly

**The reference's masses are city blocks; ours are buildings, and no honest lever closes that.** At
0.950 m/px — confirmed independently here, King St W to Wellington St W measures ~162 px against a
real ~160 m — the reference's masses are 100-140 m across, one per block, each a cluster of four to
six 25 m cubes. Real OSM data at King & Spadina has a median footprint short span of **12.9 m**.
Drawing block-sized masses from it would mean unioning neighbouring footprints into buildings that
do not exist, which is the one thing this project will not do. Zooming in instead does not help:
to make our footprints read at 110 px the frame would have to cover ~170 m of ground where the
reference covers 673, which destroys both the composition and the 230 m walk path.

So the reference's *density, openness and calm* are now matched to within a few percent on every
structural statistic, and its *granularity* is not — because its granularity is not what the data
says is there. That residual is the honest floor of this approach, and it is where this line of work
should stop.

---

## §42 — The inset was swept and it is already right; the welding was the road network, not the buildings

**This section reports a negative result on the change it was sent to make, and a positive one on
why.** The brief was to raise `INSET_M` until our separated masses stopped welding: our p90
separated mass measured 11,203 m2 against the reference's 4,162, so our masses were 2.7x too LARGE,
and an inset — which draws strictly less than the real footprint and can never claim ground a
building does not occupy — was the honest lever for pulling them apart. The sweep was run. The
inset does move that number, exactly as predicted. **It should still not be raised, because the
reason our masses measured too large is that `structure.py` was counting our road network as
buildings, and once that is corrected every honest statistic says our city is too SPARSE and its
gaps too WIDE — so every metre of inset makes the real gap worse while making the measured one
better.**

`INSET_M` therefore ships unchanged at 1.2 m. The only code changes in this section are comments,
and the MapCard chunk is byte-identical at **1,511.21 kB raw / 397.99 kB gzipped**.

### 1. The sweep, run as asked

Eight values, each with its own production build and its own browser window in its own rate-limit
window, `cap41.mjs` refusing to write pixels unless the app really rendered, all measured through
§41's one-code-path harness at the reference's own 0.950 m/px over the same 709 x 570 px crop.
"masses/ha" and "p90" are the SEVERED statistics (`sevPerHa`, `sevP90M2`) — the ones §41 quoted.

| INSET_M | ground | open | masses/ha | **p90 mass** | p90 unsevered | roofs/ha | edge | banded px |
|---|---|---|---|---|---|---|---|---|
| reference | 37.8% | 7.7% | 1.29 | **4,162** | 6,074 | 3.30 | 15.0% | 0.012% |
| 0.5 | 35.3% | 7.6% | 0.92 | 12,820 | 65,857 | 3.39 | 17.0% | **0.039%** |
| 0.9 | — | — | — | — | — | — | — | 0.004% |
| **1.2 (shipped)** | **37.0%** | **8.0%** | **1.05** | **11,324** | **51,096** | **3.20** | **16.9%** | **0.009%** |
| 1.6 | — | — | — | — | — | — | — | 0.006% |
| 2.0 | 39.4% | 8.7% | 1.11 | 9,650 | 17,753 | 3.26 | 16.9% | 0.004% |
| 3.0 | 41.8% | 9.2% | **1.32** | 7,184 | 17,424 | 3.08 | 17.1% | 0.004% |
| 4.0 | 44.3% | 9.8% | 1.36 | 5,582 | 16,661 | 2.91 | 17.1% | — |
| 6.0 | 49.5% | 11.8% | 1.58 | **2,740** | 17,646 | 2.55 | 17.1% | — |

Read on its own terms the sweep looks like a win: at 3 m the masses-per-hectare lands on the
reference's 1.29 almost exactly, and p90 separated mass falls from 2.7x the reference to 1.7x. The
unsevered p90 collapses from 51,096 to 17,753 between 1.2 and 2.0 m and then **stops moving** — a
plateau at ~17,000 m2 that no further inset touches. That plateau is what sent this section
looking, because a lever that keeps costing and stops paying is a lever aimed at the wrong thing.

**The generalisation floor was swept against the inset too**, since both knobs only ever draw less
and they push ground share in opposite directions: at 3 m inset, dropping §41's 500 m2 floor to
300 m2 buys back 1.0 point of ground share and 0.19 roofs/ha, but p90 mass gets *worse*
(7,184 -> 8,044) because the restored small buildings bridge the big masses. The floor stayed at
500 m2 on that evidence — and then §3 below overturned the evidence.

### 2. The instrument was counting the roads as buildings

`structure.py` classifies by absolute luminance, ground below 30 and building above, which §40
justified because the measured tones already matched. Rendering the classification back over both
images is what exposed it. `DIAGNOSTIC-ground-classification.png` is the whole finding in one
sheet: **in the reference the sub-30 region IS the street grid, a clean connected lattice; in ours
the streets are above the boundary and the sub-30 region is the leftover scatter between them.**

Captured with the three voxel layers hidden — same app, same camera, `capbase.mjs`:

* **24.7% of the frame is above the "ground" threshold from the BASEMAP ALONE**, and 17% of it is
  unoccluded road surface.
* Our road surface measures luminance **39.8 (p50) to 46.8**; our ground fill measures 20.4.
* The reference's street surface measures **p10 15.5, p50 20.0, p90 25.2** — level with its own
  ground, not 20 levels above it. Confirmed independently of any mask by raw vertical cuts across
  the reference sheet, which run 13-29 across every street and 60-95 across every roof.

The road network is a connected graph across the whole frame. Painting it above the
building/ground boundary therefore welds every block to every other block, which is why our
largest component measured so large and why 21.5% of its pixels are basemap rather than city. The
belief that produced it is written down at the head of `mapStyle.ts`'s DARK palette — "its streets
are a lavender-slate around luminance 35-45" — and it is simply wrong. That comment now says so,
in place, with the numbers.

### 3. What §38-§41 actually measured, restated honestly

Re-running the identical probe with the road surface stencilled down to our own ground tone — a
simulation, and it only ever moves pixels that the basemap-only capture proves nothing was drawn
over — gives the corrected picture. Two independent methods agree, one of them using **no
luminance threshold on our side at all** (a pixel counts as city if it differs from the
basemap-only capture):

| | ours (1.2 m) | reference |
|---|---|---|
| built coverage | **43.5%** (threshold-free: 45.9%) | **58.6%** (62.2%) |
| ground share | 55.5% | 37.8% |
| open street-wide ground | 31.6% | 7.7% |
| ground-corridor width, p50 | **17.0 m** | **6.0 m** |
| ground-corridor width, p90 | 67.4 m | 16.2 m |
| edge density | 11.9% | 15.0% |

**§41's headline — "ground share 37.1% vs the reference's 37.8%" — was two errors cancelling**:
roads ~17 points too bright, buildings ~15 points too few. The corridor row is the finding in one
number: the typical gap between built things is 6 m in the reference and 17 m in ours, and our p90
corridor is four times the reference's. Our city is not welded. It is thin.

That also reverses §41's own floor sweep. Re-measured through the corrected instrument, on §41's
own captures at no extra cost:

| floor | built | ground | open | roofs/ha | edge |
|---|---|---|---|---|---|
| reference | 58.6% | 37.8% | 7.7% | 3.30 | 15.0% |
| 0 | **47.2%** | 51.7% | 27.7% | 3.74 | 13.8% |
| 500 (shipped) | 43.5% | 55.5% | 31.6% | 3.32 | 11.9% |
| 900 | 36.1% | 63.1% | 39.6% | 2.38 | 9.6% |
| 2500 | 11.1% | 88.6% | 69.1% | 0.32 | 2.9% |

The floor is monotonically harmful on every statistic except the ones that improve merely because
the city is being deleted. §41 chose 500 m2 because the contaminated instrument reported floor 0 as
*under* the reference's ground share (34.1%) when the true value is far *over* it (51.7%), so the
sweep was pushed toward deleting buildings when it should have been pushed the other way. And note
what the floor-0 row settles: **even drawing every loaded ring, we reach 47.2% built against
58.6%.** §41's §8 conclusion survives, restated correctly — the deficit is in the data, not in the
floor.

### 4. Why 1.2 m is right, pinned from both sides

* **Below ~0.9 m the banding comes back.** At 0.5 m the boxes close back up on each other and
  `zfight.py` reports **0.039%** of the frame banded against the reference's 0.012% and this
  build's 0.009% — worse than §41's pre-fix render. The inset is part of §41's coplanar-roof fix,
  not decoration. 0.9 and 1.6 were built specifically to find that cliff and both come back clean.
* **Above ~1.6 m every honest statistic degrades monotonically**, at roughly 3 points of built
  coverage per metre, on a render already 15 points short.
* **Between 0.9 and 1.6 nothing is resolvable.** The same unchanged configuration measured twice,
  40 minutes apart, gives ground 55.5 / 55.5, open 31.6 / 31.6, edge 11.9 / 11.9 — but masses/ha
  1.35 / 1.32, median mass 714 / 810 m2, roofs/ha 3.32 / 3.17. **The run-to-run spread on the mass
  statistics is about 13%**, which is larger than the difference between 0.9 and 1.2 on any of
  them. That repeatability figure is new here and no earlier section had it; a difference of one or
  two percent in §38-§41's mass numbers should not have been read as a difference at all.

So 1.2 sits mid-interval with a measured cliff below it and a measured slope above it, and it does
not move.

### 5. What is deliberately NOT fixed here, and why

The road tone is the largest known defect in this render and it is left in place, for the reason
§41 gave for leaving the `cellRand` and `pickTint` hash bugs: **the fix invalidates the
measurements of the pass that found it.** Specifically:

1. Darkening 17% of the frame by ~17 levels drops frame mean luminance from 40.6 to ~37.6 against
   the reference's 39.9 — so it **regresses §40's verified tonal match**, which this section was
   told not to do.
2. `mapStyle.ts` already records a failed attempt at exactly this change: pass 1 dropped the roads
   toward the ground tone and "the grid vanished — the render came back as one continuous mass of
   rooftops with no sense of place." The reference gets away with dark streets because its blocks
   cover 58.6% of the frame and read as bright masses against them. At our 43.5% the same change
   would expose the sparseness rather than fix it. **The pale roads are currently, accidentally,
   compensating for the missing density.**

Roads and density have to move together, in one pass, with their own before/after and their own
tonal re-verification. That is the next piece of work in this file, and it now has an instrument
that will not lie to it. The correction is written into `mapStyle.ts` at both the palette and the
casing layer so it cannot be missed.

### 7. What code review caught, and it was not cosmetic

Five findings, three of them real defects this pass introduced:

1. **An unterminated CSS comment silently deleted `.opt-when`.** A `*/` closed a comment
   and the prose kept going, so the parser read the remaining paragraph plus `.opt-when`
   as one selector prelude and dropped the whole rule — taking the flex/baseline layout
   and the 92px reserved width with it. **The §F probe passed all twelve combinations
   with the rule missing**, because an unreserved column is not an overlap. Worth
   recording: the probe is a floor, not a proof, and a layout law can be broken without
   it firing.
2. **`voxelVehicles.setTheme` updated two uniforms of eight.** It set `uLit`/`uShade`
   only, so a dark->light swap left a bus wearing the other theme's crevice, ground AO
   and face gradient — and would now have left it wearing the night seam depth. This is
   the same failure the note above `CUBE_VERT` warns about for the shader source, one
   level up, so the fix is the same shape: `applyCubeTheme(mat, theme)` is exported from
   `voxelMesh.ts` and both call sites use it. Neither can drift again.
3. **The roof gradient dotted a CUBE-frame offset against a WORLD-frame light axis.**
   Every block is yawed by its own footprint's PCA orientation, so each roof's bright
   side pointed in an arbitrary direction. Pre-existing and invisible at the old 0.10
   amplitude; not invisible at 0.24. `vLocalW` now carries the offset rotated into world
   XY.
4. **The roof gradient is now one-sided — darken only.** Two-sided, it brightened the
   near half PAST the authored tone, which the dark theme merely wasted and the light
   theme clipped: its roofs are authored near white (`#f6f4f1` is 0.965), so any lift
   saturates them to flat 1.0 and manufactures the exact uniform region this pass exists
   to break up.
5. `MAX_TICKS` 6 -> 5. `count(step) = N` puts the span in `[(N-1)*step, (N+1)*step)`, so
   the worst-case label gap at N is `track/(N+1)` — 45px at six ticks on the 314px track,
   which an fr-CA `13 h 45` can touch. Five leaves ~52px.

**And a note on the backtick.** Twice in this pass a backtick inside a GLSL template
literal silently terminated it, and both times the error surfaced as `TS1005` on a line
two hundred lines away. There is now a one-line guard in the scratchpad that greps each
shader body for one; it belongs in this file's history rather than in the build, because
the compiler does catch it — it just does not say what it is.

### 6. Verification

Production build, real Chrome, each of the four combinations in its own rate-limit window, every
probe gated on the app having rendered:

```
desktop/dark : zoom 16.182 pitch 48 fov 16 | layers 3/3 treeCubes 227 | stop true walk "230m 4min"
               | overlaps 0 | markerCollisions 0 spill 0 | clip 0 | errors 0
               | built-coverage diorama 63.0% -> z17.8 66.1% | frames p50 4.2 p95 5.3 (n=1042)
desktop/light: same       mobile/dark: zoom 15.4 | same       mobile/light: same
```

`npm test` **214 / 214**. `tsc --noEmit` clean. Bundle unchanged at 1,511.21 kB raw /
**397.99 kB gzipped** — the diff is comments only, and every changed line in it begins with `//` or
`*`.

Evidence in `screenshots/reference-match/final7/`:
`SCALE-MATCHED-190m-inset-sweep.png` and the 620 m version (reference beside 1.2 / 3 / 6 m, each
resampled so a cube is the same size on screen in every tile — the wide one shows 3 m and 6 m
hollowing the city into scattered pebbles); `FACES-5x-inset-sweep.png`; and
`DIAGNOSTIC-ground-classification.png`, which is the section in one picture.

### 7. The honest answer to the question that was asked

**No. p90 separated mass did not reach the reference's 4,162 m2 and masses/ha did not stably reach
1.29.** At 3 m of inset the numbers say 7,184 and 1.32; at 6 m they say 2,740 and 1.58, overshooting
from the other side. Neither was shipped, because the corrected instrument shows both were bought
by shrinking buildings in a frame that is already 15 points short of the reference's coverage and
whose gaps are already three times too wide. The measured gap this section was sent to widen is
2.85 m in the reference and 5.70 m in ours — ours are already the wider of the two.

The residual §41 called granularity is real, and this section narrows what it is: not that our
masses are too big and welded, but that **our masses are too small, too few and too far apart** —
and that a fifth of what looked like our massing was the road grid. The lever that closes it is
density plus road tone, together, and it is not an inset.

---

## §43 — The seed's window is the board's own span, and `GHOSTBUS_SEED_WINDOW_DAYS` is gone

**This supersedes §3.** §3 described the seed window as granted latitude: load only the services
active in the next `GHOSTBUS_SEED_WINDOW_DAYS` (default 7) days, keep this week exact, keep the
load fast. That trade was real but it was priced wrong, and BLOCKERS.md entry 9 is the invoice.

### The defect, confirmed in code before it was fixed

`calendar` and `calendar_dates` were loaded **whole**; `trips`, `stop_times` and `shapes` were
filtered to the services active in a rolling window measured from the **seed date**. Two
different windows over one dataset, and nothing anywhere required them to agree. So the calendar
could — and did — declare a service active on a date whose trips had never been loaded.

Seeded 2026-07-24 against a board that starts 2026-07-26, the window covered
20260724..20260730, whose only Saturday predates the board. Service `2` (Saturdays, 32,874
trips) had no active day inside it and was dropped whole; service `4` (the 2026-08-03 civic
holiday, 31,295 trips) exists only via a `calendar_dates` row outside the window and was
dropped too — and because that same date carries `1,20260803,2`, the weekday board is switched
*off* on the holiday. Seven of the board's 42 days held no schedule at all, and before the
`boardIntegrity` gate (§34) they rendered exactly like days on which nothing went wrong.

### The fix: one window, and the feed defines it

```
filter = activeServiceIds(calendar, calendar_dates, boardDays(calendar, calendar_dates))
```

`boardDays` (exported from `seed_toronto.ts`, unit-tested in `seed_toronto.test.ts`) enumerates
`min(start_date)..max(end_date)` across the loaded `calendar`, widened by any `calendar_dates`
exception date outside that span, each day sampled at **Toronto local noon** so a DST
transition can never shift one onto its neighbour. It is pure and takes no clock reading: the
window depends on the feed alone. The calendar the runtime resolves against and the trips the
seeder loads are now the same window **by construction**, which is the property that was
missing, not merely a wider number.

`GHOSTBUS_SEED_WINDOW_DAYS` is **removed rather than re-defaulted**, deliberately. Any value of
it narrower than the board reintroduces exactly this defect, and a knob whose only effect is to
reproduce a shipped bug is not a feature. Two flags remain, both diagnostic:

- `GHOSTBUS_SEED_FULL=1` — no filter at all. On this feed that adds 1,112 trips for services
  `6702`/`6703`/`6704`, which carry no weekday flags and no `calendar_dates` rows and are
  therefore never active in the **feed**. It is the control that proves the filter drops
  nothing a calendar day can ask for.
- `GHOSTBUS_SEED_SKIP_DOWNLOAD=1` — reuse the extract already in `.data/gtfs/extracted` instead
  of re-downloading from CKAN. This exists for the swap procedure below: a re-seed meant to
  repair a running deployment must load the **same** board that deployment has been observing,
  and re-downloading silently permits a different one.

The seeder also now checks itself: after loading `trips` it compares the calendar-active
services against the services that actually got rows, and prints either
`integrity: all 9 calendar-active service_id(s) have trips loaded` or a warning naming the empty
services and the days they would blank. That is the seed-time twin of the `boardIntegrity` gate,
which stays — the gate still covers what this fix cannot, a feed that publishes a calendar
service with no trips of its own.

### Proof: replay every board day, against both boards, side by side

Both seeded from the same `.data/gtfs/extracted`, PGlite, download excluded; the control is the
old seeder restored from `HEAD` and run at its default 7-day window on the same machine.

| | trips | stop_times | shapes | blank days | seed time |
|---|---:|---:|---:|---|---:|
| windowed (old default) | 68,401 | 2,151,105 | 1,374 | **7** | 40.2 s |
| board span (new) | **132,570** | **4,175,275** | **1,472** | **0** | 67.2 s |
| published `trips.txt` | 133,682 | — | — | — | — |

Replaying `activeServiceIds` day by day over 20260726..20260905, the trips each day resolves to:

| day | before | after / published |
|---|---:|---:|
| six Saturdays (08-01, -08, -15, -22, -29, 09-05) | **0** | **32,874** each |
| 2026-08-03 (civic holiday, service 4) | **0** | **31,295** |
| the other 35 days | 29,870–38,517 | unchanged, matches the feed exactly |

All 42 days now equal the published feed; seven of them did not before.

### What completeness costs, measured rather than estimated

| | windowed | complete | delta |
|---|---:|---:|---|
| PGlite seed, download excluded | 40.2 s | 67.2 s | **+27.0 s (+67%)** |
| `stop_times` rows | 2,151,105 | 4,175,275 | +2,024,170 (+94%) |
| `stop_times` heap / indexes | 139.1 / 201.7 MiB | 270.0 / 372.8 MiB | ~1.9x |
| all relations | 357.5 MiB | **669.7 MiB** | **+312.2 MiB** |
| PGlite directory on disk | 845 MiB | 1.5 GiB | — |

+27 seconds on a load that runs once, against seven days of the board that were silently
missing. That is not a trade-off; it is a bug that had been priced as one.

### Swapping the live database (wave 2), without losing what has been observed

`.data/pglite3` is open by the running :8799 server and is accumulating real `trip_delay_obs`.
PGlite is single-writer — a second process opening that directory corrupts it, and §41 records
an hour lost to exactly that. So the swap is a stop, a load, and a start, in that order.

**The seed's entire write surface is: `TRUNCATE` + `INSERT` on `routes`, `stops`, `trips`,
`stop_times`, `shapes`, `calendar`, `calendar_dates`, and one `UPDATE cities SET min_lat…`.**
It issues no other statement against any other table, there are no foreign keys anywhere in the
schema (so no `TRUNCATE` can cascade), and `trip_delay_obs`, `agg_delay`, `agg_delay_route`,
`ghosts`, `service_alerts`, `rt_stop_anchor`, `rt_stop_xwalk`, `rt_stop_xwalk_votes`,
`rt_pattern`, `rt_trip_binding`, `sched_slot_claim` and `pattern_index_cache` are never named in
the file. Verified empirically as well as by reading: marker rows were written to
`trip_delay_obs`, `ghosts` and `agg_delay`, the same directory was re-seeded in place, and all
three survived intact (`delay_s` 321 still 321) while the static tables reloaded to identical
counts. The re-seed is idempotent.

```
1.  Stop the :8799 server CLEANLY (Ctrl-C / SIGTERM, never a hard kill — a killed PGlite
    leaves "PANIC: could not locate a valid checkpoint record", which clearing
    postmaster.pid does not recover; that is how pglite, pglite2 and pglite3 were each
    lost once).
2.  Confirm nothing holds the directory: no node process, and .data/pglite3/postmaster.pid
    gone. Copy .data/pglite3 aside first if the observations matter more than the disk.
3.  Re-seed IN PLACE, reusing the same extract the server has been running against:
      DATABASE_URL= PGLITE_DIR=<abs path>/.data/pglite3 GHOSTBUS_SEED_SKIP_DOWNLOAD=1 \
        node --import tsx server/src/seed_toronto.ts
    (In PowerShell, $env:DATABASE_URL = '' DELETES the variable and the seeder falls
     through to Neon — see §41. Spawn with an explicit empty-string env instead.)
4.  Read the seeder's own last lines before restarting: board span must be
    20260726..20260905 (42 days), trips 132,570, stop_times 4,175,275, and
    "integrity: all 9 calendar-active service_id(s) have trips loaded".
5.  Restart the server. The pattern index cache does NOT need clearing: its key is a
    content fingerprint over calendar/calendar_dates/trips/stop_times/stops, so a
    re-seeded board cannot match a stale entry, and writeFileCache prunes the old
    .gbpx. Budget for one rebuild at the new size — roughly double the 2.15M-row
    rebuild, since it is linear in stop_times.
```

A fresh directory (`PGLITE_DIR=.data/pglite4`) instead of an in-place re-seed is the safer shape
**only** if the observations are copied across first; a new directory starts with an empty
`trip_delay_obs`, which throws away the only thing in that database we cannot re-download.

### What the Neon re-seed will need when the quota returns

The transfer quota is currently exhausted (§35, §36) and Neon refuses even `SELECT 1`. When it
returns, three things are true and only the first is comfortable:

1. **Time.** The windowed board took **622.7 s** over Neon against 40.2 s on PGlite. The
   complete board is 1.94x the rows, so budget **~20 minutes**, with the pool at `max: 4` and
   1000-row multi-row INSERTs unchanged. Run it once, with `GHOSTBUS_SEED_SKIP_DOWNLOAD=1` so
   the board Neon receives is provably the board verified here.
2. **Storage, and this is the hard one.** The complete board is **669.7 MiB** of relations
   against 357.5 MiB windowed. That does not fit in a 0.5 GiB free-tier project. Confirm the
   plan's current storage allowance before starting, because the honest options if it is still
   0.5 GiB are all uncomfortable: pay for a tier, or drop `idx_stop_times_stop_dep` and rebuild
   it after (indexes are 372.8 MiB of the 642.9 MiB `stop_times` total), or run production on a
   deliberately truncated board **with the `boardIntegrity` gate visibly firing on the missing
   days**. Narrowing the seed window quietly is the one option that is not available: that is
   the defect this section fixed.
3. **Transfer.** A pattern-index rebuild reads the whole board — 143.70 MiB at 2.15M rows
   (§36), so **~279 MiB** at 4.18M. The §36 index cache means a boot no longer pays it, but the
   first build after the re-seed does, and so does every 6-hourly refresh that finds a new
   fingerprint. Seeding plus one rebuild is on the order of half a gigabyte of transfer; plan
   the re-seed for the start of a quota window, not the end of one.

### Documentation that still describes the removed flag

Not edited here because this workstream owns only `seed_toronto.ts`, its tests, and this file:
`.env.example:49-52`, `README.md:341-343`, `DEVPOST.md:841-847`, and §3 above all still present
`GHOSTBUS_SEED_WINDOW_DAYS` as live. Setting it now does nothing at all. Those four places
should be corrected by whoever owns them; this section is the authority in the meantime.

## §44 — Demo Mode is wired: two clocks, one namespace, and the bug that made it report itself dead

`server/src/demo.ts` and `server/src/record_demo.ts` shipped in an earlier wave with tests
and an honesty contract, and with a header admitting they wired into nothing. This entry is
the wiring, and the three decisions it forced.

### The wiring is one line, on purpose

```ts
const source = demoRequested() ? await bootDemoSource() : undefined;
const poller = createPoller(db, { source });
```

`PollerSource` carries four things — the bytes, the clock, the poll cadence and the agency
namespace — and nothing else in `poller.ts` branches on the mode. That is the spec's
"identical pipeline" made structural rather than promised: there is exactly one place where
a demo process differs from a live one, and it is the fetch layer.

### 1. The bug: the obvious wiring makes the app report itself dead

`demo.ts`'s own header suggested:

```ts
// inside fetchFeed(key), before any network call:
if (isDemoActive()) return activeDemoSource()!.fetchFeed(key);
```

That returns before `markOk(st, now)`. `markOk` is the only writer of `lastOkMs` and
`lastPollAtMs`, so with it skipped, `refreshStaleness` walks all three feeds to `down`
(`lastOkMs == null`), and `/api/health` — whose `ok` is *some feed is ok* — answers
`ok:false, lastPollAtMs:null` while the process is serving a complete recorded snapshot of
1,157 buses. The app declares itself dead at the exact moment it is proving it is not.

The fix is placement, not logic: the recorded branch sits **inside** `fetchFeed`, after the
backoff check, and falls through the same `markOk`. Health bookkeeping is about our own
poll loop — did a snapshot arrive just now — and on a recording one genuinely did.
`mode:'demo'` in the same payload is what stops that from reading as "live". Verified: the
real `/api/health` now answers `ok:true` with all three feeds `ok` under replay.

One deliberate asymmetry: a recorded **failure** frame replays once and the recording moves
on, with no exponential backoff. Backoff is a politeness protocol with a live server; the
frames are already laid out in time, and a 5-minute wall backoff at 8x would skip ~53
recorded minutes — turning a faithfully reproduced 45-second hiccup into a hole the
original never had.

### 2. Two clocks, because a recording is bytes *and* the moment they were taken

The poller now reads a WALL clock (backoff, feed staleness, `lastPollAtMs` — "is our loop
alive") and a DATA clock (`dataNow()`: service date, the ghost due window, the engine's
`nowMs`, retention — "what moment does this snapshot describe"). Live they are the same
function. On a recording `dataNow()` is the capture instant of the frame being replayed.

This is not cosmetic. `computeDue` selects static trips whose scheduled start is 6–30
minutes ago. Judged against the wall clock, every trip in a recording taken an hour earlier
is outside that window, the entire calendar-active board reads as due-but-absent, and the
mass-ghost breaker fires on 100% of it. Demo Mode's failure mode is not a blank screen, it
is **a confident claim that the whole network has been cancelled** — the single worst thing
this codebase could output. Proven the other way in `poller_demo.test.ts`: a trip seeded 10
minutes before the capture instant is found due (`due=1`) on the data clock; on the wall
clock, now hours past the capture, it cannot be.

`DemoFrame.slotMs` was added for the same coherence reason. A frame's `offsetMs` is when
its response *finished arriving*, so it carries 0.3–1.5 s of the recorder's own fetch
latency. Selecting frames by it puts every frame just past the cadence tick a replaying
poller lands on, shifting the replay a frame late and serving frame 0 twice per loop. The
recorder polls on a grid it re-anchors every cycle, so `seq * cadenceMs` is the frame's
intended position and network luck is not. `capturedAtMs` still carries the true instant —
it is the provenance, it is just not the clock.

### 3. Isolation: a separate agency namespace, not a separate database

The spec's anti-blend rule is absolute, so it had to be enforced by something other than
discipline. Three options were live:

- **A separate database.** Structurally perfect and operationally useless: the demo needs
  the seeded static board (2.15M `stop_times`), so a second database means a second 46 s
  seed and a second Neon instance in the deploy — precisely the moving parts that will not
  exist on the day the live feed is down.
- **An in-memory overlay.** Reads must fall through to the shared board while writes and
  their read-backs do not, which is a small database. Rejected on cost.
- **A separate agency namespace.** Chosen. Every observation table is keyed `(agency, …)`
  and every read is already agency-filtered, so tagging demo rows `ttc-demo` makes the rule
  a property of the primary keys. Neither mode can see the other's rows even by accident.

The static board is read under `ttc` in both modes, and that is not a leak: a schedule is
not an observation, there is one published board, and a recording is a recording *of* it.
The pattern-index cache is likewise shared — it is a pure function of the static board,
contains nothing realtime-derived, and is keyed by board fingerprint.

`createDelayEngine(db, agency, writeAgency = agency)` gained one defaulted parameter to
express the same split: two static call sites keep `agency`, thirteen runtime ones move to
`writeAgency`. The live path is byte-identical by construction.

Two consequences fell out:

- **`retention()` had no agency filter at all** — `DELETE FROM trip_delay_obs WHERE ts < $1`.
  Harmless while one namespace existed; a demo process would have pruned live observations
  on its first cycle. Now scoped, and pinned by a test that seeds a 7-month-old live row.
- **Aggregation is skipped in demo mode.** `runAggregation` rebuilds `agg_delay` for the
  live agency; a recorded-replay process must not rewrite live aggregates, and a ten-minute
  recording could not honestly fill a fourteen-day window anyway. Demo arrivals therefore
  fall back to schedule-only ETAs with `bucket:'none'` — the truthful answer to "what does
  history say" when there is no history, and not something wave 2 should paper over.

### What was deliberately NOT built: a runtime toggle

The spec offers Demo Mode when the live feed is unreachable or the URL says `?demo=1`.
Mode is nonetheless decided once, at boot (`--demo` / `GHOSTBUS_DEMO=1`), and `demo.ts`'s
latch keeps it irreversible. A running poller holds in-memory state — positions, live
predictions, engine bindings — that a mid-flight switch would leave as a blend of live and
recorded, under one badge, in one session. Serving `?demo=1` from a single process means
two poller instances and a per-request selection in `api.ts`; that is a real design, it is
not this one, and pretending otherwise in a footnote would be worse than saying so here.

---

## §46 — The blocked 43% was reachable, but not by the road that was proposed

Written 2026-07-26, on the live Sunday board. §35 measured that the two-independent-patterns
promotion rule alone blocks 43.2% of realtime stop occurrences, refused to relax it on a
held-out experiment that could not tell "propagation is wrong" from "geometry picked the
other side of the street", and filed the experiment so the next attempt would start from it.
This is that attempt. It starts from the evidence, and the first thing it did was destroy its
own premise.

### The premise: an active binding is an independent witness. It is not.

The proposal was that a live binding corroborates a stop identity — a vehicle locked onto a
specific static trip, its realtime stop sequence resolved through the crosswalk, surviving the
monotonicity audit and the board-agreement gates, is service reality confirming the mapping.

That is checkable, so it was checked before it was built. For every active binding, for every
tracked realtime stop at sequence *n*, the bound trip's static pattern names a stop at *n*;
compare it to what the crosswalk says. Over 23 live cycles:

| | |
|---|---:|
| realtime stops touched by at least one active binding | 4,228 |
| binding "confirmations" pooled | 81,729 |
| of those, from a pattern the stop did not ALREADY have in its agreeing set | **55 (0.07%)** |
| confirmations of mappings blocked by the promotion rule | 37,319 |
| **disagreements among those** | **0** |

Zero disagreements out of 37,319, and 0.07% novelty, because the comparison is circular by
construction. A binding's static pattern *is* the pattern that resolved the realtime pattern,
and `staticStops[seq - 1]` is the very entry that implied the mapping. Asking the binding
whether it agrees asks one inference twice. It cannot answer no.

This project has shipped a test that could not fail twice before — the monotonicity audit
comparing a sorted list against itself (§33), and the cross-route audit computed over four
stops (BLOCKERS 17). **A promotion rule built on this premise would have been the third, and
the first one to reach published delay numbers.**

### What survived the premise

A surviving binding does establish something, and it is independent — just not about stop
identity. The pattern was matched to a scheduled slot at its origin, beat its runner-up by
120 s, and kept agreeing with the schedule for cycles afterwards. That is evidence in the
**time domain about the pattern assignment** — the single failure that makes every identity a
pattern implies wrong together, which is the failure the two-pattern rule exists to catch.
Different road, same destination.

So the question became measurable: does time-domain validation of the implying pattern predict
that its one-pattern identities are right?

### The experiment, with the flaw §35 was refused over removed

Same design: withhold a fifth of the geometric anchors, remove those stops from the propagation
seed as well, let propagation predict them from what remains, score against the measurement
withheld. One change: **the withheld truth is restricted to unambiguous nearest-stop matches**
(runner-up at least 60 m further), which is exactly the population where "geometry picked the
other side of the street" cannot happen.

| held-out prediction group (truth gap >= 60 m) | n | agree |
|---|---:|---:|
| 2+ patterns — the current rule | 249 | **100.00%** |
| 1 pattern — currently blocked | 242 | **100.00%** |

Zero errors in either arm. **A test that cannot fail proves nothing**, so the same harness was
run with the ambiguous truths put back in — and it fails, exactly where §35 said it would:

| held-out prediction group (truth gap >= 0 m, the control) | n | agree |
|---|---:|---:|
| 2+ patterns — the current rule | 501 | 88.42% |
| 2+ patterns, no binding validation | 132 | 71.21% |
| 1 pattern — currently blocked | 687 | 94.03% |
| 1 pattern, no binding validation | 363 | 89.81% |
| **1 pattern + binding-validated (>= 2 cycles)** | **301** | **98.67%** |
| 1 pattern + binding-validated + structurally safe | 250 | 98.40% |

Three things follow, and the harness has now demonstrated it can report all of them.

1. §35's finding **reproduces** at six times the sample: one-pattern identities score *higher*
   than two-or-more (94.03% against 88.42%; §35 had 88.57% against 80.70%). The two-pattern
   rule buys no accuracy.
2. §35's *hypothesis about why* is **confirmed**. Restricting the truth to unambiguous geometry
   removes **100%** of the disagreements in **both** arms. The disagreements were the
   experiment's own truth being wrong, not propagation.
3. Binding validation is a strong predictor where errors exist: one-pattern accuracy goes from
   89.81% unvalidated to 98.67% validated, which also clears the current promoted set's 88.42%.

### The safety condition, and the claim that did not survive contact with the board

The obvious guard against the adjacent-platform failure is to require direction consistency,
since `direction_id` names the two sides of a street. That claim was checked against the board
before anything was built on it:

| same-route stop pairs within 80 m | 4,262 |
|---|---:|
| no direction in common — separable | 3,375 (**79.19%**) |
| **share a direction — `direction_id` cannot separate them** | **887 (20.81%)** |

**A direction check would have read as a safeguard while passing one adjacent pair in five.**
What it was trying to approximate is taken directly instead: `structurallyAmbiguousStops` asks
whether another stop on this route sits within 80 m *and is served in the same direction*. If
one does, nothing available to this engine can tell the two apart and the new path refuses.
1,484 of 9,361 stops (15.85%) are ruled out this way. It does real work in the control arm:
one-pattern accuracy is 95.78% on structurally safe stops against 85.59% on ambiguous ones.

### What shipped

`MIN_XWALK_OCCURRENCE_COVERAGE` is **unchanged at 0.50**, and no gate was touched. A third
promotion path was added beside the two that existed:

> one pattern implies the mapping, **and** that pattern has been validated by at least 2
> distinct origin-locked bindings across at least 2 distinct cycles, **and** the stop it names
> is not structurally ambiguous.

The thresholds are read off the measurement rather than chosen: validating bindings N=0 gives
89.81% (n=363), N=1 gives 100.00% (n=25), N=2-3 gives 97.48% (n=159), N=4-7 gives 100.00%
(n=140); validating cycles M=0 gives 89.81%, M=1 and M=2 both give 100.00% (n=23 each). One of
each measured at 100% too, but on 23-25 samples, and one long-dwelling vehicle can produce one
binding in one cycle — two of each cannot come from one trip. Both floors are set at 2.

**"Survived" is load-bearing.** A binding is credited only after it has cleared the per-trip
consistency gate and the per-pattern drift breaker in a cycle, and the credit is taken back
when either later voids it — the whole pattern's credit when the consistency gate fires, since
that gate firing means the pattern assignment itself is in doubt. Crediting at lock time would
have counted the bindings the audits went on to reject.

**A restored row may not outlive its evidence.** `distinct_patterns` and `geo_resid_m` are
persisted, so the first two paths can be re-checked at warm start. Binding validation cannot —
bindings belong to a service day, not to a board — so a row confirmed that way comes back as a
`candidate` and re-earns confirmation within a couple of cycles. Without this, a restart would
republish a promotion whose evidence no longer existed anywhere in the process. It is a no-op
for every row written before this section, because nothing else could have confirmed them.

### The instrument, kept

§35 could not be repeated because it was run from a throwaway script against state that no
longer existed. `GHOSTBUS_XWALK_PROBE_DIR` now makes the engine dump its crosswalk, patterns,
anchors and bindings once per cycle — off unless set, never set in production. The analyser
that produced every table above reads those dumps. The next person to re-examine this rule
starts from the evidence rather than from rebuilding the instrument.

### The result

Three runs, all against the live TTC feeds at the production 45 s cadence, none of them
touching the running :8799 server.

**The controlled pair (cold crosswalk, byte-identical starting board, one code path apart).**
Coverage by cycles elapsed after the crosswalk clears its confidence floor:

| +1 | +3 | +6 | +9 | +12 | +16 |
|---:|---:|---:|---:|---:|---:|
| control 39.93% | 41.17% | 43.52% | 44.35% | **45.26%** | — |
| third path 42.23% | 56.49% | 62.07% | 63.87% | **65.69%** | **66.75%** |

The control never reaches the gate: 23 cycles, peak 45.26%, `SUPPRESSED
(xwalkOccurrenceCoverage)` on every one — the plateau this section set out to explain.

**The contemporaneous control is better than any of ours, because it is the product.** The
running production server — old code, warm crosswalk, same board, same feed — sat at
**49.4–49.7% and `SUPPRESSED` at cycle 131**, an hour and a half in. That is the plateau in
its natural habitat, and it is the number the third path has to beat honestly.

**The confirmation run, on the final code, warm.** After code review found three defects in the
credit lifecycle (below), the whole thing was re-measured rather than argued about, because
every fix makes validation *harder* to earn and none of the earlier numbers would have
transferred:

| cycle | 1 | 3 | 6 | 9 | 12 | 15 | 18 |
|---|---:|---:|---:|---:|---:|---:|---:|
| coverage | 47.3% | 58.9% | 61.6% | 64.1% | 65.8% | 66.7% | **68.5%** |

Above the gate on every cycle, against the live server's 49.4% at the same wall clock.

**The gate cleared, and the engine published.** 3,105 `trip_delay_obs` rows over 457 distinct
static trips, 149 routes and 1,972 stops:

| | |
|---|---:|
| delay p10 / p25 / p50 / p75 / p90 | −203 s / −93 s / **0 s** / +75 s / +175 s |
| min / max | −1,409 s / +673 s |
| exactly zero | 58 rows (1.9%) |
| late (> 60 s) / on time / early (< −60 s) | 898 / 1,193 / 1,014 |
| ground-truth rows (`source='observed'`, a VehiclePosition reporting STOPPED_AT) | 137 |
| bindings bound / voided / refused | 886 / 30 / 161 |

That is a plausible Sunday distribution and, more usefully, it is **not** either of the two
shapes that would mean the engine is lying. It is not the all-zero census of §29 — 58 of 3,105
rows are exactly zero, and the mass is spread across ±3 minutes — and it is not absurd. On the
earlier run the bias check §29 built the `observed` column for got its first answer: ground-truth
rows read p10 −161 s / p50 −7 s / p90 +180 s against predicted rows at −161 / −3 / +164. **The
predicted rows are not measurably biased against the ones we watched happen.**

**Ghosts: a genuine 0, with a reason.** 646 due trips and zero ghosts, because the poller's
`GLOBAL MASS-GHOST BREAKER` fired: 470 of 646 due static trips had no binding, far past its 30%
ceiling, so it suppressed all of them as "feed outage or our bug, not reality". That is the
breaker working. The join rate is 36.0% and rising, and ghost detection stays honestly silent
until far more of the board is bound. **This change moved the delay engine past its gate; it did
not move ghost detection past its own, and nothing here pretends otherwise.**

**What the safety condition costs, stated rather than buried.** 2.60% of occurrences sit in
`candidate, one pattern, binding-validated, structurally AMBIGUOUS` — stops the third path could
have taken and refused. That is coverage deliberately left on the table, and it is the right
trade: those are precisely the platforms nothing here can tell apart.

### Three defects the first draft of this shipped, and what they teach

Code review of the credit bookkeeping found three, all of the same species — evidence outliving
its retraction — and all invisible to a passing coverage number:

1. **Cycles were counted per pattern, not per binding.** A binding voided by the drift breaker
   left its cycles behind, so two bindings credited in a single later cycle could clear the
   two-cycle floor on the strength of a binding the audits had already thrown out.
2. **Whole-pattern retraction was order-dependent.** When the consistency gate caught a pattern,
   deleting its credit was not enough: a sibling binding on the same pattern, reached later in
   the same settle pass, put it straight back. Patterns are now *distrusted* permanently.
3. **A path-3 confirmation was never demoted in-process.** The promotion loop only rewrites
   entries the current cycle re-proposed, and a stop stops being proposed the moment its RT
   pattern is quarantined — so an entry could keep backing delay rows on evidence that no longer
   existed. `demoteUnvalidated()` sweeps for exactly that; paths 1 and 2 rest on evidence that
   only accumulates and are never swept.

The bookkeeping moved into `xwalk.ts` as `createPatternCreditStore`, per this engine's own rule
that everything algorithmic lives in the pure modules. Each of the three failures is now a named
regression test: defects 1 and 2 in `xwalk.test.ts` against the credit store directly (*"a voided
binding takes its CYCLES with it, not just its count"*, *"a distrusted pattern can never be
credited again, in any order"*), and defect 3 in `engine.test.ts` (*"a validation-confirmed entry
is demoted IN-PROCESS when its evidence is withdrawn"*), which drives the real engine through six
cycles: two bindings lock onto pattern PA and confirm a one-pattern stop, the per-trip consistency
gate then quarantines the pattern, and the sweep must take the confirmation away.

**A spec-fidelity reviewer caught that claim before it was true.** This paragraph originally
asserted three named tests when only two existed — defect 3, the in-process sweep, had none, and
its two nearest neighbours in `engine.test.ts` cover the cold-boot restore guard, a different
path. Writing it required the fixture's first binding-capable board (three slots on one pattern,
so `medianHeadwayForSlots` has a headway to return and `originLock` stops refusing), which is
also the first engine-level test of the binding half at all. It was then checked the only way a
regression test can honestly be checked: with `demoteUnvalidated()` commented out it fails on
exactly the closing assertion, and passes with it restored.

**The point is not that three bugs were found. It is that all three would have quietly promoted
stop identities on withdrawn evidence, and none of them would have shown up as anything except
coverage going up** — which is the outcome this work was trying to produce. The fourth, in this
paragraph, was a claim about test coverage that was easier to write than to earn.

### What this measurement does not cover

- **The holdout population is stops geometry can see clearly.** A propagated-only stop has no
  geometric anchor by definition, so it can never be scored this way. Generalising from one to
  the other is an assumption, and it is the same assumption §35 made.
- **One board, one Sunday, 18-23 cycles per run.** Not a soak, and not a weekday.
- **The controlled cold-start pair was run on the pre-review code.** The three lifecycle
  defects were found afterwards, and every fix makes validation strictly harder to earn, so the
  final code was re-measured on its own run (47.3% to 68.5%) against the production server's
  contemporaneous 49.4%. What was not re-run is the *control arm* on the final code; the claim
  that the third path is what moves coverage rests on the cold-start pair.
- **Zero errors in the strict arm bounds the error rate, it does not measure it.** 242 of 242
  puts the 95% upper bound near 1.5%, not at 0.

## §45 — The rider was told the TTC was down. It was us. Attribution is now a typed contract

A rider reported, verbatim:

> "when I allow it to use my location yesterday it kept saying cant reach the live ttc feed
> right now"

Two defects hide in that sentence, and only one of them is the throttling.

**The first is that we ran out of our own rate-limit budget.** **The second, and the worse
one, is that when we did, the app blamed the Toronto Transit Commission for it.** For a
project whose entire argument is that it does not tell riders things that are not true, an
outage notice naming the wrong party is a first-class defect — a false statement about a
third party, printed in our own UI, at the exact moment the rider is deciding whether to
trust us. This section is both fixes, and the contract that stops the second one recurring.

### 1. The throttling: 120 req/min was never measured against anything

`api.ts` registered `rateLimit({ max: 120, timeWindow: '1 minute' })`. That number came from
spec-era caution. Nobody had ever compared it to what this app's own client costs.

Measured, on the shipped client, per open tab:

| source | endpoint | req/min |
|---|---|---|
| MapCard vehicle poll (5 s) | `/api/vehicles` | 12 |
| health (20 s) | `/api/health` | 3 |
| arrivals (30 s) | `/api/stops/:id/arrivals` | 2 |
| alerts (60 s) | `/api/alerts` | 1 |
| ghosts (60 s) | `/api/ghosts/feed` | 1 |
| **steady state, one visible tab** | | **~19** |

A cold load adds another 10–15 one-shot requests: nearby, the route shape, stats, the
next-service probe walk, a search burst. So **120/min is about six tabs of idle polling**,
and far fewer in practice — every reload, every granted location fix (which refetches
nearby + arrivals + shape at the new coordinates), every ⌘K peek spends from the same
bucket. Everything on one machine shares one `127.0.0.1` bucket, so the rider's own tabs,
a second window they forgot about, and — on the day of the report — automated verification
suites hammering the same port all drew from one budget of 120. The rider's requests got
the 429s.

**The ceiling is now 600/min**, chosen from the table above: ~31 tabs of steady-state
polling, or a handful of tabs with real headroom for reloads, location grants, search
bursts and an agent sharing the machine. It is still a genuine ceiling — this is a
read-only JSON API over a local Postgres — and the two endpoints that are *not* cheap keep
their own tighter budgets, so raising the global ceiling cannot be turned into a way to
make the database work hard:

* `/api/plan` — **60/min**. It runs the windowed board self-join, the heaviest query here.
* `/api/stops` — **120/min**. A leading-wildcard `ILIKE` over the whole stops table, and
  the search sheet is the one place a human generates requests as fast as they type.

Both are far above what the client can generate: the search sheet debounces to ~1 request
per typing burst, the planner issues at most two per destination. A rider cannot reach
them; a script pointed at them will.

**Measured after the change**: the §F probe now runs eight full browser contexts
back-to-back with no rate-limit drain between them. The previous harness needed a
68-second sleep between every context to survive, and that sleep is gone.

### 2. The lie: a boolean cannot name a culprit

The client had exactly one failure channel:

```ts
if (!res.ok) throw new Error(msg);          // web/src/lib/api.ts
...
.catch(() => set({ healthError: true }))    // web/src/hooks/useLive.ts
```

`healthError` was true whenever the health *fetch* failed — our 429, our 5xx, our restart,
a dead socket, all of it. And the copy chosen for that boolean was:

```
empty.apiDownTitle:     "Can't reach the live feed"
empty.apiDownBody:      "GhostBus can't reach the TTC data right now. Check your
                         connection and try again."
status.feedDownGeneric: "TTC feed unreachable — showing scheduled times."
```

So our own rate limiter printed an accusation against the transit agency, and told the
rider to check a connection that was fine. **A boolean has no room to say whose fault it
was, so the copy guessed — and it guessed in the most damaging possible direction.**

**The fix is that attribution is now typed end to end, on the wire and in the client.**
Every error body from `api.ts` carries a `kind` (`shared/types.ts::ApiErrorKind`):

| kind | meaning | may it mention the TTC? |
|---|---|---|
| `rateLimited` | our limiter refused us (429), with `retryAfterSec` | **no** |
| `badRequest` | we asked for something invalid (4xx) | **no** |
| `serverError` | our server failed (5xx) | **no** |

and the client turns every outcome into an `ApiFailure` with one of five kinds —
`throttled`, `serverDown`, `unreachable`, `badRequest`, `aborted`. **No member of either
union means "the TTC feed is down."** That claim has exactly one honest source in the whole
system, `HealthResponse.feeds`, and it is a different field with a different meaning.

### 3. The three states, and the copy each one is allowed to use

Derived in one place (`attributionOf`, `hooks/useLive.ts`) so no component can invent a
fourth. Order matters: demo first, then ours, and only then theirs.

**(a) OURS — throttled, restarting, or unreachable.** Blue, not red: the app is already
recovering and the colour should not overstate it.

> **GhostBus is catching up**
> Our own server is busy or restarting, so there is nothing fresh to show yet. GhostBus is
> retrying on its own — this is us, not the TTC.

and, specifically when we throttled ourselves:

> GhostBus asked its own server for too much at once and is waiting its turn. It will
> resume by itself in a moment — the TTC feed is fine.

Pill: **Catching up** · *GhostBus is catching up — retrying automatically*.

**(b) THEIRS — our server answered, and its own `health.feeds` reports the outage.** This
is the only state in the app permitted to name the agency, and it is driven by health data
rather than by a fetch outcome: `TTC feed unreachable — showing scheduled times.`

**(c) A RECORDING — `health.mode === 'demo'`.** Amber DEMO badge plus provenance:
`Replaying a recorded slice of real TTC data. Nothing here is live.` Stated first, because
a recording's feeds are honestly `ok` and the badge is the only thing that stops that from
reading as live.

All three exist in en / fr-CA / es, and the `Dict` type makes `tsc` prove it.

### 4. Dedupe and backoff, because the throttling was partly self-inflicted

The network log showed health, alerts and ghosts each fetched twice within milliseconds —
different components asking independently — and **nothing backed off at all**, so a
throttled or restarting server was hammered at exactly the same rate as a healthy one.

* **Identical in-flight GETs now share one request.** Only requests with *no* `AbortSignal`:
  a caller that passed one wants individual cancellation (the search sheet aborts
  superseded queries precisely so they stop costing budget), and handing it a promise
  somebody else can cancel would break that.
* **Four `setInterval`s became one heartbeat** with four due-times, which is what makes a
  *shared* backoff possible. Backing off per-task would leave three tasks hammering a
  server that just said stop.
* **Exponential backoff with jitter**: 2 s doubling to 60 s, jittered into [0.5, 1.0) so
  several tabs that failed together do not retry in lockstep. A 429's own `retryAfterSec`
  overrides the curve — the server knows when its window reopens. One success clears
  everything; regaining focus or network clears it immediately.
* An `aborted` request never counts as a failure, or the search sheet's own cancellations
  would throttle the whole app.

### 5. Proven as a rider, not as a probe

Real Chrome, real production build, real server (PGlite + real seeded TTC GTFS), real
geolocation. `screenshots/working/`:

| shot | what it proves |
|---|---|
| `01-load-located` | cold load at a granted fix, board + walk path |
| `02-search-open` | ⌘K opens the real sheet, real `/api/stops` results |
| `03-stop-selected` | choosing a stop across town navigates — **and draws no walk line** |
| `04-plan-ride` | a real single-ride plan, first leg drawn |
| `05-plan-transfer` | honest transfer message, **`walkNodes = 0`** |
| `06-before-storm` | pill: Live |
| `07-throttled-honest` | **throttled after 567 requests**; screen says *"GhostBus is catching up — retrying automatically"*, never the TTC |
| `08-recovered-by-itself` | no reload, no interaction — backoff expired, pill back to Live |
| `09a-before-server-stops` | healthy, immediately before a clean SIGTERM |
| `09-server-down` | server genuinely gone; same honest copy; agency never blamed |
| `10-recovered-after-restart` | **same page, never reloaded** — it found the server again |
| `11-out-of-coverage` | Mississauga: *"No TTC stops within 800 m of you"* + the nearest at 6.8 km |
| `12-default-after-fallback` | explicit fallback, correctly relabelled *"Using a default location"* |

The 429 body observed on the wire:

```json
{"statusCode":429,"kind":"rateLimited",
 "error":"Too many requests to the GhostBus API from this address.",
 "retryAfterSec":47,"limit":600}
```

### 6. A location outside coverage is no longer swallowed

Separately reported and fixed here: spoofed to Mississauga (MiWay territory), a rider who
granted location saw the "using a default location" banner *disappear* — so they believed
their position had taken effect — while the app quietly kept showing King St W at Spadina
as though it were their stop. `/api/stops/nearby` returned an empty list and the client
dropped it on the floor.

**Silently substituting a location the rider did not choose is the same dishonesty class as
blaming the agency for our own throttling: the UI asserting something that is not true.**

`/api/stops/nearby` now answers an empty radius with `nearest` — the closest stop at *any*
distance, with `distanceM` measured by the same haversine as every other distance in the
response — and `searchedRadiusM`. The extra query runs **only** on the empty path, the case
where we did no work anyway, and is ordered by squared planar degrees (cosine-corrected so
the sort is isotropic) then re-measured properly, so the number printed is never the
approximation sorted by. The client states the fact, names the nearest stop, and offers one
explicit button back to downtown — which relabels the view as a default location, because
that is what it is. Nothing moves the rider's location without them pressing something.

### 7. The queued Demo-API items, landed in the same pass

> **PARTLY SUPERSEDED (2026-07-26) — see §48.** The FIRST bullet below overshot: a schedule
> is not an observation, so `api.ts` now binds `staticAgency` (`'ttc'` always, for the
> published board) separately from `modeAgency` (the poller's, for observations). Binding
> every query to the poller's agency made Demo Mode return zero static rows. The other
> three bullets below stand unchanged.

* **`AGENCY` now comes from `poller.getMode().agency`, not the literal `'ttc'`.** Verified
  bug: a demo instance sharing a database with live TTC rows would have read the *live*
  rows and served them under the amber DEMO badge — the badge attached to data it does not
  describe, which is the same lie as a recording labelled live. One read at boot is correct
  for the process's whole life, because `mode` is immutable after boot (§44).
* **`serverNowMs` and the board/plan/alerts "now" use `poller.now()`** — the DATA clock, so
  a replayed board is judged against the moment its bytes were captured. The `Date.now()`
  calls that filter `trip_delay_obs.ts` and `ghosts.detected_at` are **deliberately
  untouched and now say so at each site**: those columns are stamped by the database's own
  `DEFAULT now()`, so mixing clocks there would compare a wall-clock column against a
  capture-window instant and silently return nothing.
* **`HealthResponse` gained `mode` and `demo`** (`DemoProvenance`, restated in `shared/`
  because the wire contract must not import from `server/`). Without them a recording and a
  live feed are indistinguishable on the wire and the DEMO badge has nothing to key off.
* **`api.test.ts`'s `fakePoller` lost its `as unknown as PollerHandle` cast.** That cast
  asserted nothing, and it is precisely how `now()` and `getMode()` came to be missing from
  the double while `api.ts` was being changed to depend on them. It is a plain
  `PollerHandle` annotation now, so the compiler proves the double is complete — and it
  earned its keep immediately by failing the build on a `getJoinStats` shape mismatch. The
  one remaining cast is scoped to that single return value (a ~20-field diagnostic blob of
  which api.ts reads one field) rather than to the whole object.

### 8. A failed plan draws no route-like geometry

Gate question from the orchestrator, and the answer needed two rules rather than one.

The map's beaded walk path is a **claim**: "you can walk this". It was drawn
unconditionally as a straight line from the rider to whatever stop was selected. Searching
a stop across town therefore left a dotted line running clear across the city, and that
reads as a suggested walking route.

**Rule one — a walk we would refuse to plan is not drawn.** `PLAN_MAX_RADIUS_M` (1500 m
ceiling, `server/src/api.ts`) is the longest walk our own planner will put in a plan at
all. Drawing one past that is self-contradictory, so the geometry stops there: no line, no
walker node, no walk time, and the camera falls back to the standard city framing instead
of dissolving the diorama trying to fit a line that is not there. **The threshold is the
app's own existing contract, not a new opinion.**

**Rule two — a failed plan takes the geometry with it, whatever the distance says.** Rule
one alone was not enough, and the harness is what caught it: on the transfer screen
`walkNodes` was still `1`, because the leg being drawn was the *previous, successful*
plan's first leg — geometry belonging to a different journey, still on screen under this
one's failure message. `store.planUnresolved` is set by `PlanView` for every non-`ride`
outcome *and* for a `ride` whose candidates are all uncatchable, and `MapCard` treats it
exactly like "not walkable".

Both states now say something true, and both are asserted by render, not by eye:
`04-plan-ride` → `walkNodes = 1` with three legs; `05-plan-transfer` → `walkNodes = 0`.

The red route line stays in both. It is the agency's own published shape for the focus
route, drawn whether or not a plan exists, and it is unmistakably a transit route rather
than a walking one — it is not a claim about the plan.

### 9. What the road-tone / density work in the tree was, and why it shipped

The working tree also held uncommitted edits to `map/mapStyle.ts`, `map/voxelCity.ts` and
`map/voxelMesh.ts` whose provenance was unknown. **Assessed and kept**, because they are
the finished piece of work §42 explicitly asked for rather than a partial one.

§42 measured that our road surface sits at luminance 39.8 against our own ground at 20.4,
where the reference's streets are its *darkest* surface at ~20 — and that the consequence
was structural, not tonal: the road network is a connected graph, so painting it above the
building/ground boundary welded every block to every other. §42 then declined to fix it
alone, on the record, because "roads and density have to move together, with their own
before/after" — pass 1 had already proved that darkening roads on a too-sparse city makes
the grid vanish.

These edits move both together: the two signed-hash bugs are fixed (`h % n` →
`(h >>> 0) % n`), the `MIN_FOOTPRINT_PX2` generalisation floor is gone (both raising built
coverage), and the road ladder comes down to casing 17.5 / minor 20.6 / secondary 22.7 /
major 26.7 against a 20.4 ground — with the casing now a step *darker* than its fill, so
each street reads as a shallow channel rather than the brightest element in the frame.
That is §42's own prescription, executed. It typechecks, the 304-test suite is green, and
the eight-combination probe is clean on it. Kept, with the stale "§43 ships it"
cross-references in those files left pointing at the section that actually holds the
measurements, §42.

## §47 — `npm run eval`: the spec's honest evaluation script, built for a backtest it cannot run yet

STATUS.md's R3 row: `npm run eval` did not exist. It now does, as `server/src/eval.ts` +
`server/src/eval.test.ts`, wired by one line in `package.json`. Two sections, both computed
from real rows in the configured DB via the same dual-driver pattern as `aggregate.ts`.

**1. Ghost Forecast backtest (METHODS.md §7).** Holds out the most recent FULL service day
with a meaningful number of ghost events, trains a (route, hour_of_week) risk model on the
`WINDOW_DAYS` before it, and scores every departure due on the held-out day into a
TP/FP/FN/TN confusion matrix. It deliberately does not reimplement the forecast: it imports
`buildForecast` and `ghostRiskFor` UNMODIFIED from `api.ts`, so this is a backtest of the
exact mechanism the live app ships, not a parallel algorithm that could quietly drift from
it. "Meaningful" is a stated, testable bar rather than a vibe: `BACKTEST_MIN_QUALIFYING_DAYS`
= 2 and `BACKTEST_MIN_EVENTS_PER_DAY` = 5, both exported constants, both printed in the
"not runnable" message. A day only counts if it clears the event bar AND falls inside the
actual training window used — a first draft checked the bar against all of history and a
code-reviewer pass caught that a qualifying day outside the training window would let a
"RUNNABLE" claim rest on data the model never trains on; the fix (`eval.ts`, the
`windowQualifying` check) closed it before this shipped, not after.

The confusion-matrix accumulation clamps `ghosts` to `scheduled` per cell rather than
letting a negative "not-ghosted" count corrupt the totals silently: `scheduled` is
recomputed from the CURRENT static tables while a ghost's cell comes from its own recorded
`scheduled_start`, so a re-seed between when a ghost fired and when this eval runs could
disagree. Clamped cells are counted (`inconsistentCells`) and surfaced as a warning in the
report rather than absorbed quietly — the same instinct as `voidForInconsistency` in
`engine.ts`, applied to an eval script instead of the live pipeline.

**REALITY TODAY, unchanged by this section existing:** the `ghosts` table holds zero rows —
the mass-ghost breaker is still honestly suppressing (§9.4/§9.5) — so this prints:

> Ghost Forecast backtest: not runnable — 0 ghost events recorded across 0 service day(s)
> observed (breaker suppression: see /api/health). A meaningful eval needs >=2 full service
> days with >=5 ghost events each (have 0 qualifying day(s), 0 ghost event(s) total, 0
> service day(s) observed).

That is the actual output against a throwaway seed (`.data/pglite-eval`, static board only,
`GHOSTBUS_SEED_SKIP_DOWNLOAD=1`), not a description of expected behaviour. The backtest math
itself is proven against a synthetic fixture in `eval.test.ts`: two Wednesdays seven days
apart (so they share an hour_of_week cell), a trained 50% ghost rate on ten same-slot static
trips clearing `GHOST_RISK_MIN_N`, and a held-out day that hand-computes to
TP=4, FP=6, FN=1, TN=0 — precision 40%, recall 80% — asserted exactly, not approximately.

**2. Honest-ETA within-sample calibration (METHODS.md §6).** Reconstructing "what
`agg_delay` looked like at observation time" was considered and rejected: no history of the
aggregate table is retained, so the honest simpler thing is a within-sample statistic — for
every (route, hour_of_week) bucket with `n >= ROUTE_HOUR_MIN_N` (the estimator's own
route-hour floor from `eta.ts`), what fraction of THAT bucket's own observations land inside
THAT bucket's own P25-P75 band. Expected ~50% by construction; it measures band consistency,
not forecast skill, and the printed report says so in those words rather than letting a
number imply more than it is. `CALIBRATION_MIN_OBS = 500` gates it; below that it reports
the real count and nothing else. Against the same static-only throwaway (no collector has
run against it, so `trip_delay_obs` is empty) it correctly reports "thin data — 0 qualifying
observation(s)"; `eval.test.ts` proves the arithmetic itself on a 500-observation fixture
(two qualifying buckets, one sub-threshold bucket padding the total) against percentiles
computed independently with the already-tested `percentileCont`, landing on exactly 490 of
500 covered.

Every number either script prints traces to a parameterized, agency-scoped (`'ttc'` only —
`'ttc-demo'` is never queried) query; both sections exit 0 on thin data, because an honest
"not enough data yet" is this script's success case, not its failure one. 331 tests green
(324 pre-existing + 7 new), `tsc -p tsconfig.node.json --noEmit` clean.

## §48 — A schedule is not an observation: §45 §7's agency fix overshot, and the limiter was refusing the app itself

> **PARTLY SUPERSEDED (2026-07-26) — see §49 and §50.** ONE sentence in §6 below is false and
> always was: *"anything not positively identifiable as non-API is **limited** — including
> 404s"*. Unmatched requests are never limited, at any exhaustion state. §49 records the
> finding and why the code deliberately stays as it is; **§50 corrects §49's own account of
> the mechanism**, which was right about the outcome and wrong about the cause for the
> commonest case. Everything else in §48 — the agency split, the cross-seam join, the
> `/api`-only scoping and the `%61pi` encoded bypass, all of it measured — stands unchanged.
>
> **HISTORICAL DETAILS (2026-07-27).** The R5-GTA multi-agency reshape (commits
> `857a337`..`b974008`) kept the split's *principle* — schedule reads and observation reads
> bind different agency names — but made this entry's specifics historical: schedule reads
> now bind the seeded-agency list (`agency = ANY(...)` over `seeded`), and `staticAgency`
> is now the poller's own agency id rather than the literal `'ttc'`; the seeder is
> agency-parameterised, so the `seed_toronto.ts:60` hardcode quoted in §1 no longer exists
> in that form; `api.ts` no longer imports `STATIC_AGENCY`; and the per-table site counts
> below are as of 5ba1bbf, not the current tree. The union read path is recorded in
> `.data/r5gta-plan.md` and its commits.

Two corrections to §45, both found by testers on the build §45 describes, and both in the same
file. **§45 is left exactly as written** — it records what was decided and why at the time,
and the honest way to handle a decision that turned out to be half right is to say so in a
new entry rather than to quietly improve the old one. This is that entry.

---

### 1. The claim that is superseded

**§45 §7's first bullet — now carrying its own PARTLY SUPERSEDED marker — asserts:**

> **`AGENCY` now comes from `poller.getMode().agency`, not the literal `'ttc'`.** Verified
> bug: a demo instance sharing a database with live TTC rows would have read the *live* rows
> and served them under the amber DEMO badge…

**That is superseded by commit 5ba1bbf.** The verified bug it describes was real and the fix
was right — *for observations*. Applying it to **every** query in `api.ts` was an overshoot,
and it broke Demo Mode completely.

`seed_toronto.ts:60` hardcodes `const AGENCY = 'ttc'` and only ever writes the static tables
under it. There is no `'ttc-demo'` seed path and there was never meant to be. So once every
query in `buildApi()` bound `poller.getMode().agency`, a demo instance asked for
`stops`/`routes`/`trips`/`stop_times`/`shapes`/`calendar`/`calendar_dates` under
`'ttc-demo'` — **a namespace nothing is ever written to — and got zero rows from all of
them.**

What a rider saw: a demo instance standing at King & Spadina reporting **"No TTC stops within
800 m of you"**, with search, the arrivals board, the planner and route shapes all silently
dead. **That is a new instance of exactly the dishonesty §45 exists to prevent** — the UI
asserting something untrue — produced by a namespace bug instead of a copy bug. §45 §6 makes
the same argument about substituting a location the rider did not choose; this is the same
failure with a different cause.

The intent was already written down correctly in two places, and neither was followed:

* **§44**: "The static board is read under `ttc` in both modes… a schedule is not an
  observation, there is one published board, and a recording is a recording *of* it."
* **`demo.ts` rule 5**: "Everything a demo process writes is tagged `agency = 'ttc-demo'`
  (DEMO_AGENCY). The static schedule is read under `'ttc'` because a schedule is not an
  observation and there is only one published board."

`poller.ts` had implemented that split since Demo Mode landed (`STATIC_AGENCY` vs `agency`),
which is why `/api/health`'s `boardCoverage` kept reporting the real span while `/api/stops`
returned nothing. **`api.ts` was the only file that had not made the distinction.**

### 2. The split, per table

`STATIC_AGENCY` is now exported from `poller.ts` and `api.ts` binds two clearly different
names, so neither can be typed where the other belongs:

| constant | value | tables | sites |
|---|---|---|---|
| `staticAgency` | always `'ttc'` | `stops`, `routes`, `trips`, `stop_times`, `shapes`, `calendar`, `calendar_dates` | 17 |
| `modeAgency` | `poller.getMode().agency` | `trip_delay_obs`, `ghosts`, `agg_delay`, `agg_delay_route`, `service_alerts` | 12 |

(Counted as binding lines in `api.ts` with comments stripped. One line appears in both
columns — the cross-seam join in §3 below, which is the point of it.)

Every site was classified by the table that **drives** it, not by the endpoint it serves —
including two that are easy to get wrong:

* **`/api/plan`'s self-join** is `stop_times` joined to `stop_times` and `trips`. All three
  inherit `b.agency`, so the whole join is **static**. Binding it to the mode agency is what
  made the planner return nothing in demo mode.
* **The forecast denominator** is mixed and is bound per query: the `trips`/`stop_times`
  scheduled-trip count is static, while its `trip_delay_obs` and `ghosts` inputs are
  observations.

**Both directions of this mistake are real bugs, and `api.ts` has now shipped each one.**
Hardcoding `'ttc'` served live observations under the DEMO badge; using the mode agency
everywhere served nothing at all. That is the reason for two names rather than one clever
one.

### 3. The one query that crosses the seam

`/api/ghosts/feed` joins the published schedule onto an observation to recover a headsign:

```sql
FROM ghosts g LEFT JOIN trips t ON t.agency = $2 AND t.trip_id = g.trip_id
WHERE g.agency = $1
```

It used to read `ON t.agency = g.agency`, which bound the **static** side to the
**observation** namespace. In demo mode the join matched nothing and **every ghost lost its
headsign**, rendering as a bare trip id instead of "504 to Dundas West". The two agencies
are separate bound parameters now, which is the only form that states the fact: this row
comes from two namespaces on purpose.

Found by review, not by the tests — noted because the seam test **cannot** catch it. That
test classifies a query by its first `FROM` table and inspects `$1`; a cross-namespace join
is invisible to both rules. It has its own test.

### 4. Why the old test did not catch any of this

`api.test.ts` contained a test literally named *"every query is scoped to the POLLER's
agency, not the literal 'ttc'"*. **It asserted the bug.** It exercised only `/api/alerts` —
an observation table — and then asserted that *every* agency-scoped query binds the poller's
agency, which is precisely the over-generalisation that broke the static side. A test that
encodes a wrong rule is worse than no test: it defends the defect.

Replaced with tests that pin the seam **per table** across eight endpoints, one that
reproduces the rider-visible symptom (`/api/stops/nearby` at King & Spadina under a demo
poller, against a fixture seeded under `'ttc'` only), one for the cross-seam join, and a
live-mode mirror so the split cannot be satisfied by hardcoding `'ttc'` again.

The fake `Db` grew a `whenParams` predicate for this. Without it, a fixture answers every
query that matches its SQL substring regardless of the parameters bound — so **a namespace
bug is structurally invisible to the suite**, which is exactly how this one reached a
tester. A test can now model what a real seeded database does: rows exist under one agency
and genuinely do not exist under another.

**Verified against a real demo instance** replaying the 2026-07-26 fixture: `mode: "demo"`
with its recorded notice on the wire, 7 search hits for "Dundas West", 18 departures at King
& Spadina, a real ride plan with 27 candidates, a 119-point route shape with 36 stops. Every
one of those was zero.

---

### 5. The rate limiter was refusing the app itself

Undocumented in §45, and a defect in the same file: `rateLimit` was registered at **root
scope**, so it guarded the static bundle as well as the API. A rider who reloaded during a
throttle was served **raw 429 JSON instead of GhostBus** — the app could not even paint the
"GhostBus is catching up — retrying automatically" screen that §45 §3 built to explain the
throttle. **A reload is the first thing anyone does when an app looks stuck, and it was the
one action guaranteed to make things worse.**

The limiter is now scoped to `/api` via the plugin's own `allowList`. `index.html` and the
hashed assets are a handful of cacheable static files; they are not what a budget protects.
The budget protects the database behind `/api/`, and that is now exactly what it covers. The
ceilings from §45 §1 are unchanged and restated here for the record:

| scope | budget | why |
|---|---|---|
| global, `/api/*` | **600 / min** | ~31 tabs of steady-state polling; a human cannot reach it |
| `/api/plan` | **60 / min** | the windowed board self-join, the heaviest query in the file |
| `/api/stops` | **120 / min** | a leading-wildcard `ILIKE` over the whole stops table |
| everything else (`/`, `/assets/*`) | **unlimited** | the shell must always load so the app can explain itself |

### 6. `req.url` is not the routed path, and the difference is a bypass

The first version of that scoping read:

```ts
allowList: (req) => !req.url.startsWith('/api'),
```

**That is bypassable, and a code review caught it before it shipped.** `req.url` is the
**raw** request target, but the router decodes before matching. So:

```
GET /%61pi/stops?q=King
```

reads as "not an API route" in the `allowList` — and dispatches to `/api/stops` anyway. Both
the 600/min global and the 60/min plan budget are skipped entirely by one curl loop.
Absolute-form targets (`GET http://host/api/vehicles`) do the same thing, since Fastify
strips the origin before matching.

The gate is now the **routed** path (`routeOptions.url`, the matched route *pattern*, decided
before `onRequest` hooks run), which cannot be spelled around. **And the fallback matters as
much as the primary:** a request with no matched route has no pattern, and treating "unknown"
as exempt is how the bypass comes straight back. So anything not positively identifiable as
non-API is **limited** — including 404s, which is precisely what a scanner generates.

Measured on a running server, with `/api/stops`' own 120/min budget exhausted:

```
/api/stops?q=King      -> 429      (plain path, refused)
/%61pi/stops?q=King    -> 429      (encoded path, refused by the same budget)
GET /                  -> 200      (the shell, never limited)
GET /assets/index-*.js -> 200      (the bundle, never limited)
```

**The general lesson, and the reason this is in the ledger rather than only in a comment:**
any security or budget decision keyed on a URL must be keyed on the value the *router*
resolved, never on the bytes the client sent. Those are two different strings, and an
attacker picks which one you read.

---

### 7. What this section does not change

The attribution contract in §45 §2-§3 is untouched and still holds: three states, typed
`ApiErrorKind` on the wire, `ApiFailure` in the client, and no failure of ours able to reach
a copy string that names the transit agency. Testers re-verified it across eight combinations
of a 107,385-response 429 storm and eight of a genuinely dead server. What changed here is
**who** the queries are scoped to and **what** the limiter covers — not what the app says
when either one fails.

334 tests green, both typechecks clean, §F still zero across all eight combinations.

## §49 — Unmatched routes were never rate-limited, the claim that they were is withdrawn, and the code stays as it is

> **PARTLY SUPERSEDED (2026-07-26) — see §50.** §1 below ("Why the fallback never runs") is
> wrong for the commonest case. It says the limiter's hook is never called for an unmatched
> request; measured, that holds only for non-GET/HEAD methods and for every method when no
> bundle is built. In the DEPLOYED configuration an unmatched GET/HEAD matches
> @fastify/static's `/*` wildcard, the hook DOES fire, and the request is exempted because
> the routed pattern is `/*` rather than an `/api` path. **Every CONCLUSION in §49 is
> unaffected and none of it is superseded** — unmatched requests are still never limited,
> the per-branch exposure in §2 is unchanged, the decision not to change the code in §3
> still holds for the same reasons, and the deferred hardening in §4 is untouched. §50 has
> the corrected mechanism and the probe that settled it.

§48 §6 ended with a sentence I wrote with confidence and never tested:

> anything not positively identifiable as non-API is **limited** — including 404s, which is
> precisely what a scanner generates.

**That is false, and it was false when written.** Two testers found it independently — T2's
adversarial rerun confirmed it empirically three times and root-caused it in the plugin and
Fastify sources; T3's docs re-check flagged the same sentence from the other direction. The
coordinator verified it against the not-found handler before this entry was written.

The §48 marker is scoped to that one sentence. The rest of §48 was measured and stands.

### 1. Why the fallback never runs

Two facts, both read out of `node_modules/` rather than assumed:

* **`@fastify/rate-limit` attaches to `onRequest`** (`index.js`, `const defaultHook =
  'onRequest'`).
* **Fastify's 404 handling has a router of its own.** `lib/fourOhFour.js` builds a separate
  `FindMyWay` instance, commented in the source as *"404 router, used for handling
  encapsulated 404 handlers"*.

An unmatched request is dispatched by that second router, which never fires the main router's
`onRequest` chain. **The limiter's hook is not called at all, so the `allowList` callback — and
therefore the careful fallback branch §48 §6 describes — is never consulted.** The fallback is
dead code on that path. It is still correct for what it does cover, and it stays, because it
guards the case where a route *is* matched but the pattern is unavailable.

Note what this does **not** affect: every bypass §48 §6 actually measured was against a
*matched* route (`/%61pi/stops` resolves to `/api/stops`). Those refusals were real and remain
real. What was never true is the extra claim layered on top of them.

### 2. The real exposure, per branch

Read off the not-found handler in `server/src/api.ts` (the `app.setNotFoundHandler` block, the
last handler registered before the server starts). It is a four-branch funnel, and three of the
four exit cheaply:

| unmatched request | branch | cost |
|---|---|---|
| `/api` or `/api/…` | explicit JSON 404 | negligible — no I/O |
| `/assets/…` or any known asset extension | JSON 404 | negligible — no I/O |
| non-`GET`/`HEAD`, or no HTML `Accept` **and** has an extension | JSON 404 | negligible — no I/O |
| a genuine navigation (no extension, or explicit `text/html`) | SPA shell | **`readFileSync(index.html)`, uncached, per request** |

So the unlimited surface is not "the API" and not "the database" — it is a handful of string
comparisons for anything that looks like an API path, an asset, or a non-navigation, and one
synchronous file read for anything shaped like a navigation. **A scanner spraying `/admin`,
`/.env`, `/wp-login.php` hits the last row.** That is the wart: a synchronous read on the event
loop, once per navigation-shaped 404, with no cache in front of it.

### 3. Why the code is not being changed

This is a deliberate decision, not an oversight deferred for want of time.

**The documented fix would re-break a user-facing bug that was just fixed.** The standard
pattern for limiting a not-found handler is `preHandler: app.rateLimit()` on
`setNotFoundHandler`. Applying it means that during an exhausted budget the SPA shell — served
from exactly that handler for every client-side route — answers **429 instead of the app**.
That is precisely the failure §48 §5 fixed and T1 verified: a rider who reloads while throttled
must get GhostBus, which then explains the throttle honestly, rather than raw JSON. **Limiting
scanner noise does not outrank a rider being able to load the app.** Given the choice, the
rider wins.

**And the thing being protected is already cheap.** The budget exists to keep the database from
being made to work hard (§45 §1). Not one of these four branches touches the database. Three do
no I/O at all. The one that does reads a ~1.2 kB file that the OS page cache will hold.

### 4. Deferred hardening, and where it is tracked

Two viable options, neither shipped:

* **Cache the shell, but not naively.** A boot-time `readFileSync` into a module constant would
  remove the per-request read — and would reintroduce the **§28** family of failures directly:
  rebuild the bundle under a running server and every navigation is served a stale `index.html`
  pointing at hashed assets that no longer exist, i.e. a blank screen with 404s in the console.
  **§27** is the other half of why that is nasty: the service worker will happily cache whatever
  the shell URL returns, and hashed URLs are never revalidated, so a stale shell can outlive the
  server that served it. The viable forms are an **mtime-checked cache** (`statSync` is far
  cheaper than reading, and it self-heals across a rebuild) or an **async read**, which at least
  stops blocking the event loop.

  *(Citation corrected while writing this entry: the hand-off that prompted §49 cited "§26" for
  this failure. §26 is the Vite dev-server config fix, and §27 already records that §26's
  "production is unaffected" claim was itself measured false. The stale-shell/hashed-asset
  failure is §28, with §27 supplying the service-worker half. Checked rather than copied —
  which is the whole subject of this section.)*
* **A navigation-exempt rate limit on the handler** — limit the three cheap JSON-404 branches,
  leave the navigation branch unlimited so the shell always loads. This keeps §48 §5's guarantee
  and removes most scanner traffic, at the cost of a second limiter configuration to keep in
  step with the first.

**Tracked in `SECURITY.md` §8, "Known open items, in priority order"** — the list this repo
actually uses for security follow-ups, alongside the Fastify 5 upgrade and the `trustProxy`
item. It is filed low in that list on purpose: it is a resource wart on an unauthenticated
cheap path, not an access-control or data-exposure defect.

### 5. The lesson worth keeping

§48 §6 closed with a general rule — *any budget decision keyed on a URL must be keyed on the
value the router resolved* — and that rule is still right. **What went wrong is the sentence
next to it: I described the behaviour of a code path I had reasoned about but never exercised.**
The `%61pi` bypass in the same section was measured, and it was correct. The fallback claim was
inferred, and it was wrong. A ledger entry that mixes the two teaches a reader to trust both
equally.

The correction is procedural, not just factual: **a claim about what a hook does needs a probe
that makes the hook fail to fire, not a reading of the code that registers it.** The
seam-test lesson in §48 §4 was the same shape — a test that encodes a wrong rule defends the
defect — and this is that lesson again, one layer up, in prose instead of in a test.

## §50 — §49 was right that unmatched routes are never limited, and wrong about why — and it got that wrong the exact way it warned against

§49 closed by naming its own failure mode:

> a claim about what a hook does needs a probe that makes the hook fail to fire, not a
> reading of the code that registers it.

**§49 then explained the mechanism by reading `node_modules` and never ran that probe.** It
identified one real path and presented it as the only one. T3's docs re-check caught it with
a probe: `GET /api/bogus` invokes the `allowList` with a routed pattern of `/*`, which §49
says cannot happen.

**Every conclusion §49 drew is still correct.** Unmatched requests are never rate-limited; the
per-branch exposure is unchanged; the decision not to change the code stands on the same
reasoning. What was wrong is the account of *how* — and it was wrong for the case that
actually dominates production traffic. This section corrects the mechanism and nothing else.

### 1. Probed before written, this time

`.data/ft3fix_probe.mjs`, output in `.data/ft3fix_probe.out`. The instrument is the **real**
`allowList`, not a replica: a byte copy of `api.ts` with a recorder pushed into the callback
and an env switch to force the no-bundle configuration. The recorder *is* the evidence — an
entry means the hook fired, no entry means it never ran. Response headers cannot tell those
apart, because both end unlimited, and that indistinguishability is precisely how §49 talked
itself into the wrong story.

**Config A — `webDist` present (what actually ships):**

| request | status | hook fired | routed pattern | exempted | counted |
|---|---|---|---|---|---|
| `GET /api/health` | 200 | **yes** | `/api/health` | no | **yes** |
| `GET /api/bogus` | 404 | **yes** | `/*` | **yes** | no |
| `HEAD /api/bogus` | 404 | **yes** | `/*` | **yes** | no |
| `GET /assets/nope-abc123.js` | 404 | **yes** | `/*` | **yes** | no |
| `GET /admin` | **200** | **yes** | `/*` | **yes** | no |
| `POST /api/bogus` | 404 | **no** | — | — | no |
| `PUT /api/health` | 404 | **no** | — | — | no |
| `DELETE /api/stops` | 404 | **no** | — | — | no |

**Config B — `webDist` absent:** every row except the matched `GET /api/health` shows
`hook fired: no`. With no static plugin there is no wildcard, so nothing unmatched routes at
all.

8/8 verdicts pass. The probe asserts both mechanisms explicitly rather than leaving them to be
read off a table.

### 2. The corrected mechanism: two paths, one outcome

**Path A — the deployed one, and the one §49 missed entirely.** `@fastify/static` registers a
`/*` wildcard route. Every unmatched **GET or HEAD** — *including `/api`-prefixed ones* —
matches it. So the request is fully routed, the `onRequest` chain runs, and
`@fastify/rate-limit`'s hook **does** fire. `allowList` is then handed `routeOptions.url ===
'/*'`, which does not start with `/api`, so it returns `true` and the request is exempted.
The JSON 404 an API client sees for `/api/bogus` comes from the not-found handler only
*after* the static handler falls through to it.

**Path B — everything else.** Non-GET/HEAD methods match no route in any configuration, and
with no bundle built nothing unmatched matches anything. Fastify dispatches these on the
separate internal 404 router (`lib/fourOhFour.js`, its own `FindMyWay` instance), which never
runs the main router's `onRequest` chain. **This is the path §49 described** — it is real, it
is just not the common one.

**The observable is identical on both paths** (never limited, confirmed empirically three
times by T2), which is why a header-level probe could not separate them and why §49's
plausible half-explanation survived review until someone instrumented the callback.

**Consequence for the code:** the no-route fallback branch inside `allowList` is **dead in
both configurations and across all five methods**. On path A a pattern always exists; on path
B the callback is never invoked. It stays as a fail-closed guard against a future route that
registers without a pattern, and its comment now says so.

### 3. What did NOT change, and why the code still stands

Explicitly not superseded, restated so no reader has to reconstruct it:

* **Unmatched requests are never rate-limited.** Unchanged — only the reason differs.
* **The per-branch exposure (§49 §2)** is unchanged: three cheap JSON-404 branches with no
  I/O, one navigation branch doing an uncached `readFileSync` of a ~1.2 kB shell. Path A
  adds nothing to that cost; the static plugin's `stat` miss is the same filesystem work the
  handler was already going to do.
* **The decision not to change the code (§49 §3)** holds on identical reasoning: limiting the
  not-found handler would answer 429 for the SPA shell during an exhausted budget and
  re-break the fix T1 verified, and nothing on any branch touches the database.
* **The deferred hardening (§49 §4)** is untouched, still filed as `SECURITY.md` §8 item 5.

One detail the probe adds to §49 §2: `GET /admin` returns **200** with the SPA shell, not a
404 — it is navigation-shaped, so it takes the `readFileSync` branch. That is the scanner
case, and it confirms rather than changes §49's cost table.

### 4. Where the wrong mechanism was carried, and what was done to each

| location | action |
|---|---|
| §49 §1 body | scoped `PARTLY SUPERSEDED` marker; **conclusions explicitly not superseded** |
| §48's marker | **reworded in place** — it is a navigation annotation, not a historical section body, so leaving a wrong mechanism in a signpost would misdirect every future reader. Now points at both §49 and §50 and states only the outcome. |
| `SECURITY.md` §8 item 5 | corrected in place (living document, not a ledger) |
| `api.ts` allowList comment | rewritten to the two-path behaviour |
| `api.ts` fallback-branch comment | now records the branch's unreachability where the branch sits |

`TESTLOG`'s T2 entry carries it too; that file is append-only and its owner annotates it.

The `api.ts` changes are **comment-only** — every changed line in the diff is a comment line,
with both typechecks clean and 334/334 tests green afterwards. Leaving a withdrawn claim
standing in a source comment is the same defect §49 exists to correct, and a comment is the
first thing the next person to touch that code will read.

### 5. The lesson, sharpened

§49 §5 already said the right thing. The failure was not that the rule was unknown — **it was
that the rule was stated in the same entry that broke it.** Writing down a discipline is not
practising it.

Two things generalise:

1. **A partial explanation is more dangerous than no explanation.** "The hook never fires"
   was true, checkable, and supported by a real source comment — and it stopped the enquiry
   one case short. Every subsequent reader, including a code review, had a plausible story to
   agree with. An unexplained finding invites a probe; a half-explained one closes the file.
2. **When two mechanisms share an observable, the observable cannot be the evidence.** The
   only instrument that could tell path A from path B was one that recorded whether the
   callback ran. That is what got built this time, and it is checked in.


## §51 — The walk path follows streets, and the data was already on the device

A rider testing the live app filed it in one sentence: **the walk path cuts through
buildings.** It did. The map drew the rider's walk to the boarding stop as a two-point
LineString, and a straight line through downtown Toronto crosses whatever is in the
way. In an app whose argument is that it does not show people things that are not
true, that line was a fiction drawn in the loudest place available — and it was drawn
*over* the very buildings the voxel city renders from real footprints.

### 1. Where the streets come from — and the three options that lost

* **An external routing API (OSRM / Valhalla public instances)** — rejected. A
  third-party dependency with rate limits, on the critical path of a screen that must
  work when the transit feed is down, in Demo Mode, and offline-ish. It would also mean
  sending the rider's live position to somebody else's server, which is the one
  guarantee this app makes about location (see `plan.ts` `transitDirectionsUrl`, which
  deliberately sends the destination and never the rider).
* **A server-side pedestrian graph precomputed at seed time** — the option that fits
  this codebase's honest-precompute habit, and the one I expected to choose. It loses
  on its data source. There is no OSM extract anywhere in this project: `seed_toronto`
  downloads GTFS and nothing else. Building a graph for the coverage area would mean
  either an Overpass query over 630 km² (hundreds of MB, rate-limited, fragile at seed
  time) or fetching and decoding vector tiles server-side — *the same tiles the client
  has already downloaded and parsed* — plus an MVT decoder, a cache table, an endpoint
  and a rate limiter, to answer a question the client can already answer.
* **A pedestrian graph out of the GTFS shapes we already store** — genuinely tempting:
  zero new data, fully offline, already seeded. Rejected because it can only ever
  follow bus routes. A walk down a residential side street would be snapped onto an
  arterial and reported several hundred metres long. That is a real walk, but it is not
  *the* walk, and the detour would be invisible to the rider.

**What shipped: a client-side graph over the basemap's own tiles.** The map already
renders OpenFreeMap vector tiles on the OpenMapTiles schema, and `voxelMesh.ts` already
reads that source's `building` polygons to build the city. The `transportation` layer
in the *same tiles* carries the OSM ways that draw the streets under the path —
footways, sidewalks, crossings, steps, laneways. `map.querySourceFeatures('omt', {
sourceLayer: 'transportation' })` hands them over already decoded. Measured in the
running app at King & Spadina: 883 features in the tile cache, 476 walkable line parts
inside the walk's bounding box, 2,041 vertices. **Routing therefore costs zero new
network.** Demo Mode is unaffected by construction — it replays transit data, and this
asks the basemap.

The price is stated rather than hidden: **where there is no map there is no route.** On
a phone's Plan tab the map card is unmounted, so a leg that was never routed on the
Nearby tab stays an estimate — and says so.

### 2. Two measurements that changed the design

Both against `fixtures/walk-king-spadina.json`: the real content of the two z14 tiles
over King & Spadina, 734 walkable ways and 378 building footprints, checked in.

**(a) Vector tiles are clipped, and a naive graph comes apart along the seam.** A
street crossing a tile boundary arrives as two pieces, and the piece from the
neighbouring tile overruns into the buffer, so its cut end lands in the *middle* of the
other piece rather than on one of its vertices. Merging coincident vertices cannot see
that. Unhealed, four of five realistic walks had no path at all and one routed at 16.9×
the straight line. Healing every dangling end (degree 1) onto a segment within a few
metres fixes all five.

**(b) The tolerance is 8 m, and 3 m was not enough — the app's own opening screen
proved it.** Three metres passed those five because a long walk absorbs a missing link.
`DEFAULT_LOCATION` (Front & Spadina) to the stop the board opens on (King St W at
Spadina Ave West Side) is 225 m, and one unjoined 7 m gap sent it 1,152 m round the
block — over the detour ceiling, so the very first screen a rider sees fell back to the
straight line this whole wave exists to remove. At 8 m it is 419 m. Every other pair is
identical from 3 m to 12 m, measured over the fixture *and* over lines captured live out
of the running app's tile cache, so the change buys the short walks without loosening
the long ones. The joint is charged to the route like any other edge: a healed crossing
is walked, not teleported.

### 3. The complaint, made measurable

Metres of the drawn line that lie inside a building footprint, sampled every 2 m:

| walk | straight line | routed |
|---|---|---|
| from the northwest, 363 m | 191 m inside (53%) | 24 m (3%) |
| from south of the corridor, 549 m | 146 m (27%) | 8 m (1%) |
| from the west, 603 m | 92 m (15%) | 36 m (4%) |
| from inside the block, 157 m | 96 m (61%) | 36 m (15%) |
| from the north, 445 m | 130 m (29%) | 8 m (1%) |

The residue is the two end stubs — you do walk out of the building you are standing in
— plus places where OSM draws a footway under a footprint. `walkRoute.test.ts` asserts
the comparison rather than a zero, because a zero would be a claim about Toronto's
mapping rather than about our router.

### 4. What is refused, and what a refusal looks like

`routeWalk` returns **null** — a first-class answer meaning *this device cannot say* —
when the ways have not loaded, when an endpoint is more than 150 m from any way, when
the two ends are unconnected, and when the route is both over 3× the straight line and
more than 250 m longer than it. That last guard needs both halves: a rider 30 m from the
stop but on the far side of Spadina Ave routes 182 m, because crossing six lanes means
walking to the light — ratio 6.1, and completely true. A ratio alone cannot tell that
from a broken graph; a ratio plus an absolute detour can, because a broken graph
overshoots by kilometres, not by metres.

**A null is never drawn as a route.** The straight line still appears, because the stop
is still that way, but it appears as a thin pale dash with no beads, no drop shadow and
no walker glyph riding it — and every number derived from it is printed with `≈`, in all
three locales, with `plan.basisRide` and `catch.evWalkBasis` stating which of the two a
reader is looking at.

### 5. The 1.25 route factor is retired for routed walks

It was an apology for not knowing the route: a documented guess at how much longer the
pavement is than the crow's flight. Applying it to a measured distance would bill a real
620 m as 775 m — a correction for an error no longer being made. `walkLegSeconds` applies
it only to the straight-line fallback, where it still means what it always meant.
Measured detours on this fixture run 1.16×–1.95×, so 1.25 was optimistic anyway, which
is the wrong direction for a number a rider uses to decide whether to run.

### 6. Three things deliberately left alone

* **The 1,500 m gate stays on the straight line.** `WALKABLE_MAX_M` mirrors the
  planner's own `PLAN_MAX_RADIUS_M`, which the server applies as a straight-line radius.
  It asks "does this app consider these two points connected on foot at all", and that
  answer must not change because the pavement wanders. A stop 1,400 m away routes past
  1,500 m and is still drawn; the route then tells the truth about the walk inside the
  gate, however long it turns out to be.
* **The plan's ranking never sees a measured walk.** A measured walk arrives after the
  plan is chosen. Letting it change the choice would let the answer rewrite the question
  — option A picked, map routes to A, longer walk makes A unreachable, B picked, map
  routes to B, A reachable again. `pickBestRide` ranks on the estimate every candidate
  shares; only the chosen plan is re-timed.
* **The alighting leg is not routed.** It happens at the far end of a ride, in tiles this
  device has no reason to have loaded. It stays the estimate it has always been and is
  marked as one, rather than quietly borrowing the first leg's credibility.

## §52 — The GTA joins the board: eight agencies, every licence read first, and two seeded dark on purpose

The user stood somewhere in the GTA and the app told them, honestly, that it covered
nothing within 800 m. Phase 0/1 built the machinery (registry, union reads, identity
crosswalk, per-agency everything); this wave uses it: **YRT/Viva, Burlington Transit,
Durham Region Transit, Brampton Transit, Oakville Transit, Milton Transit, GO Transit and
UP Express join TTC and MiWay** — ten agencies, ~8.7M stop_times, the whole GTA. Adding an
agency was, as designed, a descriptor plus a seed run: no engine, gate, poller or API code
changed in this wave.

### 1. No licence, no seed — and both former blockers dissolved when actually read

The plan's rule ("shipping an unread licence is indefensible") held: every one of the six
new publishers' terms was retrieved and read before its seed ran, and the verbatim
attribution strings live in the descriptors (`agencies.ts`) and the About sheet, per
locale. DRT's "unretrievable" licence turned out to be the Region of Durham Open Data
Licence v.1.0, quoted in full on durham.ca; Milton's "thin" disclaimer turned out to be a
complete OGL-shaped licence embedded in a JS-rendered ArcGIS Hub page, extracted via the
Hub item's data API. Both permit redistribution, adaptation and commercial use with
attribution. The full record, with retrieval provenance, is the dated addendum in
`.data/r5gta-plan.md` §1.6. One human obligation remains open and is flagged in the
operator's report: YRT asks users to accept its licence via a web form — a compliance
formality the operator must click, not something a builder submits on their behalf.

### 2. Milton is seeded dark, and that is a feature refusing to be a bug

Milton publishes realtime — through a shared feed carrying **fourteen other operators**:
35 of 137 TripUpdate entities and 384 of 1,551 stop_ids are Milton's (measured 2026-07-26).
Wiring it unfiltered would put Belleville buses on a Milton map, and the identity gate's
0.95 membership floor would (correctly) refuse the whole feed at 24.8%. So Milton's
descriptor carries `rt: {}` — *GhostBus does not observe Milton's realtime* — and its
boards are schedule-only and say so, exactly the §4.1 degradation Oakville exercises for
the simpler reason that no Oakville feed exists at all. Milton RT needs prefix-filter
machinery; that is its own wave, not a corner cut in this one.

### 3. GO and UP Express: static-only under an agreement with teeth

The Metrolinx static zips are open; the realtime API wants a key that takes up to ten
business days, so both agencies ship schedule-only now — when the key arrives, RT is a
descriptor edit, and GO's `rtNamespace` stays `'learned'` until the namespace is
*measured*, because it is the one GTA feed nobody has been able to verify. The GO API
agreement itself binds more than the feed, and the constraints are recorded in §1.6's
addendum: no Metrolinx/GO/UP branding or lookalike styling anywhere (agency labels stay
plain factual text), no public announcement referencing GO Transit (README/DEVPOST/
VIDEO_SCRIPT swept — the three existing mentions are factual naming-collision
explanations, which is what the clause permits), the licence is revocable at will, and —
the clause that shapes architecture — **§7a: no redistributing the Data within our own
API or feed.**

**The §7a position, stated so it stays true:** GhostBus's `/api` is the app's own
first-party backend serving its own frontend with *transformed* data — delay percentiles,
evidence-gated ETAs, boards windowed and joined — rate-limited, undocumented for third
parties, and not offered as a feed. That is what makes it a product surface rather than a
redistribution channel, and it must stay that way: anyone turning `/api` into a public
data service has changed the app's legal footing with Metrolinx, not just its ops load.

The About sheet also gained one sentence covering every agency at once — GhostBus is
independent, not affiliated, sponsored or endorsed — because Metrolinx requires never
implying official status and it was already true of everyone else.

### 4. One doc-contract widening instead of one convenient lie

`AgencyLicence.attribution` was documented as "the sentence the publisher REQUIRES,
verbatim, or null". The ten real licences are less tidy: YRT *suggests* a credit without
requiring one, Brampton's CC BY mandates attribution but not its wording, Burlington's
terms want their URL travelling with the data. Declaring YRT's credit "required" would
have been false; declaring it `null` would have hidden a credit the publisher asked for
politely. The field's doc now names the four real cases and each descriptor's comment
says which it is — the same move as §45: when the truth has more cases than the type
comment, fix the comment, never round the truth to fit it.

## §53 — Five days of `obs=0`: a sweep that could not tell withdrawn evidence from unearned evidence

`ghostbus.tech` ran for five days accumulating **zero** delay observations on every
agency, while every feed reported healthy and `/api/health` reported `ok: true`. This is
the post-mortem, and the one-line version is that §(the third-path section)'s `demoteUnvalidated()`
asked a broader question than the defect it was written for.

### What the box actually showed

The engine was not failing. It was computing observations and **dropping every one of
them**, which is what the `xwalkOccurrenceCoverage` gate is supposed to do below 50%
coverage. Occurrence coverage, daily maximum, from the production journal:

| Jul 30 | Jul 31 | Aug 01 | Aug 02 | Aug 03 |
|---:|---:|---:|---:|---:|
| **50.0%** | **50.0%** | 46.1% | 43.9% | 43.7% |

It cleared the gate on the first two days — 200,643 observations, the last of them at
09:04 on Jul 31 — and then ratcheted down and never returned. The join rate decayed with
it, 43% to 0.1%, because bindings that cannot be credited cannot validate anything either.

### The ratchet

`runCycle` clears the entire pattern credit store at every service-day rollover, **by
design**: binding credit is evidence about the service that ran, not about the board. The
comment at that clear says the patterns still running "re-earn it within a couple of
cycles".

`demoteUnvalidated()` then ran on the next cycle and asked `validationSufficient(validationFor(stop))`.
That predicate answers null for **two unrelated situations**: a pattern the consistency
gate REJECTED, and a pattern that simply has no credit yet. At 4 a.m. almost nothing is
running to re-earn anything, so the sweep demoted a slice of the crosswalk every night.

And every crosswalk entry is upserted to `rt_stop_xwalk` on every cycle — so each night's
demotion **persisted into the next day**, under one 6-week board tag. A nightly reset that
was meant to be an accounting boundary became a one-way loss.

### The fix, and why it is a narrowing rather than a new rule

The sweep now triggers on **distrust** — permanent, order-independent, and the only thing
in this engine that actually means "an audit withdrew this" — via a new
`anyDistrusted()` on the credit store. It never triggers on the absence of credit that
the rollover is entitled to reset.

This is not a weakened gate. It is the sweep finally matching its own stated purpose:
this document already described defect 3 as *"a stop stops being proposed the moment its
RT pattern is QUARANTINED"*. Quarantine was always the trigger; `validationFor` was just
a broader proxy for it that nobody noticed was broader, because on a single-day test run
the credit store is never cleared and the two questions have identical answers. **The bug
was invisible to every test that did not span a service-day boundary**, which is all of
them.

Confirmed in production: coverage recovered 43.7% -> 52.7% within three cycles of the
deploy, the gate flipped from `SUPPRESSED` to `publishing`, and the observation counter
started climbing for the first time in five days.

### What else this cost, and the two things that made it expensive to find

**Poller and engine log lines carried no agency id.** Seven pollers interleaved their
cycle lines into one journal with nothing but a cycle number to tell them apart, and the
cycle numbers drift apart on backoff. Attributing a symptom to an agency took longer than
diagnosing it. Both now print `[poller:ttc]` / `[engine:go]`.

**Suppression was invisible above the log.** `/api/health` reported `ok: true` throughout,
because it was true — every feed *was* arriving. `health.delayEngine` now carries
`{suppressed, reason, gate}`, the engine's own sentence passed through verbatim so the
endpoint and the log can never drift into two accounts of one refusal.

### The unrelated fault found in the same session, recorded here so it is not re-diagnosed

The same box was at **96% disk**: `pg_wal` held 87 GB across 5,514 segments after 4.7 days,
against a 2.1 GB database. PGlite is Postgres compiled to WASM and run single-process —
**the background checkpointer does not exist**, so nothing ever services the checkpoint
request `max_wal_size` raises. The GUC was set to 1 GB and simply never acted on; not one
segment had been recycled since boot.

A clean shutdown reclaimed all 86 GB in 3.2 seconds, which is the whole diagnosis:
checkpoints work, nothing was asking for one. `ALTER SYSTEM` + `pg_reload_conf()` is not
an alternative — verified against a throwaway datadir, `SHOW` still reports the boot value,
because there is no postmaster to signal. The hourly aggregation tick now also issues
`CHECKPOINT`, independently of the aggregation so neither failure costs the other.

**The two faults are not related.** WAL growth is driven by writes the engine makes
whether or not the gate lets observations through — which is exactly why the box was
filling up during five days of publishing nothing at all.

---

## §54 — Two agencies published into nothing, and the rest bound against two calendars at once

Two separate diseases, found in one session, sharing one symptom: **bindings are born and
never activate**. They are unrelated and are recorded separately.

- **TTC** (and every learned agency): `births` climbed, `pending` climbed, `active` sat at
  **0-1**, against ~700-900 four days earlier.
- **Brampton and Burlington**: gates OPEN, crosswalk coverage 99.2% and 85.4%,
  `directTripIdMatch` 96.8% and 100% — and `patterns 0/0 resolved`, `births=0`, `obs=0`,
  every cycle since they were added.

### What it took to see either: the counters that did not exist

`lockPendingBirths` has four exits and **three of them are silent `continue`s** — no RT
pattern yet, pattern not resolved, origin stop not confirmed. The fourth, refusal, kept its
counters in a struct no log line and no endpoint ever read. So the engine's worst-looking
state, `pending` climbing while `active` is zero, had no explanation available above the
log. §53's own post-mortem said this in as many words about a different layer, and it was
still true one layer down.

A per-cycle `lockPath` block now prints where each pending birth stopped, beside the
cumulative refusal ledger. It landed the TTC diagnosis in **one cycle**:

    lock unres=148 noPat=0 originUnconf=308 scored=345 locked=1
    refused(cum) noSlot=17 amb=319 hw=0 inactive=8 midroute=826

345 births reached the origin lock, 1 locked, and essentially all of the rest were
`refused_ambiguous`. The margin test was firing on nearly every trip in the city.

### Disease 1 — the engine was handed two service calendars for one service date

`originLock` refuses when the runner-up slot sits within `MARGIN_MIN_S`. The runner-ups
were not real buses. `poller.ts` built the engine's `activeServices` as

    const activeServices = servicesForYmd(day.ymd, day.dow);
    // A trip that started before midnight is still running on yesterday's service day.
    for (const s of servicesForYmd(prevDay.ymd, prevDay.dow)) activeServices.add(s);

The comment describes a real problem that this code does not solve, because it was already
solved: `serviceYmd` is `torontoYmd(now - 4 h)`, so at 01:30 the service date **is**
yesterday, and one lookup already returns yesterday's services. The union never covered
anything. What it did was add a **second, complete service calendar** to the set the engine
filters candidate slots by — so on every day whose `service_id` differs from the previous
day's, each pattern was scored against two interleaved schedules whose departures sit
minutes apart. The ambiguity was manufactured by us, and it is worst exactly where the two
schedules are most alike.

It also **compounded**. `servicesForYmd` returns its cache entry, so `.add()` wrote
yesterday into today's cached answer permanently, and each rollover unioned an
already-poisoned set:

| day | service | `activeServices` actually used | TTC `active` |
|---|---|---|---:|
| Wed Jul 29 - Fri Jul 31 | weekday `1` | `{1}` | **721 - 935** |
| Sat Aug 1 | Saturday `2` | `{1,2}` | **149 - 357** |
| Sun Aug 2 | Sunday `3` | `{1,2,3}` | **74 - 269** |
| Mon Aug 3 (civic holiday) | holiday `4` | `{1,2,3,4}` | **0 - 13** |

Four whole boards on one service date. The curve reads like a slow decay and is nothing of
the kind — it is a step per day-of-week boundary, and it would have half-recovered on the
Tuesday and been misread as fixed. The same poisoned set was also feeding `computeDue`,
which was scanning yesterday's trips as due today.

**The fix.** One lookup, on one service day, asked with **that service day's own weekday**.
`serviceDay()` returns `{ymd, dow}` from a single shifted instant so the date and the
weekday cannot disagree — at 01:30 on a Monday the calendar must be asked about Sunday, and
deriving the two separately is how they came to disagree at all. `serviceYmd` is now defined
in terms of it: one definition of the 4 a.m. rollover, not two.

`servicesForYmd` and `EngineCycleInput.activeServices` are now `ReadonlySet`, which makes
this particular mutation a compile error rather than a five-day outage. That is a stronger
guarantee than a test, and it is why there is no poller-level test here.

**No gate constant moved.** If a service day genuinely has no seeded trips, `boardIntegrity`
now fails honestly instead of being masked by the previous day's board.

### Disease 2 — a feed may omit `stop_sequence`, and this engine is built on it

Measured against both live feeds: **0 of 131** Brampton TripUpdates and **0 of 119**
Burlington TripUpdates carry a single `stop_sequence`, while **131/131** and **119/119**
carry both `trip_id` and `route_id`. GTFS-realtime makes `stop_sequence` optional — a
StopTimeUpdate may identify its stop by `stop_id` alone — so the feeds are correct and the
engine was not. `clusterPatterns` skips a stop without a sequence, so no RT pattern ever
formed; `captureBirths` skips it too, so no birth was ever captured; with no births there is
no binding, no settle, and no observation.

*The prior wave's hypothesis that these feeds omit `route_id` is withdrawn. They do not.*

**Recovery, not invention.** The sequence is read off the board, for a trip the board itself
names, by aligning the feed's stop-id list against the static trip's stop list as a
contiguous window and requiring that window to be **unique**. Uniqueness is the entire
safety argument: a loop route visits one stop id twice, so a `stop_id -> stop_sequence` map
would silently pick the first visit and measure the return leg against the outbound
departure — self-consistent, invisible, and wrong by the length of the loop. Two matches, or
none, and nothing is recovered; the trip stays exactly as unusable as it was.

**And then we do not re-guess it.** Having read the static trip to number the stops,
inferring which static trip it was would be scoring our own arithmetic: pattern resolution
becomes tautological, and the origin lock could still pick a *neighbouring* slot, pairing
one trip's numbering with another trip's schedule. `directLock` binds the trip the agency
named. It is the STAGE 0 fast path the engine has measured every cycle since it was written
and has never been able to use.

What a direct binding deliberately does **not** claim: `marginS` is null and `agree` is 0,
because there was no runner-up and no anchor vote, and a fabricated separation would make it
read as a well-separated origin lock in the same columns. `residS` is measured and persisted
— but it is the trip's **lateness**, not evidence about the identification, so it is kept
out of the board-agreement gate and the per-pattern drift breaker. Both of those exist to
catch an origin lock that slipped by about one headway, which a trip named by id cannot do;
and feeding real lateness to a gate that suppresses on lateness would let an agency go dark
by running late, which is the exact inversion this project exists to prevent.

Feeds that publish their own sequences are untouched, field for field.

**What this means for an agency that is ALL direct**, stated rather than left to be
discovered: its board-agreement gate, its drift breaker and its consistency check are all
inert. The first two are inert by the paragraph above. The third is inert because for a
repaired trip it re-tests the same stop-id equality that produced the sequence, so it can
only agree. That is not three audits being suppressed — it is three audits of an inference
that was never made. What replaces them is the uniqueness requirement: if the published
stop-id list fits the named trip's stop list in exactly one place, the numbering is the only
one consistent with the board, and there is nothing left for those audits to disagree with.
If that requirement is ever weakened to a nearest or first match, all three must come back,
because then there would be an inference again.

### Measured on ghostbus.tech, 2026-08-03

| | before | after |
|---|---:|---:|
| TTC `bindings active` | 0-1 across 26 cycles | **317 -> 384** in 8 cycles, climbing |
| TTC `refused_ambiguous` | 319 in 2 cycles | **4** in 8 cycles |
| TTC `obs+` per cycle | 0 | **29 - 42** |
| TTC join rate | 0.0% | **22.5%** and climbing |
| Brampton `patterns resolved` | 0/0 | **58/76** |
| Brampton `bindings active` | 0 | **9** |
| Burlington `patterns resolved` | 0/0 | **10/11** |
| Burlington `bindings active` | 0 | **47** |

`seqFromBoard` reads 86/129 and 72/110: about a third of each feed's trips are refused
recovery, because their published stop list is not a unique contiguous window of the trip
the board names. Those refusals are the mechanism working, not a shortfall to be tuned away.

### The review finding worth keeping

An audit of the above caught the one test that could not fail. Five recovery tests passed
with the numbering off by one **in either direction**, because a wrong sequence still
produces a pattern, a birth and a binding — every counter they asserted is identical. What a
wrong sequence changes is which scheduled time the trip is measured against, and nothing
asserted that. It does now, through `first_stop_resid_s` on a window that starts mid-trip.
The `lockPath` counters are likewise asserted as a partition, so the next silent `continue`
someone adds fails a test instead of costing a week.

### The corridors that never intersected: same disease, not a second one

Raised in parallel by the UX wave: 156,165 observations had become 62,622 `agg_delay`
rows, and yet five sampled origin/destination pairs and six downtown TTC boards all came
back `bucket: 'none'`. The suspicion was a WHERE problem — aggregate keys landing on cells
riders never query, a crosswalked RT stop id where a static one belongs, an hour-of-week
skew. It is none of those, and the test that settles it is one endpoint called twice.

**Stop 5299, routes 54 and 954, `/api/stops/5299/arrivals?agency=ttc`:**

| `at` | bucket | n | p50 |
|---|---|---:|---:|
| Thu 09:00 EDT | `route-hour` | **136** | −135 s |
| Thu 07:30 EDT | `route-hour` | **281** | −141 s |
| Fri 08:00 EDT | `none` | 0 | — |
| now (Mon 16:00 EDT) | `none` | 0 | — |

Same stop, same routes, same query, same code path. The join works. `stop_id` is the
STATIC id on both sides (`DelayRow.stopId` is documented as such and the reader keys on it),
`route_id` is the static id on both sides — it has to be, or `clusterPatterns` could not
look up `index.byRoute` and no pattern would ever resolve — and `hour_of_week` is computed
from the SCHEDULED time on both sides, `hourOfWeek(schedEpochS * 1000)` writing and
`hourOfWeek(r.scheduledMs)` reading.

What is actually missing is **hours**. `hour_of_week` has 168 cells. This deployment has
ever produced observations in about 29 of them: all of Thursday and Friday up to ~05:00
EDT, which is exactly the window §53 identified before the five-day `obs=0` stall — and
then nothing at all until the fixes above. A rider planning on a Monday afternoon is asking
about a cell that has never had a single observation in it, and `'none'` is the correct and
honest answer to that question. The corridor did not fail to intersect; there was no
corridor.

It is closing. Over 25 minutes on the afternoon of the fix, with nothing else changing:

| | 19:52 | 20:17 |
|---|---:|---:|
| `trip_delay_obs` | 156,260 | **157,137** |
| `agg_delay` cells | 62,697 | **63,527** |
| `agg_delay_route` cells | 2,498 | **2,611** |

113 new route-hour cells in 25 minutes, minted from observations that did not exist before
the binding fix. The current hour's cells are still under the evidence floors
(`STOP_HOUR_MIN_N` 8, `ROUTE_HOUR_MIN_N` 20) and will stay there for about an hour: the
Thursday cells that read n=136–281 took a full day of publishing to get there. Nothing more
needs to be built for them to fill; they fill by the engine running.

**One thing that will NOT fill, and should not be waited for.** Aggregation requires
`confidence = 'high'`, and a binding is high-confidence only when its pattern's median
headway is at least `HIGH_CONFIDENCE_HEADWAY_S`. Sub-300 s headways are refused a binding
outright. So the most frequent downtown corridors — the ones a rider is most likely to
sample — produce no aggregatable observation at any throughput, and their boards will read
`'none'` forever under this design. That is `ORIGIN_BAND_NOTE`'s stance held to, not a
defect: on a two-minute headway a bus more than half a headway late is shape-identical to
the next bus on time, and the honest product statement is "too frequent to measure
reliably". The route-hour cell counts are consistent with roughly half the TTC's routes
being able to produce evidence at all. Any plan that assumes every board eventually earns a
grade is wrong for the same reason BLOCKERS 10 was right.

## §55 — The flat face was the gap, not the flat frame: seams, a re-centred palette, and the axis that was left out

The user's verdict was *"the design is really lacking, make the voxel art style better"*,
and the brief named the residual gaps as per-face shading depth, block-tint variety,
ground/road contrast and tree canopy read. Three of those four turned out to be real and
one did not — and the one that mattered most was none of them. It was a metric §39 named
and no pass since had run.

**The instrument** (`vox.py`, one code path over both images) resamples the reference
sheet's desktop map region and our production capture to the reference's own 0.950 m/px
with a box filter, then measures six-band luminance, the convex-corner face ratios (§40's
discriminator), wall vertical ramp, roof-tone hue and luminance spread, §40's canopy
segmentation, ground/built/open structure, and — new here — **flatness**: quantise
luminance into 4-level bins, label 8-connected components, and ask what share of the frame
sits in any region bigger than 0.2% of it.

### 1. Flatness: §39 named this and then measured the wrong surface

§39 wrote: *"The reference's largest connected same-tone region is 0.38% of the frame.
Ours is 1.97%... Our faces are three flat measured tones, so a bigger block is simply a
bigger flat region."* It concluded the lever was block size and closed the file. Measured
whole-frame at HEAD, ours is **2.96% against the reference's 0.47%**, with **33.5% of our
frame in flat regions against its 5.1%** — six times worse, and worse than §39 reported.

Dumping the winning regions says why the whole-frame figure is not the one to chase: ours
is `#0e142c` at luminance 20.6, in one piece, in the bottom-left of the frame — **the rail
corridor south of Front Street.** That is real emptiness in real data, and §42 already
closed the book on it. So the metric was restricted to **building surface** (luminance
>= 32, a band both images share), which is what §39 was actually talking about:

| | reference | before | after |
|---|---|---|---|
| largest single face patch | 0.72% | 1.10% | **0.78%** |
| face patches over 0.2% | 9 | 59 | **3** |
| **share of face area in them** | **3.0%** | **22.4%** | **1.2%** |

**The cause, at 5x: a tone blend cannot draw a seam between two identical tones.** §39
rebuilt every mass as a cluster of cubes and the clusters are there — but along a
cluster's flank the neighbour is another cube's wall on the SAME plane facing the SAME
way, so the bevel's blend toward "the tone across the edge" is a no-op and five cubes drew
as one uncut quad. The cube grid existed in the silhouette and nowhere on the surface.
The reference plainly shows both cuts at 5x: a vertical line where two cubes stand side by
side, and a horizontal one at each course.

So the seam is a **multiply**, not a blend — it darkens near the edge whatever the tone is,
which is what the gap between two abutting blocks does to the light. It cannot disturb the
measured face ratios, because it scales the lit and shaded walls by the same factor and
dies to nothing at the face centre where those ratios are sampled. Three parts:

* **roof seam** (`SEAM_M` 2.6 m, `seam` 0.58) — its own width and depth, because `BEVEL_M`
  is shared with the wall corner and that one is deliberately tiny: its own comment
  records that blending the wall corner hard bunched the two measured wall tones from
  0.641 : 0.491 to 0.676 : 0.650;
* **wall seams**, vertical at the cube edge and horizontal at each course, at **0.36** of
  the roof seam's depth. Parity was built and rejected at 5x: at full strength the course
  lines read as a drawn stripe across every wall, which is what §41's depth-buffer banding
  looked like, and this pass must not reintroduce by hand the appearance it just measured
  away;
* **`gradientTop` split from `gradient`** (0.24 against the walls' unchanged 0.10). The two
  faces measured differently and one number could not serve both: the wall-ramp instrument
  puts the reference at 0.027 and ours at 0.053, so our walls are already twice as
  contoured as the reference's, while its roofs visibly ramp and ours were flat quads.

### 2. The palette: the mean was right again, and the shape was wrong again

Measured over roof pixels only (luminance > 58, saturation > 0.10), both images at
0.950 m/px:

| | reference | before | after |
|---|---|---|---|
| circular mean hue | 233.3 | 238.2 | **231.1** |
| hue, fullest 10 deg bin | 34.3% | **51.2%** | **35.6%** |
| roof luminance IQR | 12.9 | **23.6** | **11.4** |
| p95 frame luminance | 77.7 | 87.7 | **75.0** |
| frame above luminance 80 | 3.7% | 7.2% | **3.0%** |

Two independent faults, and §38's hue work fixed neither because it was measuring the mean,
which was already close. **Half our roof pixels sat in one 10 deg bin** — the same "narrow
spike reads as one colour" failure §38 diagnosed, one bin further warm. And our roof
**luminance** spread was 1.8x the reference's, which is `tintJitter` stacking on families
that already spanned 66..89.

The six families are now **constructed from the measurement** rather than nudged toward it
— each solved for a target Rec.709 luminance at a chosen hue and saturation — giving a
dealt-weighted mean of **76.6**, the reference's own measured roof median to one decimal,
over a family span of 70..83 rather than 66..89. `tintJitter` narrows +/-15% -> **+/-7%**
(fill the gaps between six tones, not smear the population); `hueJitter` widens
+/-11 deg -> **+/-18 deg**.

### 3. The frame, and what did not move

| | reference | before | after |
|---|---|---|---|
| bands 0-16 / 16-32 / 32-48 / 48-64 / 64-80 / 80+ | 3.3 / 39.5 / 28.7 / 13.2 / 11.5 / 3.7 | 0.7 / 53.0 / 16.0 / 16.2 / 7.0 / 7.2 | 0.6 / 50.9 / **18.0** / 16.7 / **10.7** / **3.0** |
| **six-band deviation** | — | **39.8** | **29.8** |
| median frame luminance | 35.1 | 26.7 | **29.7** |
| built coverage | 61.7% | 47.7% | 49.9% |

**The 16-32 band is still 12 points over and built coverage 13 points under, and neither is
a shading problem.** §42 measured that even drawing every ring the tiles hand us we reach
47.2% against 58.6%; the deficit is in the data. This pass did not re-open it and no lever
here pretends to.

The contact shadow was widened (`grow` 2.6 + 0.10h -> 4.2 + 0.22h) and its falloff made a
continuous gradient with the knee at zero. **It is worth recording that this did NOT do
what it was changed to do.** It was aimed at the whole-frame flatness figure; measured, it
moved that figure 2.96 -> 4.30 in the WRONG direction on the first attempt (a 0.26 knee
with the falloff squared — squaring shortens the tail rather than lengthening it, so the
wider quad laid down a bigger flat plate) and 4.29 after the knee went to zero. It is kept
because it is a closer reading of the reference's own ground and costs nothing measurable,
but the flatness win in §1 is the seams, not this.

### 4. The tree trunk: built, measured, reverted

§40 closed the trees on a close match and left one residual: *"the reference's canopy sits
on a visible brown trunk (~4 px wide at 0.950 m/px) and ours has none."* It was built — the
canopy lifted off the ground on a `base`, a third `fill-extrusion` layer filtered on a `tk`
property off the same source, the colour authored against the RENDER rather than the sample
after the first attempt drew at luminance 26 against a ground of 20 and was invisible.

**It renders and it cannot be seen.** `queryRenderedFeatures` reports 21 trunks against 110
canopy cubes, so the geometry is there; at 9x it is not, and the reason is structural. The
reference's canopy is a tall narrow cluster with gaps you can see the trunk through and
below. Ours is a 1.76-canopy-wide slab about 1.0 canopy tall, and from the diorama's
48 degree pitch its own silhouette projects below the trunk base at every point. No trunk
under its centre can be visible without changing the cluster's proportions — which would
move canopy width, the one tree statistic §40 pinned and this pass re-measured as still
good (27.5 m against the reference's 29.4, coverage 1.59% against 1.51%).

So `voxelTrees.ts` is **unchanged**, and this is the honest negative result rather than a
layer of invisible geometry and a floating-canopy risk. §31's "sub-pixel at every framing"
was wrong about the reason and right about the outcome. If a future pass wants the trunk,
the change is the cluster's aspect — `CLUSTER_OFFSET` / `CLUSTER_SIDE` / `HEIGHT_RATIO` —
and it needs its own measurement of canopy width first.

### 5. The journey surfaces: the piece the transit notes had deliberately left out

`design-refs/transit-app-notes.md` listed four adoptions and one of them was never built:
*"itineraries as rows on a SHARED PROPORTIONAL TIME AXIS."* It is built now, in
`buildTimeAxis` / `axisFrac` (pure, in `lib/journey.ts`, with four new tests).

It is a drawing, not a claim: every instant on it is one the plan already published and the
card already prints in words. **And it refuses to draw.** A menu of real transit options
does not guarantee that every row is readable — the last row can be tomorrow morning's
first service — so the axis returns null when the span exceeds three hours or the narrowest
option is under 6% of the track, and the list renders without it. Clamping, bucketing or
breaking the scale would all draw a length that is not the duration.

Also: the countdown numeral 30 -> **38px** (46 on desktop), with `.opt-when`'s reserved
width recomputed from the 390px arithmetic rather than left where it was; the brand wash
0.07 flat -> a **0.22 directional ramp** that has decayed to nothing before it reaches the
text column, so `readableOn`'s contrast argument at the head of that file still holds; and
the options list joins the SAME stagger the search rows and plan legs use, including its
`prefers-reduced-motion` delay flattening.

**A dead declaration removed in passing:** `font-variant-numeric: var(--tabular)` on
`.opt-when`, where `--tabular` is `"tnum" 1, "lnum" 1` — font-feature-settings syntax,
which `font-variant-numeric` rejects, so it never did anything. Tabular figures come from
`body` and from the `.tnum` class. **The same dead declaration is still on `.pct-num` and
`.jr-count-num`** and was left there, because this pass had no other reason to be in those
rules.

### 7. What code review caught, and it was not cosmetic

Five findings, three of them real defects this pass introduced:

1. **An unterminated CSS comment silently deleted `.opt-when`.** A `*/` closed a comment
   and the prose kept going, so the parser read the remaining paragraph plus `.opt-when`
   as one selector prelude and dropped the whole rule — taking the flex/baseline layout
   and the 92px reserved width with it. **The §F probe passed all twelve combinations
   with the rule missing**, because an unreserved column is not an overlap. Worth
   recording: the probe is a floor, not a proof, and a layout law can be broken without
   it firing.
2. **`voxelVehicles.setTheme` updated two uniforms of eight.** It set `uLit`/`uShade`
   only, so a dark->light swap left a bus wearing the other theme's crevice, ground AO
   and face gradient — and would now have left it wearing the night seam depth. This is
   the same failure the note above `CUBE_VERT` warns about for the shader source, one
   level up, so the fix is the same shape: `applyCubeTheme(mat, theme)` is exported from
   `voxelMesh.ts` and both call sites use it. Neither can drift again.
3. **The roof gradient dotted a CUBE-frame offset against a WORLD-frame light axis.**
   Every block is yawed by its own footprint's PCA orientation, so each roof's bright
   side pointed in an arbitrary direction. Pre-existing and invisible at the old 0.10
   amplitude; not invisible at 0.24. `vLocalW` now carries the offset rotated into world
   XY.
4. **The roof gradient is now one-sided — darken only.** Two-sided, it brightened the
   near half PAST the authored tone, which the dark theme merely wasted and the light
   theme clipped: its roofs are authored near white (`#f6f4f1` is 0.965), so any lift
   saturates them to flat 1.0 and manufactures the exact uniform region this pass exists
   to break up.
5. `MAX_TICKS` 6 -> 5. `count(step) = N` puts the span in `[(N-1)*step, (N+1)*step)`, so
   the worst-case label gap at N is `track/(N+1)` — 45px at six ticks on the 314px track,
   which an fr-CA `13 h 45` can touch. Five leaves ~52px.

**And a note on the backtick.** Twice in this pass a backtick inside a GLSL template
literal silently terminated it, and both times the error surfaced as `TS1005` on a line
two hundred lines away. There is now a one-line guard in the scratchpad that greps each
shader body for one; it belongs in this file's history rather than in the build, because
the compiler does catch it — it just does not say what it is.

### 6. Verification

`npm test` **500 / 500** (496 before, plus four on the axis). `tsc --noEmit` and
`tsc -p tsconfig.node.json --noEmit` both clean.

**All twelve combinations** — 390x844 and 1280x800, dark and light, `en-CA` / `fr-CA` /
`es`, on the home view AND the options view: **`trueOverlaps` 0, `hScroll` false, clipping
audit 0 hits, 0 console and page errors**, axis present in all twelve.

**Computed contrast** on every new or changed string, read off the live page in both themes
(not from the tokens — a `var()` that resolves to nothing computes to invalid silently):
`.opt-axis-label` 6.02 dark / 4.89 light, `.opt-num` 14.5 / 17.8, `.opt-unit` 6.14 / 6.77,
`.opt-dest` 14.5 / 17.8, `.opt-meta` 6.14 / 6.77, `.evidence-chip` 5.32 / 5.31, `.pill`
4.95 / 6.05. All pass.

**One measured failure, and it is not this pass's:** `.opt-go-label` / `.opt-go-sub` read
**4.38:1** against the 4.5 they need, identically in both themes — so it is the route
colour against `readableOn`'s white, not a theme bug. `.opt-go` is untouched here. The fix
is not a colour tweak: `readableOn` returns *the better of white and near-black*, which is
not the same as *a colour that clears 4.5:1*, and making that guarantee real changes a
helper `RouteBadge` uses everywhere. It needs its own pass.

Frame timings, foregrounded, 4.5 s of `requestAnimationFrame` with `triggerRepaint`:
**p50 4.2 / p95 4.9 / worst 21.4 ms**, against p50 4.2 / p95 5.4 / worst 27.0 measured on
the deployed build in the same session. Flat, which is what a shader change with no new
geometry costs. Camera unchanged and measured: zoom 16.182, pitch 48, FOV 16.

Evidence in the session scratchpad: `FINAL-scale-matched-400m.png` (reference, before and
after, all resampled to 0.950 m/px BEFORE cropping so a cube is the same size on screen in
every panel) and `FINAL-zoom5x-{1,2,3}.png` (the same 85 m of ground at 5x, which is where
the seams are legible and where the case for them was actually made).

**One operational note.** Iterating on a shader needs the app running, and this session did
it WITHOUT PGlite — three of whose directories have now been corrupted by hard kills — by
running `vite` and standing a 20-line proxy on :8799 that forwards `/api` to the deployed
service. No repo change, no seed, no `postmaster.pid`. The local dev build reproduced the
deployed build's camera and every measured statistic to within 0.3, which is what makes it
a legitimate place to measure.
