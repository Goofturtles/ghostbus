# ARCHITECTURE

One process, one database, one promise: nothing is displayed that cannot be traced back
to something measured.

---

## The pipeline

```
   ┌──────────────────── TTC GTFS-realtime (public, unauthenticated) ────────────────────┐
   │   bustime.ttc.ca/gtfsrt/vehicles        trips        alerts                          │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  every 45 s · 10 s timeout · per-feed exponential backoff
          │  EVERY optional scalar read through pb.ts — presence, never a proto2 default
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  COLLECTOR                     server/src/poller.ts                                  │
   │  decode protobuf → in-memory vehicle map (~1,200 live) + 6-deep position ring buffer │
   │  ══ RAW PINGS STOP HERE. THEY NEVER TOUCH POSTGRES. ══                               │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  one decoded snapshot per cycle, handed to the engine
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  DELAY ENGINE            server/src/engine.ts — owns the state, the SQL, the order   │
   │                                                                                      │
   │   patterns.ts   STATIC PATTERN INDEX   1,252 patterns from 68,401 trips              │
   │        │        keyset-paged 200k rows at a time, interned ids, Int32Array times     │
   │        │        built in the background (107.8 s over Neon), swapped in atomically   │
   │        ▼                                                                             │
   │   xwalk.ts      LEARNED STOP CROSSWALK — the two stop-id namespaces are disjoint     │
   │        │         a. geometric anchor   STOPPED_AT vehicle → nearest stop on route    │
   │        │                               ≤80 m, ≥15 m clear of the runner-up           │
   │        │         b. RT pattern merge   ≥3 shared sequences, zero conflicts,          │
   │        │                               never longer than the route's static max      │
   │        │         c. resolve to fixpoint  ≥2 anchors, ≤8 iterations, transitive       │
   │        │         d. promote            2 patterns agree, or geo residual ≤60 m       │
   │        ▼         usable for a delay row only if confirmed ∧ confidence ≥ 0.60        │
   │   bind.ts       ORIGIN LOCK — capture the trip at BIRTH, bind ONCE, never re-solve   │
   │        │        band [−180, +420] s · runner-up margin ≥120 s · headway ≥300 s       │
   │        ▼                                                                             │
   │   delay.ts      SETTLE AND EMIT   delay_s = event_epoch_s − sched_epoch_s            │
   │        │        scheduled time comes from OUR OWN stop_times, never from the feed    │
   │        ▼        a stop still in the future is never emitted                          │
   │   gates.ts      boardActive · xwalk occurrence coverage ≥50% · cross-route ≥85%      │
   │                 monotonicity ≤5% · board agreement ≤300 s                            │
   │                 ANY FAILURE ⇒ WRITE NOTHING, AND NAME THE GATE AND THE REASON        │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  the static trips currently bound = "present"
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  GHOST SCAN + ALERTS           server/src/poller.ts                                  │
   │  due 6–30 min · absent ≥2 consecutive cycles · not cancelled                         │
   │  retracted (DELETEd) if the trip is later bound or cancelled inside the window       │
   │  breakers: global >30% of due · per-route >30% once a route has ≥4 due               │
   │  alerts: current snapshot upserted by alert_id                                       │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  only distilled events are written
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  POSTGRES        Neon (pg)  ·  or embedded PGlite when DATABASE_URL is unset         │
   │  static GTFS: routes · stops · trips · stop_times · shapes · calendar · calendar_dates│
   │  events:      trip_delay_obs (14-day retention) · ghosts · service_alerts            │
   │  audit trail: rt_stop_anchor · rt_stop_xwalk(_votes) · rt_pattern · rt_trip_binding  │
   │               · sched_slot_claim   — written for inspection, never read back         │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  boot + hourly, whole tables rebuilt inside a transaction
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  AGGREGATES                    server/src/aggregate.ts                               │
   │  only method='sched_diff' ∧ confidence='high' ∧ xwalk_conf ≥ 0.60 is evidence        │
   │  agg_delay        (route, stop, hour-of-week) → n, n_trips, P25, P50, P75            │
   │  agg_delay_route  (route,       hour-of-week) → n, n_trips, P25, P50, P75            │
   │                                                        trailing 14 days              │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  PROMISE ENGINE                server/src/eta.ts + api.ts                            │
   │  estimate = scheduled + median delay,  band = P25…P75                                │
   │  evidence gate: stop-hour n ≥ 8  ·  else route-hour n ≥ 20  ·  else NO ESTIMATE      │
   │  trust grade A–E from (n, spread); ghost-risk chip only above 8 scheduled trips      │
   │  every response carries { n, windowDays, bucket } — the number and its warrant       │
   └──────┬──────────────────────────────────────────────────────────────────────────────┘
          │  JSON typed once in shared/types.ts
          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────────┐
   │  API  Fastify — /api/health · /vehicles · /stops · /stops/nearby · /stops/:id/arrivals│
   │                 /routes/:id/shape · /alerts · /ghosts/feed · /stats                  │
   │                 + serves the built SPA in production                                 │
   ├─────────────────────────────────────────────────────────────────────────────────────┤
   │  UI   React + TypeScript · MapLibre · procedural voxel sprites · en / fr-CA / es     │
   └─────────────────────────────────────────────────────────────────────────────────────┘

   ONE PROCESS. The collector is not a separate service — server.ts calls
   createPoller(db).start() in-process, so the API reads live vehicle state
   straight out of the same memory the poller writes it to. No queue, no IPC,
   no second dyno to keep warm on a free tier.
```

