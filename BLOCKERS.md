# BLOCKERS.md — honest limitations found on real data

Each entry carries a status. **Nothing measured has been deleted**, including the entries
that turned out to be wrong — those are marked `SUPERSEDED` with what replaced them and why,
because a finding that quietly disappears teaches a future reader nothing.

Last reconciled against the source tree, the production database and the running collector on
**2026-07-25**.

| # | Status | Entry |
|---|---|---|
| 1 | RESOLVED | Static GTFS seed into Postgres |
| 2 | OPEN (structural) | Realtime `trip_id` does not match static `trip_id` |
| 3 | SUPERSEDED | The Phase-2 reconstructed-schedule-time join |
| 4 | OPEN (feed limitation) | No usable officially-`CANCELED` labelling |
| 5 | NOTE | The feeds do not support conditional requests |
| 6 | RESOLVED in code, data purged | The feed publishes no `delay` field at all |
| 7 | OPEN, mitigated | Realtime and static `stop_id` are disjoint namespaces |
| 8 | OPEN (feed limitation) | `TripDescriptor` carries no start time, date or direction |
| 9 | OPEN, filed, not fixed | The seeded board has no Saturday trips |
| 10 | OPEN (blocking today) | Crosswalk coverage is below its own publication gate |
| 11 | OPEN (blocking every restart) | The learned crosswalk is not restored across restarts |
| 12 | OPEN (new risk) | Ghost detection now inherits every binding refusal |
| 13 | OPEN, filed | `/api/health` does not surface the delay engine's own stats |
| 14 | OPEN (structural) | No end-to-end accuracy validation is possible before 2026-07-26 |
| 15 | NOTE | Route 501 hits the RT pattern cap every cycle |

---

## 1. RESOLVED by Milestone 0 — static GTFS seed into Postgres

The pre-existing `server/live.ts` noted that geographically-correct live rendering
"needs the static GTFS seed (route colors, shapes, headsigns, stop_times) loaded into
Postgres." Milestone 0 delivers exactly that: `npm run seed:toronto` loads routes,
stops, trips, stop_times, shapes, calendar, and calendar_dates into Postgres (verified
against Neon: 233 routes, 9,361 stops, 68,401 trips, 2,151,105 stop_times, 1,374 shapes).

*Re-verified 2026-07-25: 233 routes, 9,361 stops, 68,401 trips, 2,151,105 stop_times.*

---

## 2. OPEN (structural) — TTC realtime trip_ids do NOT match static GTFS trip_ids

This is the mismatch the spec required us to check for, and it is real.

**Measured on live data (collector calibration, real TTC feeds):**
`RT trip_id sample = 1920, matched to static trips = 2, match rate = 0.1%`.

**Re-measured 2026-07-25** by the delay engine, which now computes this every cycle rather
than trusting a stored figure (`stats.directTripIdMatchRate`, `runCycle` in
`server/src/engine.ts`): **0.3%** on every cycle of the current run. It is re-measured
because every positive realtime trip id ends in `"020"`, which reads like a board tag — a
board rollover could make the ids match outright, and the engine should notice for free
rather than keep inferring.

Also: **13 of 1,392** trip updates carry a negative synthetic `tripId`, and those 13 are
exactly the 13 with the undocumented trip-level `scheduleRelationship === 8` (not a value in
the GTFS-realtime enum). They are counted and excluded from binding; no semantics are
inferred from them.

`StopTimeUpdate.scheduleRelationship` values seen: **NO_DATA (2) = 483, SKIPPED (1) = 0.**
NO_DATA carries no time and is never emitted — imputing an on-time arrival for it would
reproduce exactly the fabrication in entry 6.

### Consequence

Trip identity has to be **inferred**. It is now inferred by the origin lock
(`server/src/bind.ts`), described in `METHODS.md` §3.4, not by any `trip_id` comparison.

### What we used to do here, and what changed

The Milestone-0 collector measured the match rate live and **suppressed ghost/cancelled
emission** whenever it fell below 50% (`MATCH_RATE_THRESHOLD`). **That constant no longer
exists.** Presence is no longer decided by `trip_id` at all — a static trip is "present"
when the delay engine holds a live binding for it — so a match-rate gate would be gating a
quantity nothing depends on. The guards that remain are the ≥2-cycle ghost confirmation,
retraction, and the global/per-route mass-ghost breakers. Entry 12 records what that leaves
open.

