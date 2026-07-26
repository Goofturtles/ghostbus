# METHODS

How GhostBus decides what it knows, what it will say out loud, and what it refuses to say.

Every threshold below is a real constant in the shipped code, cited by file and function so
it can be opened and checked. Every number attributed to "our data" was measured — against
the source tree, the production Neon database, or the running collector's own log — and the
source of each measurement is named.

**Two caveats about sourcing, stated up front.** Some measurements are recorded only as a
comment in the module that acted on them (the settle rate in `delay.ts`, the birth-lead
distribution and candidate-MAD in `bind.ts`, the arrival/departure split in `poller.ts`).
Those are cited to the module rather than to an external artifact, and they cannot be
re-derived today — the feed has moved on. Where a figure came from a one-time probe with no
retained artifact at all, it is labelled as such rather than dressed up.

**Verification stamp.** This document was rewritten against the source tree and re-measured
on **2026-07-25**, with the database census taken at **10:43 America/Toronto** and the
collector's own figures taken from cycle 17 of the run in `.data/collector.log`. The
algorithm it describes is the one in `server/src/{pb,patterns,xwalk,bind,delay,gates,engine}.ts`.

An earlier version of this file described a different algorithm — one that read a `delay`
field from the realtime feed and reconstructed scheduled time as `predicted − delay`. That
algorithm was measuring nothing, it has been deleted, and §4 documents exactly what went
wrong. Nothing in §3 is inherited from it.

---

## 1. Operational definitions

These are the definitions the code implements. The distinction between "not present" and
"ghost" is the whole product.

**Scheduled trip.** A row in the static GTFS `trips` table whose `service_id` is active on
the service date in question, per `calendar` + `calendar_dates` (`activeServiceIds` in
`server/src/gtfs.ts`). Its scheduled start is `COALESCE(departure_s, arrival_s)` of its
first `stop_time`, resolved to an absolute instant against agency-local midnight.

**Static pattern.** A route's distinct ordered stop list, identified by a SHA-1 over
`route_id | direction_id | stops` (`patternIdFor` in `server/src/patterns.ts`). The seeded
board's 68,401 trips collapse to **1,252 patterns** (measured — `[engine] pattern index`
line in `.data/collector.log`). Matching a realtime trip is therefore a two-step problem:
pick the pattern, then pick the slot on it.

**Slot.** One static trip on one pattern, ordered by its first departure. Slots on a
pattern are exact time-shifted clones of one another; telling them apart is §3.4.

**Bound.** A realtime trip is *bound* to a static trip when the origin lock
(`originLock` in `server/src/bind.ts`) identified exactly one slot for it, with enough
separation from the runner-up. A binding is written once and **never re-solved** — see
§3.4.5 for why.

**Present.** A scheduled trip is *present* in a poll cycle if the delay engine currently
holds a live binding naming it (`getPresentStaticTrips()` in `server/src/engine.ts`,
consumed by `poll()` in `server/src/poller.ts`). Presence is positive evidence that a
vehicle is operating that trip. Absence, on its own, is not evidence of anything — it is a
question, and §5 is the procedure for answering it.

**Settled stop.** A stop on a bound trip whose predicted time can no longer change: its
`stop_sequence` has dropped out of the trip's `StopTimeUpdate` list, or the trip has left
the feed entirely, or its predicted time is at least 30 s in the past while still listed
(`settleTrip` in `server/src/delay.ts`). A stop still in the future is never emitted —
publishing a prediction as a measurement is the failure this engine exists to prevent.

**Delay observation.** One row in `trip_delay_obs` per settled stop of a bound trip:
`delay_s = event_epoch_s − sched_epoch_s`. Both epochs are stored, so the row is
recomputable from itself and any future change to the anchor or the settle rule can be
re-evaluated without re-collecting a day of feed (`server/migrations/004_delay_engine.sql`).

**Ghost.** A scheduled trip that is **due** (scheduled start 6–30 minutes in the past),
**not present**, **not explicitly cancelled by the agency**, and has been absent for at
least **two consecutive poll cycles**, in a cycle where neither circuit breaker fired. In
plain terms: *the schedule promised this trip, its start time has passed, the agency has
not said it was cancelled, and nothing in the realtime feed shows it running.* A ghost is a
claim about the agency's published promise, not about any individual vehicle.

**Officially cancelled.** A trip the agency itself declared cancelled — a GTFS-realtime
`TripDescriptor` with `scheduleRelationship = CANCELED (3)` — **and** which we could tie to
a specific static trip, by direct `trip_id` match or an existing binding. Stored as
`kind='cancelled'` in the same `ghosts` table. A cancelled trip is explicitly *not* a
ghost: the agency confessed, so there is nothing to detect. §5.4 covers what happens when
the agency confesses anonymously.

**Retracted.** A ghost we wrote and then took back, because the trip was subsequently bound
(or cancelled) while still inside the detection window. Retraction is a `DELETE`, so a
retracted ghost leaves no row and never appears in the public ledger.

**Untracked.** A departure with no evidence bucket clearing its threshold (§6). Untracked
departures get the schedule and nothing else — no estimate, no band, no trust letter. "We
don't know" is a first-class answer here, not a fallback.

---

## 2. Data collection

**Cadence.** One poll cycle every **45 s** (`POLL_MS`, `server/src/poller.ts`), fetching all
three TTC GTFS-realtime feeds concurrently: `vehicles`, `trips`, `alerts`. 10 s request
timeout (`REQUEST_TIMEOUT_MS`); per-feed exponential backoff from 5 s, capped at 5 min.

45 s is short enough that the ≥2-cycle ghost confirmation (§5.2) resolves inside 90 s — well
within the 6–30 min detection window — and long enough that a full day is 1,920 cycles
rather than a rate-limit problem for a public feed we do not pay for.

**Presence-aware decoding.** Every optional scalar the **delay engine** reads goes through
`server/src/pb.ts` (`present`, `presentInt`, `presentStr`), which tests
`Object.prototype.hasOwnProperty` rather than comparing against a value. This is not
defensive padding: §4 is what happens without it.

The map's vehicle DTO path is the stated exception: `processVehicles` in `poller.ts` still
reads `currentStopSequence`, `position.bearing`, `position.speed` and `timestamp` with
`!= null` checks, and `processAlerts` reads `effect`/`cause` raw. `bearing` and `speed` are
proto2 optional floats, so a vehicle that never sent a bearing renders as heading due north.
Nothing on that path reaches a delay measurement or a published statistic — it is a sprite
rotation — but it is the same trap and it is recorded rather than glossed (BLOCKERS.md
entry 16).

**Freshness gate (`feedsFresh`).** The delay engine and the ghost scan run only when
**both** the vehicles and trips feeds returned a fresh `200` in *this* cycle. If either
failed, the cycle collects what it can and skips both. A feed outage must never be laundered
into "the buses didn't come".

**Staleness labelling.** A feed is `ok` under 90 s since its last good poll
(`STALE_AFTER_MS`), `stale` beyond that, `down` if it has never succeeded. `/api/health`
exposes this per feed, so the UI degrades honestly instead of showing confident stale data.

**Retention.** `trip_delay_obs` older than **14 days** (`RETENTION_DAYS` in `poller.ts`) is
deleted once per calendar day. That matches the window the aggregates are computed over
(`WINDOW_DAYS` in `server/src/aggregate.ts`), which is what the `windowDays` in every
evidence object reports. **The two are separate literals, not one shared constant** — they
agree today and nothing enforces that they keep agreeing. The prune is also keyed on the
Toronto calendar date rather than the service date, and carries no `agency` predicate.

**Raw pings are never persisted.** Vehicle positions live in a `Map` inside the process with
a 6-deep ring buffer per vehicle, evicted after 10 cycles without a sighting. See
`ARCHITECTURE.md` §1 for the arithmetic that forced this.

---

## 3. Measuring delay

### 3.1 The definition

```
delay_s = event_epoch_s − sched_epoch_s
```

`sched_epoch_s` comes **only** from our own seeded `stop_times`. `event_epoch_s` is the last
thing the feed said about that stop before it settled, or — where a `VehiclePosition`
reported `STOPPED_AT` there — the vehicle's own timestamp.

