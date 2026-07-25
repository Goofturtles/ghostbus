# METHODS

How GhostBus decides what it knows, what it will say out loud, and what it refuses to say.

This is the methods section for the accountability engine. Every threshold below is a
real constant in the code, with the reason it has the value it has. Every number
attributed to "our data" was measured, not estimated.

**Verification stamp.** Unless noted otherwise, everything here was read out of the
source tree and re-measured against the live TTC feeds on **2026-07-24, ~21:35
America/Toronto**. Two workstreams were editing `server/` while this was written (a
delay-engine rebuild and a ghost-surfaces phase); §3.3 and §7 say precisely which
parts were verified as landed and which were verified as still in flight. Where the
code and this document disagree, the code is right and this document is stale — say
so rather than trusting the prose.

---

## 1. Operational definitions

These are the definitions the code implements, not marketing language. The
distinction between the first two is the whole product.

**Scheduled trip.** A row in the static GTFS `trips` table whose `service_id` is
active on the service date in question, per `calendar` + `calendar_dates`. Its
scheduled start is the `departure_s` (falling back to `arrival_s`) of its first
`stop_time`, resolved to an absolute instant against agency-local midnight.

**Present.** A scheduled trip is *present* in a poll cycle if the identity join (§4)
claims it from a GTFS-realtime `TripUpdate` in that cycle's snapshot. Presence is
evidence that a vehicle is actually operating that trip. Absence, on its own, is not
evidence of anything — it is a question.

**Ghost.** A scheduled trip that is **due**, **not present**, **not explicitly
cancelled by the agency**, and has been absent for at least two consecutive poll
cycles. In plain terms: *the schedule promised this trip, the trip's start time has
passed, the agency has not said it was cancelled, and nothing in the realtime feed
shows it running.* A ghost is a claim about the agency's own published promise, not a
claim about any individual vehicle.

**Officially cancelled.** A trip the agency itself declared cancelled — a GTFS-realtime
`TripDescriptor` with `scheduleRelationship = CANCELED (3)` — **and** which we could
tie to a specific static trip. Stored as `kind='cancelled'` in the same `ghosts`
table. A cancelled trip is explicitly *not* a ghost: the agency confessed, so there is
nothing to detect. §5.3 covers what happens when the agency confesses anonymously.

**Retracted.** A ghost we wrote and then took back, because the trip was subsequently
claimed (or cancelled) while still inside the detection window. Retraction is a
`DELETE`, so a retracted ghost leaves no row and never appears in the public ledger.

**Untracked.** A departure for which we have no evidence bucket clearing its threshold
(§6). Untracked departures get the schedule and nothing else — no estimate, no band,
no trust letter. "We don't know" is a first-class answer here, not a fallback.

---

## 2. Data collection

**Cadence.** One poll cycle every **45 s** (`POLL_MS`), fetching all three TTC
GTFS-realtime feeds concurrently: `vehicles`, `trips`, `alerts`. 10 s request timeout;
per-feed exponential backoff on failure from 5 s, capped at 5 min.

45 s was chosen against the feed's own behaviour, not picked for a round number. It is
short enough that the ≥2-cycle ghost confirmation (§5.2) resolves inside 90 s — well
within the 6–30 min detection window — and long enough that a full day of collection is
1,920 cycles rather than a rate-limit problem for a public feed we do not pay for.

**Freshness gate (`feedsFresh`).** The ghost scan runs only when **both** the vehicles
and trips feeds returned a fresh `200` in *this* cycle. If either failed, the cycle
collects what it can and skips ghost detection entirely. A feed outage must never be
laundered into "the buses didn't come."

**Staleness labelling.** A feed is `ok` under 90 s since its last good poll, `stale`
beyond that, `down` if it has never succeeded. `/api/health` exposes this per feed, so
the UI can degrade honestly instead of showing confident stale data.

**Retention.** `trip_delay_obs` older than **14 days** is deleted once per service day.
14 days is the same window the aggregates are computed over (§6), exported from a
single constant (`WINDOW_DAYS` in `aggregate.ts`) so the retention horizon and the
`windowDays` reported in every evidence object cannot drift apart.

---

## 3. Measuring delay — and the finding that forced a rewrite

### 3.1 What the feed claims

