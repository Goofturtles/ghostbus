# GhostBus

**Every transit app predicts when the bus will come. GhostBus knows when it won't.**

An independent accountability engine for the Toronto Transit Commission, with a transit
app attached. It watches the published schedule and the published realtime feed, and it
tells riders when the two stopped agreeing — without waiting for the agency to admit it.

Repo layout, setup and run instructions: **see `README.md`.**

> **Author's note before submitting.** Every number below carries the moment it was measured.
> This document was re-verified end-to-end on **2026-07-25 (collector cycles 55–84)**, against the production
> Neon database, the running collector's log, and the source. Where a figure moves on its own —
> the fleet count, the crosswalk's coverage, the bundle sizes — it is given with its window
> rather than as a round number. Anything still genuinely open is marked **[IN PROGRESS]** and
> says what "open" means. Nothing here should reach a judge as an unverified claim — that is
> the whole thesis of the project.
>
> Figures are stamped with a **date and a collector cycle number**, not a wall-clock time, and
> that is deliberate: the build machine's clock and the Neon instance's clock disagree by four
> hours, so any "15:42 ET" in this document would be an assertion we cannot actually defend.
> The service date and the cycle number are unambiguous on both. It is a small thing, and it is
> the same discipline as the rest of the document — do not state a number whose provenance you
> would lose an argument about.
>
> One structural warning, because it is the most likely way this document goes stale again:
> **`server/src/join.ts` no longer exists.** An earlier draft described it as shipped. It was
> deleted in commit `65e3843` and replaced by the delay engine described under Technical
> Execution. If you find a reference to it anywhere, that reference is wrong.

---

## Creativity & Originality

### Related work — what already exists

Arrival prediction is a solved and crowded problem. Transit, Google Maps and Citymapper
all consume GTFS-realtime and answer *"when will the next bus arrive?"* well. GhostBus
does not compete there and does not claim to.