No code path reconstructs a scheduled time from the feed. That prohibition is the direct
consequence of §4 and it is enforced by the absence of any such expression in
`server/src/delay.ts`, whose header states the rule.

**Scheduled time is anchored at noon-minus-12h**, per the GTFS spec, not at local midnight
(`serviceEpochSeconds` in `server/src/tz.ts`). The distinction is invisible for 363 days a
year and worth exactly 3,600 s of fabricated delay, all day, on the other two.

### 3.2 The problem this creates

The feed gives us a predicted time for a stop. To subtract a scheduled time we must know
**which static trip** the realtime trip is running, and **which static stop** the realtime
stop id names. Neither is available directly:

- **`trip_id` does not match.** The engine re-measures the direct match rate every cycle
  rather than hardcoding it (`stats.directTripIdMatchRate`, `runCycle` in `engine.ts`);
  on the run in `.data/collector.log` it reads **0.3%** on every cycle. It is re-measured
  because every positive realtime trip id ends in `"020"`, which reads like a board tag —
  a board rollover could make the ids match outright, and we should notice for free rather
  than keep inferring.
- **`stop_id` is a different namespace.** Measured (BLOCKERS.md): of 10,262
  (route, rt\_stop\_id) pairs only **69 — 0.67%** name a stop that route serves in our
  board. The tempting **59.3%** global id overlap (4,892 of 8,244) is numeric coincidence.
  The control measurement is decisive: for a vehicle reported `STOPPED_AT` realtime stop
  *X*, the static stop *numbered X* sits a median **13,703 m** away, and **0 of 55** are
  within 100 m.
- **`TripDescriptor` carries nothing else.** Own-property census over 1,392 TripUpdates
  (BLOCKERS.md): `startTime` present **0** times, `startDate` **0**, `directionId` **0**.
  Only `tripId`, `routeId` and `scheduleRelationship` are on the wire, so the spec's
  `(route_id, start_date, start_time)` identity key is impossible as written.

So both identities have to be **inferred**, and the inference has to be auditable. §3.3–3.4
are that inference; §3.6 is the set of conditions under which we refuse to publish its
output at all.

### 3.3 Learning the stop crosswalk (`server/src/xwalk.ts`)

The two namespaces share exactly one thing: physical position.

**a. Geometric anchors.** When a vehicle reports `currentStatus === STOPPED_AT (1)` — read
through `presentInt`, because the proto2 default for that field is `IN_TRANSIT_TO (2)`, not
`0` — with a route and a realtime stop id, its coordinates name a static stop on that route.
`accumulateAnchors` in `engine.ts` keeps a running centroid per `(route_id, rt_stop_id)`;
`nearestStopOnRoute` in `xwalk.ts` resolves it.

| Rejection | Value | Why |
|---|---|---|
| `maxDistM` | **80 m** | About 2× the measured p90 of 44 m for a `STOPPED_AT` vehicle's distance to the correct static stop (median 17.9 m; 90 of 93 within 50 m — DECISIONS §29). Beyond it, the vehicle is not at a stop on this route. |
| `minGapM` | **15 m** | Terminal-bay ambiguity. At a loop or terminal several static stops sit metres apart; picking the nearer by a hair would assign a whole pattern to the wrong bay. The measured gap to the second-nearest is p10 10 m / p50 65 m, so this rejects roughly the worst tenth. |
| `ANCHOR_MAX_AGE_S` | **120 s** (`engine.ts`) | A ping older than two minutes is not evidence of where the bus is now. |
| One vote per dwell episode | — (`dwellSeen`, `engine.ts`) | A bus parked five minutes at a terminal would otherwise vote every cycle and drown out genuine cross-vehicle agreement. |

Geometry alone is far too slow: only ~100 of ~1,400 vehicles per cycle are usable anchors
(DECISIONS §29).

**b. RT pattern clustering (`mergeRtTrip`).** Realtime trips are folded into per-route
`(stop_sequence → rt_stop_id)` patterns. Three clauses, each load-bearing:

0. **an exactly identical stop map is the same pattern by definition**, whatever the overlap
   floor says. Without this, two newborns that both publish only `{1: X}` would create two
   pattern objects with the same content hash — a duplicate identity that collapses in every
   downstream map keyed by `rtPatternId`;
1. **every shared sequence must agree** — one disagreement means a different pattern;
2. **at least `minOverlap` = 3 shared sequences** — without this floor a newborn trip
   publishing one or two stops fuses two genuinely *distinct* patterns that share an origin,
   and newborns are exactly what we bind on;
3. **the merged pattern may not exceed the route's longest *static* pattern** — without the
   cap, a short-turn and a full run agree on their shared prefix and fuse into a phantom
   pattern longer than anything the route actually runs.

A per-route cap of **48** patterns stops a pathological route from unbounded growth; hitting
it is logged, not silenced (route 501 hits it on the current run). The merge rule is doing
real work rather than rubber-stamping: at route level the realtime
`(route, stop_sequence) → stop_id` map is **not** self-consistent — 6,340 agreements against
**11,728 conflicts** on one snapshot (DECISIONS §29) — because opposite directions and
branches put different stops at the same sequence number. Splitting those apart is the point.

**c. Resolution to a fixpoint (`resolvePatterns`).** Each iteration, an unresolved RT
pattern gathers its anchors (geometric first, then whatever the crosswalk already knows) and
keeps only static patterns of the same route where `stops[seq − 1]` equals the anchor's
static stop for **every** anchor. One violation eliminates a candidate. `minAnchors = 2`,
`maxIters = 8`.

- **The hard constraint is deliberate.** Relaxing it to tolerate a single mismatch was
  measured to rescue only 39 of 137 no-candidate patterns while admitting a wrong anchor —
  and one wrong anchor shifts an entire pattern's delays by a constant that no downstream
  shape check can detect.
- **Zero survivors is re-tested on geometry alone.** If geometric anchors alone leave
  candidates, the elimination was caused by a *propagated* entry contradicting direct
  observation. Geometry is measured, propagation is derived, so geometry wins and the
  offending entry is marked `conflicted` — it stops backing delay rows and stops poisoning
  other patterns.
- **Ambiguity is judged on the implied crosswalk, not on pattern identity.** If several
  candidates survive but all map every sequence to the same static stop, the choice between
  them is immaterial and we resolve. If they differ anywhere, we stay silent.

**Transitive propagation is the multiplier.** Once a pattern resolves, every stop on it is
crosswalked and those stops become anchors for other patterns. `rt_pattern.resolve_iter`
records which iteration a resolution came from, so the value of iterating is measurable
rather than asserted.

Read that column carefully: `resolvePatterns` starts from an empty `resolved` map every
cycle, and `persistCrosswalk` overwrites the column on every write, so the stored value is
the iteration a pattern resolved at **in the last cycle that touched it** — not the
iteration it was *first* reachable at. It therefore understates propagation, because a
pattern that needed six iterations on the day it was discovered resolves at iteration 0 once
its stops are in the seed. With that caveat, the production table today (queried 2026-07-25)
holds 4,025 resolved pattern rows, of which **3,787 last resolved at iteration 0 and 238 at
iterations 1–7**. The un-understated figure is the one taken on a cold eight-cycle run in
DECISIONS §29: 569 of 1,106 RT patterns resolved, **503 at iteration 0 and 66 reachable only
by iterating to a fixpoint**.

**d. Promotion and confidence.** An entry becomes `confirmed` on any **one of three paths**
(`promotionState`). A second, different static stop id for the same realtime stop marks it
`conflicted` — permanently unusable until the board tag changes, because we cannot tell which
observation was wrong; a conflict overrides all three paths.

| # | Path | Condition |
|---|---|---|
| 1 | **Two independent patterns** | `distinctPatterns ≥ 2` — two distinct *static* patterns agree on the identity. Keyed by static pattern id, not RT: an RT pattern's id is a content hash, so extending it renames it, and counting RT ids would let one line of evidence corroborate itself twice. |
| 2 | **Geometric self-confirmation** | `source === 'geo'` and the anchor's own centroid is within **60 m** (`GEO_SELF_CONFIRM_M`) of the stop it names. |
| 3 | **Time-domain validation** | `distinctPatterns ≥ 1`, **and** the implying pattern has been validated by ≥ **2** distinct surviving origin-locked bindings (`MIN_VALIDATING_BINDINGS`) across ≥ **2** distinct cycles (`MIN_VALIDATING_CYCLES`), **and** the stop it names is not structurally ambiguous. |

