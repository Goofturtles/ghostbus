# GhostBus

**GhostBus is not a transit app with a ghost feature. It is an accountability engine
with a transit app attached.**

Every transit app in the world is built to predict when the bus will come. GhostBus is
built to know when it **won't** — and to keep the receipt.

The schedule a transit agency publishes is a promise. When a bus simply never shows up,
that promise is broken silently: the trip vanishes from the live map, the app quietly
recalculates to the next one, and by tomorrow there is no record it was ever supposed to
exist. Riders are told they were unlucky. GhostBus is an attempt to make that
unfalsifiable experience into a measured, public, auditable fact.

Everything below is separated into **what works today** and **what is designed but not
yet built**, because a project about honesty that overstates itself has already lost the
argument.

---

## The one rule

> **No prediction renders without its evidence.**

The API cannot express "here is an estimate" separately from "here is why" — they are
the same object. A departure either carries `{ n, windowDays, bucket }` proving the
sample behind it, or it carries no estimate at all and says *untracked*. "We don't know"
is a first-class answer, not a fallback.

That rule is why this repository contains a `METHODS.md`, a `BLOCKERS.md` full of
inconvenient measurements, and a ghost count that is currently, honestly, **zero**.

---

## What works today

Toronto TTC only. Every number here was measured, not estimated — collection window and
method noted where it matters.

### The data spine

| | Measured |
|---|---|
| Static GTFS loaded into Neon Postgres | **2,151,105** `stop_times`, **68,401** trips, **9,361** stops, **233** routes, **1,374** shapes |
| Loaded schedule board coverage | `2026-07-26 … 2026-09-05` |
| Collector | **45 s** cycle, **3** TTC GTFS-realtime feeds (vehicles / trips / alerts), 10 s timeout, per-feed exponential backoff |
| Live vehicles observed in one snapshot | **1,488** with positions |
| Service alerts distilled | **64** stored |
| Database size | **426 MB** — of which `stop_times` alone is 341 MB |
| Unit tests | **86 passing** (`npm test`) |

### The engine

- **Identity join.** TTC realtime `trip_id`s match static GTFS `trip_id`s at **~0.1%**,
  and the feed omits `start_time` and `start_date` on *every* entity — so the two
  standard ways of tying realtime to schedule are both unavailable. GhostBus instead
  reconstructs each trip's schedule from its own stop predictions and claims a static
  trip only when **≥2 stops agree within ±75 s**. Pure, unit-tested, and it refuses to
  guess on a tie.
- **Ghost detection.** A scheduled trip that is due (6–30 min past its start), not
  present, not agency-cancelled, and **absent for ≥2 consecutive cycles**. Every ghost is
  **retractable** — if the trip later appears, the row is deleted. Two circuit breakers
  (global >30% of due trips, and per-route >30% once a route has ≥4 due) suppress the
  mass-false-positive failure mode.
- **Honest-ETA engine.** `scheduled + median historical delay`, band P25–P75, gated at
  **n ≥ 8** for a (route, stop, hour) bucket, **n ≥ 20** for the (route, hour) fallback,
  and **no estimate at all** below that.
- **Trust grades A–E**, awarded only when *both* a sample-size floor and a spread ceiling
  are met (A = n ≥ 40 and ±≤4 min; E = has evidence but meets no tier). Absent entirely —
  never defaulted — for an untracked departure.
- **Ghost forecast**, with a denominator derived from hours the collector **demonstrably
  ran**, not from "days we saw anything". Chips appear only above 8% (elevated) and 20%
  (high); there is deliberately no reassuring "low risk" badge.
- **Fastify API**, poller in-process (one deployable service): `/api/health`,
  `/api/vehicles`, `/api/stops`, `/api/stops/nearby`, `/api/stops/:id/arrivals`,
  `/api/routes/:routeId/shape`, `/api/alerts`, `/api/ghosts/feed`, `/api/stats`.

### The app

- **Nearby view** — real departures for the nearest stop, with live board, evidence,
  trust chips and honest empty states.
- **Alerts tab** — the Ghost Feed and live TTC service alerts.
- **MapLibre map** — flat hand-styled vector map (both themes hand-painted layer by
  layer), **~1,700 live vehicles** as procedural voxel sprites on a single data-driven
  symbol layer, You beacon, boarding pin, walking path, and the real route shape drawn in
  red. Code-split so it never lands in the initial bundle: **79.6 KB gzip initial JS**,
  map arriving after first paint as a **256.6 KB JS + 10.0 KB CSS** chunk *(measured at
  the Phase 4 build)*.
