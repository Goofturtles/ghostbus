# ARCHITECTURE

One process, one database, one promise: nothing is displayed that cannot be traced back
to something measured.

---

## The pipeline

```
   ┌──────────────────────── TTC GTFS-realtime (public, unauthenticated) ───────────────────────┐
   │   bustime.ttc.ca/gtfsrt/vehicles     trips     alerts                                      │
   └──────┬─────────────────────────────────┬──────────┬────────────────────────────────────────┘
          │  every 45 s, 10 s timeout, per-feed exponential backoff
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  COLLECTOR                    server/src/poller.ts                                       │
   │  decode protobuf → in-memory vehicle map (~1,500 live) + 6-deep position ring buffer     │
   │  ══ RAW PINGS STOP HERE. THEY NEVER TOUCH POSTGRES. ══                                   │
   └──────┬──────────────────────────────────────────────────────────────────────────────────┘
          │  a snapshot, not a stream
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  DISTILLER                    poller.ts + server/src/join.ts                             │
   │  ① identity join   realtime ⇢ static trip, ≥2 agreeing stops within ±75 s                │
   │  ② delay obs       one row per (trip, stop, service-day), passed stops only              │
   │  ③ ghost scan      due 6–30 min, absent ≥2 cycles, not cancelled, breakers armed         │
   │  ④ alert upsert    current snapshot, keyed by alert_id                                   │
   └──────┬──────────────────────────────────────────────────────────────────────────────────┘
          │  only distilled events are written
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  POSTGRES        Neon (pg)  ·  or embedded PGlite when DATABASE_URL is unset             │
   │  static GTFS: routes · stops · trips · stop_times · shapes · calendar · calendar_dates   │
   │  events:      trip_delay_obs (14-day retention) · ghosts · service_alerts                │
   └──────┬──────────────────────────────────────────────────────────────────────────────────┘
          │  boot + hourly, whole tables rebuilt inside a transaction
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  AGGREGATES                   server/src/aggregate.ts                                    │
   │  agg_delay        (route, stop, hour-of-week) → n, P25, P50, P75                         │
   │  agg_delay_route  (route,       hour-of-week) → n, P25, P50, P75      trailing 14 days   │
   └──────┬──────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  PROMISE ENGINE               server/src/eta.ts + api.ts                                 │
   │  estimate = scheduled + median delay,  band = P25…P75                                    │
   │  evidence gate: stop-hour n ≥ 8  ·  else route-hour n ≥ 20  ·  else NO ESTIMATE          │
   │  every response carries { n, windowDays, bucket } — the number and its warrant, together │
   └──────┬──────────────────────────────────────────────────────────────────────────────────┘
          │  JSON typed once in shared/types.ts
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │  API  Fastify — /api/health · /vehicles · /stops · /stops/nearby · /stops/:id/arrivals   │
   │                 /routes/:id/shape · /stats            + serves the built SPA in prod     │
   ├─────────────────────────────────────────────────────────────────────────────────────────┤
   │  UI   React + TypeScript · MapLibre · procedural voxel sprites · en / fr-CA / es         │
   └─────────────────────────────────────────────────────────────────────────────────────────┘

   ONE PROCESS. The collector is not a separate service — server.ts calls
   createPoller(db).start() in-process, so the API reads live vehicle state
   straight out of the same memory the poller writes it to. No queue, no IPC,
   no second dyno to keep warm on a free tier.
```

---

## 1. Memory-first: raw pings never reach Postgres

This is the load-bearing architectural decision, and it was forced by arithmetic.

**What the feed produces.** The vehicles feed carries roughly **1,488 vehicles with
positions** per snapshot (measured 2026-07-24). At a 45 s cadence that is
`86,400 / 45 = 1,920` cycles per day, or about **2.86 million position rows per day** if
each ping were persisted.

**What that would cost.** Our one comparable table gives a real per-row figure rather
than a guess: `trip_delay_obs` holds **304,697 rows in 45 MB** including indexes — about
**155 bytes per row**. So persisting raw pings would cost roughly **440 MB per day**.

**What we have.** Neon's Free plan allows **0.5 GB of storage per project**. Measured
right now, the database is **426 MB**, of which `stop_times` alone is **341 MB** (2.15
million rows — the static TTC schedule is simply large). That leaves about **86 MB** of
headroom.

> **Raw pings would exhaust the entire remaining free-tier budget in under five hours.**

So they do not get written. Positions live in a `Map<vehicleId, VehicleState>` inside the
process, plus a 6-deep ring buffer per vehicle for heading derivation, and vehicles are
evicted after 10 cycles without a sighting. The API reads that map directly.

**What gets written instead** is the *distillate* — the small number of facts that are
worth keeping forever:

| Written | Not written |
|---|---|
| A delay observation, once per (trip, stop, service-day) | Every position ping |
| A ghost or cancellation event, once per (trip, scheduled start) | Every trip-update snapshot |
| The current service-alert snapshot, upserted by `alert_id` | Every intermediate prediction |

This is not only a cost decision. Two other things fall out of it:

- **Privacy.** There is no historical archive of vehicle movement to leak or subpoena.
  See `SECURITY.md` §7.
- **Honesty.** The database contains *claims*, not *telemetry*. Every row in `ghosts` is
  a statement GhostBus is prepared to defend; every row in `trip_delay_obs` is a
  completed measurement at a stop a vehicle actually passed. Nothing in the database is
  raw material awaiting interpretation.

**The cost that remains.** Storage is not the only free-tier meter. Neon's Free plan
also grants **100 CU-hours/project/month** — about 400 hours at 0.25 CU — and scales the
compute to zero after 5 minutes of inactivity, a behaviour the Free plan cannot disable.
A 45-second poller never lets that idle timer expire, so a continuously-running collector
burns wall-clock compute for the whole month (~730 h) and will exhaust the monthly
allowance in roughly **17 days**. There is no clever fix inside this architecture; it is
a real limit of running a continuous observer on free infrastructure, and it is recorded
here rather than discovered later.

---

## 2. One deployable service

`server/src/server.ts` boots the database (running migrations), starts the poller
in-process, kicks off aggregation on boot and hourly, and serves the API — then wires
`SIGINT`/`SIGTERM` to stop the poller, close Fastify, and close the pool in order.

The alternative — a separate collector process writing to a shared database — is the
textbook shape, and it was rejected for three reasons:

1. **Free tiers charge per service.** Two services means two things to keep awake.
2. **`/api/vehicles` needs the poller's memory, not the database.** Since raw pings are
   never persisted (§1), a separate collector would have to publish live positions
   *somewhere* for the API to read — which reintroduces exactly the storage cost the
   memory-first decision was avoiding.
3. **Fewer moving parts fail in fewer ways** in a project whose credibility depends on
   not producing wrong output.

`server/src/collect.ts` still exists as a thin standalone wrapper around the same
`createPoller()` (`npm run collect`, with `GHOSTBUS_MAX_CYCLES` for bounded calibration
runs), so the collector can be exercised in isolation without a second deployment
target. The poller is a factory returning a handle, not a module of globals, precisely so
both entry points get the same code.

---

## 3. The dual driver: `pg` and PGlite

```
DATABASE_URL set    →  node-postgres Pool (max: 4)        →  Neon, us-east-2
DATABASE_URL unset  →  @electric-sql/pglite → .data/pglite  →  embedded WASM Postgres
```

Both are exposed through one 30-line interface (`query`, `transaction`, `close`,
`driver`) in `server/src/db.ts`, and **the same standard-Postgres SQL and the same
migration files run on both**. `/api/health` reports which driver is live, so there is
never ambiguity about what you are looking at.

**Why bother.** The specification assumed `DATABASE_URL` is always set. That assumption
costs a reviewer a database signup before they can see anything work. With PGlite,
`git clone && npm install && npm run dev` produces a running app with a real Postgres —
migrations, `JSONB`, `ON CONFLICT`, transactions, window functions — and zero accounts
created anywhere. For a project whose entire pitch is *verify me*, lowering the cost of
verification to zero is the point.

**What it constrains.** Committing to two drivers means committing to their intersection:

- **No Postgres-specific extensions**, no PostGIS. Proximity search is therefore a
  bounding-box prefilter in SQL (using the `(agency, lat, lon)` range) followed by an
  exact Haversine filter in JavaScript — which is fine at 9,361 stops and would not be
  at nine million.
- **Percentiles are computed in JavaScript**, not with `percentile_cont`. The function is
  probed and its availability logged on every aggregation run for the record, but the JS
  implementation is used regardless so `agg_delay` is byte-identical across drivers. A
  statistic that changes value depending on which driver produced it is not a statistic.
- **Batched writes, not per-row writes.** PGlite is single-threaded WASM and Neon's free
  pool is small, so inserts are built as multi-row `VALUES` statements (500 rows per
  statement in the collector, 1,000 in the seeder) and committed in 40,000-row chunks
  rather than one enormous transaction. Same code path, both drivers, no `COPY`.

**Where the seam shows.** `shapes.points` is `JSONB`; `pg` returns it already parsed
while PGlite may hand back text, so the shape endpoint parses defensively. That is the
only place in the codebase where the two drivers required different handling, and it is
handled by accepting both rather than branching on `db.driver`.

---

## 4. Time is agency-local, always

Every time calculation resolves through the built-in `Intl` API against IANA
`America/Toronto`. There is not a single hardcoded UTC offset in the codebase.