Path 3 was added in DECISIONS §46 and needs its terms stated precisely, because a plausible
misreading of it is circular.

- **A binding does not re-observe the stop.** A bound trip's `staticStops[seq − 1]` *is* the
  pattern entry that implied the mapping, so asking whether the binding agrees asks one
  inference twice. Measured over 23 live cycles: 81,729 binding "confirmations", of which
  **0.07%** came from a pattern the stop did not already have, and **0 disagreements** out of
  37,319 on exactly the mappings this path governs. What a *surviving* binding establishes is
  in the time domain and is independent: the pattern was matched to a scheduled slot at its
  origin, separated from its runner-up by the §3.4.4 margin test (or had no runner-up in band
  at all), and kept agreeing with the schedule afterwards. That is
  evidence about the **pattern assignment** — the one failure that makes every identity a
  pattern implies wrong together, which is the failure path 1 exists to catch.
- **"Surviving" is load-bearing.** A binding is credited only after clearing the per-trip
  consistency gate (§3.5) and the per-pattern drift breaker (§3.6) in a cycle. Credit is
  retracted when either later voids it — the *whole* pattern's credit when the consistency
  gate fires, since that means the assignment itself is in doubt, and one binding's worth when
  the drift breaker or a double-booked slot voids a single trip. All credit is dropped outright
  on a service-day rollover or a board change, because bindings belong to the service that ran.
  Cycles are counted per binding, not per pattern, so a voided binding takes its cycles with it.
  Bookkeeping lives in `createPatternCreditStore` (`xwalk.ts`).
- **Structural unambiguity** (`structurallyAmbiguousStops`) refuses the path for any stop with
  another stop **on the same route within 80 m** (`ADJACENT_STOP_M`) that shares a
  **direction** — 1,484 of 9,361 stops (15.85%) on the live board. Proximity is judged per
  route; the direction sets are built board-wide, so a stop served in both directions anywhere
  counts as sharing with either neighbour. That is deliberately the conservative way round: it
  flags more stops than a strictly per-route reading would, and every stop it flags is one this
  path declines to promote. The obvious
  alternative, requiring the corroborating bindings to be direction-consistent, was checked
  against the board first and **rejected**: of 4,262 same-route stop pairs within 80 m, only
  3,375 (**79.19%**) have no direction in common, so a direction check would have read as a
  safeguard while passing one adjacent pair in five.
- **This promotion does not survive a restart.** `distinct_patterns` and `geo_resid_m` are
  persisted, so paths 1 and 2 are re-checked at warm start; binding validation is a property
  of the running service day and is not persisted, so a row confirmed by path 3 is restored as
  a `candidate` and re-earns confirmation. Within one process the same rule is enforced by a
  sweep (`demoteUnvalidated`), because the promotion loop only rewrites entries the current
  cycle re-proposed and a stop stops being proposed once its RT pattern is quarantined.

```
confidence = min(1, votes / 10) × residualFactor × sourceFactor
             residualFactor = 1                       (propagated: no residual of its own)
                            = clamp(1 − resid/60, 0.2, 1)   (geometric)
             sourceFactor   = 1.00 (geo) | 0.85 (propagated)
```

That formula is what a **single** source is worth. Where geometry and propagation both name
the same stop, the shipped value is `corroboratedConfidence`, which takes the **better of the
agreeing sources** rather than letting the newer one overwrite the other. This is not a loosened
threshold: it admits nothing either source would have refused alone. It exists because the
overwrite version was actively harmful — geometry carries a residual factor propagation does
not, so a stop propagation supported at 0.85 was demoted to 0.33 the moment a bus was observed
40 m from it *while agreeing about which stop it was*, and 13.5% of occurrences resolved to an
entry capped under the floor for exactly that reason (DECISIONS §35).

`votes` counts the number of cycles in which the identity was independently **re-derived and
agreed** (`implied`, not `learned` — see §4.3). Only `state === 'confirmed'` **and**
`confidence ≥ 0.60` (`XWALK_MIN_CONFIDENCE`, `usableForDelay`) may back a written delay row.

Two consequences worth stating because they are visible in the log rather than hidden in the
formula:

- A **propagated** entry needs **8 corroborating cycles** before it can back a delay row:
  `7/10 × 0.85 = 0.595`, just under the floor; `8/10 × 0.85 = 0.68`, over it.
- That is exactly what the collector shows. Crosswalk occurrence coverage reads **0.0%**
  through cycle 9, **0.9%** at cycle 10, then **34.5%** at cycle 11 and **35.6%** by cycle
  17 (`.data/collector.log`). The step is the vote threshold clearing, not a bug.

**e. The crosswalk's own falsifiable audits.** Neither requires ground truth, and both are
designed to be able to fail. One of the two is still narrower than its gate name suggests —
stated here because a reviewer will check, and because an audit that cannot fail is not an
audit:

- **Cross-route agreement** (`crossRouteAgreement`) — a realtime stop id seen from two or
  more routes must resolve to the same static stop from each route independently. Measured
  **93.8%** at cycle 17. **This audits geometric anchors only:** `runCycle` builds its
  per-route map from `geoAnchors`, so propagated entries — the bulk of the crosswalk — are
  not covered by it.
- **Monotonicity** (`monotonicityViolations`) — within one bound trip, the crosswalked static
  stops must appear in strictly increasing static `stop_sequence` order. **This gate can
  fail, and did not always be able to.** It was fed each binding's
  `[...b.tracked.keys()].sort()` — the *realtime* sequence numbers, ascending by
  construction — so it compared a sorted list against itself and returned zero violations on
  every possible input. Fixed in commit `6920b13`: `runCycle` now routes each binding's
  tracked realtime stops through **`crosswalkedStaticSeqs`** (`xwalk.ts`), which resolves
  each one through the crosswalk to the static `stop_sequence` it occupies on the bound
  static pattern, and feeds *those* to `monotonicityViolations`. The falsifiable property is
  on the static side: a crosswalk error shows up as the static sequence going backwards
  while the realtime sequence goes forwards.

  Two leniencies keep a reported violation a real one: where a static pattern visits the
  same stop twice (loops, turnbacks, on-street terminals) the earliest occurrence that still
  increases is taken, so a violation is reported only when *no* monotone assignment exists;
  and stops the crosswalk cannot name, or names off-pattern, are skipped — an absent
  identity is not evidence of disorder, and an off-pattern one is the stricter per-trip
  consistency gate's business (§3.5).

  That the gate can now fail is itself pinned by a regression test —
  `xwalk.test.ts` *"REGRESSION (BLOCKERS 17): the monotonicity gate can actually fail"* —
  alongside direct tests of `crosswalkedStaticSeqs` (including the looping-pattern case) and
  of `monotonicityViolations` against a genuinely out-of-order trip. BLOCKERS.md entry 17
  records the original defect and its fix.

### 3.4 Binding a realtime trip to a static trip (`server/src/bind.ts`)

#### 3.4.1 Why binding happens at birth, and only once

Scoring every live trip against every candidate slot each cycle was measured and does not
work: candidate trips on one pattern are exact time-shifted clones, so the residual spread
of the correct candidate is not distinguishable from the wrong one (best-candidate MAD p50
**31 s** against worst **42 s**). There is no signal in the shape of a mid-route trip.

What carries signal is the moment a trip is born. TTC publishes a trip roughly **29.5
minutes** before its first stop (measured p10 1,734 s / p50 1,766 s / p90 1,780 s past the
feed header), overwhelmingly at `stopSequence` 1. At that instant the trip has not moved, so
its first predicted departure is essentially its scheduled departure plus whatever the
operator already knows. That is the one clean measurement available, and it is taken before
live drift can contaminate it.

`captureBirths` in `engine.ts` refuses a trip whose lowest published sequence is `> 2`, or
whose first predicted event is already in the past (`refused_midroute`): we never saw its
origin, so the uncontaminated anchor this design depends on does not exist for it and never
will.

