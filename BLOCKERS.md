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
| 9 | OPEN in the seed, GATED in the engine | The seeded board has no Saturday trips |
| 10 | RESOLVED (gate unchanged, learning fixed) | Crosswalk coverage is below its own publication gate |
| 11 | RESOLVED for the crosswalk, OPEN for the anchors | The learned crosswalk is not restored across restarts |
| 12 | OPEN (new risk) | Ghost detection now inherits every binding refusal |
| 13 | OPEN, filed | `/api/health` does not surface the delay engine's own stats |
| 14 | OPEN (structural) | No end-to-end accuracy validation is possible before 2026-07-26 |
| 15 | NOTE | Route 501 hits the RT pattern cap every cycle |
| 16 | RESOLVED in code; measured latent, not active | The proto2 default trap still applies on the map's vehicle path |
| 17 | RESOLVED for monotonicity, OPEN for cross-route | The two crosswalk self-audits are narrower than their gate names |

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
- **Decoder:** fixed **on the delay path**. `engineVehicles()` and `processTripUpdates()` —
  everything the delay engine consumes — read through `pb.ts`, and `pb.test.ts` pins the
  behaviour. The map's vehicle DTO path does not; see entry 16.
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

## 9. OPEN in the seed, GATED in the engine (`seed_toronto.ts` is not owned by this workstream) — the seeded board is missing Saturdays and the civic holiday

**The symptom.** `calendar` contains service_id `'2'` with `sat = true`, but **zero trips
reference it**. Trips per service in the seeded board: `1` = 38,112 (Mon–Fri), `3` = 29,870
(Sun), `6701` = 360, and 59 more across four small specials — 68,401 in total, against
**133,682** rows in the published `trips.txt`.

**The cause, now diagnosed exactly.** This is not a malformed feed and not a seeder bug: it
is the seeder's deliberate 7-day window (`GHOSTBUS_SEED_WINDOW_DAYS`, default 7, bypassed by
`GHOSTBUS_SEED_FULL=1`), which loads only trips whose `service_id` is active inside that
window. The seed ran on 2026-07-24; the board starts 2026-07-26; so the window covered
20260724..20260730, whose only Saturday (07-25) predates the board. Service `'2'` had no
active day in it and was dropped whole. The arithmetic closes exactly:

| service | trips in `trips.txt` | seeded | why not |
|---|---:|---|---|
| `2` (Saturday) | 32,874 | no | no Saturday inside the seed window |
| `4` (holiday) | 31,295 | no | active only via `calendar_dates` on **20260803**, outside the window |
| `6702` / `6703` / `6704` | 390 / 361 / 361 | no | no weekday flags and no `calendar_dates` rows — never active |
| all others | 68,401 | yes | |

32,874 + 31,295 + 390 + 361 + 361 = **65,281**, and 133,682 − 68,401 = **65,281**. The gap is
fully accounted for; the earlier note that it was "probably wider than Saturday alone" is
resolved rather than left hanging.

**What it costs, on specific dates.** Inside the board window 20260726..20260905:

- **Six Saturdays** (Aug 1, 8, 15, 22, 29 and Sep 5) resolve to service `'2'` with zero
  trips.
- **Monday 2026-08-03** is worse. `calendar_dates` holds exactly two rows: service `4` added
  and service **`1` removed** on that date. Service 1 is the entire weekday board. So on the
  civic holiday the seeded database has the weekday service switched off and the holiday
  service empty — **a completely blank service day**, not a reduced one.

That is **7 of the board's 42 days** with no schedule at all. The engine will correctly
report "no calendar-active schedule for this date", which is honest but is not the truth
about the city. A re-seed with a wider window (or `GHOSTBUS_SEED_FULL=1`) fixes it; nothing
in the delay engine can or should paper over it.

*Verified 2026-07-25 against both the seeded database and `.data/gtfs/extracted/{calendar,calendar_dates,trips}.txt`.*

### Re-verified independently, day by day, and the dates above are exactly right

Replaying `activeServiceIds` over all 42 board days against the seeded tables and against the
raw feed files side by side: **7 blank days** — 2026-08-01, 08-08, 08-15, 08-22, 08-29 and
09-05 (service `2`: **32,874** trips published, **0** loaded) and 2026-08-03 (service `4`:
**31,295** published, **0** loaded, with service `1` removed by `calendar_dates` that day). The
other **35 days match the published feed exactly** — the seeded board is not thin anywhere
else, only absent on those seven. Services `6702`/`6703`/`6704` are never active in the FEED
either, so that part of the shortfall is not ours.