The algorithmic detail behind the DELAY ENGINE box — every threshold, and why it has the
value it has — is `METHODS.md` §3. What follows here is why the *system* is shaped this way.

---

## 1. Memory-first: raw pings never reach Postgres

This is the load-bearing architectural decision, and it was forced by arithmetic.

**What the feed produces.** The vehicles feed carries roughly **1,190–1,200 vehicles with
positions** per snapshot on the current run (measured, `.data/collector.log`, 2026-07-25;
weekday snapshots earlier in the project ran ~1,400–1,500). At a 45 s cadence that is
`86,400 / 45 = 1,920` cycles per day, or about **2.3 million position rows per day** if each
ping were persisted.

**What that would cost.** A comparable narrow table in the same database gives a real
per-row figure rather than a guess: `rt_stop_anchor` holds **2,943 rows in 536 kB**
including its index — about **187 bytes per row** for a row of three text ids, four
numerics and two timestamps, which is very close to the shape of a position ping. So
persisting raw pings would cost roughly **430 MB per day**.

**What we have.** Neon's Free plan allows **0.5 GB of storage per project**. Measured
2026-07-25, the database is **378 MB**, of which `stop_times` alone is **341 MB** (2,151,105
rows — the static TTC schedule is simply large). That leaves roughly **120 MB** of headroom.

> **Raw pings would exhaust the entire remaining free-tier budget in under seven hours.**

So they do not get written. Positions live in a `Map<vehicleId, VehicleState>` inside the
process, plus a 6-deep ring buffer per vehicle for heading derivation, and vehicles are
evicted after 10 cycles without a sighting. The API reads that map directly.

**What gets written instead** is the *distillate* — the small number of facts worth keeping:

| Written | Not written |
|---|---|
| A delay observation, once per (trip, stop_sequence, service-day), for a **settled** stop on a **bound** trip | Every position ping |
| A ghost or cancellation event, once per (trip, scheduled start) | Every trip-update snapshot |
| The current service-alert snapshot, upserted by `alert_id` | Every intermediate prediction |
| The engine's own evidence — anchors, crosswalk votes, pattern resolutions, bindings | Anything that would let a delay be reconstructed from a feed-supplied number |

This is not only a cost decision. Two other things fall out of it:

- **Privacy.** There is no historical archive of vehicle movement to leak or subpoena.
  See `SECURITY.md` §7.
- **Honesty.** The database contains *claims*, not *telemetry*. Every row in `ghosts` is a
  statement GhostBus is prepared to defend; every row in `trip_delay_obs` is a completed
  measurement at a stop a bound vehicle actually settled at, carrying both epochs so it is
  recomputable from itself. Nothing in the database is raw material awaiting interpretation.