#### 3.4.2 One forced deviation: capture at birth, bind later

A newborn publishes a **median of one stop**. It cannot clear the 3-shared-sequence merge
floor (only clause 0 will take it, and only into a pattern with an identical one-stop map),
and a one- or two-stop pattern cannot clear `minAnchors = 2` either, so its pattern is not
resolvable in the cycle it is born. The binding
therefore waits — but it waits on the **anchors captured at birth, which are never
refreshed**. The property the design rests on is preserved; only the moment of the database
write moves. Births that are still unbindable after **`BIRTH_EXPIRY_S` = 3600 s** are
dropped and counted (`expireBirths`). That pruning runs every cycle rather than inside the
lock path, because with an inactive board nothing is ever locked and the pending map would
otherwise grow by ~100 entries a cycle forever — a leak visible only in the state this
deployment sat in until the board activated on 2026-07-26.

#### 3.4.3 The origin band

| Constant | Value | Rationale |
|---|---|---|
| `ORIGIN_BAND_EARLY_S` | **−180 s** | A trip published ~29 minutes before it departs cannot be meaningfully early, so this only covers clock, rounding and board slop. |
| `ORIGIN_BAND_LATE_S` | **+420 s** | Covers a genuinely late block handoff. |

The asymmetry is deliberate and its direction is stated rather than buried: together with
**headway aliasing** — a bus more than half a headway late is shape-identical to the next bus
departing on time — it biases our *errors* toward matching a late bus to a later slot, which
reads as **less** lateness than reality. **Our errors flatter the agency.** That is the wrong
direction for an accountability product; it cannot be engineered away, only bounded and
disclosed. It is bounded by §3.4.4 and disclosed on every row, which carries `method`,
`confidence`, `xwalk_conf`, `match_margin_s` and `headway_s`.

#### 3.4.4 The gates on the lock

| Constant | Value | Rationale |
|---|---|---|
| `MIN_PUBLISHABLE_HEADWAY_S` | **300 s** | Below a 5-minute scheduled headway, identification is hopeless *and* it is the busiest, most-watched service. The whole band is refused at any confidence (`refused_headway_band`); the honest product statement is "too frequent to measure reliably", never a guess. Measured trip-weighted share of the sub-300 s band on service 1: **4.9%** (DECISIONS §29). The same refusal also covers an **unknown** headway — `medianHeadwayForSlots` returns null for a pattern with fewer than 3 slots on its dominant service — so thin patterns are refused too, and the counter conflates the two cases. |
| `HIGH_CONFIDENCE_HEADWAY_S` | **600 s** | At or above a 10-minute headway a binding is `high` confidence; 300–600 s is `low`. Only `high` rows enter the aggregates (§6.1). |
| `MARGIN_MIN_S` | **120 s** | Neighbouring slots are exact clones, so the `\|resid\|` separation is what decides. If the runner-up is within 120 s we genuinely cannot tell them apart and say so (`refused_ambiguous`). |
| `MARGIN_MIN_AGREE` | **2** | A winner that beats the runner-up by two or more agreeing anchors is accepted even inside the 120 s band, because the anchors are independent evidence the origin residual is not. |
| Anchor tolerance | `min(240, 60 + 10 × Δseq)` s | Anchors further down the trip have accumulated more legitimate drift, so the tolerance widens with distance from the first published stop and then caps. |

Slots are filtered to the calendar-active services for the service date and to trips not
already claimed. Refusals are counted by kind (`refused_ambiguous`, `refused_no_slot`,
`refused_midroute`, `refused_headway_band`, `refused_board_inactive`, `refused_unresolved`,
`refused_schedule_relationship_8`) and reported, because they are the honest denominator
behind every published delay. An eighth kind, `refused_too_few_anchors`, is declared and
counted but never returned by `originLock` — a thin-anchor pattern simply stays unresolved
and its births expire — so that counter reads zero by construction.

`scheduleRelationship === 8` — an undocumented value not in the GTFS-realtime enum, carried
by 13 of 1,392 entities on a live snapshot, exactly the ones with a negative synthetic trip
id (BLOCKERS.md) — is counted and excluded from binding. No semantics are inferred from it.

#### 3.4.5 What is deliberately not done

- **No re-solving.** A binding is immutable. Re-solving under a "plausible delay" band would
  quietly truncate the delay distribution toward zero — the app would under-report exactly
  the lateness it exists to expose.
- **No day-long FIFO slot chaining.** One missed collector cycle would phase-slip an entire
  (route, pattern) for the rest of the service day, producing delays wrong by exactly one
  headway that are perfectly self-consistent and invisible to every internal check. Slot
  claiming (`sched_slot_claim`) is kept as a uniqueness record only.
- **No order-preserving assignment.** TTC bunching means a late bus gets overtaken, so
  observed order does not preserve scheduled order; order preservation was measured strictly
  worse than independent selection (**64.7%** against **77.0%**).
- **Double-books are voided, not re-solved.** If two realtime trips lock the same static
  trip, `preferBinding` picks the higher `agree`, then the smaller `|resid|`, then a stable
  tiebreak; the loser is voided. A partial unique index on
  `rt_trip_binding (agency, service_date, trip_id)` makes a race a database error rather
  than two silently wrong delay series.

### 3.5 Settling and emitting (`server/src/delay.ts`)

One row per stop that settled this cycle. In order:

1. **Not settled** → skipped and counted (`droppedNotSettled`). Settling is: sequence dropped
   from the list (measured: **30.6%** of carried-over trips drop at least one leading
   sequence per cycle), or the trip left the feed, or the predicted time is at least
   **`SETTLE_LAG_S` = 30 s** in the past while still listed.
2. **`NO_DATA`** (`StopTimeUpdate.scheduleRelationship === 2`) → never emitted
   (`droppedNoData`). It carries no time; imputing an on-time arrival for it would reproduce
   exactly the fabrication of §4. Measured on one snapshot: NO_DATA = 483, SKIPPED = 0.
3. **No usable crosswalk entry** → skipped and counted (`droppedNoXwalk`).
4. **Consistency gate.** If the bound static trip's stop at this sequence is not the stop the
   crosswalk names, one of the two is wrong and neither may be published. The whole trip's
   rows are abandoned — not just the offending one — the binding is voided, its already-written
   observations for that service date are deleted, and the RT pattern is quarantined
   (`voidForInconsistency` in `engine.ts`).
5. **Which scheduled time.** A departure event is compared against the scheduled departure, an
   arrival event against the scheduled arrival. The event kind is unambiguous per stop:
   measured **22,391 arrival-only, 602 departure-only, 0 carrying both**. A stop with no
   scheduled time in the bound trip is skipped, not treated as zero (`droppedNoSchedule`).
6. **Observed beats predicted.** Where a `VehiclePosition` reported `STOPPED_AT` that stop,
   its timestamp is used and the row is stamped `source='observed'`; otherwise
   `source='predicted'`. Roughly 100 per cycle system-wide — enough to measure the predicted
   rows' bias rather than assume it is zero.
7. **`MAX_PLAUSIBLE_DELAY_S` = 5400 s.** Beyond ±90 minutes the row is evidence of a bug, not
   of a late bus. It is **dropped and counted** (`droppedImplausible`), never clamped —
   clamping would censor the distribution. **No band is applied below that.** Once a trip is
   bound, a 40-minute delay is measurable and gets measured.
8. **Bucketed by the scheduled hour**, not the actual one. A bus scheduled at 08:58 running
   six minutes late belongs in the 08:00 bucket, because that is the bucket a rider planning
   an 08:58 departure will read.

Uniqueness is `(agency, trip_id, stop_sequence, service_date)`, added by migration 004
specifically because **loop routes visit the same stop twice on one trip** and the older
`(agency, trip_id, stop_id, service_date)` constraint cannot express that.

### 3.6 The honesty gates (`server/src/gates.ts`)

Evaluated every cycle, before the settle step and before any **delay row** is written. Any
failure means no observation is emitted, and the engine reports in words why. Each gate has a
distinct machine-readable name so the UI can say what is actually happening instead of
rendering a reassuring zero.