### What was done in the engine, and what was not

Those seven days used to pass `boardActive`, produce zero due trips, zero ghosts and zero
delays, and render **identically to a day on which nothing went wrong** — a zero meaning "we
have no schedule" wearing the costume of a zero meaning "nothing was late", which for an
accountability product is the worst confusion available. A `boardIntegrity` gate (`gates.ts`)
now fires when the calendar activates a service for the date and the loaded board holds no
trips for it, and names the hole in its reason string. `patterns.ts` gains `tripsByService` to
answer the question.

**That is a smaller claim than a fix, and only the smaller claim is true.** The seeding fix
belongs in `seed_toronto.ts`: `tripRows` and `stopTimeRows` filter on the services active in
the next `GHOSTBUS_SEED_WINDOW_DAYS` (default 7) days *from the seed date*, while `calendar`
and `calendar_dates` are loaded whole — two different windows over the same board. The filter
must be derived from the loaded board's own validity span
(`min(start_date)..max(end_date)` across `calendar`), or at minimum unioned with it, so that a
service the calendar declares active can never lack its trips. Until that runs, this entry
stays OPEN.

---

## 10. RESOLVED — the crosswalk was below its own publication gate, and the gate was not the problem

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

**It got worse before it was understood.** By cycle 75 of the same run coverage read **30.9%**
and by cycle 87 **30.6%**: the curve was not flat, it was descending, while the crosswalk was
still notionally learning. A metric that falls as evidence accumulates is not a plateau, it is
a leak.

### Diagnosis, 2026-07-25 — measured, not inferred

Decomposing one live trips snapshot (**23,636 `StopTimeUpdate` occurrences**) against the
persisted crosswalk gives the whole loss, by name:

| share | occurrences | bucket |
|---:|---:|---|
| 43.2% | 10,212 | `candidate` — has an identity, blocked only by the two-pattern promotion rule |
| **35.6%** | **8,417** | **covered** |
| 13.5% | 3,185 | `confirmed` but confidence < 0.60, source `geo` |
| 4.0% | 939 | `conflicted` |
| 2.6% | 625 | no crosswalk entry at all (328 distinct rt stops) |
| 1.1% | 258 | `confirmed` but confidence < 0.60, source `propagated` |

Almost none of that is a shortage of evidence. Two rules were **discarding** it.

**1. Corroboration lowered confidence.** A geometric anchor *overwrote* a propagated entry,
and geometry carries a residual penalty (`1 - resid/60`) that propagation does not — while
`nearestStopOnRoute` accepts anchors out to 80 m. So any geometric residual over 24 m is
permanently under the 0.60 floor whatever the vote count, and a stop propagation supported at
0.85 dropped to 0.33 the moment a vehicle was seen 40 m from it **while agreeing about which
stop it was**. Two lines of evidence yielding less than one is incoherent. In the database:
1,018 of 1,535 geometric entries have a residual over 20 m, and 522 of those are capped below
0.50 by arithmetic alone. `corroboratedConfidence` now takes the best of the *agreeing*
sources, which admits nothing either source would have refused on its own.

**2. Promotion forgot what it had already seen.** `distinctPatterns` was recounted every cycle
from the patterns resolved in *that* cycle, so a stop confirmed by two agreeing patterns fell
back to `candidate` when one of them went off shift — 03:00 unlearning what 08:00 established.
The oscillation is visible directly in the log (confirmed 3,043 -> 3,031 -> 3,019 -> 3,025 ->
3,042 over five consecutive cycles). Agreement is now accumulated, keyed by **static** pattern
id so an RT pattern's content-hash rename cannot let one line of evidence corroborate itself
twice, and restored from the database on a warm start.

### Result — the gate was right

Measured against the live feeds, with `MIN_XWALK_OCCURRENCE_COVERAGE` **unchanged at 0.50**:

| | cycle 1 | after 10 cycles | direction |
|---|---:|---:|---|
| before (running collector, same wall clock) | 0.0% | 30.9% at cycle 75 | **falling** |
| after | **49.1%** | **51.7%** | **rising** |

A second run: 49.3% -> 50.7% over six cycles. The binding gate is now `boardActive` rather
than `xwalkOccurrenceCoverage` — the crosswalk is no longer what stands between this engine
and its first published number.

### What was deliberately NOT done

