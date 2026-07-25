# BLOCKERS.md — honest limitations found on real data

## RESOLVED by Milestone 0 — static GTFS seed into Postgres

The pre-existing `server/live.ts` noted that geographically-correct live rendering
"needs the static GTFS seed (route colors, shapes, headsigns, stop_times) loaded into
Postgres." Milestone 0 delivers exactly that: `npm run seed:toronto` loads routes,
stops, trips, stop_times, shapes, calendar, and calendar_dates into Postgres (verified
against Neon: 233 routes, 9,361 stops, 68,401 trips, 2,151,105 stop_times, 1,374 shapes).

## BLOCKER (empirical) — TTC realtime trip_ids do NOT match static GTFS trip_ids

This is the mismatch the spec required us to check for, and it is real.

**Measured on live data (collector calibration, real TTC feeds):**
`RT trip_id sample = 1920, matched to static trips = 2, match rate = 0.1%`.

### Consequence
Ghost detection works by finding a scheduled, calendar-active trip whose `trip_id`
has **no** VehiclePosition and **no** TripUpdate. If realtime `trip_id`s don't line up
with static `trip_id`s, then *every* running trip looks absent and *every* scheduled
trip would be reported as a ghost — 100% false positives.

### What we did (no faking)
The collector measures the match rate live and **suppresses ghost/cancelled emission**
whenever it is below 50% (`MATCH_RATE_THRESHOLD`). On this run it correctly stayed
suppressed. `ghosts` therefore has 0 rows — an honest 0, not a fabricated one. The
suppression is logged loudly and re-evaluated every cycle (so it self-enables if a feed
ever starts publishing matching ids).

### What identifiers ARE shared (the Phase-2 fallback)
The RT `TripDescriptor` does carry a usable **`route_id`** (confirmed: delay
observations were written with a non-null `route_id` sourced from the feed), plus a
`start_date` and, per `StopTimeUpdate`, a `stop_id` and `stop_sequence`. The static
schedule has each trip's first-stop time. So the supported fallback for genuine ghost
detection is **match on `route_id` + scheduled start time (+ direction)** rather than
`trip_id`. That join is Phase-2 work and was intentionally not built in Milestone 0 —
flagged here rather than shipped half-done.

### Not affected: delay observations
Delay observations do **not** depend on the trip_id join — they use the feed-provided
`delay` at passed stops, keyed by `route_id` + `stop_id`. They worked on real data
(1,984 observations inserted into Neon on the first cycle alone). This is genuine
schedule-vs-live signal and remains the collector's primary honest output for now.

### Context
This is a known characteristic of TTC's NextBus/Umo-derived GTFS-realtime feed; its
realtime trip identifiers are not the static GTFS `trip_id`s. Nothing here is a bug in
the collector — the collector's job was to detect and report this, which it did.

### RESOLVED in Phase 2 — route + reconstructed-schedule-time join (with a caveat)

Phase 2 builds the fallback join (`server/src/join.ts`). Measured on live TTC data:

- RT `TripDescriptor` **omits `start_time` AND `start_date`** (both empty strings on all
  1200 vehicles / 1876 trip updates) — so the spec's literal `(route_id, start_date,
  start_time)` key is impossible as written.
- RT `route_id` **matches** the static `route_id` (174/175 distinct present).
- RT `stop_id` (per StopTimeUpdate) is **~60–70%** present in static `stops`.
- Each StopTimeUpdate carries an explicit `delay` + predicted `time`.

So the join reconstructs `scheduled = predicted_time − delay` per stop and claims the static
trip whose `(route_id, stop_id, departure_s)` agrees on **≥2 stops** within ±75s. This is exact
by the GTFS definition of `delay` when the RT feed and loaded static are the same board.

**Measured join rate on live data (this run): 0.0%** — and it is honest, not broken. The machine
clock is **2026-07-24** but this feed's calendar board is **2026-07-26 … 2026-09-05**, so (a) there
is **0 calendar-active service today** (0 due trips → an honest **ghosts = 0**, never a fabricated
one), and (b) the currently-running RT references the pre-Jul-26 board that is not in our static
data, so reconstructed times don't align with the loaded timetable (an independent probe: 3.8% of
trips get one coincidental vote, 0% get the required two). The mass-ghost breaker never tripped
(0/0). When the clock falls inside the feed's board period, `predicted − delay` equals the loaded
`departure_s` by definition and the join becomes near-exact — the mechanism is proven by unit
tests (`server/src/join.test.ts`). Delay observations are unaffected and remain the primary honest
signal (27k+ obs collected). See DECISIONS.md §12–§14.

## BLOCKER (empirical) — TTC cannot support officially-"cancelled" labeling for anonymous trips

Measured on the live trips feed: of ~2,115 TripUpdate entities, **0 carry the standard
`scheduleRelationship = CANCELED (3)`**; 2,084 are SCHEDULED and 31 carry a **non-standard
`scheduleRelationship = 8`** (not defined in the GTFS-realtime `TripDescriptor.ScheduleRelationship`
enum — undocumented semantics, so we do not act on it). Separately, CANCELED entities on this feed
ship **no `stop_time_update`** and no `start_time`/`start_date`, and their RT `trip_id` does not match
static — so a CANCELED entity is **anonymous**: it cannot win the ≥2-stop identity join and cannot be
placed on a schedule.

**What we do:** for a CANCELED entity we attempt a direct static `trip_id` match first, then a join
claim; only an identified trip is labeled `kind='cancelled'`. Anything left is **counted, never
guessed** (`canceledUnidentified`). The honest consequence: an officially-cancelled but anonymous trip
will simply surface as a **ghost ("never arrived")** via the absence path rather than as a distinct
"cancelled" label. This is a feed limitation, not a bug. If TTC later publishes CANCELED entities with
a matching identity, the `kind='cancelled'` path activates with no code change.

## Note (empirical) — the TTC GTFS-realtime feeds do not support conditional requests

The trips feed returns **no `ETag` and no `Last-Modified`**, and a conditional re-request (with
`If-None-Match`/`If-Modified-Since`) returns **200, never 304**. So the collector's conditional-request
headers are harmless no-ops and a "fresh" cycle is always a real 200 snapshot. The ghost-scan freshness
gate (`feedsFresh`) is therefore never satisfied by a stale-but-unchanged reuse — there is nothing to
reuse. No state-caching-on-304 path was built because it would be dead code on this feed.

## BLOCKER (measured, 2026-07-24) — the TTC realtime feed publishes NO `delay` field at all

The previously-reported finding "every StopTimeUpdate carries a `delay` and every one is 0" was
itself wrong. It was a **decoder artifact**, not a measurement.

GTFS-realtime is proto2, and protobuf.js materialises every optional field's default on the message
**prototype**. So a field the producer never put on the wire still reads as a value. `poller.ts` used
`ev.delay != null`, which cannot distinguish "reported as on time" from "never reported".

**Own-property census over one live snapshot** (`Object.prototype.hasOwnProperty.call(ev, 'delay')`):

| Entity | Count | `hasOwnProperty('delay')` |
|---|---:|---:|
| StopTimeEvent | 23,476 | **0** |
| TripUpdate | 1,392 | **0** |

Every one of them reads `delay === 0`. **Wire-level proof** (`server/src/pb.test.ts`, test 1):
`StopTimeEvent.create({time:123})` encodes to **2 bytes** and decodes with `hasOwn(delay) === false`;
adding an explicit `delay: 0` encodes to **4 bytes** and decodes with `hasOwn(delay) === true`.

**Consequence.** Every delay observation this project accumulated before 2026-07-24 recorded a
protobuf default as if it were a measurement. The evidence base was information-free, and the
identity join built on it (`scheduled = predicted − delay`) reduced to `scheduled = predicted` — a
circular comparison of predictions against predictions, which is exactly why its measured join rate
was 0%. `join.ts` is deleted; genuine delay is now `predicted_time − scheduled_time` with the
scheduled time taken from our own seeded `stop_times`.

**The same trap applies to three more fields**, all verified by round-trip:
`VehiclePosition.currentStatus` defaults to **IN_TRANSIT_TO (2)**, not 0 (live census: 565 absent,
460 explicit 0, 102 explicit 1, 286 explicit 2); `TripDescriptor.directionId` defaults to 0;
`TripDescriptor.startDate`/`startTime` default to `''`. Every optional scalar must be read through
`server/src/pb.ts`.

## BLOCKER (measured) — RT and static `stop_id` are DISJOINT namespaces

Matching realtime stop ids against static stop ids directly produces confident, plausible, entirely
wrong results. Measured on one live snapshot:

- **Per-route overlap: 69 of 10,262 = 0.67%.** A realtime stop id almost never names a stop that
  route actually serves in our static board.
- The tempting **59.3% global id overlap** (4,892 of 8,244) is pure numeric coincidence — both
  namespaces are small integers.
- **Control measurement, and it is decisive:** for a vehicle reported STOPPED_AT realtime stop *X*,
  the static stop *numbered X* sits a **median 13,703 m away**, and **0 of 55** are within 100 m.

Stop identity must therefore be **learned** from geometry and propagated (`server/src/xwalk.ts`).
Every published delay passes through an inferred crosswalk, and the row carries `xwalk_conf` so the
UI can say so.

## BLOCKER (measured) — `TripDescriptor` carries no start time, start date, or direction

Own-property census over 1,392 TripUpdates: `startTime` present **0** times, `startDate` **0**,
`directionId` **0**. Only `tripId`, `routeId` and `scheduleRelationship` are on the wire. Direction
must be inferred from the stop pattern and must never be read from this feed.

Also: **13 of 1,392** trip updates carry a negative synthetic `tripId`, and those 13 are exactly the
13 with the undocumented trip-level `scheduleRelationship === 8` (not a value in the GTFS-realtime
enum). They are counted and excluded from binding; no semantics are inferred from them. The other
1,379 trip ids are positive and **every one ends in `"020"`**, which reads like a board tag — so the
engine re-measures the direct `trip_id` match rate every cycle rather than hardcoding today's 0.00%
(0 of 1,392).

`StopTimeUpdate.scheduleRelationship` values seen: **NO_DATA (2) = 483, SKIPPED (1) = 0.** NO_DATA
carries no time and is never emitted — imputing an on-time arrival for it would reproduce exactly the
fabrication described above.

## BLOCKER (filed, NOT fixed — `seed_toronto.ts` is not owned by this workstream) — Saturday has no trips

`calendar` contains service_id `'2'` with `sat = true`, but **zero trips reference it**. Trips per
service in the seeded board: `1` = 38,112 (Mon–Fri), `3` = 29,870 (Sun), `6701` = 360, and 59 more
across four small specials. **Every Saturday the engine will legitimately find no schedule**, and the
honest product state on those days is "no calendar-active schedule for this date".

Total seeded trips are **68,401** against roughly 133,682 in TTC's published board, so the gap is
probably wider than Saturday alone. This needs a re-seed; it is not something the delay engine can
or should paper over.

## BLOCKER (structural) — no end-to-end accuracy validation is possible before 2026-07-26

The seeded board covers **20260726..20260905** and today is 2026-07-24/25, so **zero static service
is calendar-active**. The crosswalk half of the engine is calendar-independent and is measurable
today (see DECISIONS). Trip binding and delay measurement are not: they are gated off by
`boardActive`, emit nothing, and cannot be validated until the board activates.

Consequently **no accuracy figure for binding or delay is claimed anywhere in this repo.** In
particular, the simulation-derived numbers that appeared in earlier design documents (33.2% / 70.5% /
90.2% / 97.7%) rest on an assumed delay distribution and assumed noise. They are not measurements and
must not be reported as performance.