- **Installable PWA** — web manifest, maskable voxel-ghost icons, and a hand-rolled
  zero-dependency service worker that derives Vite's content-hashed asset list at install
  time. Registered only from a production build.
- **Light and dark themes**, **en / fr-CA / es**, skeleton loading, `prefers-reduced-motion`
  honoured throughout, polling paused when the tab is hidden.

### And the number that is honestly zero

**Ghosts detected: 0.**

Not "not many". Zero, with a denominator of zero. The published TTC static board begins
**2026-07-26**, so before that date there is no calendar-active service in the database,
therefore no due trips, therefore nothing that can fail to arrive. Every
schedule-dependent feature is genuinely inert until the board activates, and the app says
so rather than filling the space with something.

**No ghost count from this project should ever be estimated, extrapolated or
annualised.** There is no number to extrapolate from yet.

---

## The finding we are proudest of

While building the collector we recorded **304,697 delay observations**. Every single one
says the bus was **exactly on time**:

```sql
SELECT delay_s, COUNT(*) FROM trip_delay_obs GROUP BY delay_s;
--  delay_s |  count
-- ---------+---------
--        0 |  304697     ← one group. There are no others.
```

*(Snapshot at 2026-07-24 21:35 ET, while the collector was still running. It kept growing
— 312,696 rows at 21:58, 314,742 by the time it was stopped — and never held more than
**one** distinct `delay_s` value: zero. The count moved; the finding did not. The table
has since been truncated; see the status note below.)*

They are all worthless, and the reason is more interesting than "the agency published bad
data".

**The TTC does not publish the `delay` field at all.** On a live snapshot of 23,335
stop-time events, `time` is present on the wire **23,335** times and `delay` is present
**0** times — verified two independent ways (`hasOwnProperty`, and
`toObject({ defaults: false })`).

But GTFS-realtime is proto2, where `delay` is an `optional int32` defaulting to `0`, and
protobuf.js materialises that default on the message prototype. So a decoded event
cheerfully **answers `0` for a field it never received** — and the collector's
idiomatic, apparently-defensive guard `if (delay != null)` passed on all 23,335 of them.

*A correct-looking null-check silently converted missing data into confident data,
304,697 times.* Nobody lied. The wire format's implicit default, the decoder's
convenience behaviour, and a reasonable guard combined to manufacture measurements out of
nothing — and the honest-ETA engine dutifully computed **81,182 aggregate buckets whose
P25, P50 and P75 are all zero**, many of them clearing the n ≥ 8 evidence gate. The
gating machinery worked perfectly on an input that was unanimously meaningless.

The fix is to stop asking the agency how late its buses are and measure it ourselves:
`delay = predicted time − scheduled time`, using our own static GTFS for the second term.

**Status, stated plainly, in two parts.**

*Done.* The write path no longer records a decoder default as a measurement. `poller.ts`
now requires `delay` to be an **own property** of the decoded event, so a field the agency
never sent stays absent instead of arriving as a confident `0` (commit `f54b1cd`). The
contaminated history — which had grown to **314,742** rows, still one distinct value — was
truncated along with the 87,955 aggregate buckets derived from it. Verified in a clean
room: with every stale process stopped and only the fixed code running, a full poll cycle
over **1,417 vehicles and 1,397 trip updates** wrote **0** observations. Absence stays
absent, the evidence gates correctly see no samples, and every departure honestly reports
"schedule only".

*Not done.* Measuring delay properly — `predicted − scheduled` against our own static
GTFS — is a harder problem than it sounds, because the realtime feed shares neither
`trip_id` nor a complete `stop_id` namespace with the schedule, and it is still being
built. Until it lands, GhostBus has **no delay measurements at all**, and it says so on
every row rather than showing a grade it cannot justify.

See `METHODS.md` §3 for the full measurement and the general lesson — with
implicit-default wire formats, only an explicit presence probe is an absence check.

This is exactly why the honesty architecture exists. A system that displays a number
without its provenance would have shown riders a confident, perfectly-sampled, completely
fabricated "on time" for months.

---

## Related work

| | What they do | Where GhostBus differs |
|---|---|---|
| **Transit, Google Maps, Citymapper, Apple Maps** | Predict *when the vehicle will arrive*, from realtime feeds. When a trip vanishes, the prediction quietly disappears with it. | GhostBus predicts arrivals too, but its primary object is the **absence** — the trip that was promised and never ran. |
| **Chicago CTA + the Transit app** | Since 2025 the CTA publishes its own cancelled bus runs, and the Transit app surfaces them **with a strike-through** in the UI. Riders finally see which buses aren't coming. | This is the closest prior art, and it is genuinely good. But it works **because the agency confesses.** It is an agency-cooperation feature. |