GTFS-realtime's `StopTimeEvent` has two relevant fields: an absolute predicted `time`
and a `delay` in seconds relative to the static schedule. The specification treats
`delay` as authoritative. The obvious implementation reads `delay` and stores it.

### 3.2 What the feed actually publishes

Independently re-measured on the live TTC trips feed at **2026-07-24 21:35
America/Toronto**, decoding one full snapshot:

| Measurement | Value |
|---|---|
| `TripUpdate` entities | 1,508 |
| `StopTimeUpdate` entries | 23,875 |
| `StopTimeEvent`s carrying a `time` | 23,141 |
| `StopTimeEvent`s carrying a `delay` field | 23,141 |
| **`StopTimeEvent`s with a NON-ZERO `delay`** | **0** |

**The TTC populates `delay` on essentially every stop-time event and the value is
always exactly `0`** — while simultaneously publishing real, varying absolute `time`
predictions in the same message. The `delay` field is structurally present and
semantically empty. An earlier project measurement over a larger sample found the same
thing: 23,664 stop-time updates, zero non-zero delays.

The same snapshot re-confirms two other feed facts this project depends on:

- `TripDescriptor.startTime` present on **0** of 1,508 trip updates and **0** of 1,488
  vehicles; `startDate` likewise **0** and **0**.
- `scheduleRelationship` histogram: **1,497 × SCHEDULED (0)**, **11 × `8`** — a value
  that does not exist in the GTFS-realtime `TripDescriptor.ScheduleRelationship` enum.
  **0 × CANCELED (3)**.
- Service alerts: **36** entities, **all 36** with `Alert.Effect = UNKNOWN_EFFECT`, and
  **0** carrying an `activePeriod`.

### 3.3 The consequence, and what we did about it

The first-generation collector trusted `delay`. Because that field is always zero, its
output was a database full of rows all saying "this bus was exactly on time," which is
both false and useless. That is not a rounding error in a side table — it was the entire
historical evidence base for the honest-ETA engine, and every percentile computed from it
was a percentile of zeros.

This was verified directly against the production Neon database on 2026-07-24, and the
result is unambiguous:

```sql
SELECT delay_s, COUNT(*) FROM trip_delay_obs GROUP BY delay_s;
--  delay_s |  count
-- ---------+---------
--        0 |  304697      ← the ONLY value present. One group. No others.

SELECT p25, p50, p75, COUNT(*) FROM agg_delay GROUP BY p25, p50, p75;
--  p25 | p50 | p75 |  count
-- -----+-----+-----+--------
--    0 |   0 |   0 |  81182      ← every aggregate bucket, all three percentiles
```

**304,697 observations, collected over ~7.2 hours across 183 routes, 8,741 stops and 13
hour-of-week buckets, and every single one carries a delay of exactly zero.** They
propagated into **81,182 `agg_delay` buckets whose P25, P50 and P75 are all zero**. Many
of those buckets clear the n ≥ 8 evidence gate (§6.2), so the honest-ETA engine is
currently returning, with full confidence and genuine sample sizes behind it, the
estimate *"scheduled + 0, ± 0"*. The gating machinery is working perfectly on an input
that is unanimously meaningless — which is exactly why measuring your own inputs matters
more than gating them well.

The correction is to stop asking the agency how late its buses are and measure it
ourselves:

```
delay = predicted absolute time (from the realtime feed)
      − scheduled absolute time (from our own static GTFS, for that trip and stop)
```

Both sides of that subtraction are real data. The left side is the agency's own
prediction of when the vehicle will be at the stop; the right side is the agency's own
published promise of when it should be. The difference is the quantity the `delay`
field was supposed to contain.

**Verification status — read this before quoting any delay number.** At the stamp at the
top of this file:

- `server/src/poller.ts` had **not yet been rewritten**. Its observation path still reads
  the feed's `delay` field, and its identity join still reconstructs
  `scheduled = predicted − delay`. The rewrite was in flight in a parallel workstream.
- The **304,697 information-free rows were still present** in the production database,
  and `agg_delay` was still derived from them. The purge and recomputation had not yet
  been run.

So until that work lands: the collector's delay observations remain information-free for
the reason above, every honest-ETA estimate resolves to the bare schedule with a zero
band, and the join's reconstruction degenerates to `scheduled ≈ predicted` (§4.3). This
is stated plainly rather than papered over — the finding is only worth anything if its
consequence is reported with the same precision.