### CORRECTION to this entry's original text

The original version of this entry ended with a paragraph headed *"Not affected: delay
observations"*, claiming they were "genuine schedule-vs-live signal" because they used the
feed-provided `delay` keyed by `route_id` + `stop_id`, and citing 1,984 observations inserted
on the first cycle as evidence that they worked.

**That paragraph was wrong, and it was wrong in the most expensive possible way.** Those
observations were reading a protobuf default, not a measurement — see entry 6. The text is
recorded here rather than silently edited because it is the clearest illustration of the
trap: the delay path looked like the *healthy* half of the system precisely because it
produced rows.

---

## 3. SUPERSEDED — the Phase-2 route + reconstructed-schedule-time join

This entry originally recorded `server/src/join.ts` as the resolution to entry 2. It is kept
because its measurements of the feed are still valid, and because the resolution it claimed
was itself invalid.

**Still-valid measurements from that work:**

- RT `TripDescriptor` **omits `start_time` AND `start_date`** (both empty strings on all
  1,200 vehicles / 1,876 trip updates) — so the spec's literal
  `(route_id, start_date, start_time)` key is impossible as written.
- RT `route_id` **matches** the static `route_id` (174/175 distinct present).
- RT `stop_id` (per StopTimeUpdate) is **~60–70%** *numerically* present in static `stops` —
  which entry 7 later showed to be coincidence, not identity.
- Each StopTimeUpdate carries a predicted `time`.

**Why the join is deleted, not fixed.** It reconstructed `scheduled = predicted − delay` per
stop and claimed the static trip whose `(route_id, stop_id, departure_s)` agreed on ≥2 stops
within ±75 s. The feed publishes no `delay` (entry 6), so that expression evaluated to
`scheduled = predicted` and the join compared predictions against predictions.

**Its measured join rate of 0.0% was therefore a property of its own arithmetic**, not of the
board offset and not of the `trip_id` mismatch, which is what this entry originally blamed.
Both of those are real and are recorded in entries 2 and 14 — but neither produced that
particular zero. `server/src/join.ts` is deleted. No code path may reconstruct a scheduled
time from the feed; scheduled time comes only from our own seeded `stop_times`.

---

## 4. OPEN (feed limitation) — TTC cannot support officially-"cancelled" labelling for anonymous trips

Measured on the live trips feed: of ~2,115 TripUpdate entities, **0 carry the standard
`scheduleRelationship = CANCELED (3)`**; 2,084 are SCHEDULED and 31 carry a **non-standard
`scheduleRelationship = 8`** (not defined in the GTFS-realtime
`TripDescriptor.ScheduleRelationship` enum — undocumented semantics, so we do not act on it).
Separately, CANCELED entities on this feed ship **no `stop_time_update`** and no
`start_time`/`start_date`, and their RT `trip_id` does not match static — so a CANCELED
entity is **anonymous**: it carries no stops, so it can never be bound by the origin lock and
cannot be placed on a schedule.