The 43.2% `candidate` bucket is blocked by the two-independent-patterns rule alone, and 4,066
of those 4,686 entries already clear the confidence floor. Admitting them would have been the
single largest coverage win available, and it was **not taken**. The evidence for it was a
held-out-geometry experiment — withhold a fifth of the geometric anchors, let propagation
predict those stops, compare against the measurement withheld — which returned **88.57%
agreement for one-pattern identities (n=140) against 80.70% for two-or-more (n=57)**. That
says the rule buys no accuracy. But the withheld "truth" is itself a nearest-stop match, and
its disagreements are overwhelmingly *adjacent platform ids at one intersection*
(`1037` vs `1036`, `2034` vs `2033`, `8349` vs `8348`), so the experiment cannot distinguish
"propagation is wrong" from "the geometric answer picked the other side of the street".
Loosening a promotion rule on evidence that weak, to raise a number, is the move this file
exists to prevent. The rule stands and the experiment is recorded so the next person starts
from it rather than from scratch.

**Caveat on all of the above.** The Neon free-tier data-transfer quota was exhausted by the
repeated 2.15M-row pattern-index rebuilds these measurements required (each run rebuilds the
index in ~120 s), which also **stopped the collector at cycle 88**. The after-numbers therefore
rest on two runs of 10 and 6 cycles, not on a long soak. They are consistent with each other
and both are rising, but they are short.

---

## 11. RESOLVED for `rt_stop_xwalk`, OPEN for the rest — the learned crosswalk was written to Postgres and never read back

New entry, 2026-07-25. `rt_stop_anchor`, `rt_stop_xwalk`, `rt_stop_xwalk_votes`,
`rt_pattern`, `rt_trip_binding` and `sched_slot_claim` are written by `engine.ts` and
**never `SELECT`ed by any code path, test or otherwise** — the only statements touching them
are `INSERT`s plus four `UPDATE`s (three voiding a binding, one quarantining a pattern). They
are an audit trail, not a cache.

**Consequence.** Every process restart begins with an empty crosswalk. Because a propagated
entry needs 8 corroborating cycles to clear the 0.60 confidence floor
(`7/10 × 0.85 = 0.595`, `8/10 × 0.85 = 0.68`), occurrence coverage reads **0.0% through cycle
9** on a cold start, 0.9% at cycle 10, and 34.5% at cycle 11 — a warm-up of roughly eight
minutes at a 45 s cadence before the crosswalk can back anything at all, and longer before it
could clear the gate in entry 10.

On a free hosting tier that spins the service down after inactivity, this compounds: a
deployment that restarts more often than its warm-up period publishes nothing, ever.

### FIXED 2026-07-25 for `rt_stop_xwalk`

`loadCrosswalk()` (`engine.ts`) restores the crosswalk at boot, scoped by `board_tag`, and
only when the in-memory crosswalk is genuinely cold — a periodic same-board reload must not
stomp on fresher state with the row we ourselves wrote. Three merge properties, each with a
regression test in `engine.test.ts`:

1. **A restored row is not an observation.** It seeds `xwalkVotes` with the persisted count;
   the usual `+1` fires only when the identity is actually re-derived. Crediting a vote for
   reading a row would let an entry climb the confidence ladder by restarting the process.
2. **New evidence can still overturn it.** The loaded stop id is seeded into
   `xwalkProposals`, so a later cycle proposing a different static stop marks the rt stop
   conflicted exactly as it would have within one process. Without that seeding a
   contradiction would silently overwrite — the one outcome the conflict machinery exists to
   prevent.
3. **A restored `conflicted` entry stays conflicted**, at confidence 0, and out of the
   propagation seed.

**Measured cold start, before and after.** Before: occurrence coverage **0.0% on cycle 1** and
for the following ~9 cycles, first usable crosswalk at cycle 11 — roughly **8 minutes** at the
45 s cadence. After, against the live feeds with the production crosswalk in place: *"restored
8,214 crosswalk entries for 20260726..20260905 (2,550 usable for a delay row, 171 conflicted)
— warm start"*, and **cycle-1 coverage 49.1%** (a second run: 8,230 entries, 49.3%). The
warm-up is **zero cycles**.

### STILL OPEN — the other five tables

`rt_stop_anchor`, `rt_stop_xwalk_votes`, `rt_pattern`, `rt_trip_binding` and
`sched_slot_claim` are still written and never read.

