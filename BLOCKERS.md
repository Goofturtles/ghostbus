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
