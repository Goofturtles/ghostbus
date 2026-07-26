// Catch Mode's verdict — the whole decision, as one pure function.
//
// It answers exactly one question: with the rider walking from where they
// actually are, and the vehicle where the live feed actually says it is, do they
// make it? Every input is passed in; nothing here fetches, remembers, or guesses.
//
// The degraded states are the point. When a position is missing or has gone
// stale, the verdict becomes a sentence about *that* rather than an extrapolation
// from a fix that may no longer be true. There is no state in which this function
// keeps counting down from data it cannot vouch for.

import { walkSeconds, type MeasuredWalk } from './walk';

/** Below this the rider is standing at the stop. A consumer GPS fix is not
 *  precise enough to claim otherwise, and someone already at the stop cannot
 *  "miss" a bus by walking — so this outranks the buffer arithmetic. */
export const AT_STOP_M = 40;
/** A fix older than this is not a position any more, it is a memory.
 *
 *  MEASURED, not assumed (live TTC feed, 2026-07-24, sampled every 6s for a
 *  minute): the server polls the agency every 45s (poller.ts POLL_MS) and the
 *  feed's own vehicle timestamps are already ~40s behind our clock when they
 *  arrive, so a perfectly healthy fix sawtooths between ~41s and ~106s old. The
 *  spec's 90s would therefore have fired on every polling cycle and told riders
 *  we could not see a vehicle that we could see perfectly well — an artifact of
 *  our own cadence dressed up as a fact about the bus. 150s is the first age
 *  that means the vehicle actually missed a poll of the feed. See DECISIONS §27. */
export const STALE_FIX_MS = 150_000;
/** Buffer at or above this is comfortable; below it, the rider should hurry. */
export const COMFORTABLE_SEC = 120;

export type VerdictKind =
  | 'noGeo'        // no rider position (or no stop position) — nothing to time
  | 'gone'         // the trip is no longer on the live board
  | 'unseen'       // no live vehicle fix for this route, or the last one is stale
  | 'atStop'       // the rider is already there
  | 'missed'       // the walk is longer than the time left
  | 'tight'        // they make it, but with less than COMFORTABLE_SEC to spare
  | 'comfortable';

export interface Point { lat: number; lon: number }
/** A vehicle position with the epoch-ms timestamp of the ping it came from. */
export interface VehicleFix extends Point { ts: number }

export interface CatchInput {
  /** server-corrected now (see liveNow()). */
  nowMs: number;
  /** the rider's live geolocation; null when denied, unavailable, or erroring. */
  rider: Point | null;
  /** the boarding stop; null when the agency publishes it without coordinates. */
  stop: Point | null;
  paceMps: number;
  /** live arrival prediction for THIS trip; null once it leaves the live board. */
  arrivalMs: number | null;
  /** the freshest position seen for a vehicle on this route, however old. */
  vehicle: VehicleFix | null;
  /**
   * The walk to this stop as the map has actually MEASURED it, when it has.
   *
   * Optional, and null-safe by design: with no measured walk this function does
   * exactly what it always did — haversine at the profile pace with the 1.25 route
   * factor. With one, the verdict is timed along the line the rider can see, so
   * "you'll make it" and the path on the map can never be answers to different
   * questions. The caller is responsible for only passing a walk that ends at THIS
   * stop (see `walkFor`).
   *
   * It replaces the walk's TIME and DISTANCE, never the at-the-stop test: whether
   * someone is standing at their stop is a question about where they are, and a
   * rider 20 m away across a six-lane road is still 20 m away even though the route
   * to the far kerb is 180 m.
   */
  walk?: MeasuredWalk | null;
  /** true when the vehicle feed itself is not healthy (or we cannot reach our own
   *  API). The newest fix we hold cannot be refreshed, so it is not trustworthy
   *  however recently it arrived — this trips the same degradation as staleness,
   *  immediately rather than after it ages out. */
  feedDown?: boolean;
}

export interface CatchVerdict {
  kind: VerdictKind;
  /** metres to the stop: along the routed walk when there is one, else straight-line. */
  distanceM: number | null;
  /** seconds of walking — measured along the route, or the profile pace with the
   *  1.25 route factor when the walk was never routed. */
  walkSec: number | null;
  /** how `distanceM` and `walkSec` were arrived at, so the UI can mark an estimate. */
  walkKind: 'routed' | 'direct';
  /** seconds to spare after walking. Negative means the walk is too long. */
  bufferSec: number | null;
  /** age of the vehicle fix in seconds; null when there has never been one. */
  fixAgeSec: number | null;
  /** straight-line metres from the vehicle to the stop. */
  vehicleDistM: number | null;
  /** the latest instant the rider can set off and still arrive in time. */
  leaveByMs: number | null;
}