The interesting prior art is Chicago. CTA riders named the phenomenon — *ghost buses* —
and in 2025 the agency began publishing data on which scheduled runs were cancelled; the
Transit app now renders those runs with a line through the scheduled time
([WBEZ, 2025-08-04](https://www.wbez.org/transportation/2025/08/04/cta-canceled-bus-tracker-apps-ventra-transit)).
That is the right outcome. It is also a dependency: **it required the agency to confess.**
The strike-through appears because CTA chose to publish a cancellation feed. Where an
agency does not publish one — which is most agencies, including the TTC — riders get
nothing, and the phenomenon is invisible in the data even though it is extremely visible
at the shelter.

### What GhostBus claims is new

Four things, in combination, and stated as a claim rather than an absolute:

1. **Independent, agency-cooperation-free detection of vanished trips.** GhostBus infers a
   no-show by reconciling the published static schedule against the published vehicle and
   trip-update feeds. It needs no cancellation feed, no agency API, no partnership, and no
   permission. Chicago proved riders want this; GhostBus's contribution is not needing the
   confession to provide it.
2. **A historical accountability ledger**, not just a live status. Ghosts are recorded with
   their scheduled start, their detection time, and — crucially — the window in which the
   collector was demonstrably watching, so a rate computed from them has a real denominator.
3. **Prediction of future ghosts**, not just reporting of past ones: a per-`(route, hour-of-week)`
   risk rate, gated on sample size, surfaced only when it is genuinely elevated. Built and
   rendered — but honestly dormant, because it cannot fire until the ledger has ghosts in it
   (see Known limitations).
4. **Public receipts.** Every prediction the UI shows is accompanied by the evidence behind
   it, and any prediction without sufficient evidence is *withheld rather than softened*.

If a judge finds an app doing all four for an agency that publishes no cancellation feed,
that claim is wrong and we would want to know. We are not claiming nobody does this. We
are claiming this specific combination, done independently of the agency, is the
contribution.

### The second original thing: the honesty architecture is enforced by types, not by intent

`shared/types.ts` makes a trust grade optional and `server/src/api.ts` returns `null` for
it whenever the evidence bucket is `'none'`. An unevidenced prediction is not merely
discouraged — there is no shape for it to travel in. That constraint is what caught the
bug described under Technical Execution, in our own product.

---

## Impact

### The rider problem

A bus that is 20 minutes late and a bus that never runs feel identical from the shelter,
and current apps present them identically: a number that keeps refreshing. The rider's
actual decision — *keep waiting, or walk / cab / take the other route* — depends entirely
on which one it is, and that is exactly the information no app gives them.

Scale, for Toronto alone: TTC customers took **420 million trips in 2024**, of which
**204 million were on the bus network**
([TTC news release, 2025-04-10](https://www.ttc.ca/news/2025/April/34-billion-rides-and-counting)).

### Who is hurt most

Not the commuter with an alternative. The cost of a ghost falls hardest on people whose
next option is worse:

- Shift workers on late-evening and overnight service, where headways are 20–30 minutes and
  the "just take the next one" fallback costs half an hour, not five minutes.
- Riders who cannot walk to a parallel route — the reason GhostBus stores an accessibility
  flag on every service alert (**15 of the 82 alerts** stored on 2026-07-25 are
  accessibility-flagged) and why a ghosted *accessible* departure has its own copy string
  rather than being folded into the generic case (`web/src/i18n/en.ts`, `ghost.accessibleNever`).
- Riders for whom a cab is not a fallback at all. For them, the schedule is the service.

### The accountability gap

This is the part that is not a UX problem.

The TTC measures on-time performance **at end terminals**: a vehicle counts as on time if it
departs a terminal within a window of roughly one minute early to five minutes late. There is
no published measurement of schedule adherence anywhere else along the route. Transit
advocate Steve Munro puts the consequence plainly: most riders do not board at terminals, so
service quality is not measured where riders actually see it
([Steve Munro, 2025-01-23](https://stevemunro.ca/2025/01/23/delving-into-ttc-on-time-performance/)).
The rider-advocacy group TTCriders reached the same finding in its report *Lucky or late:
A report on TTC metrics vs. rider experience* (November 2025), which documents that the TTC
does not publicly report whether vehicles hold to schedule along the route
([TTCriders](https://www.ttcriders.ca/bunchingreport)).

So the metric that governs the service is measured at the two points where almost nobody
boards. **The stop you are standing at is not measured, by anyone.** GhostBus's ledger is an
attempt to measure it from the outside, from public data, at the stop.

### Our own numbers — measured, and honestly qualified

These are GhostBus's own figures, not external statistics. Database rows queried on **2026-07-25**; live-engine rows read from the running collector's
log at **cycle 84** of that day's run.
The repo was under active development throughout, which is itself worth disclosing: two of the
corrections described under Technical Execution landed *while this table was being written*.

| Ours | Value | Window / caveat |
|---|---|---|
| Static schedule loaded (Neon Postgres) | 2,151,105 stop_times · 68,401 trips · 9,361 stops · 233 routes · 1,374 shapes | TTC GTFS board **2026-07-26 – 2026-09-05** |
| Live vehicles tracked | **1,190–1,232 per cycle** across cycles 10–55 of the current run, plus one cycle that returned 0 (a feed miss, logged not hidden) | **`.data/` and `*.log` are gitignored and are not in a fresh clone.** A range, not a round number — the fleet in service varies by hour, and a mid-afternoon Saturday is not a weekday peak |
| Realtime trip updates per cycle | 1,569–1,598 over the same cycles | |
| Delay observations stored | **0** | Not "none yet collected" — **actively refused.** The engine's first gate (`boardActive`) fails, because there is no calendar-active service today. It reports why, in words, every cycle. See Technical Execution |
| Aggregate buckets built | **0** stop-hour · **0** route-hour | Nothing to aggregate, by construction |
| Ghosts recorded | **0** | An honest zero. The loaded board does not activate until 2026-07-26, so no trip has yet been due, so nothing can yet have failed to arrive |
| Service alerts stored | **82** (15 accessibility-flagged) | Accumulated across the collection window; 36 were live in the feed on the last cycle |
| Learned stop crosswalk | **7,606** realtime stop ids seen · **3,165 confirmed** · 277 conflicted (cycle 84, in-process; the persisted table held 8,162 rows earlier the same day) | Warms independently of the calendar — this is the part of the engine that works today. See Technical Execution |
| Crosswalk occurrence coverage | **30.7%** at cycle 84, and **falling** — it peaked at 37.2% and declined from there | Its own gate demands **50%**. Diagnosed on 2026-07-25 as two learning bugs rather than a shortage of evidence, and fixed in commit `dc36469`; **the running collector predates that commit, so this number does not yet reflect the fix.** See Technical Execution |

The zeros in that table are the most important numbers in this document. It would have been
trivial to seed a plausible-looking ghost count, and — as the next section documents — this
project has already shipped a version that filled the same table with 300,000 rows of nothing.
The zeros are what the system does now when it has nothing true to say.

---

## Technical Execution

### The pipeline: memory-first by design

One Node process. A poller runs **inside** the Fastify API (`server/src/poller.ts`,
started by `server/src/server.ts`), so there is exactly one thing to deploy —
`render.yaml` declares a single `type: web` service against an external Neon Postgres.

Every 45 seconds the poller fetches three public TTC GTFS-realtime feeds
(`bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}`; no key, no registration) and then makes a
deliberate split:

- **Raw pings stay in memory.** Current vehicle positions live in a `Map` with a short ring
  buffer and are evicted after 10 unseen cycles. They are *never written to Postgres*. At
  1,500 vehicles every 45 seconds, persisting raw pings would be ~2.9M rows a day of data
  nobody queries — and, worse, would make the interesting table 99% noise.
- **Only distilled facts are persisted**: settled delay observations, the current
  service-alert snapshot, confirmed ghosts, and the delay engine's own evidence trail —
  geometric anchors, crosswalk votes, pattern resolutions and trip bindings (migration
  `server/migrations/004_delay_engine.sql`).

That last clause is deliberate and worth one sentence: **the evidence trail keeps being written
even while the engine is refusing to publish.** If it stopped, there would be no record of *why*
it refused, and "we published nothing today" would be indistinguishable from "we were down".

Idempotency is enforced by the database, not by trust: `trip_delay_obs` has
`UNIQUE (agency, trip_id, stop_id, service_date)` and every insert is `ON CONFLICT DO NOTHING`.
A process-local in-memory dedupe sits in front of it to avoid pointless round-trips during a
run; it is empty after a restart, which is exactly why the DB constraint — not the cache — is
what actually guarantees correctness across restarts. Retention is 14 days.

### The evidence gates

`server/src/eta.ts` is 77 lines and is the product's spine. An estimate is
`scheduled + median historical delay`, banded P25–P75, and the bucket that supplies those
percentiles is chosen by hard thresholds:

```
(route, stop, hour_of_week)  needs n >= 8    -> bucket 'stop-hour'
(route, hour_of_week)        needs n >= 20   -> bucket 'route-hour'
otherwise                                     -> estimate is null, bucket 'none'
```

When the bucket is `'none'` the API returns `null` for every numeric field and the UI
renders *"schedule only — not enough live history yet"*. Percentiles are computed in JS
(`percentileCont`, matching Postgres `percentile_cont`, unit-tested) specifically so the
numbers are byte-identical on the `pg` and PGlite drivers.

Trust grades (`GRADE_TIERS`: A needs n≥40 and ≤±4 min spread, down to D at n≥8 / ≤±14 min, E
for evidenced-but-untiered) and the Ghost Forecast (`GHOST_RISK_MIN_N = 8`, elevated above an
8% rate, high above 20%) are pure, exported, unit-tested functions in `server/src/api.ts`,
served by the API and rendered in `web/src/components/DepartureRow.tsx`. A departure with
bucket `'none'` gets **no grade object at all** — the UI renders an untracked dash rather than
inventing a letter (`screenshots/phase5/departures-untracked-390-dark.png`, where *every* row is
untracked). The forecast chip, though built, **cannot fire until ghosts exist** — limitation 2.

### Identity without an id — the feed fights this, and the first attempt lost

Both of GhostBus's claims — *this bus is late* and *this bus never came* — require knowing
which **static trip** a realtime trip is running, and which **static stop** a realtime stop id
names. Neither identity is on this feed. Measured, reproducibly, and re-measured every cycle
rather than hardcoded:

- **Realtime `trip_id` does not match static `trip_id`.** The engine re-measures the direct
  match rate every cycle (`stats.directTripIdMatchRate`, `runCycle` in `server/src/engine.ts`):
  **0.3%** on every cycle of the current run. It is re-measured, not assumed, because every
  positive realtime trip id ends in `"020"`, which reads like a board tag — if a board rollover
  ever made the ids match outright we should notice for free instead of inferring forever.
- **`TripDescriptor` carries nothing else.** Own-property census over 1,392 TripUpdates:
  `startTime` present **0** times, `startDate` **0**, `directionId` **0**. The textbook
  `(route_id, start_date, start_time)` key is impossible as written.
- **The stop-id namespaces are disjoint.** Of 10,262 (route, realtime stop id) pairs, only
  **69 — 0.67%** name a stop that route serves in our board. The tempting 59.3% global id
  overlap is numeric coincidence, and the control measurement settles it: for a bus reported
  `STOPPED_AT` realtime stop *X*, the static stop *numbered X* sits a median **13,703 m**
  away, and **0 of 55** are within 100 m. Matching the ids directly would have produced
  confident, plausible, completely wrong delays.
- **`route_id` does match** (174 of 175 distinct realtime route ids present in static `routes`).
- **`scheduleRelationship = 8`** appears on 13 of 1,392 entities — not a value in the
  GTFS-realtime enum. Undocumented semantics, so it is counted and excluded, never interpreted.
- **Zero standard `CANCELED` entities.** TTC publishes none, and its CANCELED-shaped entities
  carry no stop-time updates, so they are *anonymous* — they cannot be placed on a schedule.
  We count them and never guess (`canceledUnidentified`).
- **No conditional-request support.** No `ETag`, no `Last-Modified`, and a conditional
  re-request returns 200, never 304.

**The first solution to this was wrong, and it has been deleted rather than patched.**
`server/src/join.ts` reconciled on the schedule itself, reconstructing a scheduled time as
`predicted − delay` and claiming a static trip when ≥2 stops agreed within ±75 s. That is
sound arithmetic *if the feed publishes `delay`.* It does not (below). Protobuf supplied a
`0`, the expression collapsed to `scheduled = predicted`, and the join spent its life
comparing the feed's own predictions against themselves. Its measured 0% match rate was a
property of the arithmetic, not of the feed — which is why it was originally, and wrongly,
blamed on the `trip_id` mismatch. `join.ts` and `join.test.ts` are **gone** (commit
`65e3843`), and the prohibition is now structural: no code path reconstructs a scheduled time
from the realtime feed.

### What replaced it: a five-stage delay engine, each stage able to refuse

Scheduled time now comes only from our own seeded `stop_times`. The pipeline that makes that
subtraction possible is five pure modules — no database, no wall clock, no network in any of
them — wired by one DB-facing engine. Full derivation and every constant's rationale is in
`METHODS.md` §3.

| Stage | File | What it does | The load-bearing measurement |
|---|---|---|---|
| **1. Static pattern index** | `server/src/patterns.ts` | Collapses 68,401 seeded trips into **1,252 distinct patterns** (a route's distinct ordered stop list), so matching is "pick the pattern, then pick the slot" rather than a scan | Reading `stop_times` in one shot cost 45.5 s and 184 MB of heap. Keyset-paged on `trip_id` with interned stop ids and `Int32Array` times: 109 s, 71 MB. It runs in the background and never on a request path |
| **2. Learned stop crosswalk** | `server/src/xwalk.ts` | Learns realtime→static stop identity from the one thing both namespaces share — **physical position** — then propagates it transitively to a fixpoint | A `STOPPED_AT` vehicle sits a median **17.9 m** from the correct static stop on its route (90 of 93 within 50 m). Only ~100 of ~1,400 vehicles per cycle are usable anchors, so geometry alone is far too slow; propagation is the multiplier. On a cold 8-cycle run, 569 of 1,106 realtime patterns resolved — 503 at iteration 0 and **66 reachable only by iterating** |
| **3. Origin lock** | `server/src/bind.ts` | Binds a realtime trip to a static trip **once, at birth, and never re-solves it** | Scoring mid-route trips does not work: candidate slots on a pattern are exact time-shifted clones, and the best candidate's residual spread (MAD p50 **31 s**) is not distinguishable from the worst (**42 s**). TTC publishes a trip ~**29.5 minutes** before its first stop, which is the one uncontaminated measurement available |
| **4. Settle and emit** | `server/src/delay.ts` | `delay_s = event_epoch_s − sched_epoch_s`, emitted only for stops that have **settled** — dropped from the feed's list, or the trip left, or the predicted time is ≥30 s past | A stop still in the future is never emitted; that would be publishing a prediction as a measurement. `NO_DATA` is dropped, not imputed as on-time. Values beyond ±5,400 s are **dropped and counted, never clamped** — clamping would censor the distribution toward zero |
| **5. Honesty gates** | `server/src/gates.ts` | Six conditions evaluated **before** anything is written. Any failure means the engine writes nothing and reports, in words, which gate failed | Each has a distinct machine-readable name, so the UI can distinguish "we hold no schedule for today" from "no data yet" from "0 min delay" — three very different statements a naive implementation renders identically |

Presence-aware protobuf reads (`server/src/pb.ts`) sit under all of it, and `server/src/engine.ts`
is the DB-facing half: anchor accumulation, pattern clustering, fixpoint resolution, birth
capture, locking, settling, gate evaluation and the evidence tables.

Three refusals worth naming, because each one costs us coverage on purpose:

- **Sub-5-minute headways are refused outright**, at any confidence. Identification is worst
  exactly there and it is the busiest, most-watched service. The honest statement is "too
  frequent to measure reliably", never a guess.
- **A runner-up within 120 s means we cannot tell two slots apart**, and we say so
  (`refused_ambiguous`) rather than taking the nearer one.
- **The bias is disclosed, not hidden.** The origin band is asymmetric (`[−180, +420] s`) and
  headway aliasing means a bus more than half a headway late is shape-identical to the next
  bus departing on time. Both push our *errors* toward reading a late bus as a later,
  on-time one. **Our errors flatter the agency** — the wrong direction for an accountability
  product. It cannot be engineered away, only bounded and stated, and every stored row carries
  `method`, `confidence`, `xwalk_conf`, `match_margin_s` and `headway_s` so a reader can check.

Ghost detection rides on the same bindings, and ghosts are both **confirmed and retractable**:
a due trip must be absent for **2 consecutive cycles** before a row is written, and if it is
later bound inside its due window the ghost row is **DELETEd** and the retraction logged. Two
circuit breakers sit on top — a global breaker suppressing any cycle that would flag >30% of
due trips, and a per-route breaker for routes with ≥4 due trips — because a mass no-show is
far more likely to be a feed outage or our bug than reality.

### The missing-`delay` discovery — a bug we shipped, and the best thing in this submission

Mid-build, the collector's first-generation logic trusted the feed's `StopTimeEvent.delay`
field. The GTFS-realtime spec is unambiguous about what that field means: *"Delay of 0 means
that the vehicle is exactly on time."*
([GTFS-realtime reference](https://gtfs.org/documentation/realtime/reference/)).

Our collector recorded hundreds of thousands of observations, every one of them saying "exactly
on time". The count kept moving as the collector ran — 304,697, then 312,696, and **314,742** at
the moment of the fix — and the single distinct value never did. The reason is more interesting
than an agency publishing bad data.

**The TTC does not publish the `delay` field at all.** Measured live on a snapshot of 23,165
stop-time events:

```
stopTimeEvents:        23165
delay present on wire:     0     (hasOwnProperty)
time  present on wire: 23165
delay reported as != null: 23165 ← the trap
```

GTFS-realtime is proto2, where `delay` is an `optional int32` whose default is `0`, and
protobuf.js materialises that default on the decoded message's prototype. **A decoded event
answers `0` for a field it never received.** So the collector's idiomatic, apparently-defensive
guard — `if (delay != null)` — passed on all 23,165 events and wrote a measurement for a
quantity the feed never sent. Nobody lied. A correct-looking null check silently converted
*missing data* into *confident data*, three hundred thousand times.

Three consequences. The first two were live in the product before anyone noticed; the third we
caught only because the first two taught us where to look:

1. **The observations measured nothing.** Every row in `trip_delay_obs` had `delay_s = 0`, so
   every stop-hour and route-hour aggregate bucket had `p25 = p50 = p75 = 0`. Buckets cleared
   the `n >= 8` and `n >= 20` evidence gates comfortably — **6,022 of them were rendering in the
   UI as trust grades and confidence bands**, as "±0 min · N observations", as though it were
   evidence. The gate held perfectly. The input was hollow. (That 6,022 is the pre-purge audit's
   single reading and is **not independently re-verifiable** — the tables were truncated before
   this was written. The qualitative claim follows from 87,955 buckets and is not in doubt.)
2. **The join was circular.** It reconstructed scheduled time as `predicted − delay`. With
   `delay` always zero that reduces to `scheduled = predicted` — the join was matching the
   feed's own predictions against themselves and scoring the agreement as a match. Its 0% match
   rate had been attributed to the `trip_id` mismatch. The `trip_id` mismatch is real, but it
   was not the cause of *that* zero. We had the right number and the wrong explanation.
3. **The same trap was live on three more fields**, found once we knew to look.
   `VehiclePosition.currentStatus` defaults to **`IN_TRANSIT_TO (2)`, not 0** — reading it
   naively would have told us 565 stationary vehicles were moving, and geometric anchoring, the
   entire foundation of the stop crosswalk, depends on that field. `TripDescriptor.directionId`
   defaults to `0`, so direction must never be read from this feed. `startDate`/`startTime`
   default to `''`.

**How it was caught:** by re-measuring a believed-true assumption against the live feed instead
of trusting the build reports, which were accurate about what the code did and silent about
whether it meant anything. Verified two independent ways — `hasOwnProperty` on the decoded
event, and `toObject({ defaults: false })` — and then nailed down at the wire level by a unit
test that does not depend on the TTC being up: `StopTimeEvent.create({time:123})` encodes to
**2 bytes** and decodes with `hasOwn(delay) === false`; adding an explicit `delay: 0` encodes to
**4 bytes** and decodes with `hasOwn(delay) === true` (`server/src/pb.test.ts`, *"THE ROOT
CAUSE"*). The zero was manufactured by our decoder. It was never on the wire.

**The general rule this produced:** a null check is not an absence check when the decoder
supplies defaults. Anywhere a wire format has implicit defaults, the only sound test for "did
this arrive?" is an explicit presence probe — never a comparison against the default value.
That is why `server/src/pb.ts` exists. Every optional scalar on the **delay-engine and vehicle**
paths is now read through it. It is not yet universal: `poller.ts` still reads `al.effect` and
`al.cause` off the alerts feed raw, which is filed as `BLOCKERS.md` entry 16 rather than
quietly fixed in a sentence. Enum fields are lower-stakes than `delay` was — a defaulted enum
name is visibly wrong, where a defaulted `0` is invisibly wrong — but the rule is the rule, and
the exception is named here rather than rounded off.

**The point, for anyone evaluating AI-assisted work:** an honesty architecture is worthless
unless someone verifies it against reality. The evidence gates did their job flawlessly and
still produced a lie, because a gate tests sample size and spread — not whether the samples
mean anything. And the specific trap here is not an AI failure mode at all; it is a protobuf
default-value trap that has caught experienced engineers for a decade. What the process
contributed was the habit of going back to the wire to check.

**Remediation — status, stated exactly, verified today.** The fix is to stop asking the agency
how late its buses are and measure it ourselves:

```
delay_s = event_epoch_s  (last thing the feed said about that stop before it settled,
                          or the vehicle's own timestamp where it reported STOPPED_AT)
        − sched_epoch_s  (our own seeded static GTFS, for that trip and stop,
                          anchored at noon-minus-12h per the GTFS service-day rule)
```

Both sides of that subtraction are real, published data, and neither comes from a field the
feed does not send.

**Status on 2026-07-25.** Method: a direct `SELECT` against the production Neon
database, plus reading the current source and the running collector's log. An earlier draft of
this document said the fix had not merged and the table was refilling with zeros; that was true
when it was written, on 2026-07-24 at 22:02 ET. It is no longer true. What is true now:

- **The guard is fixed.** `server/src/pb.ts` reads every optional protobuf scalar through an
  own-property check, so an absent field returns `null` instead of a default. Commit `f54b1cd`.
  Its message records the cost precisely: **314,742 rows** with exactly one distinct value,
  feeding **87,955** aggregate buckets, of which **6,022 had cleared the n≥8 evidence gate and
  were rendering in the UI as trust grades and confidence bands.**
- **The bad data is gone.** `trip_delay_obs`, `agg_delay` and `agg_delay_route` were truncated.
  Queried today: **0 / 0 / 0 rows.** (Migration 004 also carries an
  `UPDATE ... SET method='legacy_feed_delay_zero'` and `aggregate.ts` filters on
  `method='sched_diff'`, so the artifact rows could never re-enter a percentile on any
  database. That statement affected 0 rows here because the table was already empty; it stays
  anyway, and a dedicated test — `aggregate.test.ts`, *"THE ONE-LINE OMISSION"* — asserts that
  1,000 legacy zero rows plus 20 real ones yield n=20.)
- **A whole new measurement engine shipped after it**, described in the previous section. The
  circular join was deleted; delay is now computed against our own schedule.
- **The engine is currently publishing nothing, on purpose, and says so.** Its first gate,
  `boardActive`, fails: the loaded TTC board covers `20260726..20260905` and today is
  2026-07-25, so no service is calendar-active, no trip is due, and any delay figure would be
  fabricated. The suppression string in the log, every cycle, reads:

  ```
  SUPPRESSED (boardActive): no calendar-active schedule for 20260725;
  the loaded board covers 20260726..20260905
  ```

- **The half of the engine that can work today is working.** Crosswalk learning is
  calendar-independent, and it is warming: **8,162** realtime stop ids seen, **3,048
  confirmed**, 277 conflicted, cross-route agreement **94.1%** (93.8–94.1% across cycles, and a
  **geometric-anchor** figure — see the correction below). Its occurrence coverage is
  **30.7%** — **below its own 50% gate**, so it would suppress publication even if the board
  were active. Two gates would have to pass, and today neither does. And that coverage number
  has its own correction attached, immediately below.

So the honest summary is not "we fixed it and the numbers are good." It is: **the lie is gone,
the machinery that would replace it is built and unit-tested, and it has not yet been allowed
to say a single thing about a real bus.** The first genuine end-to-end exercise happens when
the board activates on 2026-07-26. That is one day away and it has not happened yet.

### The second correction: two of our own audits were weaker than their names

Found while fact-checking `METHODS.md` against the source — the same habit that found the
first one, pointed at the honesty machinery itself rather than at the product.

The crosswalk has two self-audits that are supposed to be *falsifiable*: they exist to be able
to fail, because an inference stack with no failing test underneath it is just a confident
guess. Both were narrower than their gate names implied:

1. **The monotonicity gate could not fail.** Within one bound trip, the crosswalked static
   stops must appear in increasing static `stop_sequence` order — a crosswalk error shows up as
   the static side going backwards while the realtime side goes forwards. But `runCycle` was
   feeding the audit `[...b.tracked.keys()].sort()` — the binding's own **realtime** sequences,
   which are ascending by construction. The check compared a sorted list against itself and
   returned **0 violations on every possible input.** A gate that reported "healthy" because it
   was structurally incapable of reporting anything else.
2. **The cross-route agreement audit covers geometry only.** A realtime stop seen from two or
   more routes must resolve to the same static stop from each independently. `runCycle` builds
   its per-route map exclusively from `geoAnchors` — so the *propagated* entries, which
   `METHODS.md` correctly calls "the multiplier" and which are the **majority** of the
   crosswalk, are not covered. The headline **93.9%** is a geometric-anchor figure describing
   a minority of the data it appears to describe.

**Status, verified in the source on 2026-07-25 — not claimed from a plan:**

- **(1) is fixed.** `crosswalkedStaticSeqs` in `server/src/xwalk.ts` now resolves each tracked
  realtime stop to the static sequence the crosswalk claims for it, and `runCycle` feeds *that*
  to the audit. It is deliberately lenient in two ways so that a reported violation is always a
  real one — a looping pattern gets the earliest occurrence that still increases, and stops the
  crosswalk cannot name are skipped rather than counted as disorder. A regression test named
  **"REGRESSION (BLOCKERS 17): the monotonicity gate can actually fail"** passes, which is the
  point: the gate now has a demonstrated failing input.
- **(2) is not fixed.** `runCycle` still builds `perRoute` from `geoAnchors` alone. **Read the
  93.9% as an accuracy estimate for the geometric anchors, not for the whole crosswalk.**
  Filed as `BLOCKERS.md` entry 17. **[IN PROGRESS]**

That leaves the project, today, with one working falsifiable accuracy estimate over a minority
of its own crosswalk, and one newly-repaired one that has not yet had a bound trip to run
against. Neither was publishing a wrong number. Both were audits that would not have caught the
error they exist to catch — which, for this project specifically, is a worse failure than a
missing feature, and is why it is written here rather than left in a blockers file.

### A third: corroboration was *lowering* our confidence

The crosswalk's occurrence coverage sat around 37% against a 50% publish gate, and the
comfortable reading was "it just needs more time to warm." Somebody checked instead of waiting,
and the number was not plateauing — **it was falling.** 37.2% at its peak, 36.4% at cycle 40,
30.9% at cycle 75. Decomposing one live snapshot of 23,636 stop-time occurrences against the
persisted crosswalk found the plateau was not a shortage of evidence at all. Two rules were
throwing evidence away:

1. **A second, agreeing source made an entry *less* trusted.** A geometric anchor overwrote a
   propagated entry, and geometry carries a residual penalty that propagation does not, while
   anchors are accepted out to 80 m. So a stop identity supported at 0.85 confidence **dropped
   to 0.33 the moment a vehicle was seen 40 m away agreeing with it.** Two lines of evidence
   yielding less than one is incoherent on its face. It accounted for 3,185 occurrences —
   13.5% — sitting `confirmed` but under the 0.60 floor. `corroboratedConfidence` now takes the
   best of the *agreeing* sources, which admits nothing either source would have refused alone.
2. **Promotion forgot what it had already seen.** `distinctPatterns` was recounted from the
   patterns resolved in *that cycle*, so a stop confirmed by two agreeing patterns demoted
   itself to `candidate` when one of them went off shift — 03:00 unlearning what 08:00
   established. The oscillation is visible directly in the log: confirmed counts of 3,043 →
   3,031 → 3,019 → 3,025 → 3,042 across five consecutive cycles. Agreement is now accumulated
   and restored from the database on a warm start.

**What was deliberately not done**, and this is the part worth reading: the two-independent-
patterns requirement blocks 43.2% of occurrences on its own, and loosening it would have taken
coverage over the gate in one line. A held-out-geometry experiment even suggested one-pattern
identities are no less accurate than two-pattern ones (88.6% against 80.7%, n=197). **The rule
stays**, because the "truth" that experiment withheld was itself a nearest-stop match and its
disagreements were overwhelmingly adjacent platform ids at one intersection — so it cannot
settle the question. Loosening a safety rule on evidence that weak, to make a number clear a
gate, is precisely the move this project exists not to make. The 50% gate is unchanged too.

**Status: fixed in commit `dc36469`, and not yet observed working.** The detached collector
process predates the commit, so every coverage figure in this document — including the 30.7% in
the table above — was produced by the *old* code. Whether the fix moves coverage over 50% is an
open empirical question, and the honest answer today is that we do not know.

### A fourth, found the same way, on 2026-07-25

Same shape again, and it is the most rider-visible of the four. The seeder loads `calendar`
and `calendar_dates` whole but filters `trips` through a rolling window, so the board can
declare a service **active** on a date for which we hold **no trips at all**. Re-measured
against both the database and the extracted feed: **7 of this board's 42 days** are exactly
that — the six Saturdays on service 2 (32,874 trips published, 0 loaded) and the civic holiday
on 2026-08-03 (31,295 published, 0 loaded). The other 35 days match the feed exactly.

On those seven days, the old code passed `boardActive`, found zero due trips, wrote zero ghosts
and zero delays — and rendered **identically to a day on which nothing went wrong.** "We hold
no schedule for this date" and "the TTC ran a clean day" are opposite statements, and the
product was rendering them the same way. A new `boardIntegrity` gate now suppresses those days
and names the hole (`server/src/gates.ts`). It does **not** repair the seed — that fix belongs
in `seed_toronto.ts` and is written up in `DECISIONS.md` §34 and `BLOCKERS.md` entry 9 (still open). It stops a gap in our data from
reading as good news about the transit system, which is the failure this whole project exists
to prevent, aimed inward.

**What this run of corrections is actually evidence of.** Four times now, the thing that caught the
product lying to itself was not the honesty architecture — it was somebody going back and
re-measuring a believed-true assumption against reality. The gates were perfect and the input
was hollow. The audit was well-designed and the wiring made it tautological. Design does not
survive contact with a live feed on its own; the only thing that does is the habit of
re-checking, and the willingness to write down what re-checking turns up.

### Performance, measured from the build output

| Asset | Gzipped | Raw |
|---|---|---|
| Initial JS (`dist/assets/index-*.js`) | **94,192 B** | 300,464 B |
| Initial CSS | 8,177 B | 39,541 B |
| Lazy map chunk (`MapCard-*.js`) | 260,514 B | 986,167 B |
| Lazy map CSS | 11,475 B | 75,847 B |

Measured with `gzip -9` over `dist/assets/` from the build of **2026-07-25 11:10**. The map
chunk is `React.lazy` and never enters the initial budget; MapLibre also emits a separate
468,361 B raw worker chunk, loaded only once the map mounts. Earlier drafts of this document
and `DECISIONS.md` §23 record 79.6 KB and 256.6 KB for the same two bundles (and §28 records a
97.9 KB initial load, §31 a 262.1 KB map chunk, from builds in between) — that is genuine
growth from features landing (Catch Mode, the About/Credits sheets), not a disagreement about
method. Re-measure after the final build; the command is one line and the numbers move.

Every live vehicle in the viewport renders through **one MapLibre symbol layer**, not DOM markers. Sprites are
drawn procedurally on an offscreen canvas (`web/src/map/sprites.ts`) and cached per
`(kind, colour)` — the live TTC feed contains only 4 distinct route colours, so ≤ 8 images
total. Each poll eases vehicles old→new over 1.2s via `requestAnimationFrame`, mutating **one
reused GeoJSON FeatureCollection in place** with a single `setData` per frame; the rAF loop
stops when nothing is animating. A jump > 500 m snaps and fades rather than sliding across the
city. `prefers-reduced-motion` turns position animations into instant transitions and camera
flights into cuts.

**Polling provably pauses when the tab is hidden.** Every timer is gated on `!document.hidden`
— map vehicles at 5s, health 20s, arrivals 30s, alerts and ghosts 60s
(`web/src/map/MapCard.tsx`, `web/src/hooks/useLive.ts`). Verified: over 11 seconds hidden,
**0** vehicle fetches; **1** on resume.

### Security and hygiene

`@fastify/helmet`, CORS locked to same-origin plus localhost dev origins, rate limiting at
120 req/min on all routes, every parameter validated (bbox side capped at 3°, radius capped
at 3 km, query ≤ 64 chars, `at=` rejected before 2020 or beyond +30 days), uniform JSON errors
with no stack traces, and parameterised SQL everywhere. **There are no API keys anywhere in
this project** — the TTC feeds are unauthenticated and OpenFreeMap requires no key,
registration or token ([OpenFreeMap](https://openfreemap.org/)). `.env` is gitignored and has
never been committed.

### Where to read more

All present and verified on 2026-07-25. `METHODS.md` and `ARCHITECTURE.md` were
rewritten against the delay engine on 2026-07-25 and independently fact-checked against the
source; where any document and the code disagree, **the code wins and the disagreement gets
filed in `BLOCKERS.md`** rather than quietly reconciled.

| Document | Contains |
|---|---|
| `METHODS.md` | The delay engine in full — crosswalk, origin lock, settle rule, every gate and its constant's rationale — plus the corrections in §4 |
| `BLOCKERS.md` | Every empirically measured feed limitation, and every place the code is currently weaker than the docs claim (entry 17 is the audit gap above) |
| `DECISIONS.md` | Every non-obvious choice and every deviation, numbered §1–§34, including the ones that make us look bad |
| `ARCHITECTURE.md` | Process model, data flow, schema |
| `SECURITY.md` | AppSec checklist with verification commands, and unfixed findings listed as findings |
| `CREDITS.md` | Every dependency and asset with its licence |
| `TOOLKIT.md` | Every dependency, verified to exist before use |
| `README.md` | Setup, run, repo tour, deploy, AI disclosure |

---

## Thoughtfulness of Design

### Verifiable copy: "never arrived" is a fact, "isn't coming" is a prediction

`web/src/lib/ghostCopy.ts` exists to hold exactly one decision, and it is deliberately its own
module with its own unit test rather than an inline ternary in a component:

- `'ghost'` → **"7:26 — never arrived."** We watched a scheduled, due trip. It did not show up.
  A statement about the past, which we can defend.
- `'cancelled'` → **"7:26 — cancelled by the agency."** The agency said so, on the record.

A detected ghost must never be described as "cancelled": we do not know *why* it did not come,
only that it did not. And a cancellation must never be dressed up as a no-show, because the
agency owned it publicly and deserves the credit for saying so. Every user-facing sentence in
the app was written against that test — is this a fact we observed, or an inference we are
making, and does the sentence say which?

### "Catch", not "Go"

The primary action on a live departure is labelled **Catch** (`row.catch`). It was **Go**. In
Toronto, GO is a different transit agency — GO Transit runs the regional network — so a button
reading "GO" on a Toronto transit app names a competitor at the exact moment the rider is
deciding what to do. Nobody outside Toronto would catch this, which is precisely why it is
worth mentioning: local correctness is not a detail you can outsource to a style guide.

### Scheduled rows get "View route", not a tracking promise the data cannot keep

A departure with no live trip-update cannot be tracked. It would have been easy — and normal —
to show the same "Catch"/"Track" affordance on every row and let it fail quietly. Instead
`web/src/components/DepartureRow.tsx` branches on `dep.liveEtaMs != null`: live rows get
**Catch** with a live pill; scheduled-only rows get a quiet **View route** and a `Scheduled`
pill. The label promises exactly what the data can deliver. You can see both states in
`screenshots/phase3/mobile-dark-scrolled.png`.

**A caveat that was here, and is now resolved — left visible because the sequence matters.**
An earlier review of this document found that the *labels* were correct but neither action was
wired to a destination: `App.tsx` mounted `NearbyPanel` with no `onCatch` handler, so pressing
a correctly-labelled button took you nowhere. The row was telling the truth about the *data*
and not about the *destination*. Re-checked in the source on 2026-07-25: `App.tsx` now passes
`onCatch={setCatching}` and mounts `CatchView` (`web/src/components/CatchView.tsx`), so the
Tier-0 Catch flow exists. The full guided choreography in the design is still not built.

### The tiered reality contract: a small correct core instead of a large broken one

The design covers considerably more than what shipped. Rather than half-wiring all of it, the
build drew a hard line and **the app itself discloses where the line is** — the `Plan` tab
renders *"Trip planning is designed — it isn't wired up in this build yet."* That is a shipped
product string (`web/src/i18n/en.ts`, `plan.body`), translated into all three locales, not a
caveat buried in a README. A user who never reads this document still learns where the edge is.

The line moved during the build, which is worth saying plainly: the `Alerts` tab carried the
same kind of disclosure until the Ghost Feed panel landed late in development. Verified in
`web/src/i18n/en.ts` on 2026-07-25 — `plan.body` is still the disclosure quoted above, and
`alerts.body` now reads *"Trips that never came, and what the agency has said about it."*,
which is a description of a working feature rather than a disclaimer. That direction of travel
is fine; the opposite would not be. **A stale disclosure is worse than no disclosure**, so this
pair is worth re-reading against the source before any submission or any camera.

### Honest states everywhere else, too

- **Empty states tell the truth about *why*.** With the loaded board not active until 2026-07-26,
  the Nearby view says *"No departures in the next 90 minutes / This stop's live board isn't
  active yet — here's its scheduled service"* and then walks forward day by day to find and
  label the genuine next service day — **SUN, JUL 26** — rather than showing the first plausible
  future day it finds (see `DECISIONS.md` §15, Phase-4 amendment; visible in
  `screenshots/reference-match/PROD-desktop-dark-verified.png`).
- **Skeletons shaped like real rows**, not spinners, so the layout does not jump.
- **Feed failure is a first-class state**: the header pill stops saying `Live`, and a banner
  says the TTC feed is unreachable and that you are looking at scheduled times.
- **Map tiles failing** flips a *"Map tiles unavailable — showing list only"* overlay over the
  ground colour, so a slow tile never flashes a checkerboard.
- **The walk path is honestly a straight line.** There is no routing engine in this tier, so the
  path from You to the boarding stop is a beaded as-the-crow-flies indicator — deliberately not
  drawn as a street-following route it isn't.
- **Two complete themes.** The light theme is a real daylight map style hand-painted for
  navigational contrast (`web/src/map/mapStyle.ts`), not an inverted dark theme.
- **Three complete locales**: en, fr-CA, es — **324 leaf keys each, key sets identical**
  (counted 2026-07-25 by importing all three dictionaries and diffing their flattened key sets;
  the count grew 218 → 250 → 324 as features landed), with parity also enforced by the type
  system (`const frCA: Dict = {...}` where `Dict = typeof en`), so a missing translation is a
  compile error rather than an English string leaking into a French UI.
- **The map canvas is `aria-hidden` and keyboard-inert on purpose**: the departures list is the
  accessible path, and a focus trap on a GL canvas would be worse than no focus at all.

---

## Presentation & Clarity

### How to navigate this repo

Start with `README.md` for setup. Then, depending on what you want to check:

| If you want to check… | Read |
|---|---|
| The claim that predictions are gated on evidence | `server/src/eta.ts` (77 lines) and `server/src/eta.test.ts` |
| How a trip is identified without a shared `trip_id` | `server/src/patterns.ts` → `xwalk.ts` → `bind.ts` → `delay.ts` → `gates.ts`, each with its own `*.test.ts`; `server/src/engine.ts` wires them; `METHODS.md` §3 derives every constant. **`server/src/join.ts` does not exist** — it was the first attempt and it was deleted, for the reason in `DECISIONS.md` §12 (superseded) and §29 |
| The conditions under which the engine refuses to publish | `server/src/gates.ts` (103 lines, six gates, each with a distinct reason string) and `gates.test.ts` |
| Whether the self-audits can actually fail | `xwalk.test.ts`, *"REGRESSION (BLOCKERS 17): the monotonicity gate can actually fail"* for the repaired one, and `server/src/engine.ts` (its `perRoute` map is built from `geoAnchors` alone) for the one that still cannot. `BLOCKERS.md` entry 17 filed both; its monotonicity half describes the state before the fix landed |
| Ghost confirmation, retraction, circuit breakers | `server/src/poller.ts`; `DECISIONS.md` §14, §18, §20, §22 |
| The API contract | `shared/types.ts` — one file, both sides, heavily commented |
| That the feed really behaves as claimed | **Reproduce it in one command, no clone artifacts needed** (see the box below). `.data/` and `*.log` are gitignored, so `.data/feedprobe.cjs` and `collector.log` exist on the build machine but **not in a fresh clone** — every figure sourced from them in this document is labelled with where it came from. |
| What we could not do and why | `BLOCKERS.md` — every entry is an empirical measurement, not a guess |
| Every deviation from the original plan | `DECISIONS.md` — 34 numbered sections, including the ones that make us look bad, and including three marked **superseded** (one of them only partly) rather than rewritten |

The two files worth reading if you only read two: **`BLOCKERS.md`** and **`DECISIONS.md`**.
They are the project's actual record.

### Verify the central claim yourself, in about ten seconds

The missing-`delay` finding is the load-bearing measurement in this submission, so here it is
with no dependency on our repo, our database, or our word. It hits the public TTC feed directly
and — importantly — distinguishes *present-and-zero* from *absent-and-defaulted*, which is the
whole point:

```bash
npm i gtfs-realtime-bindings
node -e "const g=require('gtfs-realtime-bindings');fetch('https://bustime.ttc.ca/gtfsrt/trips').then(r=>r.arrayBuffer()).then(b=>{const f=g.transit_realtime.FeedMessage.decode(Buffer.from(b));let n=0,onWire=0,notNull=0,t=0;for(const e of f.entity)for(const s of e.tripUpdate?.stopTimeUpdate||[]){const v=s.departure||s.arrival;if(!v)continue;n++;if(Object.prototype.hasOwnProperty.call(v,'delay'))onWire++;if(v.delay!=null)notNull++;if(Object.prototype.hasOwnProperty.call(v,'time'))t++;}console.log({stopTimeEvents:n,delayOnWire:onWire,timeOnWire:t,delayReportedNotNull:notNull});})"
```

No key, no registration, no account. Expected: **`delayOnWire: 0`** while `timeOnWire` equals
the event count and `delayReportedNotNull` *also* equals the event count. That gap between the
last two numbers is the bug, reproducible on anyone's machine in ten seconds. Totals drift run
to run; the gap does not.

### AI-use disclosure

**GhostBus was built with Claude Code**, using a spec-driven, evidence-gated process. We are
disclosing this as a strength, and here is the specific argument.

The failure mode of AI-assisted work is exactly the failure mode this project is about:
**confident output with no verification underneath it.** A model will happily generate a
collector that reports "304,697 observations collected" and a build report that says the
milestone is complete, and both statements will be true, and the data will still mean nothing.
That is not a hypothetical — it is what happened here, and it is documented above in full.

What made it recoverable was structural, not motivational:

- **Every dependency was verified to exist before use.** `TOOLKIT.md` records the `npm view`
  check and the actually-installed version for every package — a direct countermeasure to
  hallucinated packages.
- **Every empirical claim was measured, then written down with its measurement.**
  `BLOCKERS.md` exists because a probe was run against the live feed, not because a model
  believed something about GTFS.
- **Every deviation from the plan was recorded rather than quietly absorbed — and superseded
  decisions are marked, not deleted.** `DECISIONS.md` §12 records why the specified join key was
  impossible on this feed and what we built instead; it now carries a **SUPERSEDED** banner
  explaining that what we built instead was *also* wrong, and why. §8 and §13 carry the same
  treatment. The reasoning that led somewhere wrong is left legible, because a document that
  only contains decisions that turned out well is not a record, it is a highlight reel.
- **The honesty architecture was applied to the tooling, not just the product.** The rule "no
  prediction renders without its evidence" is the same rule as "no build report is believed
  without a query against the database." One of those caught the other.

The honesty architecture and the AI-verification discipline are not two practices. They are one
practice pointed in two directions — and the evidence for that is now two incidents, not one.
The delay-zero bug: the product's refusal to show an unevidenced number is what made an
unevidenced number worth going to look for. The audit gap: the same habit, turned on our own
documentation, found a gate that was structurally incapable of failing. Neither was found by a
test, a type, or a build report. Both were found by re-deriving something already believed.

**What a human decided**, for the record: the tiered scope cut (ship a small correct core), the
"never arrived" vs "cancelled" copy rule, the Go → Catch rename, the choice to publish a ghost
count of zero rather than manufacture a demo, and the decision to write this section instead of
omitting it.

---

## What's built vs designed

| Feature | Status | Where to verify |
|---|---|---|
| Static GTFS seed into Postgres (2.15M stop_times) | **Built** | `server/src/seed_toronto.ts`; `BLOCKERS.md` |
| 45s collector, 3 TTC realtime feeds, memory-first | **Built** | `server/src/poller.ts`; `.data/collector.log` |
| Honest-ETA engine with evidence gates | **Built** | `server/src/eta.ts`, `eta.test.ts` |
| Identity without a shared `trip_id` — pattern index, learned stop crosswalk, origin lock | **Built and running**; the crosswalk half is warming against the live feed today | `server/src/patterns.ts`, `xwalk.ts`, `bind.ts` + their tests; `METHODS.md` §3 |
| Delay measured against our own schedule (settle-and-emit) | **Built, gated off** — the machinery is complete and unit-tested; it has **not yet measured a single real bus**, because the board is not active. First live exercise 2026-07-26 | `server/src/delay.ts`, `delay.test.ts` |
| Honesty gates on the delay engine | **Built and firing** — `boardActive` suppresses every cycle today and names the reason in the log | `server/src/gates.ts`, `gates.test.ts` |
| The first identity join (`join.ts`) | **Deleted** — it reconstructed `scheduled = predicted − delay` against a feed that publishes no `delay`, so it compared predictions with themselves | commit `65e3843`; `DECISIONS.md` §12 (superseded), §29 |
| Ghost confirm-over-2-cycles + retraction + breakers | **Built** (dormant until the board activates 2026-07-26) | `server/src/poller.ts` |
| Fastify API, poller in-process, one deployable service | **Built** | `server/src/server.ts`, `render.yaml` |
| Nearby view, live MapLibre map, voxel sprites, markers | **Built** | `screenshots/reference-match/*` (production build). The `phase4/*` stills predate the §30 shell rebuild and the §31–§32 map rebuild — they are a historical record, not current UI |
| Both themes, en/fr-CA/es, skeletons, honest empty states | **Built** | `screenshots/phase3/*`, `web/src/i18n/*` |
| Route shape endpoint + real GTFS route line | **Built** | `GET /api/routes/:routeId/shape` |
| Service alerts incl. accessibility flagging | **Built** | 82 stored, 15 flagged (2026-07-25) |
| Trust grades (A–E) | **Built** — served by the API and rendered as a chip, with an explicit **untracked** dash when there is no evidence. Every departure is untracked today, for the reason in limitation 1 | `GRADE_TIERS` in `server/src/api.ts`, `web/src/components/DepartureRow.tsx`, `screenshots/phase5/departures-untracked-390-dark.png` |
| Ghost Forecast chips | **Built, but dormant** — `ghostRiskFor` is served and rendered, and **cannot fire until ghosts exist** (limitation 2). Do not demo it as working until it has real input | `server/src/api.ts`, `web/src/components/DepartureRow.tsx` |
| Ghost Feed UI | **Built** — today/week ghost + cancelled counters, ghost event cards, honest empty state, service-alerts list. **Renders `0 / 0` today, correctly (limitation 2)** | `web/src/components/AlertsPanel.tsx`, `GET /api/ghosts/feed`, `screenshots/phase5/alerts-ghostfeed-390-dark.png` |
| PWA — manifest, icons, service worker | **Built** — registered at startup **in production builds only** (`pwa.ts` guards on `import.meta.env.PROD`, so it never registers under `vite dev`) | `web/src/pwa.ts`, `web/public/sw.js`, `manifest.webmanifest`, `screenshots/pwa/*` |
| Demo Mode | **[IN PROGRESS]** — recorder + replay source written and unit-tested; re-checked 2026-07-25: still **not wired into the poller**, and no web component consumes the `DEMO` badge string. There is no demo footage to shoot | `server/src/record_demo.ts`, `demo.ts` |
| Ride Mode | **Designed, not built** | copy exists in `web/src/i18n/en.ts` (`ride.*`) |
| Plan / "Where to?" routing | **Designed, not built** | app says so: `plan.body` |
| Saved places | **Designed, not built** | app says so: `saved.body` |
| Catch Mode (Tier 0) | **Built** — `App.tsx` passes `onCatch` and mounts `CatchView` | `web/src/components/CatchView.tsx`, `web/src/lib/catch.ts` |
| Catch Mode's full guided choreography | **Designed, not built** | remaining `catch.*` strings |
| Focused Boarding Mode | **Designed, not built** | — |
| 3D voxel building city | **Built** — deferred at `DECISIONS.md` §23, then rebuilt against a reference image in §31–§32; 168 building features verified in a production build | `web/src/map/voxelCity.ts`, wired in `MapCard.tsx`; `screenshots/voxel/*` |
| Vancouver / multi-city coverage engine | **Removed** — Tier 0 is Toronto-only | `DECISIONS.md` §10 |
| Transit Passport | **Designed, not built** | `settings.passport` string only |
| Rider Evidence (crowd reports) | **Designed, not built** | — |
| Offline schedule-slice cache | **Designed, not built** | — |
| Capacitor Android shell | **Designed, not built** | — |

---

## Known limitations

Listed because a reviewer will find them anyway, and because a limitation you found yourself is
worth more than one someone found for you.

1. **The delay engine has never measured a real bus.** This is the single largest caveat in the
   project and it is worth stating without hedging. The hollow signal is gone — the guard is
   fixed, the 314,742 artifact rows are purged, and the replacement engine is built, unit-tested
   and running. But its first gate (`boardActive`) fails every cycle because the loaded board
   does not activate until 2026-07-26, so `trip_delay_obs` holds **0 rows** and every departure
   in the app renders as untracked. A second gate would also fail if the first passed: crosswalk
   occurrence coverage sits at **30.7%** against a required 50% (and was falling — see the
   third correction; a fix landed today that the running collector has not picked up). **Nothing about the delay
   pipeline has been validated end-to-end against real due trips.** The pure functions are
   tested; the system is not yet proven.
2. **Ghost count is 0 and will stay 0 until 2026-07-26.** The published TTC board covers
   2026-07-26 – 2026-09-05, so on the build date there is no calendar-active service, no trip is
   due, and nothing can be a no-show. Ghost detection, the ghost ledger, forecasts and any
   accountability number derived from them are **genuinely inert** until the board activates.
   The mechanism is unit-tested; it has not yet been exercised against live due trips.
3. **Zero trips are bound today, and the binding half of the engine is therefore untested
   against reality.** Births are captured every cycle — 1,890 pending at cycle 55 — but
   `runCycle` guards the origin lock on `boardActive`, so none of them is ever tested and they
   expire after an hour. The realtime trips running right now belong to the pre-Jul-26 board,
   which is not in our static data, so there is genuinely nothing correct to bind them to.
   **The stop crosswalk, by contrast, is calendar-independent and is warming today** — that is
   the part of the engine a reviewer can watch working before 2026-07-26.
4. **One of the crosswalk's two self-audits covers a minority of the crosswalk.** Cross-route
   agreement is computed from geometric anchors only, so the 93.9% figure does not describe the
   propagated entries that make up the bulk of it. The monotonicity audit was tautological and
   has been fixed; this one has not. `BLOCKERS.md` entry 17.
5. **Anonymous cancellations surface as ghosts.** TTC publishes no standard `CANCELED` entities,
   and its cancellation-shaped entities carry no stop-time updates, so they cannot be placed on
   a schedule. An officially-cancelled but anonymous trip will therefore read as "never arrived"
   rather than "cancelled by the agency". This is a feed limitation; the `kind='cancelled'` path
   activates with no code change if TTC ever publishes identifiable cancellations.
6. **The API read-path caches static data at boot.** The poller hot-reloads calendar and trip
   data on service-day rollover and every 6h; the API's route/calendar caches do not, so after a
   board re-seed, arrivals can serve stale schedule metadata until the process restarts
   (`DECISIONS.md` §19).
7. **Toronto only.** One agency, one timezone, one feed dialect. The multi-city engine was
   deleted rather than left half-working (`DECISIONS.md` §10). Every measured feed quirk above is
   a TTC quirk; none of it is claimed to generalise.
8. **The walk path is a straight line**, not a walking route. There is no routing engine.
9. **Web-only, foreground-only.** No background tracking, no push notifications; the app says as
   much in its own copy (`ride.keepOpen`).
10. **The seeded schedule has holes, and the seeder's window is why.** `GHOSTBUS_SEED_WINDOW_DAYS`
    (default 7) filters trips to services active in the next N days **from the seed date**, which
    is a different window from the board `calendar` loads whole. Consequence, measured: **7 of
    this board's 42 days** — the six Saturdays and the civic holiday — are calendar-active with
    **zero** loaded trips. A `boardIntegrity` gate now refuses to publish on those days rather
    than letting them read as clean service, but **the seed itself is not fixed**
    (`DECISIONS.md` §34, `BLOCKERS.md` entry 9). `GHOSTBUS_SEED_FULL=1` loads all 2,151,105 rows.
11. **Single-operator scale.** All figures come from one collector process against one Neon free-tier
    instance (pool capped at 4 connections) over a single afternoon. Nothing here has been load-tested.

---

## Credits and data sources

- **Static schedule:** *TTC Routes and Schedules*, City of Toronto Open Data Portal —
  https://open.toronto.ca/dataset/ttc-routes-and-schedules/ (GTFS ZIP, refreshed monthly per the
  portal's metadata; confirm the licence terms on the portal page at submission).
- **Realtime:** TTC GTFS-realtime feeds at `bustime.ttc.ca/gtfsrt/{vehicles,trips,alerts}` —
  unauthenticated, no key.
- **Map tiles:** OpenFreeMap (OpenMapTiles schema) over OpenStreetMap data — no registration, no
  API keys — https://openfreemap.org/. Attribution is rendered permanently expanded in the app.
- **Specification:** GTFS-realtime reference — https://gtfs.org/documentation/realtime/reference/
- Full dependency provenance: `TOOLKIT.md`. Further credits: **see `CREDITS.md`.**
