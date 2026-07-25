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

import { walkSeconds } from './format';

/** Below this the rider is standing at the stop. A consumer GPS fix is not
 *  precise enough to claim otherwise, and someone already at the stop cannot
 *  "miss" a bus by walking — so this outranks the buffer arithmetic. */
export const AT_STOP_M = 40;
/** A fix older than this is not a position any more, it is a memory. */
export const STALE_FIX_MS = 90_000;
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
}

export interface CatchVerdict {
  kind: VerdictKind;
  /** straight-line metres from the rider to the stop. */
  distanceM: number | null;
  /** seconds of walking at the profile pace, route factor included. */
  walkSec: number | null;
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
    && finite(i.vehicle.ts, i.vehicle.lat, i.vehicle.lon, i.nowMs)
    && i.nowMs - i.vehicle.ts > -FUTURE_FIX_TOLERANCE_MS
    && i.nowMs - i.vehicle.ts <= STALE_FIX_MS;
  const fixAgeSec = i.vehicle == null || !finite(i.vehicle.ts, i.nowMs)
    ? null
    : Math.max(0, Math.round((i.nowMs - i.vehicle.ts) / 1000));
  const base = { distanceM: null, walkSec: null, bufferSec: null, fixAgeSec, vehicleDistM: null, leaveByMs: null };

  // Without two real endpoints there is no walk to time — and a walk timed from a
  // fallback location would be a fabricated position, which is the one thing this
  // screen must never do. A non-finite input is treated the same as a missing one:
  // NaN comparisons are all false, so without this gate they would fall through to
  // the *most confident* verdict, which is exactly backwards.
  if (i.rider == null || i.stop == null) return { ...base, kind: 'noGeo' };
  if (!finite(i.rider.lat, i.rider.lon, i.stop.lat, i.stop.lon, i.nowMs, i.paceMps) || i.paceMps <= 0) {
    return { ...base, kind: 'noGeo' };
  }

  const distanceM = haversineM(i.rider, i.stop);
  const walkSec = walkSeconds(distanceM, i.paceMps);
  const arrivalMs = finite(i.arrivalMs) ? (i.arrivalMs as number) : null;
  const leaveByMs = arrivalMs == null ? null : arrivalMs - walkSec * 1000;
  const withWalk = { ...base, distanceM, walkSec, leaveByMs };

  // The run left the live board: we are no longer being told anything about it,
  // so there is nothing left to compute — say so and offer the next one.
  if (arrivalMs == null) return { ...withWalk, kind: 'gone' };

  // Never keep computing from a position we can no longer vouch for. This one
  // gate covers all three ways trust is lost: the feed dropped, the vehicle
  // vanished (it simply stops refreshing and ages out), or its clock is wrong.
  if (!fixUsable || i.vehicle == null) return { ...withWalk, kind: 'unseen' };

  const vehicleDistM = haversineM(i.vehicle, i.stop);
  const secsToArrival = Math.round((arrivalMs - i.nowMs) / 1000);
  if (distanceM <= AT_STOP_M) return { ...withWalk, vehicleDistM, kind: 'atStop', bufferSec: secsToArrival };

  const bufferSec = secsToArrival - walkSec;
  const kind: VerdictKind = bufferSec < 0 ? 'missed' : bufferSec < COMFORTABLE_SEC ? 'tight' : 'comfortable';
  return { ...withWalk, vehicleDistM, kind, bufferSec };
}