### 3.4 Which observations count

Independent of how delay is computed, an observation is only written when the vehicle
has actually **passed** the stop — either its `stop_sequence` is behind the vehicle's
`current_stop_sequence`, or the event time is already in the past. A prediction about
the future is not a measurement.

- Observations with `|delay| > 24 h` are dropped as feed corruption.
- One observation per `(trip, stop, service_date)`, enforced both by an in-memory
  dedupe (so a restart does not hammer the database) and by a DB `UNIQUE` constraint
  with `ON CONFLICT DO NOTHING` (so the in-memory dedupe is not the only guard).
- Each observation is bucketed by the **scheduled** hour-of-week, not the actual event
  hour. A bus scheduled at 08:58 and running 6 minutes late belongs in the 08:00
  bucket, because that is the bucket a rider planning an 08:58 departure will read.

---

## 4. The identity join — matching realtime to schedule without a shared ID

### 4.1 Why a join is needed at all

Ghost detection requires knowing which *scheduled* trips are running. The natural key
is `trip_id`. On the TTC that key does not work:

> **Measured: realtime `trip_id`s match static GTFS `trip_id`s at ~0.1%** (1,920
> sampled realtime trip ids, 2 matched). The realtime identifiers come from the
> agency's NextBus/Umo-derived pipeline and are internal to it.

Naively trusting `trip_id` would mark essentially every scheduled trip absent and emit
a 100% false-positive ghost storm. Milestone 0 shipped a hard gate for exactly this:
measure the match rate every cycle and suppress all ghost emission below 50%.

The GTFS-realtime spec's other standard identity key is
`(route_id, start_date, start_time)`. That is also unavailable: as re-measured in §3.2,
`startTime` and `startDate` are absent from **every** trip descriptor and **every**
vehicle in the feed.

### 4.2 What the join actually does

What the feed *does* carry per `StopTimeUpdate` is a `stop_id`, a predicted `time`, and
a `route_id` that genuinely matches static (174 of 175 distinct route ids present in
our `routes` table). So the join uses the schedule itself as the identity.

For each stop a realtime trip covers, reconstruct the scheduled second at that stop,
convert it to seconds-past-service-midnight, and look it up in an inverted index keyed
`(route_id, stop_id)` over every static stop-time we have loaded. Each agreeing stop
casts one vote for that static trip.

| Parameter | Value | Why |
|---|---|---|
| `JOIN_TOL_SEC` | **± 75 s** | Wide enough to absorb prediction rounding and the feed's own quantisation; narrow enough that adjacent trips on a frequent route (TTC headways on the busiest routes are minutes, not seconds) do not both fall inside the window. |
| `JOIN_MIN_VOTES` | **≥ 2 stops** | One coincidental time alignment on a busy route is noise. Two agreeing stops on the same route is signal. A single vote claiming a trip would *fabricate presence* and thereby **hide a real ghost** — the failure mode that matters most, since it makes the product silently under-report. |
| Tie handling | **left unmatched** | If the top two candidate static trips tie on votes, the realtime trip is counted as ambiguous and claims nothing. Guessing between two trips would be a coin flip presented as a fact. |
| Assignment | **greedy 1:1, by descending votes** | A static trip can be claimed at most once per cycle; when two realtime trips want the same static trip the stronger evidence wins and the loser falls back to its next-best candidate. Order-independent by construction. |

The claim logic lives in `server/src/join.ts`, is pure (no database, no clock), and is
unit-tested for the exact-match, tolerance-edge, double-claim, unmatched, day-wrap, and
ambiguous cases.

### 4.3 The honest state of the join today

Two independent things currently hold the measured live join rate at **0.0%**:

1. **Board offset.** The loaded static GTFS board covers **2026-07-26 … 2026-09-05**.
   The clock is 2026-07-24. The trips currently running belong to the *previous* board,
   which is not in our database, so there is nothing correct for them to match. An
   independent probe found 3.8% of realtime trips get exactly one coincidental vote and
   **0%** get the required two — the ≥2-vote threshold is doing precisely its job.
2. **The `delay = 0` finding.** While the join reconstructs
   `scheduled = predicted − delay` and `delay` is always zero, the reconstruction
   collapses to `scheduled = predicted`. That is exact only for a perfectly on-time
   trip; a trip running 4 minutes late will miss its true schedule slot by 240 s, far
   outside the ±75 s tolerance. The delay-engine rewrite (§3.3) removes this by
   matching predicted times against the static timetable directly.