**What we do:** for a CANCELED entity we attempt a direct static `trip_id` match first, then
look for an existing binding; only an identified trip is labelled `kind='cancelled'`.
Anything left is **counted, never guessed** (`canceledUnidentified`). The honest consequence:
an officially-cancelled but anonymous trip will simply surface as a **ghost ("never
arrived")** via the absence path rather than as a distinct "cancelled" label. This is a feed
limitation, not a bug. If TTC later publishes CANCELED entities with a matching identity, the
`kind='cancelled'` path activates with no code change.

*(Updated 2026-07-25: the mechanism named here was the ≥2-stop identity join, which is
deleted. The conclusion is unchanged and is in fact stronger — a CANCELED entity ships no
stops at all, so it cannot clear the origin lock's birth capture either.)*

---

## 5. NOTE (empirical) — the TTC GTFS-realtime feeds do not support conditional requests

The trips feed returns **no `ETag` and no `Last-Modified`**, and a conditional re-request
(with `If-None-Match`/`If-Modified-Since`) returns **200, never 304**. So the collector's
conditional-request headers are harmless no-ops and a "fresh" cycle is always a real 200
snapshot. The ghost-scan freshness gate (`feedsFresh`) is therefore never satisfied by a
stale-but-unchanged reuse — there is nothing to reuse. No state-caching-on-304 path was built
because it would be dead code on this feed.

---

## 6. RESOLVED in code, data purged (measured 2026-07-24) — the TTC realtime feed publishes NO `delay` field at all

The previously-reported finding "every StopTimeUpdate carries a `delay` and every one is 0"
was itself wrong. It was a **decoder artifact**, not a measurement.

GTFS-realtime is proto2, and protobuf.js materialises every optional field's default on the
message **prototype**. So a field the producer never put on the wire still reads as a value.
`poller.ts` used `ev.delay != null`, which cannot distinguish "reported as on time" from
"never reported".

**Own-property census over one live snapshot** (`Object.prototype.hasOwnProperty.call(ev, 'delay')`):

| Entity | Count | `hasOwnProperty('delay')` |
|---|---:|---:|
| StopTimeEvent | 23,476 | **0** |
| TripUpdate | 1,392 | **0** |

Every one of them reads `delay === 0`. **Wire-level proof** (`server/src/pb.test.ts`, test 1):
`StopTimeEvent.create({time:123})` encodes to **2 bytes** and decodes with
`hasOwn(delay) === false`; adding an explicit `delay: 0` encodes to **4 bytes** and decodes
with `hasOwn(delay) === true`.

**Consequence.** Every delay observation this project accumulated before 2026-07-24 recorded
a protobuf default as if it were a measurement. The evidence base was information-free, and
the identity join built on it reduced to a comparison of predictions against predictions
(entry 3).

**The same trap applies to three more fields**, all verified by round-trip:
`VehiclePosition.currentStatus` defaults to **IN_TRANSIT_TO (2)**, not 0 (live census: 565
absent, 460 explicit 0, 102 explicit 1, 286 explicit 2); `TripDescriptor.directionId` defaults
to 0; `TripDescriptor.startDate`/`startTime` default to `''`. Every optional scalar must be
read through `server/src/pb.ts`.

### Resolution status

- **Write path:** fixed. Nothing is written from a feed-supplied delay; `delay_s` is
  `event_epoch_s − sched_epoch_s` with the scheduled side from our own `stop_times`
  (`server/src/delay.ts`).
- **Decoder:** fixed. Every optional scalar in `poller.ts` and `engine.ts` goes through
  `pb.ts`; `pb.test.ts` pins the behaviour.
- **Join:** deleted (entry 3).
- **Data:** purged. `trip_delay_obs`, `agg_delay` and `agg_delay_route` were truncated and
  collection restarted from zero. Verified 2026-07-25: **all three tables hold 0 rows.**
  Migration 004's `UPDATE ... SET method='legacy_feed_delay_zero' WHERE method IS NULL`
  affected 0 rows here but stays, so `method IS NULL` is impossible for any pre-existing row
  on any database this migration is applied to; `aggregate.ts` filters on
  `method = 'sched_diff'` and a dedicated test exists to stop that line being deleted.

The pre-purge counts (314,742 observations, 87,955 aggregate buckets) are recorded in
`README.md` and `METHODS.md` §4.2. They are no longer re-derivable from the database.

---

## 7. OPEN, mitigated (measured) — RT and static `stop_id` are DISJOINT namespaces

Matching realtime stop ids against static stop ids directly produces confident, plausible,
entirely wrong results. Measured on one live snapshot:

- **Per-route overlap: 69 of 10,262 = 0.67%.** A realtime stop id almost never names a stop
  that route actually serves in our static board.
- The tempting **59.3% global id overlap** (4,892 of 8,244) is pure numeric coincidence —
  both namespaces are small integers.
- **Control measurement, and it is decisive:** for a vehicle reported STOPPED_AT realtime
  stop *X*, the static stop *numbered X* sits a **median 13,703 m away**, and **0 of 55** are
  within 100 m.

Stop identity must therefore be **learned** from geometry and propagated
(`server/src/xwalk.ts`). Every published delay passes through an inferred crosswalk, and the
row carries `xwalk_conf` so the UI can say so.

**This is a mitigation, not a resolution.** The crosswalk is an inference with its own
falsifiable audits (cross-route agreement, monotonicity) and its own coverage problem —
entry 10.

---

## 8. OPEN (feed limitation) — `TripDescriptor` carries no start time, start date, or direction

Own-property census over 1,392 TripUpdates: `startTime` present **0** times, `startDate`
**0**, `directionId` **0**. Only `tripId`, `routeId` and `scheduleRelationship` are on the
wire. Direction must be inferred from the stop pattern and must never be read from this feed.

---

## 9. OPEN, filed, NOT fixed (`seed_toronto.ts` is not owned by this workstream) — Saturday has no trips

`calendar` contains service_id `'2'` with `sat = true`, but **zero trips reference it**. Trips
per service in the seeded board: `1` = 38,112 (Mon–Fri), `3` = 29,870 (Sun), `6701` = 360, and
59 more across four small specials. **Every Saturday the engine will legitimately find no
schedule**, and the honest product state on those days is "no calendar-active schedule for
this date".

Total seeded trips are **68,401** against roughly 133,682 in TTC's published board, so the gap
is probably wider than Saturday alone. This needs a re-seed; it is not something the delay
engine can or should paper over.

*Re-verified 2026-07-25 (itself a Saturday): `calendar` holds 12 service rows, all covering
20260726..20260905, and service `'2'` is the only one with `sat = true`. Trips exist for
services 1, 3, 6701, 7001, 4501, 4401 and 501 only — none of them Saturday services. Services
`'4'`, `'6702'`, `'6703'` and `'6704'` are also referenced by no trips at all.*

---

## 10. OPEN — the learned crosswalk is below its own publication gate

New entry, 2026-07-25. `evaluateGates` requires
`xwalkOccurrenceCoverage ≥ MIN_XWALK_OCCURRENCE_COVERAGE = 0.50` — the share of realtime
`StopTimeUpdate` occurrences that resolve through a `confirmed` crosswalk entry with
confidence ≥ 0.60.

Measured on the current run (`.data/collector.log`): coverage is 0.0% through cycle 9, jumps
to **34.5% at cycle 11** when the first entries clear the 8-vote confidence threshold, and
then **flattens — 36.5% to 37.2% across cycles 25–32**. It has not approached 0.50. In the
production `rt_stop_xwalk` table (read at cycle ~17): 7,966 realtime stop ids seen, 2,693
`confirmed`, 65 `conflicted`, and **1,935 entries usable for a delay row** (`confirmed` ∧
confidence ≥ 0.60).

**So even if the board were active today, the engine would still publish nothing** — it would
report `xwalkOccurrenceCoverage` rather than `boardActive` as the reason. This is the gate
behaving correctly, but it means the board activating on 2026-07-26 is **not by itself
sufficient** for the engine to start emitting, and any plan that assumes it is will be wrong.

**Whether 0.50 is reachable at all on this feed is now genuinely in doubt.** Fifteen cycles
of plateau is not proof — new stop identities are still being confirmed each cycle, just
slowly, and the run started from an empty crosswalk (entry 11) — but the curve is flat, not
climbing, and the gate is 13 points away. If it does not clear, the honest options are to
find the coverage that is being lost (a large share of `StopTimeUpdate` occurrences name
stops the geometry has never anchored) or to justify a different threshold on evidence
rather than on convenience. Lowering the gate to fit the measurement would be exactly the
move this project exists not to make.

---

## 11. OPEN — the learned crosswalk is written to Postgres but never read back

New entry, 2026-07-25. `rt_stop_anchor`, `rt_stop_xwalk`, `rt_stop_xwalk_votes`,
`rt_pattern`, `rt_trip_binding` and `sched_slot_claim` are written by `engine.ts` and
**never read by any code path** (verified: the only occurrences outside tests are `INSERT`
statements and one `UPDATE`). They are an audit trail, not a cache.

**Consequence.** Every process restart begins with an empty crosswalk. Because a propagated
entry needs 8 corroborating cycles to clear the 0.60 confidence floor
(`7/10 × 0.85 = 0.595`, `8/10 × 0.85 = 0.68`), occurrence coverage reads **0.0% through cycle
9** on a cold start, 0.9% at cycle 10, and 34.5% at cycle 11 — a warm-up of roughly eight
minutes at a 45 s cadence before the crosswalk can back anything at all, and longer before it
could clear the gate in entry 10.

On a free hosting tier that spins the service down after inactivity, this compounds: a
deployment that restarts more often than its warm-up period publishes nothing, ever. Loading
the crosswalk from `rt_stop_xwalk` at boot (scoped by `board_tag`) is the obvious fix and has
not been done.

---

## 12. OPEN — ghost detection now inherits every binding refusal

New entry, 2026-07-25. A scheduled trip is "present" only if the engine holds a live binding
for it. Any trip the origin lock refuses is therefore **indistinguishable from a trip that
never ran**. Refusals happen for good reasons, and each one is a false-absence channel:

- **sub-300 s headway** (`refused_headway_band`) — refused outright at any confidence.
  Measured trip-weighted share on service 1: **4.9%** (DECISIONS §29). Those static trips can
  never be bound and so are permanently absent.
- **mid-route arrival** (`refused_midroute`) — after any process restart, every trip already
  running is refused and stays absent until it finishes.
- **crosswalk not yet confident** — the entire warm-up window in entry 11.
- **ambiguous slot** (`refused_ambiguous`) — correct behaviour, same visible effect.

The only quantitative guards between this and a wall of false ghosts are the global (>30% of
due) and per-route (>30% once a route has ≥4 due) mass-ghost breakers, and a breaker is a
blunt instrument: it suppresses a whole route or a whole cycle rather than the specific trips
that were unbindable.

**This is untested against reality and cannot be tested until the board activates** — with 0
calendar-active services there are 0 due trips, so the ghost path has never run against a
non-empty denominator. It is the weakest joint in the system. A targeted fix would be to
exclude from the due set any static trip on a pattern the engine has structurally refused
(sub-300 s headway), rather than relying on a breaker to notice afterwards.

---

## 13. OPEN, filed — `/api/health` does not surface the delay engine's own stats

Filed in DECISIONS §29 ("Notes for other owners") and still true as of 2026-07-25:
`getJoinStats()` returns a `delayEngine` object (`DelayEngineStats`), but `/api/health` reads
only `boardCoverage` off it. The fields that most need to be public —
`suppressionReason`, `suppressionGate`, `xwalk.occurrenceCoverage` and
`xwalk.crossRouteAgreement` — are visible only in the server log.

The product's claim is that it can always say *why* it is not publishing a number. Today it
can say that to an operator reading stdout, and not to a rider or a reviewer hitting the API.

---

## 14. OPEN (structural) — no end-to-end accuracy validation is possible before 2026-07-26

The seeded board covers **20260726..20260905** and today is 2026-07-25, so **zero static
service is calendar-active**. The crosswalk half of the engine is calendar-independent and is
measurable today (cross-route agreement read **93.8%** at cycle 17). Trip binding and delay
measurement are not: they are gated off by `boardActive`, emit nothing, and cannot be
validated until the board activates. Verified today: `trip_delay_obs` = 0 rows,
`rt_trip_binding` = 0 rows, `ghosts` = 0 rows, due trips per cycle = 0.

The board's first active day is **Sunday 2026-07-26** (service `3`, 29,870 trips). Note entry
10: board activation is necessary but not sufficient.

Consequently **no accuracy figure for binding or delay is claimed anywhere in this repo.** In
particular, the simulation-derived numbers that appeared in earlier design documents (33.2% /
70.5% / 90.2% / 97.7%) rest on an assumed delay distribution and assumed noise. They are not
measurements and must not be reported as performance.

Nor is there any ground truth to validate against even after the board activates: there is no
independent record of which TTC trips actually operated, so ghost precision and recall are
not computable. The crosswalk's cross-route agreement and monotonicity audits are the only
falsifiable accuracy estimates the system has, and they audit *stop* identity, not *trip*
identity.

---

## 15. NOTE — route 501 hits the RT pattern cap every cycle

New entry, 2026-07-25. `mergeRtTrip` caps a route at 48 distinct RT patterns
(`maxPatternsPerRoute`). On the current run exactly one route hits it — **501**, on every
cycle (80 log lines). Trips beyond the cap are not clustered, so they are never bound and
never contribute delay observations for that route.

This is logged loudly rather than silenced, and it is recorded here because a route that is
permanently uncapturable is a coverage hole with a specific name. Whether 48 is too low for a
streetcar route with many short-turn branches, or whether 501's realtime patterns are
genuinely fragmenting, has not been determined.