**The audit tables are the one deliberate exception, and they are not a cache.**
`rt_stop_anchor`, `rt_stop_xwalk`, `rt_stop_xwalk_votes`, `rt_pattern`, `rt_trip_binding`
and `sched_slot_claim` exist so the promoted winner in the crosswalk is always recomputable
from the evidence behind it, and so a binding can be inspected after the fact. The engine
**writes them and never reads them back**: every process restart re-learns the crosswalk
from an empty map. That is a real operational cost (`METHODS.md` §9.3) accepted in exchange
for not having a persisted-state format that could silently disagree with the code that
produced it.

**The cost that remains.** Storage is not the only free-tier meter. Neon's Free plan also
grants **100 CU-hours/project/month** — about 400 hours at 0.25 CU — and scales compute to
zero after 5 minutes of inactivity, a behaviour the Free plan cannot disable. A 45-second
poller never lets that idle timer expire, so a continuously-running collector burns
wall-clock compute for the whole month (~730 h) and will exhaust the monthly allowance in
roughly **17 days**. There is no clever fix inside this architecture; it is a real limit of
running a continuous observer on free infrastructure, and it is recorded here rather than
discovered later.

---

## 2. Why the engine is five pure modules and one impure one

`engine.ts` owns the state that has to survive a cycle, all the SQL, and the order of
operations. Everything algorithmic lives in modules with **no database, no clock and no
network**: `patterns.ts`, `xwalk.ts`, `bind.ts`, `delay.ts`, `gates.ts`.

That split is not tidiness. It is what makes the claims in `METHODS.md` checkable: the
origin-lock margin test, the crosswalk promotion rule, the settle rule and every gate are
exercised by unit tests that pass a plain object in and read a plain object out
(`server/src/{patterns,xwalk,bind,delay,gates}.test.ts`), with no fixture database and no
recorded feed. A reviewer can change a threshold and watch exactly one test fail.

The per-cycle order in `runCycle` is fixed and matters:

1. accumulate geometric anchors from `STOPPED_AT` vehicles;
2. cluster realtime trip updates into RT patterns;
3. resolve those patterns to static patterns, iterating to a fixpoint, and promote the stop
   identities that implies;
4. capture births, and origin-lock the ones whose pattern has become resolvable;
5. **evaluate the gates** — before anything is written;
6. settle and emit, writing only if the gates said publish.

Steps 1–3 are **calendar-independent**: the crosswalk works and warms today, months before
the loaded board activates. Steps 4–6 are gated off until it does. Births and locking still
run while suppressed so the machinery keeps warming; only the *write* is gated.

**The one thing the engine refuses to do is patch around a contradiction.** If the
crosswalk names a different stop than the bound static trip has at that sequence, the whole
trip's rows are abandoned, the binding is voided, the already-written observations for that
service date are deleted and the RT pattern is quarantined. Emitting the "good" rows from a
trip we have just proved we misidentified is precisely the failure this project exists to
avoid.

---

## 3. One deployable service

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
3. **Fewer moving parts fail in fewer ways** in a project whose credibility depends on not
   producing wrong output.

`server/src/collect.ts` still exists as a thin standalone wrapper around the same
`createPoller()` (`npm run collect`, with `GHOSTBUS_MAX_CYCLES` for bounded calibration
runs), so the collector can be exercised in isolation without a second deployment target.
The poller is a factory returning a handle, not a module of globals, precisely so both entry
points get the same code — including the same delay engine.

---

## 4. The dual driver: `pg` and PGlite

```
DATABASE_URL set    →  node-postgres Pool (max: 4)         →  Neon, us-east-2
DATABASE_URL unset  →  @electric-sql/pglite → .data/pglite  →  embedded WASM Postgres
```

Both are exposed through one small interface (`query`, `transaction`, `close`, `driver`,
`closed`) in `server/src/db.ts`, and **the same standard-Postgres SQL and the same migration
files run on both**. `/api/health` reports which driver is live, so there is never ambiguity
about what you are looking at.

**Why bother.** The specification assumed `DATABASE_URL` is always set. That assumption
costs a reviewer a database signup before they can see anything work. With PGlite,
`git clone && npm install && npm run dev` produces a running app with a real Postgres —
migrations, `JSONB`, `ON CONFLICT`, transactions, partial unique indexes — and zero accounts
created anywhere. For a project whose entire pitch is *verify me*, lowering the cost of
verification to zero is the point.