`rt_stop_anchor` matters most, and restoring it was **built, measured and then reverted**
rather than shipped. The accumulated geometric centroids are the crosswalk's strongest
evidence, and without them a restarted process also computes cross-route agreement over a
handful of stops — measured at **75% (3 of 4)** on a cold 6-cycle run, which would fail its own
85% gate on pure noise. But restoring 4,559 anchors surfaced ~330 fresh contradictions between
measured geometry and the restored propagated crosswalk, and occurrence coverage read **44.6%
rising to 45.3% over six cycles** instead of 49.1% rising to 51.7% — i.e. below the publish
gate. Those contradictions may be geometry correctly retiring stale propagated identities, or
they may be stale anchors (the table is not board-scoped and the centroids never decay). **The
longer run that would have settled it could not be completed: the Neon free-tier data-transfer
quota was exhausted by the repeated 2.15M-row pattern-index rebuilds these experiments
required, which also stopped the collector at cycle 88.** Shipping a change whose only
measurement puts the engine below its own publish gate, on the strength of "it would probably
have recovered", is precisely the move this file exists to prevent. It is filed here instead.

---

## 12. OPEN — ghost detection now inherits every binding refusal

New entry, 2026-07-25. A scheduled trip is "present" only if the engine holds a live binding
for it. Any trip the origin lock refuses is therefore **indistinguishable from a trip that
never ran**. Refusals happen for good reasons, and each one is a false-absence channel:

- **sub-300 s headway** (`refused_headway_band`) — refused outright at any confidence.
  Measured trip-weighted share on service 1: **4.9%** (DECISIONS §29). Those static trips can
  never be bound and so are permanently absent. The same refusal, under the same counter,
  also fires when the headway is **unknown** — `medianHeadwayForSlots` returns null for a
  pattern with fewer than three slots on its dominant service — so thin patterns are a second
  false-absence channel hidden inside a name that suggests only frequent ones.
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
(`maxPatternsPerRoute`). On the current run exactly one route hits it — **501** — and it hits
it repeatedly: **105 warnings across 30 logged engine cycles**, roughly 3–4 realtime trips
per cycle turned away. Trips beyond the cap are not clustered, so they can never be bound and
never contribute delay observations for that route.

This is logged loudly rather than silenced, and it is recorded here because a route that is
permanently uncapturable is a coverage hole with a specific name. Whether 48 is too low for a
streetcar route with many short-turn branches, or whether 501's realtime patterns are
genuinely fragmenting, has not been determined.

---

## 16. RESOLVED in code — and the trap was latent, not active

New entry, 2026-07-25. Entry 6's rule — every optional scalar goes through `pb.ts` — holds
for everything the delay engine consumes (`engineVehicles`, `processTripUpdates`). It does
**not** hold for the vehicle DTO the map renders: `processVehicles` reads
`v.currentStopSequence`, `v.position.bearing`, `v.position.speed`, `v.timestamp` and
`v.trip.tripId` with `!= null` / truthiness checks, and `processAlerts` reads
`al.effect`, `al.cause` and `activePeriod` raw.

`bearing` and `speed` are proto2 **optional floats**, so the same materialised-default
behaviour applies: a vehicle that never published a bearing decodes as `0` and renders
pointing **due north**, indistinguishable from one genuinely heading north.

Nothing on this path reaches a delay measurement, an aggregate or a published statistic — it
is sprite rotation and a speed readout. It is filed anyway, because "we fixed the decoder"
is exactly the kind of claim that should be true everywhere it is stated, and because the
fix is mechanical.

### FIXED 2026-07-25, and the entry above overstated the live impact

`processVehicles` and `processAlerts` now read every optional scalar through `pb.ts`. An absent
bearing stays **null** rather than becoming 0, which the map already handles — `MapCard.tsx`
falls back to the bearing implied by the vehicle's own movement. `toNum`, which coerced
whatever a field read as without asking whether it was sent, had no callers left and is
deleted. Two wire-level round-trip regressions in `pb.test.ts` pin `Position.bearing`,
`Position.speed`, `VehiclePosition.timestamp` and `TimeRange.start/end`.

**Own-property census over three live snapshots**, and it corrects this entry:

| field | absent on the wire | of |
|---|---:|---|
| `Position.bearing` | **0** | 1,224 / 1,236 / 1,246 vehicles with a position |
| `Position.speed` | **0** | same |
| `VehiclePosition.timestamp` | **0** | same |
| `VehiclePosition.currentStopSequence` | 270, 262 | 1,236 / 1,246 (21.8%, 21.0%) |
| `Alert.activePeriod` | 36 of 36 carry none | 36 alerts |