Neither of these is a bug in the mechanism, and neither is hidden: the join rate,
unmatched counts, and board coverage are all reported every cycle and exposed on
`/api/health`.

---

## 5. Ghost detection

### 5.1 The detection window

A scheduled trip enters the candidate set when its scheduled start is between
**6 minutes** and **30 minutes** in the past.

- **`GHOST_MIN_AGE_MS` = 6 min.** Below this, absence is unremarkable: a vehicle can be
  seconds from its terminal, a trip update can arrive on the next 45 s poll, and normal
  operational slack routinely exceeds a couple of minutes. Six minutes also sits just
  past the TTC's own on-time tolerance — the agency itself counts a departure as "on
  time" up to **5 minutes late** ([TTC Service Standards, via
  TTCriders](https://www.ttcriders.ca/bunchingreport)). Calling a trip a ghost before
  the agency would even call it *late* would be indefensible.
- **`GHOST_MAX_AGE_MS` = 30 min.** Beyond this we stop watching. A trip that has been
  absent for half an hour is either a genuine no-show (already recorded) or belongs to
  a data problem we cannot resolve retroactively.

### 5.2 Confirmation and retraction

A ghost is a public accusation, so it has to survive two tests.

- **Confirmation — `GHOST_CONFIRM_MISSES` = 2 consecutive cycles.** A due trip must be
  absent in two successive polls (≈90 s apart) before a row is written. This kills the
  single-dropped-poll false positive and the trip that is simply claimed one cycle
  late. One missed poll is never a ghost.
- **Retraction.** Every ghost row this process writes is tracked. If the trip is later
  claimed — or turns out to be cancelled — while still inside the 30-minute window, the
  row is **deleted** and the retraction counted and logged. An unreconciled false
  positive would break the only promise the product makes, so a ghost is falsifiable by
  design. Because retraction is a delete, the public ledger never contains a
  "retracted" state to render; it simply never had the event.
- Both bookkeeping maps are pruned when a trip leaves the window, so neither grows
  unbounded across a long-running process.

### 5.3 Circuit breakers

A mass no-show is almost always a feed outage or our own bug, not a city-wide collapse.
Two breakers, both suppressing emission and logging loudly:

| Breaker | Condition | Rationale |
|---|---|---|
| **Global** | confirmed ghosts > **30%** of this cycle's due trips | System-wide implausibility. Emitting here would flood the ledger with garbage and destroy its credibility permanently. |
| **Per-route** | a route with **≥ 4** due trips would emit ghosts for > **30%** of them | A board update or feed glitch touching a handful of routes stays far under the global threshold and would slip straight through a global-only breaker. The ≥4 minimum stops a route with 2 due trips from tripping on a single legitimate ghost. |

Cycles where a breaker fires are counted (`massGhostTrippedCycles`) rather than
silently discarded, so suppression is itself auditable.

Additionally, the ghost scan is skipped entirely while a static-context reload is in
flight — mid-reload, the trip map may already be the new board while the join index is
still the old one, which would make every new-board trip look absent.

### 5.4 Officially-cancelled trips

A `CANCELED` entity is identified by direct static `trip_id` match first, then by an
identity-join claim. Only an identified trip is labelled `kind='cancelled'`. Anything
left is **counted, never guessed** (`canceledUnidentified`).

A cancelled trip is excluded from the ghost confirmation loop, and if a ghost row was
already written for it, that row is retracted so the cancellation wins — otherwise the
ghost insert would win the `ON CONFLICT` and the cancellation would be silently
dropped, inflating the ghost count and undercounting cancellations.

**On the TTC today this path is honestly dormant.** As re-measured in §3.2 the feed
publishes **zero** standard `CANCELED` entities. Worse, the ones it might publish would
be *anonymous*: TTC `CANCELED` entities ship no `stop_time_update`, no `start_time`,
and no `start_date`, so they cannot win a ≥2-stop join and cannot be placed on a
schedule. The honest consequence is that an officially-cancelled-but-anonymous TTC trip
surfaces as a **ghost** via the absence path rather than as a distinct "cancelled"
label. That is a feed limitation, not a bug; if the TTC ever publishes identifiable
`CANCELED` entities, the path activates with no code change.

---

## 6. The honest-ETA estimator

### 6.1 The estimator

For a departure on route *r* at stop *s* scheduled at hour-of-week *h*:

```
estimate  = scheduled + median(historical delay for that bucket)
band      = [scheduled + P25 , scheduled + P75]
```

Median rather than mean because transit delay distributions have a long right tail —
one 40-minute short-turn should not move the number a rider plans around. P25–P75 (the
interquartile range) rather than a standard deviation for the same reason: it is a
robust statement of "half of the observed trips landed in here" that survives outliers
without any distributional assumption.

Percentiles are continuous (linear interpolation between closest ranks), matching
Postgres `percentile_cont`, but computed **in JavaScript** so the numbers are identical
on the `pg` and PGlite drivers rather than subtly diverging by backend. `percentile_cont`
support is probed and logged on each run for the record; the JS path is used regardless,
for cross-driver determinism.

Aggregates are recomputed over a trailing **14-day** window on API boot and hourly, and
each table is rebuilt inside a transaction so a reader never sees a half-written
aggregate.

### 6.2 Evidence gating — the rule that makes it "honest"

Every departure carries an evidence object `{ n, windowDays, bucket }`, and the estimate
is chosen by hard thresholds with no soft fallback:

| Bucket | Key | Minimum n | Why this threshold |
|---|---|---|---|
| `stop-hour` | (route, stop, hour-of-week) | **n ≥ 8** | The most specific bucket, and the one a rider's question actually maps to. 8 is roughly a week of a moderately frequent route at that stop-hour — enough for a median and quartiles to mean something, low enough that a real signal is not withheld for a month. |
| `route-hour` | (route, hour-of-week) | **n ≥ 20** | The fallback loses stop-level specificity, so it must earn the substitution with substantially more data — the estimate is now about the route's behaviour at that hour, not that corner's. |
| `none` | — | — | **No estimate is returned at all.** `estimateMs`, `bandLowMs`, `bandHighMs` and `medianDelaySec` are all `null` and the row is schedule-only. |

**A confident number is never returned without the evidence that supports it.** This is
the architectural commitment the whole product is named after: the API cannot express
"here is an estimate" separately from "here is why," because they are the same object.

### 6.3 Trust grade

The arrivals contract carries an optional `grade` — a letter **A–E** derived from the
sample size behind the estimate and the width of the P25–P75 spread, plus the `± X min`
the UI shows. It is **absent, not defaulted**, whenever `evidence.bucket === 'none'`; an
untracked departure has no letter and the UI must say "untracked."

**Verification status:** the `TrustGrade` contract is defined in `shared/types.ts` and
imported by `server/src/api.ts`, but at the stamp at the top of this file the tier table
and `gradeFor` implementation had not yet landed in `api.ts`. Treat the specific tier
boundaries as unverified until the code is re-read.

---

## 7. The ghost forecast

The forecast answers a different question from detection: not *did this trip vanish*
but *how often does this route×hour vanish*.

**Method.** For a `(route, hour-of-week)` cell, over a trailing window:

```
ghost rate = ghosts recorded in that cell / scheduled trips in that cell
```

Both numerator and denominator are counted over the **same** watched hour cells — a
rate computed against hours we were not collecting would be arbitrarily deflated by our
own downtime, which is the classic way this kind of metric lies.

**Gating.** The `GhostRisk` field is present on a departure **only** when the cell both
(a) clears a sample-size gate on the denominator and (b) shows a rate that is genuinely
elevated. Levels are `elevated` and `high`. A quiet route simply has no field — there is
no "low risk" badge, because a badge saying "low risk" on a cell with three observations
is a fabrication wearing a calm expression. The response carries `rate`, `n`, `ghosts`
and `windowDays` so the number can be audited by whoever reads it.

The denominator query is expensive, so it is recomputed on a **30-minute** refresh
(`FORECAST_REFRESH_MS`) rather than per request.

**Verification status:** `GhostRisk` is fully specified in `shared/types.ts` and
imported by `api.ts`, and `FORECAST_REFRESH_MS` is present in `api.ts`. The
`ghostRiskFor` implementation and its exact thresholds had **not** landed at the stamp
at the top of this file. The method above is the design intent; the specific gate values
must be read from the code before being quoted anywhere.

---

## 8. Time handling

All agency-local time arithmetic goes through the built-in `Intl` API against IANA
`America/Toronto` — no manual UTC offsets exist anywhere in the codebase. That covers:

- **GTFS `>24:00:00` times.** Stored as seconds-past-service-midnight integers, so
  `25:30:00` is `91800` and a trip that starts at 00:30 on the *previous* service day
  resolves correctly.
- **DST.** EST/EDT transitions are resolved by the tz database rather than by us. A
  spring-forward night does not silently shift every departure by an hour.
- **`hour_of_week`** (0–167, Monday 00:00 = 0), the bucketing key for all aggregates.
- **Service-day rollover.** Ghost detection scans *both* today's and yesterday's active
  service, because a past-midnight trip belongs to yesterday's service date.

---

## 9. Limitations

Stated plainly, because a methods section that omits these is advertising.

**9.1 The `trip_id` mismatch is load-bearing.** Ghost detection does not rest on a
shared identifier — it rests on a reconstruction (§4). The reconstruction is exact only
when the realtime feed and the loaded static board describe the same schedule. Whenever
that assumption weakens, the join rate falls, and a lower join rate means more trips
look absent. The ≥2-vote threshold and the mass-ghost breakers are what keep that
failure mode from becoming a wall of false ghosts, but they achieve it by
**under-reporting**: when in doubt, GhostBus stays quiet. The bias is deliberate and it
is one-directional — GhostBus will miss ghosts before it invents them.

**9.2 Board-transition inertness.** The published TTC static board runs
**2026-07-26 … 2026-09-05**. Before 2026-07-26 there is **zero calendar-active service**
in our database, therefore zero due trips, therefore **the ghost count is an honest
zero**. It is not a low number, an early number, or a number to extrapolate from — the
denominator is zero. No ghost count for this project should ever be estimated,
projected, or annualised. Schedule-dependent features are genuinely inert until the
board activates, and the app says so in the UI rather than filling the space.

**9.3 No ground truth.** There is no independent record of which TTC trips actually
operated. We cannot compute precision or recall for ghost detection, because there is
nothing to compute them against. Every guard in §5 is therefore a *design* argument
about failure modes, not a *measured* false-positive rate. Anyone reading this should
treat "GhostBus detected N ghosts" as "N scheduled trips satisfied the definition in
§1 under the thresholds in §5" — which is exactly what it says and no more.

**9.4 Observation window and survivorship.** The historical evidence base is only as
good as our uptime:

- Aggregates cover a trailing 14 days and no longer. A route's behaviour before that is
  invisible to the estimator.
- Hours during which the collector was not running contribute nothing. On a free hosting
  tier that spins down after 15 minutes of inactivity, those holes are systematic rather
  than random — they cluster in exactly the low-traffic overnight hours where service is
  sparse and ghosts are most likely. The keep-alive in the README exists for this reason,
  and it is a mitigation, not a fix.
- Delay observations are only written for stops a vehicle **passed** while we were
  watching. A trip that vanished entirely contributes no delay observations at all — so
  the delay distributions are conditioned on the trip having run. **The honest-ETA
  numbers describe how late buses are *given that they came*.** Ghosts are the other
  half of the story, and combining the two into a single "expected wait" would be a
  survivorship-biased number dressed up as a complete one. GhostBus deliberately keeps
  them separate.

**9.5 Straight-line walking.** The walk path drawn on the map is as-the-crow-flies.
There is no routing engine in this tier, and the UI presents it as an indicator rather
than a route.

**9.6 Single agency.** Everything above is measured on the TTC. The schema carries an
`agency` seam throughout, but no second agency has been ingested, and none of these
thresholds have been validated against another feed's quirks.

---

## References

- TTCriders, *Lucky or late: A report on TTC metrics vs. rider experience* —
  <https://www.ttcriders.ca/bunchingreport> (TTC on-time definition: departure from an
  end terminal within 59 s early to 5 min late).
- GTFS Realtime Reference — <https://gtfs.org/documentation/realtime/reference/>
  (`StopTimeEvent.delay`, `TripDescriptor.ScheduleRelationship`, `Alert.Effect`).
- Project decision log: `DECISIONS.md`. Measured feed findings: `BLOCKERS.md`.