Precisely what the gates do and do not hold back: `trip_delay_obs` is gated. The engine's own
evidence is not — `persistCrosswalk()` writes anchors, votes, crosswalk entries and pattern
states every cycle regardless, and `rt_trip_binding` / `sched_slot_claim` are written whenever
the board is active. That is deliberate: the audit trail has to keep accumulating while the
system is refusing to publish, or there would be no record of *why* it refused.

| Gate | Condition to publish | Rationale |
|---|---|---|
| `boardActive` | at least one calendar-active `service_id` for this service date | "We hold no schedule for today" is a different statement from "no data yet" and from "0 min delay". Checked first so it is reported ahead of every downstream symptom. |
| `boardIntegrity` | the calendar-active services must actually hold trips in our board | `calendar` and `calendar_dates` are seeded whole while `trips` is seeded through a window, so a service can be calendar-ACTIVE on a date for which we hold nothing. Without this gate such a date passes `boardActive`, produces zero due trips, zero ghosts and zero delays, and renders as a clean day. "We hold no schedule for this date" and "nothing went wrong" are opposite statements (BLOCKERS entry 9). |
| `xwalkOccurrenceCoverage` | **≥ 0.50** | Share of realtime `StopTimeUpdate` **occurrences** — not distinct stops — that resolve through a confirmed, ≥0.60-confidence crosswalk entry. Occurrences, because what matters is how much of the live feed we can actually read, and popular stops appear far more often. |
| `crossRouteAgreement` | **≥ 0.85** when measurable | The crosswalk disagreeing with itself across routes means it is wrong, not merely thin. Computed over geometric anchors only — see §3.3e. |
| `monotonicity` | violation rate **≤ 0.05** | Bound trips visiting their crosswalked stops out of order is a structural error geometry alone cannot catch. Fed the **static** sequences via `crosswalkedStaticSeqs` since `6920b13`, so it can genuinely fail — see §3.3e. |
| `boardAgreement` | median \|first-stop residual\| **≤ 300 s** over the last 200 bindings | A large systematic residual means the realtime feed and our seeded static are simply different boards. This self-detects a mid-transition case that a hand-set flag would miss. |

**Per-pattern breaker** (`patternHealthy`): a pattern whose rolling median `|residual|`
exceeds **half its own headway** has drifted onto the wrong slots and would produce delays
that are self-consistent and wrong by roughly one headway. Its bindings are voided *without*
stopping the rest of the cycle, because the fault is local.

**Birth capture** keeps running while suppressed, so the machinery keeps warming. The
**origin lock itself does not**: `runCycle` guards `lockPendingBirths` with `boardActive`. That
guard was the binding half's binding constraint until the board activated on **2026-07-26** —
births accumulated in the pending map and were expired after an hour without ever being tested
(1,334 pending, 0 active at cycle 32 of the 2026-07-25 run). It is no longer: on 2026-07-26 the
lock runs every cycle, and a measured run reached **886 bound, 30 voided, 161 refused**. The
binding half is now exercised against real service rather than reasoned about.

### 3.7 State today, stated plainly

Verified against the production database at 2026-07-25 10:43 America/Toronto and against
cycle 17 of the running collector (the run continues; later cycles are cited where they
change the picture):

> **This table is a dated snapshot from the day BEFORE the board activated, kept as the record
> of that state. It is not current.** Every row below that depends on `boardActive` has since
> changed: the board activated 2026-07-26, bindings and `trip_delay_obs` rows are non-zero, and
> crosswalk coverage cleared the 0.50 gate once the third promotion path landed. For the current
> picture see §3.3d, §9.4 and DECISIONS §46.

| Measure | Value |
|---|---|
| Loaded board coverage | `20260726..20260905` |
| Machine date | 2026-07-25 (Saturday); the board activates on Sunday 2026-07-26 |
| Calendar-active services today | **0** → gate `boardActive` fails, engine publishes nothing |
| `trip_delay_obs` rows | **0** |
| `agg_delay` / `agg_delay_route` rows | **0** / **0** |
| `ghosts` rows | **0** (an honest zero: due trips this cycle = 0) |
| `rt_trip_binding` rows | **0** |
| RT stop ids seen / confirmed / conflicted | 7,966 / 2,693 / 65 (DB); 6,632 / 2,542 / 69 in the current process |
| Crosswalk entries usable for a delay row (`confirmed` ∧ conf ≥ 0.60) | **1,935** |
| Crosswalk occurrence coverage | **35.6%** at cycle 17, flattening at **36.5–37.2%** across cycles 25–32 — below the 0.50 gate, so it would suppress even with an active board |
| Cross-route agreement | **93.8%** |
| Direct `trip_id` match rate | **0.3%** |

The suppression string the engine reports is *"no calendar-active schedule for 20260725; the
loaded board covers 20260726..20260905"* — deliberately distinct from both "no data yet" and
"0 min delay".

---

## 4. Corrections — what we got wrong

This is the most interesting empirical finding in the project, and it is a finding about our
own code. It is recorded here in full rather than in a footnote.

### 4.1 The trap

GTFS-realtime's `StopTimeEvent` carries an absolute predicted `time` and an optional `delay`
in seconds relative to the schedule. The specification treats `delay` as authoritative, and
the first-generation collector read it, guarded by the idiomatic `if (ev.delay != null)`.

GTFS-realtime is **proto2**, where `delay` is an `optional int32` with an implicit default of
`0`, and protobuf.js materialises that default **on the message prototype**. A decoded event
therefore *answers* `0` for a field it never received. The guard passed on every event and
recorded a measurement of zero seconds. **It could not distinguish "the agency says this bus
is exactly on time" from "the agency said nothing."**

The TTC publishes no `delay` field at all. Own-property census over one live snapshot
(`Object.prototype.hasOwnProperty.call(ev, 'delay')`, recorded in BLOCKERS.md):

| Entity | Count | `hasOwnProperty('delay')` | reads `delay === 0` |
|---|---:|---:|---:|
| `StopTimeEvent` | 23,476 | **0** | all |
| `TripUpdate` | 1,392 | **0** | all |

`time` is an own property on all of them. The wire-level proof is a unit test
(`server/src/pb.test.ts`, *"THE ROOT CAUSE"*): `StopTimeEvent.create({time:123})` encodes to
**2 bytes** and decodes with `hasOwn(delay) === false`; adding an explicit `delay: 0` encodes
to **4 bytes** and decodes with `hasOwn(delay) === true`.

### 4.2 What it cost

| Consequence | Figure | Source |
|---|---|---|
| Delay observations recorded, every one with the identical value `0` | **314,742** | pre-purge reading recorded in `README.md`; earlier readings the same day were 304,697 and 312,696 — the count moved, the single distinct value did not |
| `agg_delay` buckets built from them, P25 = P50 = P75 = 0 | **87,955** | pre-purge reading recorded in `README.md` |
| Of those, buckets clearing the n ≥ 8 evidence gate and rendering in the UI as trust grades and confidence bands | **6,022** | **not independently re-verifiable.** Reported by the pre-purge audit; the tables were truncated before this document was written, so the figure cannot be re-derived from the database. Treat the exact number as a single reading; the qualitative claim — that a substantial share cleared the gate — follows from 87,955 buckets over ~7 hours of collection and is not in doubt |

The honesty engine was manufacturing confidence out of a decoder default. Note that every
gate in §6 was working perfectly; they were gating an input that was unanimously
meaningless. **Measuring your own inputs matters more than gating them well.**

### 4.3 The join was circular, and that — not `trip_id` — was why it read 0%

The identity join reconstructed a scheduled time as `predicted − delay`. With `delay`
always `0`, that expression is `predicted`. The join was comparing predictions against
predictions, and its measured match rate of **0%** was a property of the arithmetic, not of
the feed.

This matters because the 0% was originally attributed to the realtime/static `trip_id`
mismatch. The `trip_id` mismatch is real (§3.2) and is a genuine blocker, but it was not the
cause of that particular zero. `server/src/join.ts` is **deleted**, not patched: no code
path may reconstruct a scheduled time from the feed.

### 4.4 The same trap, three more fields

All verified by round-trip in `server/src/pb.test.ts`:

- `VehiclePosition.currentStatus` defaults to **`IN_TRANSIT_TO (2)`**, not 0. Live census:
  565 absent, 460 explicit 0, 102 explicit 1, 286 explicit 2. Reading it naively would have
  told us 565 stationary vehicles were in transit — and geometric anchoring (§3.3a) depends
  entirely on this field.
- `TripDescriptor.directionId` defaults to `0` — so direction must be inferred from the stop
  pattern and must never be read from this feed.
- `TripDescriptor.startDate` / `startTime` default to `''`.

### 4.5 Two smaller corrections, recorded because they were also ours

Both were found by running the engine against the live feed rather than by reading it
(DECISIONS §29), and both would have made the crosswalk permanently incapable of backing a
single delay row:

1. **Votes could never accumulate.** `resolvePatterns` originally reported only *newly*
   learned stops, but a stop discovered on cycle 1 is in the seed on every later cycle — so
   its vote count froze at one, permanently below the 0.60 confidence floor. Fixed by also
   reporting re-derivations (`implied`), which is what corroboration actually is. Covered by
   a regression test (`xwalk.test.ts`, *"a re-derived stop keeps voting"*).
2. **Propagated entries were penalised twice** — once by the 0.85 source discount and again
   by a missing-residual factor — capping them at **0.595**, just under the same floor. The
   residual factor for an unknown residual is now 1; the source discount alone encodes
   "derived, not measured".

### 4.6 The general lesson

A null-check is not an absence-check when the decoder supplies defaults. Anywhere a wire
format has implicit defaults — proto2 scalars, and every library that helpfully materialises
them — the only sound test for "did this arrive?" is an explicit presence probe
(`hasOwnProperty`, `toObject({ defaults: false })`, or generated `has*` accessors), never a
comparison against the default value. That is why `server/src/pb.ts` exists and why every
optional scalar in this codebase is read through it.

### 4.7 Disposition of the bad data

All of it was purged: `trip_delay_obs`, `agg_delay` and `agg_delay_route` were truncated and
collection restarted from zero — verified at the time of the purge (2026-07-25), when all
three tables held **0** rows. They are no longer zero: the engine began publishing on
2026-07-26 (§3.3d, DECISIONS §46), and every row written since carries `method='sched_diff'`,
which is the filter that separates the new data from the purged kind.