**Why this is not paranoia.** Three concrete failure modes are avoided:

- **GTFS times exceed 24 hours by design.** A trip departing at `25:30:00` belongs to the
  previous service day. Times are stored as *seconds past service midnight* integers
  (`arrival_s`, `departure_s`), so `25:30:00` is `91800` and stays sortable, comparable
  and correct. Storing a wall-clock time here would silently corrupt every after-midnight
  trip.
- **A service day is not a calendar day.** Ghost detection scans **both** today's and
  yesterday's active service, because at 00:30 the trips that are due belong to
  yesterday's `service_id`.
- **DST is handled by the tz database, not by us.** On the spring-forward night, a
  service-midnight epoch computed with a fixed −05:00 offset is an hour wrong for every
  departure after 02:00. `torontoMidnightEpoch()` asks `Intl` instead, so the transition
  is someone else's solved problem.

`hour_of_week` (0–167, Monday 00:00 = 0) is the bucketing key for every aggregate, and it
is computed from the **scheduled** instant rather than the observed one — so a departure
scheduled at 08:58 that runs late still lands in the 08:00 bucket a rider planning an
08:58 trip will read.

The `agency` seam runs through every table's primary key. No second agency has been
ingested, so this is preparation rather than a feature — but it is preparation that costs
one column and saves a migration.

---

## 5. Static context is hot-reloadable

The calendar, the trip-start map and the join index are loaded at boot and rebuilt on
**service-day rollover** or every **6 hours**, in the background, one reload at a time.
`loadStaticContext()` builds entirely new structures and swaps them in atomically, so a
concurrent poll cycle never observes a half-cleared calendar. The board's coverage
(`min..max` calendar date) is logged on every load and exposed on `/api/health`, so a
board change is visible rather than inferred.

The ghost scan is deliberately skipped while a reload is in flight: mid-reload the trip
map may already be the new board while the join index is still the old one, which would
make every new-board trip look absent — a synthetic ghost storm caused entirely by our
own bookkeeping.

**Known gap, recorded not hidden:** the API *read path* (`api.ts`) still caches the
calendar and route metadata once at boot. The poller hot-reloads; the read path does
not, so after a re-seed the arrivals endpoint can serve stale schedule metadata until the
process restarts. Low impact for a single-city deployment where re-seeding is an operator
action, but it is a real asymmetry.

---

## 6. The frontend

React + TypeScript, built by Vite, served in production by the same Fastify process from
`dist/`.

- **The map is code-split.** MapLibre is loaded through `React.lazy` behind a
  `<Suspense>` boundary whose fallback is the styled placeholder card, keeping the
  initial JS bundle at **79.6 KB gzipped** with the map arriving as a separate
  **256.6 KB JS + 10.0 KB CSS** chunk after first paint.
- **Vehicles are one data-driven symbol layer**, never DOM markers — the difference
  between ~1,500 sprites at 60 fps and a stuttering page. Sprites are drawn
  procedurally on an offscreen canvas and cached per `(kind, colour)`; the live feed
  yields only four distinct route colours, so eight images cover the fleet.
- **Markers that need rich styling** (the You beacon, the boarding pin, the selected
  vehicle badge) *are* DOM markers, because there are at most three of them and a
  collision routine hides the lower-priority label rather than letting them overlap.
- **Polling pauses when the tab is hidden** — vehicles every 5 s, health every 20 s,
  arrivals every 30 s, all gated on `document.hidden`, all cleared on unmount.
- **`prefers-reduced-motion` is honoured**: position animations become instant fades and
  camera flights become cuts.
- **Server clock skew is tracked** (`serverNowMs − Date.now()`) so a countdown stays
  honest on a device with a wrong clock — a freshness label computed against a skewed
  local clock is exactly the kind of confidently-wrong output this project exists to
  avoid.

`shared/types.ts` is imported by both the server and the client, so the API contract and
the UI cannot drift apart without a type error.

---

## 7. Why the whole thing is shaped like this

Every structural decision above is downstream of one requirement: **the app must be
unable to display a claim it cannot support.**

- The evidence object is *inside* the departure payload, not alongside it, so there is no
  code path that emits an estimate without its `n`, window and bucket.
- Ghost detection is falsifiable — confirmed over two cycles, retracted by deletion when
  contradicted — so a wrong accusation has a defined way to be taken back.
- The circuit breakers exist because the cheapest way to destroy a ledger's credibility
  is to publish one absurd day.
- Raw pings are not stored, so there is no tempting pile of unlabelled telemetry to
  reinterpret later into a nicer-sounding number.
- The dual driver exists so a sceptic can run the whole system and check.

The measured findings that shaped these choices are in `BLOCKERS.md`, the decision
history in `DECISIONS.md`, and the thresholds and their rationale in `METHODS.md`.