**What it constrains.** Committing to two drivers means committing to their intersection:

- **No Postgres-specific extensions**, no PostGIS. Proximity search is therefore a
  bounding-box prefilter in SQL (using the `(agency, lat, lon)` range) followed by an exact
  Haversine filter in JavaScript — fine at 9,361 stops and not at nine million. The delay
  engine's own geometry is likewise plain arithmetic: a local equirectangular approximation
  centred on Toronto, whose error against a full haversine is far below a metre at the
  <200 m distances it discriminates (`metres` in `xwalk.ts`).
- **Percentiles are computed in JavaScript**, not with `percentile_cont`. The function is
  probed and its availability logged on every aggregation run for the record, but the JS
  implementation is used regardless so `agg_delay` is byte-identical across drivers. A
  statistic that changes value depending on which driver produced it is not a statistic.
- **Batched writes, not per-row writes.** PGlite is single-threaded WASM and Neon's free
  pool is small, so inserts are built as multi-row `VALUES` statements (500 rows per
  statement in the collector and the engine, 1,000 in the seeder) and committed in
  40,000-row transactions rather than one enormous one. Same code path, both drivers, no
  `COPY`.
- **`ON CONFLICT DO UPDATE` cannot name one key twice in a single `VALUES` list** — Postgres
  rejects the whole statement. Since RT patterns are identified by a content hash, two
  pattern objects can legitimately carry one identity, and this actually broke the crosswalk
  persist on three of eight cycles against the live feed. Every batch upsert now collapses
  on its conflict key first (`dedupeByKey` in `engine.ts`).

**Where the seam shows.** `shapes.points` is `JSONB`; `pg` returns it already parsed while
PGlite may hand back text, so the shape endpoint parses defensively. That is the only place
in the codebase where the two drivers required different handling, and it is handled by
accepting both rather than branching on `db.driver`.

---

## 5. Time is agency-local, always

Every time calculation resolves through the built-in `Intl` API against IANA
`America/Toronto`. There is not a single hardcoded UTC offset in the codebase.

**Why this is not paranoia.** Four concrete failure modes are avoided:

- **GTFS times exceed 24 hours by design.** A trip departing at `25:30:00` belongs to the
  previous service day. Times are stored as *seconds past service midnight* integers
  (`arrival_s`, `departure_s`), so `25:30:00` is `91800` and stays sortable, comparable and
  correct. The real maximum in the loaded board is `110861` = 30:47:41.
- **GTFS anchors its times at noon-minus-12h, not at midnight.** Anchoring at midnight
  renders a 9h GTFS time as 08:00 wall clock on the fall-back day and 10:00 on the
  spring-forward day instead of 09:00 both times — 3,600 s of fabricated delay on every
  observation, all day. `serviceEpochSeconds()` uses the spec's anchor.
- **A service day is not a calendar day.** Ghost detection scans **both** today's and
  yesterday's active service, because at 00:30 the trips that are due belong to yesterday's
  `service_id`. The service date itself is the Toronto date of `now − 4h`.
- **DST is handled by the tz database, not by us.** `torontoMidnightEpoch()` and
  `torontoNoonEpoch()` ask `Intl` with a two-pass correction, so the transition is someone
  else's solved problem.

`hour_of_week` (0–167, Monday 00:00 = 0) is the bucketing key for every aggregate, and it is
computed from the **scheduled** instant rather than the observed one — so a departure
scheduled at 08:58 that runs late still lands in the 08:00 bucket a rider planning an 08:58
trip will read.

The `agency` seam runs through every table's primary key. No second agency has been
ingested, so this is preparation rather than a feature — but it is preparation that costs
one column and saves a migration.

---

## 6. Static context is hot-reloadable

The calendar, the trip-start map and the static pattern index are loaded at boot and rebuilt
on **service-day rollover** or every **6 hours**, in the background, one reload at a time.
`loadStaticContext()` builds entirely new structures and swaps them in atomically, so a
concurrent poll cycle never observes a half-cleared calendar. The board's coverage
(`min..max` calendar date) is logged on every load and exposed on `/api/health`, so a board
change is visible rather than inferred.