const R_EARTH_M = 6_371_000;

export function haversineM(a: Point, b: Point): number {
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A fix stamped further than this ahead of our clock is not "fresh", it is a
 *  vehicle whose onboard clock disagrees with ours — the feed stamps positions
 *  with the vehicle's own time. Treated as unusable rather than as brand new. */
const FUTURE_FIX_TOLERANCE_MS = 15_000;

const finite = (...n: (number | null | undefined)[]) => n.every((x) => typeof x === 'number' && Number.isFinite(x));

export function computeVerdict(i: CatchInput): CatchVerdict {
  // A vehicle we have declared untrustworthy contributes no numbers at all —
  // including its distance to the stop, which would otherwise leak a stale
  // position into the UI underneath a headline that says we cannot see it.
  const fixUsable = i.vehicle != null
    && !i.feedDown
    && finite(i.vehicle.ts, i.vehicle.lat, i.vehicle.lon, i.nowMs)
    && i.nowMs - i.vehicle.ts > -FUTURE_FIX_TOLERANCE_MS
    && i.nowMs - i.vehicle.ts <= STALE_FIX_MS;
  const fixAgeSec = i.vehicle == null || !finite(i.vehicle.ts, i.nowMs)
    ? null
    : Math.max(0, Math.round((i.nowMs - i.vehicle.ts) / 1000));
  // Where the vehicle is relative to the stop stays true even when we cannot say
  // anything about the RIDER — so it survives 'noGeo' and 'gone', and disappears
  // only when the fix itself is the thing we distrust.
  const vehicleDistM = fixUsable && i.vehicle != null && i.stop != null ? haversineM(i.vehicle, i.stop) : null;
  const walkKind = i.walk?.kind === 'routed' ? 'routed' as const : 'direct' as const;
  const base = { distanceM: null, walkSec: null, walkKind, bufferSec: null, fixAgeSec, vehicleDistM, leaveByMs: null };

  // Without two real endpoints there is no walk to time — and a walk timed from a
  // fallback location would be a fabricated position, which is the one thing this
  // screen must never do. A non-finite input is treated the same as a missing one:
  // NaN comparisons are all false, so without this gate they would fall through to
  // the *most confident* verdict, which is exactly backwards.
  if (i.rider == null || i.stop == null) return { ...base, kind: 'noGeo' };
  if (!finite(i.rider.lat, i.rider.lon, i.stop.lat, i.stop.lon, i.nowMs, i.paceMps) || i.paceMps <= 0) {
    return { ...base, kind: 'noGeo' };
  }

  // The proximity question and the walk question are answered separately, and only
  // the second one is routed. See the note on `walk` above.
  const straightM = haversineM(i.rider, i.stop);
  const measured = i.walk?.kind === 'routed' ? i.walk : null;
  const distanceM = measured ? measured.distanceM : straightM;
  const walkSec = measured ? measured.seconds : walkSeconds(straightM, i.paceMps);
  const arrivalMs = finite(i.arrivalMs) ? (i.arrivalMs as number) : null;
  const leaveByMs = arrivalMs == null ? null : arrivalMs - walkSec * 1000;
  const withWalk = { ...base, distanceM, walkSec, leaveByMs };

  // The run left the live board: we are no longer being told anything about it,
  // so there is nothing left to compute — say so and offer the next one.
  if (arrivalMs == null) return { ...withWalk, kind: 'gone' };

  // Never keep computing from a position we can no longer vouch for. This one
  // gate covers all three ways trust is lost: the feed dropped, the vehicle
  // vanished (it simply stops refreshing and ages out), or its clock is wrong.
  if (!fixUsable) return { ...withWalk, kind: 'unseen' };

  const secsToArrival = Math.round((arrivalMs - i.nowMs) / 1000);
  if (straightM <= AT_STOP_M) return { ...withWalk, kind: 'atStop', bufferSec: secsToArrival };

  const bufferSec = secsToArrival - walkSec;
  const kind: VerdictKind = bufferSec < 0 ? 'missed' : bufferSec < COMFORTABLE_SEC ? 'tight' : 'comfortable';
  return { ...withWalk, kind, bufferSec };
}