**The novelty claim, stated precisely.** GhostBus's contribution is
**independent, agency-cooperation-free detection of vanished trips**, a **historical
accountability ledger**, **prediction of future ghosts**, and **public receipts**.
Chicago proved riders demand exactly this — but their fix requires the agency to confess.
GhostBus doesn't need the confession.

That distinction is the whole engineering problem. Detecting a cancellation the agency
announces is a UI feature. Detecting one it doesn't announce — on a feed whose trip IDs
don't match the schedule, which omits start times and start dates, and which publishes no
standard cancellations at all — is the whole pipeline documented in `METHODS.md`: a static
pattern index, a stop crosswalk learned from live traffic (realtime `stop_id` is a different
namespace from the schedule's), an origin lock that binds a running vehicle to a scheduled
trip, the evidence gates, the confirm-and-retract cycle, and the circuit breakers.

---

## The problem, documented

Every external statistic below carries a source URL that was fetched and read. Claims
that could not be verified were **removed** rather than softened.

### Chicago: riders demanded this, and got it — from the agency

- The Regional Transportation Authority's own **Travel Information Action Plan (RTA,
  May 2025)** records, from direct user observation:
  > "Riders during user observations were impacted by 'ghost buses,' or cancelled bus
  > trips that are still shown as scheduled trips on real-time tracking mobile
  > applications and on station dynamic signage."

  — [RTA Travel Information Action Plan, May 2025](https://www.rtachicago.org/uploads/files/general/Travel-Information-Action-Plan.pdf)
- The CTA responded by **publishing cancelled bus runs publicly**, garage by garage:
  testing began in late 2024, consistent publication started in May 2025, and data from
  all CTA garages was online by early July 2025, available at `ctabustracker.com`.
  — [reported 5 August 2025](https://www.transittalent.com/articles/index.cfm?story=Ghost_Buses_May_Longer_Haunt_CTA_Riders_8-5-2025)
- Third-party apps picked it up immediately. Per Transit's policy lead Stephen Miller,
  the Transit app "has been marking canceled bus runs with a strike-through", so riders
  can see the cancellation in the same list as the arrivals — a claim independently
  visible on [Transit's own CTA route pages](https://transitapp.com/en/region/chicago/cta/bus-155):
  *"Cancelled trips are now shown with a strikethrough in the app."*

### Toronto: the reliability metric and the argument about it

- **TTCriders, *Lucky or late: A report on TTC metrics vs. rider experience*** analysed
  TTC on-time performance obtained by Freedom of Information request together with
  bunching calculations derived by TransSee from TTC realtime vehicle-location data
  (study window 1 September – 16 November 2024). It found:
  - Riders **waited 50% longer than scheduled on 10 TTC routes** due to bunching — a list
    that includes **the 510 Spadina**.
  - Riders **waited 30% longer than scheduled on 41 routes** — the 510 Spadina appears
    here too.
  - **Only 10 routes** met the TTC's own goal of being on time 90% of the time during the
    evening rush hour.

  — [TTCriders, *Lucky or late*](https://www.ttcriders.ca/bunchingreport)
- **The measurement dispute.** The same report documents how the headline number is
  produced: TTC on-time performance for buses and streetcars measures **departures from
  "end terminals"** — a vehicle counts as on time if it leaves within *"59 seconds earlier
  or five minutes later than their scheduled departure time."* The official service
  standard is **90% of trips departing end terminals on time and 60% arriving on time**.
  As the report puts it, if your bus is thirty minutes late picking you up at your stop,
  the TTC may still count it as on time.
- **The TTC's response, stated accurately.** Covering the report, CBC reported the TTC
  did not reject the criticism outright: spokesperson Stuart Green said the agency
  *"understands that there are limitations"* in terminal-only measurement, noted that
  mid-route measurement had been tested on routes 47 Lansdowne and 63 Ossington, and
  described a bunching-reduction pilot running on 11 priority routes.
  — [CBC, 23 January 2025](https://ca.news.yahoo.com/ttc-bunching-blame-widespread-delays-210826729.html)

  *(An earlier framing of this project described the TTC as having "disputed" the
  findings. On reading the coverage that is not accurate — the agency acknowledged the
  limitation. The corrected version is what appears above.)*

### And our own numbers, labelled as ours

These are GhostBus measurements, not anybody's official statistics:

| Ours | Value | Collection window |
|---|---|---|
| Delay observations collected | 304,697 — **all zero-valued, see above** | 2026-07-24 17:57 – 2026-07-25 01:07 UTC (~7.2 h) |
| Coverage of those observations | 183 routes, 8,741 stops, 13 hour-of-week buckets | same |
| Live vehicles in one snapshot | 1,488 with positions | 2026-07-24 21:35 ET |
| RT→static `trip_id` match rate | ~0.1% (2 of 1,920 sampled) | collector calibration |
| Stop-time events carrying `delay` on the wire | 0 of 23,335 | 2026-07-24 21:55 ET |
| Trip descriptors carrying `start_time`/`start_date` | 0 of 1,508 | 2026-07-24 21:35 ET |
| Standard `CANCELED` entities published by TTC | 0 (11 carry an undocumented `scheduleRelationship = 8`) | same |
| Service alerts with a usable `Effect` | 0 of 36 — all `UNKNOWN_EFFECT`, none with an `activePeriod` | same |
| **Ghosts detected** | **0** | board inert until 2026-07-26 |

---

## Designed, not yet built

Listed honestly. None of the following exists in working form today; each is part of the
tier plan, not a claim about the current build.

- **Ride Mode** — the in-vehicle experience.
- **Catch Mode's full guided choreography** — the walk path, boarding pin, verdict and
  evidence panel exist; the step-by-step guided sequence does not.
- **Focused Boarding Mode.**
- **Vancouver and the multi-city coverage engine** — the `agency` seam runs through every
  table, but only the TTC has ever been ingested.
- **Transit Passport.**
- **Rider Evidence** — rider-submitted corroboration of a ghost.
- **Accessibility Ghosts elevation** — accessibility alerts are already flagged in the
  data (`is_accessibility`); the surfaced feature is not built.
- **Offline schedule-slice cache** — the PWA shell caches the app, not the timetable.
- **Capacitor Android shell.**

### Since landed

Seven things this list used to carry have shipped and were verified against a running
build: the **PWA** (manifest, icons, service worker), the **Alerts tab / Ghost Feed**
with trust and forecast chips, the **3D voxel city** (the map is a lit isometric diorama,
not flat 2D), **search and the trip planner**, **Saved places**, **street-following walk
routing**, and **Demo Mode**.

**The walk path follows streets.** It used to be a straight line from You to the boarding
stop, which a rider correctly observed cuts through buildings. It is now a shortest-walk
A* over the basemap's own vector tiles — the same OpenStreetMap ways already on the device
to draw the roads underneath — so it costs no new network, needs no routing key, and works
the same in Demo Mode. Walk minutes are read off the geometry drawn. Where those ways are
not loaded, the app falls back to the straight line and marks it `≈`, which its own copy
defines as an estimate. It is not turn-by-turn and there is no external routing service
(`DECISIONS.md` §51).

**Search and Plan.** ⌘K (or `/`) opens a real search sheet: stops come from
`/api/stops`, routes are built from departure boards already held — so every route row
carries the stop it actually leaves from and the time it actually leaves — and a distance
is shown only when the rider's own fix makes one measurable. The Plan tab is a genuine
single-ride planner over `/api/plan`: walk, stay on one vehicle, walk. It plans **one**
ride and says so; when the schedule links the two ends only via a change of vehicle it
reports `transfer` and offers a maps app rather than inventing a connection.

**Demo Mode.** `npm run demo` (or `GHOSTBUS_DEMO=1`) replays a bundled recording of real
TTC GTFS-realtime through the identical poller, engine and ghost detector — same code
path, no branch anywhere downstream. It is not a mock: the bytes are real protobuf
captured from `bustime.ttc.ca`, and they are decoded by the same
`FeedMessage.decode` the live poller uses.

Three properties make it honest rather than merely functional:

- **It says what it is.** `/api/health` reports `mode: "demo"` and a `demo` provenance
  object — the fixture's capture window in both UTC and America/Toronto, its cadence,
  replay speed and loop count. The UI renders an amber **DEMO** badge and the line
  *"Replaying a recorded slice of real TTC data. Nothing here is live."* in all three
  locales.
- **It cannot blend with live data.** Everything a demo process observes is written under
  `agency = 'ttc-demo'`, enforced by the primary keys. The published schedule is still
  read under `'ttc'`, because a schedule is not an observation and there is only one
  published board (`DECISIONS.md` §44, §48).
- **It runs on the data clock.** Replayed frames are dated by the moment they were
  captured, not by tonight's wall clock, so countdowns and freshness stay correct instead
  of reporting the whole fleet as hours stale.

Verified on a fresh instance replaying `fixtures/ttc-demo-20260726-1040.json.gz`
(42/42 frames, no failed polls): a real departure board, 25 search hits for "King", a
`ride` plan outcome, a 119-point route shape, and 471 vehicles dated on the data clock.

---

## Run it locally

Node **20+** (developed and verified on 24). Nothing else — **no database signup, no API
keys, no accounts anywhere.**

```bash
git clone <this repo>
cd ghostbus
npm install

# 1. Load the TTC schedule. Discovers the current GTFS zip at runtime through
#    Toronto Open Data's CKAN API, so it never breaks on a re-publish.
npm run seed:toronto

# 2. Start the API and the web app together (concurrently, colour-tagged).
npm run dev
```

Then open **http://localhost:3499** — the Vite dev server, which proxies `/api` to the
Fastify API on **8799**.

### The zero-signup part

With **`DATABASE_URL` unset**, GhostBus runs against **PGlite** — a real embedded
Postgres compiled to WebAssembly, persisted under `.data/pglite`. The same migrations,
the same standard-Postgres SQL, the same `JSONB` and `ON CONFLICT` and transactions. You
get a working instance with a real database and you create an account with nobody.

To use a real Postgres instead (Neon, Render, local), set `DATABASE_URL` — see
`.env.example`, which documents every variable the code actually reads. `/api/health`
reports `dbDriver` so you always know which one you are looking at.

> Note: the seeder derives its own window from the board — every service day the loaded
> `calendar`/`calendar_dates` actually declare, rather than a rolling N days from the seed
> date. There is no window variable to set; `GHOSTBUS_SEED_WINDOW_DAYS` was **removed**
> when that landed (`DECISIONS.md` §43), and setting it now does nothing.
> `GHOSTBUS_SEED_FULL=1` still loads the entire feed unfiltered, and
> `GHOSTBUS_SEED_SKIP_DOWNLOAD=1` reuses an already-extracted feed on disk.

### Other scripts

| Command | What it does |
|---|---|
| `npm run dev:api` / `npm run dev:web` | Run either half alone |
| `npm test` | 334 unit tests — time/DST, GTFS parsing, pattern matching and the stop crosswalk, ETA percentiles, bbox, grades, forecast |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run collect` | Run the collector standalone; `GHOSTBUS_MAX_CYCLES=5` for a bounded calibration run |
| `npm run aggregate` | Recompute the delay aggregates now |
| `npm run build` | Type-check the server and build the SPA to `dist/` |
| `npm start` | Production: one process serving API + built SPA |

---

## Deploy to Render

A working blueprint is committed as [`render.yaml`](./render.yaml), verified against
Render's current Blueprint spec (`runtime`, not the deprecated `env`; `ohio` is a valid
region; `free` is a valid web-service plan; `sync: false` is the documented way to
declare a dashboard-entered secret).

1. Push the repo to GitHub, then **New → Blueprint** in Render and point it at the repo.
2. When prompted, paste your `DATABASE_URL`. **Region is set to `ohio`** because that is
   Render's us-east-2 — the same AWS region as the Neon database — so every query is
   intra-region.
3. Deploy. Then **seed once**, either from your laptop or Render's Shell:
   ```bash
   DATABASE_URL='postgresql://…' npm run seed:toronto
   ```
   Seeding is deliberately *not* in the build command: loading 2.15 million rows would
   blow the build timeout.
4. Confirm `/api/health` reports `"dbDriver": "pg"`.

**Two things that will bite you, both already handled in the blueprint:**

- `server.ts` defaults `HOST` to `127.0.0.1`, which Render cannot route to. The blueprint
  sets `HOST=0.0.0.0` explicitly. `PORT` is left unset so Render's injected value wins.
- `npm start` runs the server through `tsx`, which is a *devDependency*. Do **not** set
  `NPM_CONFIG_PRODUCTION=true` or add a prune step, or the service dies with
  "Cannot find module tsx".

### Free-tier sleep, and the keep-alive

Render **spins down a free web service after 15 minutes without inbound traffic**, and
waking it takes about a minute. Each workspace gets **750 free instance-hours per
month**.

For GhostBus this is worse than the usual cold-start annoyance: **a sleeping service is a
collector that has stopped collecting.** Ghosts are detected by watching trips that never
appear, so the ledger simply has holes for every window the service was asleep — and
those holes cluster in exactly the quiet overnight hours where service is sparse and
ghosts are most likely.

**Keep it awake with UptimeRobot:**

1. Create a free [UptimeRobot](https://uptimerobot.com/) account (free plan: 50 monitors,
   **5-minute** check interval — comfortably under the 15-minute idle timeout).
2. Add a monitor: **Monitor Type** `HTTP(s)`, **URL**
   `https://<your-service>.onrender.com/api/health`, **Interval** 5 minutes.
3. `/api/health` is a cheap in-memory read, so pinging it costs essentially nothing.

Two honest caveats. First, 24/7 pinging consumes free instance-hours continuously — 750
hours is slightly more than a 730-hour month, so one service fits, but only just.
Second, `/api/health` returns HTTP 200 unconditionally and never touches Postgres; it is
a **liveness** check, not readiness. A green monitor means the process is up, not that the
database is reachable. Check the response body.

There is one more free-tier meter worth knowing about: Neon's free plan grants 100
CU-hours/month and scales compute to zero after 5 minutes idle — which a 45-second poller
never allows. See `ARCHITECTURE.md` §1 for that arithmetic.

---

## Built with AI, and that is part of the argument

GhostBus was built with **Claude Code** (Anthropic), and the process is worth describing
because it is the same discipline as the product.

The work was **spec-driven and evidence-gated**. Each phase started from a written
specification. Every non-obvious decision and every deviation from the spec was written
down as it happened in [`DECISIONS.md`](./DECISIONS.md) — 26+ numbered entries, including
the ones where the spec turned out to be impossible. Every measured limitation went into
[`BLOCKERS.md`](./BLOCKERS.md) **at the moment it was discovered**, not retrofitted after
the fact: that is why the `trip_id` mismatch, the missing start times and the absent
`CANCELED` entities are documented as findings rather than quietly worked around. Every
dependency was verified to exist with `npm view` before it was used, and the installed
version recorded afterwards ([`TOOLKIT.md`](./TOOLKIT.md)) — which is also why that file
now states plainly that **none** of the eight suggested front-end toolkit libraries were
used, and what was hand-built instead.

The claim this project makes about AI-assisted work is narrow and testable: **an AI can
be held to an evidence standard, and the artefacts prove whether it was.** The
`delay`-field finding above is the case in point — it was caught by re-measuring a
believed-true assumption against the live feed, and the response was to purge 304,697
rows and document the failure in the README rather than to keep a number that looked
good.

That is the same rule the app follows for its users: no prediction renders without its
evidence, and "we don't know" is always available. Building it that way and documenting
it that way were one decision.

Nothing here was generated and left unverified: the feed measurements in this file were
taken by decoding live TTC protobuf, the database figures by querying the running Neon
instance, the licence list by walking `node_modules`, and the external statistics by
fetching and reading each source.

---

## Documentation

| Document | What's in it |
|---|---|
| [`METHODS.md`](./METHODS.md) | Operational definitions, every threshold and its rationale, the estimator, the forecast, and the limitations |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | The pipeline diagram, memory-first discipline, the dual pg/PGlite driver, time handling |
| [`SECURITY.md`](./SECURITY.md) | A five-minute verification checklist with real results — including the `npm audit` output we did **not** come out clean on |
| [`CREDITS.md`](./CREDITS.md) | All 304 installed packages and their licences, attribution, fonts, and an honest "none" where none |
| [`DECISIONS.md`](./DECISIONS.md) | The real build history, including the deviations |
| [`BLOCKERS.md`](./BLOCKERS.md) | Measured feed limitations, recorded when found |
| [`TOOLKIT.md`](./TOOLKIT.md) | Dependency verification, and the toolkit substitutions |

Screenshots live in [`screenshots/`](./screenshots/).

---

## Attribution and licence

Transit data — schedules and realtime — comes from the City of Toronto Open Data portal,
published by the Toronto Transit Commission, under the
[Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/):

> **Contains information licensed under the Open Government Licence – Toronto.**

Map tiles are served by [OpenFreeMap](https://openfreemap.org) using the
[OpenMapTiles](https://www.openmaptiles.org/) schema, built from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data, which is licensed under
the Open Data Commons Open Database License (ODbL). The attribution control is always
visible and never collapsed. Full terms and one honest compliance gap are recorded in
[`CREDITS.md`](./CREDITS.md) §4.

---

**Built by Arjun Sharma.**