Migration 004 also carries `UPDATE trip_delay_obs SET method = 'legacy_feed_delay_zero'
WHERE method IS NULL`, and `aggregate.ts` filters on `method = 'sched_diff'`. That statement
affected 0 rows on this database because the table was already empty when it ran, but it
stays: it makes `method IS NULL` impossible for any pre-existing row on **any** database this
migration is applied to, and the filter it feeds is protected by a dedicated test
(`aggregate.test.ts`, *"THE ONE-LINE OMISSION: 1,000 legacy zero rows must not touch the
percentiles"*).

---

## 5. Ghost detection

### 5.1 The detection window

A scheduled trip enters the candidate set when its scheduled start is between **6 minutes**
(`GHOST_MIN_AGE_MS`) and **30 minutes** (`GHOST_MAX_AGE_MS`) in the past.

- **6 min.** Below this, absence is unremarkable: a vehicle can be seconds from its terminal
  and a trip update can arrive on the next 45 s poll. Six minutes also sits just past the
  agency's own on-time tolerance — the TTC counts a departure as "on time" up to **5 minutes
  late** ([TTC Service Standards, via TTCriders](https://www.ttcriders.ca/bunchingreport)).
  Calling a trip a ghost before the agency would even call it *late* would be indefensible.
- **30 min.** Beyond this we stop watching. A trip absent for half an hour is either a
  genuine no-show (already recorded) or a data problem we cannot resolve retroactively.

Both today's and yesterday's active service are scanned, because a past-midnight trip belongs
to yesterday's service date.

### 5.2 Confirmation and retraction

A ghost is a public accusation, so it has to survive two tests.

- **Confirmation — `GHOST_CONFIRM_MISSES` = 2 consecutive cycles** (≈90 s). This kills the
  single-dropped-poll false positive and the trip that is simply bound one cycle late.
- **Retraction.** Every ghost row this process writes is tracked. If the trip is later bound
  — or turns out to be cancelled — while still inside the 30-minute window, the row is
  **deleted** and the retraction counted and logged. Because retraction is a delete, the
  public ledger never contains a "retracted" state to render; it simply never had the event.
- Both bookkeeping maps are pruned when a trip leaves the window, so neither grows unbounded.

### 5.3 Circuit breakers

A mass no-show is almost always a feed outage or our own bug, not a city-wide collapse.

| Breaker | Condition | Rationale |
|---|---|---|
| **Global** | confirmed ghosts > **30%** (`MASS_GHOST_FRACTION`) of this cycle's due trips | System-wide implausibility. Emitting here would flood the ledger with garbage and destroy its credibility permanently. |
| **Per-route** | a route with **≥ 4** due trips (`MASS_GHOST_ROUTE_MIN_DUE`) would emit ghosts for > **30%** of them | A board update or feed glitch touching a handful of routes stays far under the global threshold and would slip straight through a global-only breaker. The ≥4 minimum stops a route with two due trips from tripping on a single legitimate ghost. |

Cycles where a breaker fires are counted (`massGhostTrippedCycles`) rather than silently
discarded, so suppression is itself auditable. The ghost scan is additionally skipped
entirely while a static-context reload is in flight: mid-reload the trip map may already be
the new board while the pattern index is still the old one, which would make every new-board
trip look absent.

**These breakers are now the only quantitative guard on the false-ghost path.** The earlier
design gated ghost emission on a measured realtime/static `trip_id` match rate above 50%;
that gate no longer exists, because presence is no longer decided by `trip_id` at all. See
§9.5 for the failure modes that leaves open.

### 5.4 Officially-cancelled trips

A `CANCELED` entity is identified by direct static `trip_id` match first, then by an existing
binding. Only an identified trip is labelled `kind='cancelled'`. Anything left is **counted,
never guessed** (`canceledUnidentified`).

A cancelled trip is excluded from the ghost confirmation loop, and if a ghost row was already
written for it, that row is retracted so the cancellation wins — otherwise the ghost insert
would win the `ON CONFLICT` and the cancellation would be silently dropped.

**On the TTC this path is honestly dormant.** Measured (BLOCKERS.md): of ~2,115 TripUpdate
entities, **0** carry `scheduleRelationship = CANCELED (3)`. Worse, the ones the feed might
publish would be *anonymous* — TTC `CANCELED` entities ship no `stop_time_update`, no
`start_time` and no `start_date`, so they cannot be bound by the origin lock and cannot be
placed on a schedule. The honest consequence is that an officially-cancelled-but-anonymous
trip surfaces as a **ghost** via the absence path rather than as a distinct "cancelled"
label. That is a feed limitation, not a bug; if the TTC ever publishes identifiable
`CANCELED` entities, the path activates with no code change.

---

## 6. The honest-ETA estimator

### 6.1 What becomes evidence

Not every delay observation is evidence. `runAggregation` in `server/src/aggregate.ts` reads
only rows satisfying **all** of:

```sql
method = 'sched_diff' AND confidence = 'high' AND xwalk_conf >= 0.60
```

over a trailing **14-day** window. So a `low`-confidence binding (scheduled headway 300–600 s,
§3.4.4) is recorded and auditable but never reaches a rider-facing number, and neither does a
row whose stop identity was only a candidate. `n_trips` — the count of **distinct static
trips** behind a bucket — is carried alongside `n`, because *N* observations that all came
from one very late bus is a much weaker claim than *N* observations from *M* buses, and the
two must not look identical.

Each table is rebuilt atomically inside a transaction so a reader never sees a half-written
aggregate. Percentiles are continuous (linear interpolation between closest ranks), matching
Postgres `percentile_cont`, but computed **in JavaScript** so the numbers are identical on the
`pg` and PGlite drivers rather than subtly diverging by backend. `percentile_cont` support is
probed on every run and the JS path is used regardless; note the probe result is only
*printed* by the standalone `npm run aggregate` entry point — the in-process boot and hourly
runs discard it.

### 6.2 The estimator

For a departure on route *r* at stop *s* scheduled at hour-of-week *h*:

```
estimate = scheduled + median(historical delay for that bucket)
band     = [scheduled + P25 , scheduled + P75]
```

Median rather than mean because transit delay distributions have a long right tail — one
40-minute short-turn should not move the number a rider plans around. P25–P75 rather than a
standard deviation for the same reason: a robust statement of "half the observed trips landed
in here" that survives outliers without any distributional assumption.

### 6.3 Evidence gating

Every departure carries `{ n, windowDays, bucket }`, and the bucket is chosen by hard
thresholds with no soft fallback (`selectEvidence` in `server/src/eta.ts`):

| Bucket | Key | Minimum n | Why this threshold |
|---|---|---|---|
| `stop-hour` | (route, stop, hour-of-week) | **8** (`STOP_HOUR_MIN_N`) | The most specific bucket, and the one a rider's question maps to. Roughly a week of a moderately frequent route at that stop-hour — enough for a median and quartiles to mean something, low enough that a real signal is not withheld for a month. |
| `route-hour` | (route, hour-of-week) | **20** (`ROUTE_HOUR_MIN_N`) | The fallback loses stop-level specificity, so it must earn the substitution with substantially more data: the estimate is now about the route's behaviour at that hour, not that corner's. |
| `none` | — | — | **No estimate at all.** `estimateMs`, `bandLowMs`, `bandHighMs` and `medianDelaySec` are all `null`; the row is schedule-only. |

A confident number is never returned without the evidence that supports it. The API cannot
express "here is an estimate" separately from "here is why", because they are the same object.

### 6.4 Trust grade

An optional `grade` — a letter **A–E** (`GRADE_TIERS`, `gradeFor` in `server/src/api.ts`)
derived from the two things actually measured: `n`, and `spreadMin` = half the P25–P75 spread
in whole minutes (the `± X min` the UI renders).

| Letter | Minimum n | Maximum ± spread |
|---|---:|---:|
| **A** | 40 | 4 min |
| **B** | 25 | 6 min |
| **C** | 15 | 9 min |
| **D** | 8 | 14 min |
| **E** | — | — (has evidence, meets no tier above) |

A grade is the best tier meeting **both** thresholds, so a wide spread can never be bought
with sample size and a large sample can never rescue a wide spread: 200 observations spanning
±20 minutes is a lot of evidence that the route is unpredictable, and the letter should say
so. The D floor of n ≥ 8 is deliberately the same floor `selectEvidence` uses, so D is the
weakest grade a stop-hour bucket can earn on sample size alone.

The `grade` field is **absent, not defaulted**, whenever `evidence.bucket === 'none'`. An
untracked departure has no letter and the UI says "untracked" — never a soft "E" that looks
like a measurement.

### 6.5 Live ETAs

A departure also carries `liveEtaMs` when we hold one. It is published **only** for a trip
we actually bound and a stop we actually crosswalked: the poller keys live predictions by
static trip id and static stop id, mapping through `engine.staticStopFor()`, which returns
null unless the entry is `confirmed` with confidence ≥ 0.60. An unbound trip contributes
nothing rather than a guess. Live ETAs are attached only when the query is within
`LIVE_ETA_MAX_SKEW_MS` = 10 minutes of now.

---

## 7. The ghost forecast

The forecast answers a different question from detection: not *did this trip vanish* but *how
often does this route × hour vanish*.

**Method** (`buildForecast`, `ghostRiskFor` in `server/src/api.ts`). For a
`(route_id, hour_of_week)` cell over a trailing 14-day window:

```
rate = ghosts in that cell / scheduled trips in that cell
```

**The denominator is the hard part, and it is derived rather than assumed.** A *watched cell*
is a wall-clock `(calendar-date, hour-of-week)` pair in which the collector demonstrably ran —
proven by at least one row in `trip_delay_obs` whose `ts` falls inside that hour. The
denominator counts scheduled trips whose start lands in a watched cell; the numerator counts
ghosts whose scheduled start lands in **the same** watched cells.

The lazy version — "days on which we saw anything" — silently counts scheduled trips from
hours the collector slept through, deflating the rate by our own downtime. Restricting both
sides to the same cells is what makes the ratio mean anything. An hour in which the collector
ran but recorded zero observations is indistinguishable from an hour it did not run, so it is
treated as unwatched; that drops the matching ghosts too, keeping the ratio consistent rather
than inflated. Only `kind='ghost'` rows are counted — a cancellation is an announced absence,
not a broken promise.

**Gating.** Thresholds are structural and chosen *a priori* — deliberately not tuned to any
observed distribution, because tuning a threshold to make your own numbers look interesting is
how this kind of metric stops being a measurement:

| Constant | Value | Meaning |
|---|---|---|
| `GHOST_RISK_MIN_N` | **8** | A cell with fewer than eight scheduled trips is an anecdote, not a rate. |
| `GHOST_RISK_ELEVATED_RATE` | **> 0.08** | `elevated` — roughly one run in twelve went missing. |
| `GHOST_RISK_HIGH_RATE` | **> 0.20** | `high` — more than one run in five went missing. |

Below the elevated threshold **there is no chip at all**; the field is simply absent. There is
deliberately no "low risk" badge: a reassuring label on a cell with eight observations is a
fabrication wearing a calm expression. A cell reporting more ghosts than scheduled trips is
withheld rather than reported as >100%, since the two sides must then disagree about the window.

The response carries `rate`, `n` (denominator), `ghosts` (numerator) and `windowDays`, so
anyone can check the arithmetic. The denominator query walks every trip's first stop_time, so
it is far too heavy for a request path: it is computed in the background and refreshed every
**30 minutes** (`FORECAST_REFRESH_MS`).

**The forecast is empty and correct.** It is built from confirmed ghosts, and the ghost count
is still zero for the reason given in §9.4 — the mass-ghost breaker suppresses the scan while
most of the board is unbound — so every cell returns `null`. Silent, not broken. Note the cause
has changed even though the output has not: the forecast was empty because there was no active
board, and is now empty because ghost detection is honestly refusing to report.

---

## 8. Time handling

All agency-local time arithmetic goes through the built-in `Intl` API against IANA
`America/Toronto` (`server/src/tz.ts`). There is not a single hardcoded UTC offset in the
codebase.

- **GTFS `>24:00:00` times.** Stored as seconds-past-service-midnight integers, so `25:30:00`
  is `91800`. The real maximum in our loaded board is `110861` = 30:47:41.
- **The GTFS service anchor is noon-minus-12h, not midnight** (`serviceEpochSeconds`).
  Anchoring at midnight renders a 9h GTFS time as 08:00 wall clock on 2026-11-01 and 10:00 on
  2027-03-14 instead of 09:00 both times — 3,600 s of fabricated delay on every observation,
  all day. Covered by `tz.test.ts`.
- **DST.** EST/EDT transitions are resolved by the tz database rather than by us.
- **`hour_of_week`** (0–167, Monday 00:00 = 0), the bucketing key for all aggregates, computed
  from the **scheduled** instant.
- **Service date** is the Toronto calendar date of `now − 4h` (`serviceYmd`), so a trip running
  at 01:30 attaches to the service day that started it.

---

## 9. Limitations

Stated plainly, because a methods section that omits these is advertising.

**9.1 Realtime `trip_id` does not match static `trip_id`.** Measured live at **0.3%** on the
current run, and re-measured every cycle rather than assumed. Every identity in this system —
which static trip, which static stop — is therefore *inferred*. The inference is auditable
(§3.3e, §3.6) but it is inference, and the gates that guard it work by **refusing to publish**,
which means the system's bias is one-directional: GhostBus under-reports before it invents.

**9.2 Realtime and static `stop_id` are disjoint namespaces.** 0.67% per-route overlap;
matching the ids directly produces confident, plausible, entirely wrong results (§3.2). Stop
identity must be *learned*, and the crosswalk is only as good as the geometric anchors feeding
it. Every published delay row carries `xwalk_conf` so a consumer can see this.

**9.3 Most of the engine's learned state is not restored across restarts.** `rt_stop_xwalk`
**is** read back — `loadCrosswalk()` restores it at boot, scoped by board tag, and the merge
rules that keeps it honest are pinned by tests (§3.3d; BLOCKERS entry 11). The other five
tables — `rt_stop_anchor`, `rt_stop_xwalk_votes`, `rt_pattern`, `rt_trip_binding` and
`sched_slot_claim` — are still **written but never read back**: they are an audit trail, not a
cache.

Two consequences survive that fix. **The geometric anchors do not come back**, so a restart
re-derives them from live `STOPPED_AT` vehicles at roughly 100 usable per cycle; restoring them
was implemented, measured, and reverted because it put coverage *below* the publish gate on the
only run available (DECISIONS §35, BLOCKERS 11). And **binding-derived promotions do not come
back by design** — a crosswalk entry confirmed by the time-domain path is restored as a
`candidate`, because the bindings behind it belong to a service day rather than to the board
(§3.3d). A cold-start process therefore still needs the vote count each entry needs to clear the
0.60 floor: 6 cycles for a perfect geometric anchor, **8 for a propagated one**, which is most
of them — measured at 0.0% coverage through cycle 9, reaching 34.5% at cycle 11.

**9.4 The ghost count must never be extrapolated from — and why it currently reads zero.** The
loaded board covers **20260726..20260905**, and it activated on **2026-07-26**. Before that date
there was zero calendar-active service, so the ghost count was an honest zero with a zero
denominator, and this section said so.

That is no longer the reason, and the difference matters more than the number. The denominator
is now real — roughly **646 due trips** per cycle — and the count is still zero, because the
poller's **global mass-ghost breaker** fires. Its input is the share of due trips that have been
*confirmed* absent — due, and unmatched for `GHOST_CONFIRM_MISSES` consecutive cycles (§5.3) —
and "matched" means the delay engine holds a binding for the static trip. On 2026-07-26 that was
470 of 646, far past the breaker's 30% ceiling, so it suppresses every candidate as "feed outage
or our bug, not reality". The breaker is working. But **"nothing was late" and "we could not bind enough of the
board to tell" are opposite statements**, and only the second one is true today. Ghost detection
needs most of the board bound; the join rate is **36.0%** and rising (§9.5).

**No ghost count from this project should ever be estimated, projected or annualised** — that
rule predates the board activating and is unaffected by it.

Separately, **the board's Saturdays and its civic holiday were missing from the seed** for the
first two days of this board's life. The seeder loaded only services active inside a 7-day
window, so the Saturday service (`'2'`, 32,874 trips) and the civic-holiday service (`'4'`,
31,295 trips, active only on 2026-08-03) were dropped whole along with three tiny specials —
68,401 seeded trips against 133,682 published, a 65,281-trip difference exactly accounted for by
those five services. Six Saturdays and Monday 2026-08-03 therefore resolved to a service with
zero trips. **This was fixed by a re-seed** (BLOCKERS.md entry 9, fixed 2026-07-25; the seed
window is now the board's own span — DECISIONS §43), and the `boardIntegrity` gate that was
added alongside it stays: a calendar-active date for which we hold no trips is reported as
missing data, never rendered as a clean day. The current board holds the full ~132.6k trips.

**9.5 Ghost detection inherits every binding refusal.** A trip is "present" only if it is bound.
A trip the origin lock refuses — sub-300 s headway, mid-route arrival, ambiguous slot,
unconfirmed origin stop, or simply born before this process started — is indistinguishable from
a trip that never ran. Three specific consequences, all structural and visible in the code. The
first is now also measured: on 2026-07-26 the join rate ran **18.8% → 36.0%** across 18 cycles,
so roughly two thirds of due trips were unbound and therefore indistinguishable from absent —
which is precisely why the mass-ghost breaker (§9.4) suppresses the whole scan.

- the sub-300 s headway band (**4.9%** of trips by the DECISIONS §29 measurement) can never be
  bound, so its static trips are permanently absent;
- after any process restart, trips already running are `refused_midroute` and stay absent until
  they finish;
- the crosswalk warm-up in 9.3 suppresses binding for the first several cycles of any run.
  Its coverage plateaued *below* the publish gate for the whole of this project's history
  until 2026-07-26 (BLOCKERS.md entries 10 and 20); the third promotion path (§3.3d) cleared
  it, and a measured run ran 47.3% to 68.5% over 18 cycles. The warm-up cost itself remains:
  a cold process still publishes nothing for its first ~10 cycles.

In each case the mass-ghost breakers (§5.3) are the only thing standing between that and a wall
of false ghosts, and a breaker is a blunt instrument: it suppresses a whole route or a whole
cycle. This is the weakest joint in the system and it is not yet validated against an active
board.

**9.6 Our errors flatter the agency.** The asymmetric origin band and headway aliasing (§3.4.3)
bias identification errors toward matching a late bus to a later slot, which reads as less
lateness than reality. It is bounded by the 300 s headway refusal and the 120 s margin test, and
disclosed on every row — but it is not eliminated, and it points the wrong way for an
accountability product.

**9.7 No ground truth.** There is no independent record of which TTC trips actually operated. We
cannot compute precision or recall for ghost detection, or accuracy for binding, because there is
nothing to compute them against. Every guard in §3 and §5 is a *design* argument about failure
modes, not a *measured* false-positive rate. The crosswalk's cross-route agreement audit
(§3.3e) audits *stop* identity, not trip identity, and over *geometric* anchors only. The
monotonicity audit does now cover the propagated majority — it was inert as wired until
`6920b13` and is not any more (§3.3e) — but it is a *structural* check: it detects crosswalked
stops visited out of order, not a crosswalk that is wrong in a consistently ordered way. The
one accuracy estimate the project has is the held-out-geometry experiment in DECISIONS §46, and
it is bounded in three ways stated there: it can only score stops that carry a clean geometric
anchor, it ran on one Sunday board, and its strict arm returned zero errors, which bounds the
error rate rather than measuring it. **No accuracy figure for binding
or delay is claimed anywhere in this repo**; in particular the simulation-derived numbers that
appeared in earlier design
documents (33.2% / 70.5% / 90.2% / 97.7%) rest on an assumed delay distribution and assumed noise
and must not be reported as performance.

Read "GhostBus detected N ghosts" as "N scheduled trips satisfied the definition in §1 under the
thresholds in §5" — which is exactly what it says and no more.

**9.8 Observation window and survivorship.** The historical evidence base is only as good as our
uptime:

- Aggregates cover a trailing 14 days and no longer.
- Hours the collector was not running contribute nothing. On a free hosting tier that spins down
  after 15 minutes of inactivity those holes are systematic rather than random — they cluster in
  exactly the low-traffic overnight hours where service is sparse and ghosts are most likely. The
  forecast's watched-cell denominator (§7) is designed so this deflates coverage rather than
  distorting the rate, but it is a mitigation, not a fix.
- Delay observations are only written for stops a vehicle **passed while we were watching**, on a
  trip we managed to bind. A trip that vanished entirely contributes no delay observations at
  all, so the delay distributions are conditioned on the trip having run. **The honest-ETA numbers
  describe how late buses are *given that they came*.** Ghosts are the other half of the story;
  combining the two into a single "expected wait" would be a survivorship-biased number dressed up
  as a complete one. GhostBus deliberately keeps them separate.

**9.9 Straight-line walking.** The walk path drawn on the map is as-the-crow-flies. There is no
routing engine in this tier, and the UI presents it as an indicator rather than a route.

**9.10 Single agency.** Everything above is measured on the TTC. The schema carries an `agency`
seam throughout, but no second agency has been ingested, and none of these thresholds have been
validated against another feed's quirks.

---

## References

- TTCriders, *Lucky or late: A report on TTC metrics vs. rider experience* —
  <https://www.ttcriders.ca/bunchingreport> (TTC on-time definition: departure from an end
  terminal within 59 s early to 5 min late).
- GTFS Realtime Reference — <https://gtfs.org/documentation/realtime/reference/>
  (`StopTimeEvent.delay`, `TripDescriptor.ScheduleRelationship`, `Alert.Effect`).
- Measured feed findings: `BLOCKERS.md`. Decision history: `DECISIONS.md` §29 (the delay
  engine). System shape: `ARCHITECTURE.md`.
- Unit tests for everything above: `server/src/{pb,patterns,xwalk,bind,delay,gates,eta,tz,aggregate,api}.test.ts`.