The pattern index is the expensive half: it pages 2,151,105 `stop_times` rows 200,000 at a
time so the driver never materialises them all at once, interns stop ids, holds times in
`Int32Array`, and builds into a fresh object that is swapped in atomically. Measured at
**107.8 s** over Neon on the current run. It is therefore always built in the background and
never on a request path, and it polls `db.closed` between pages so a `Ctrl-C` during a
two-minute build aborts quietly instead of throwing.

Two things are deliberately invalidated rather than carried:

- **A board change wipes the crosswalk and every binding.** A new board is a new set of stop
  identities; carrying the old crosswalk across would silently map realtime stops onto a
  schedule they were never learned from. The crosswalk tables are scoped by `board_tag` for
  the same reason.
- **The ghost scan is skipped while a reload is in flight.** Mid-reload the trip map may
  already be the new board while the pattern index is still the old one, which would make
  every new-board trip look absent — a synthetic ghost storm caused entirely by our own
  bookkeeping.

**Known gap, recorded not hidden:** the API *read path* (`api.ts`) still caches the calendar
and route metadata once at boot. The poller hot-reloads; the read path does not, so after a
re-seed the arrivals endpoint can serve stale schedule metadata until the process restarts.
Low impact for a single-city deployment where re-seeding is an operator action, but it is a
real asymmetry.

---

## 7. The frontend

React + TypeScript, built by Vite, served in production by the same Fastify process from
`dist/`.

- **The map is code-split.** MapLibre is loaded through `React.lazy` behind a `<Suspense>`
  boundary whose fallback is the styled placeholder card, keeping the initial JS bundle
  small with the map arriving as a separate chunk after first paint.
- **Vehicles are one data-driven symbol layer**, never DOM markers — the difference between
  ~1,200 sprites at 60 fps and a stuttering page. Sprites are drawn procedurally on an
  offscreen canvas and cached per `(kind, colour)`; the live feed yields only four distinct
  route colours, so eight images cover the fleet.
- **Markers that need rich styling** (the You beacon, the boarding pin, the selected vehicle
  badge) *are* DOM markers, because there are at most three of them and a collision routine
  hides the lower-priority label rather than letting them overlap.
- **Polling pauses when the tab is hidden** — vehicles every 5 s, health every 20 s,
  arrivals every 30 s, all gated on `document.hidden`, all cleared on unmount.
- **`prefers-reduced-motion` is honoured**: position animations become instant fades and
  camera flights become cuts.
- **Server clock skew is tracked** (`serverNowMs − Date.now()`) so a countdown stays honest
  on a device with a wrong clock — a freshness label computed against a skewed local clock is
  exactly the kind of confidently-wrong output this project exists to avoid.

`shared/types.ts` is imported by both the server and the client, so the API contract and the
UI cannot drift apart without a type error.

---

## 8. Why the whole thing is shaped like this

Every structural decision above is downstream of one requirement: **the app must be unable
to display a claim it cannot support.**

- The evidence object is *inside* the departure payload, not alongside it, so there is no
  code path that emits an estimate without its `n`, window and bucket.
- The honesty gates are evaluated before the write, not after, and each failure has a
  distinct name and a sentence. A collector that quietly writes nothing looks identical to
  one that is broken; the whole point is that we can always say which.
- Delay is computed against our own seeded schedule and nothing else, because the one time
  this project trusted a number the feed appeared to supply, it recorded 314,742
  measurements of a protobuf default (`METHODS.md` §4).
- Ghost detection is falsifiable — confirmed over two cycles, retracted by deletion when
  contradicted — so a wrong accusation has a defined way to be taken back.
- The circuit breakers exist because the cheapest way to destroy a ledger's credibility is
  to publish one absurd day.
- Raw pings are not stored, so there is no tempting pile of unlabelled telemetry to
  reinterpret later into a nicer-sounding number.
- The dual driver exists so a sceptic can run the whole system and check.

The measured findings that shaped these choices are in `BLOCKERS.md`, the decision history
in `DECISIONS.md`, and the thresholds and their rationale in `METHODS.md`.