So **no live vehicle is currently rendering a fabricated due-north heading**: the TTC publishes
bearing, speed and timestamp for every vehicle it publishes a position for. The one field that
genuinely is absent a fifth of the time, `currentStopSequence`, was already handled correctly
by the old `> 0` guard. Two further defaults *were* reachable and are now closed —
`timestamp` reading 0 dated a ping 1970-01-01 and made the intended "unknown -> now" fallback
unreachable, and an alert with an open-ended active period would have been published as one
starting 1970-01-01, though no live alert carries an `activePeriod` at all.

The fix is therefore **the rule holding everywhere it is stated**, not a wrong number removed.
Recorded at this length because the original entry asserted a live symptom ("renders pointing
due north") that the measurement does not support, and a corrected finding is worth more than
a confirmed one.

---

## 17. RESOLVED for monotonicity, OPEN for cross-route — the two crosswalk self-audits were narrower than their gate names

New entry, 2026-07-25. `METHODS.md` §3.3e presents cross-route agreement and monotonicity as
the crosswalk's falsifiable audits. As wired in `runCycle`, both are narrower than that:

- **Monotonicity could not fail. FIXED 2026-07-25.** The gate is meant to catch a crosswalk
  that maps two realtime stops onto static stops that are out of order. `runCycle` passed
  `[...b.tracked.keys()].sort((a, c) => a - c)` — the binding's **realtime** stop sequences,
  already sorted ascending — so `monotonicityViolations` compared a strictly increasing
  sequence against itself and always returned 0. The `monotonicity` gate (`gates.ts`) and the
  `xwalk.unhealthy` flag could never trip on it.

  `crosswalkedStaticSeqs` (`xwalk.ts`) now resolves each tracked realtime stop, in realtime
  order, to the **static** `stop_sequence` the crosswalk claims for it on the bound static
  pattern, and `runCycle` feeds the audit that. Loops get the benefit of the doubt (the
  earliest occurrence that still increases is chosen, so a violation is reported only when no
  monotone assignment exists), and unnameable or off-pattern stops are skipped rather than
  counted as disorder. Two regression tests pin it: one asserts the OLD input returns 0 on a
  deliberately inverted crosswalk, the other drives crosswalk -> static sequences ->
  `evaluateGates` end to end and asserts `failed === 'monotonicity'`.

  **Run against live data (2026-07-25).** The gate itself runs over bindings and there are
  none yet, so the audit was run over the closest available proxy — every resolved RT pattern
  in `rt_pattern`, read through the live `rt_stop_xwalk` against the static pattern it
  resolved to. **3 violations in 3,939 audited patterns = 0.08%**, against a 5% limit; 1,201
  patterns had fewer than two usable crosswalked stops and were not judged. The same input
  under the old wiring: **0 of 5,140, by construction.**

  The three are real and all on **route 25**. Two of them are two distinct realtime stop ids
  resolving to the *same* static stop (a repeated static sequence, e.g. `…47, 47, 49, 49…`),
  which is a genuine crosswalk error rather than an ordering artifact. A non-zero count is a
  finding, not a failure: the gate now measures something, and what it measures is small.
- **Cross-route agreement audits geometry only. STILL OPEN.** `runCycle` builds its per-route
  map exclusively from `geoAnchors`, so the propagated entries — which are the bulk of the
  crosswalk (2,148 of 2,693 confirmed rows when this was written) and which `METHODS.md` calls
  "the multiplier" — are never checked by it. The 93.8% is a geometric-anchor figure.
  Deliberately not widened: see DECISIONS §33, which explains why feeding derived entries into
  an independence-assuming audit would make it look stronger while being circular.

Together these meant the system had **no** working falsifiable audit able to fail, and one
narrow one that could. It now has two, one of them still covering a minority of its own
crosswalk, and both audit stop identity rather than trip identity. Neither was a wrong number
being published — both were audits that would not catch the error they exist to catch. That is
a worse failure for this project than a missing feature, which is why it was filed at this
priority.

---

## Cross-document note (not a blocker in this file's own scope)

`DECISIONS.md` §12 and `DEVPOST.md` still describe `server/src/join.ts` as a shipped
component. Entry 3 records that it is deleted. Those files are owned by other workstreams and
were not edited here; the contradiction is flagged rather than fixed.
