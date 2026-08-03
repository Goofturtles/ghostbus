// THE CATCH VERDICT'S MOVING PARTS, extracted so there is exactly one of them.
//
// This is everything CatchView used to own inline: the rider's own watched position, the
// vehicle poll around the boarding stop, the two feed-attribution flags, and the call into
// `computeVerdict`. It moved out here the moment a SECOND surface — the in-progress
// journey view — needed the same live "do I make it?" answer.
//
// It moved rather than being copied on purpose. Two implementations of this would be two
// implementations of the honesty contract in lib/catch.ts, and the second one is where the
// stale-fix rule, the feed-attribution split, or the never-substitute-a-position rule
// quietly fails to get applied. The verdict arithmetic itself stays where it was, pure and
// unit-tested; only the plumbing lives here.
//
// It deliberately does NOT own any copy. The two callers word the same verdict very
// differently — a modal about one departure, and a step inside a journey — and a hook that
// returned sentences would force them to word it identically.

import { useEffect, useRef, useState } from 'react';
import type { ArrivalsResponse } from '@shared/types';
import { api, type Bbox } from '@/lib/api';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useStore, paceMps } from '@/store';
import {
  computeVerdict, haversineM, type Point, type VehicleFix, type CatchVerdict,
} from '@/lib/catch';

/** Same cadence as the map's vehicle layer. */
const VEH_POLL_MS = 5000;
/** Box around the boarding stop, roughly ±5.5 km. A vehicle further out than that
 *  is not one this rider is about to catch, and a bigger box is a bigger payload. */
const BOX_LAT = 0.05;
const BOX_LON = 0.065;

export interface CatchEngineInput {
  /** The run being caught. Its live row is re-found on the board by this id every refresh,
   *  so the screen never renders a frozen copy of a departure. */
  tripId: string;
  /** Which route's vehicles to look for. Null disables the vehicle poll entirely. */
  routeId: string | null;
  /** The boarding stop, once known. Null until then — never substituted. */
  stop: Point | null;
  /** Its id, which is how a walk the map drew is matched to THIS stop and no other. */
  stopId: string | null;
  /** Off by default so the hook costs nothing until a surface actually wants a verdict. */
  enabled?: boolean;
}

export interface CatchEngineResult {
  verdict: CatchVerdict;
  /** The live board row for this trip, or null once the run leaves the board. */
  live: ArrivalsResponse['departures'][number] | null;
  /** Its live ETA — the instant every countdown on a catch surface is built on. */
  arrivalMs: number | null;
  rider: Point | null;
  /** The freshest vehicle position seen for this route, however old. */
  fix: VehicleFix | null;
  /** True once any fix has ever arrived, so "we lost it" and "we never had it" differ. */
  everSeen: boolean;
  /**
   * OUR server is unreachable or throttling us. Never phrased as an agency outage —
   * see DECISIONS §45; this flag is what keeps the two apart in the copy.
   */
  ourFault: boolean;
  /** The AGENCY's vehicle feed is genuinely unhealthy, per our own server's health. */
  agencyFeedDown: boolean;
  /** No stop position published, as distinct from no rider position. */
  noStop: boolean;
  /** Re-ask the browser for geolocation after a refusal. */
  retryGeo: () => void;
}

export function useCatchEngine(i: CatchEngineInput): CatchEngineResult {
  const { tripId, routeId, stop, stopId, enabled = true } = i;
  useTick(1000);

  const arrivals = useLive((s) => s.arrivals);
  /**
   * TWO REASONS A FIX STOPS BEING EVIDENCE, and they must not share a sentence.
   *
   * For the VERDICT the distinction is irrelevant: either way the position we hold can no
   * longer be refreshed, so it stops counting.
   *
   * For the COPY the distinction is everything. Folding both into one flag is how a screen
   * ends up announcing "the TTC feed is down" when the real cause was our own rate limiter
   * or our own restart. `ourFault` is what splits them.
   */
  const ourFault = useLive((s) => s.apiFailure != null);
  /**
   * `feeds.vehicles == null` means THE AGENCY PUBLISHES NO VEHICLE FEED — not that its
   * feed is down. An agency that never had one has no live-vehicle promise to break, so
   * the surface falls back to scheduled times without accusing anybody.
   */
  const agencyFeedDown = useLive((s) => s.apiFailure == null && s.health != null
    && s.health.feeds.vehicles != null && s.health.feeds.vehicles.status !== 'ok');
  const staleFix = ourFault || agencyFeedDown;

  const pace = useStore((s) => s.pace);

  // ---------------- the rider's own live position ----------------
  const [rider, setRider] = useState<Point | null>(null);
  const [geoNonce, setGeoNonce] = useState(0);
  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setRider({ lat: p.coords.latitude, lon: p.coords.longitude }),
      // Denied, timed out, or position-unavailable all land here. The rider's position is
      // then simply unknown — we never substitute one.
      () => setRider(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [geoNonce, enabled]);

  // ---------------- the vehicle's live position ----------------
  // The vehicle feed identifies vehicles by route, not by run, so this is the closest
  // tracked vehicle of this route to the boarding stop — labelled as exactly that by both
  // callers, never as "your bus". The last fix is kept so that when it stops refreshing we
  // can say how old it is instead of silently dropping it.
  const [fix, setFix] = useState<VehicleFix | null>(null);
  const [everSeen, setEverSeen] = useState(false);
  /**
   * KEYED ON THE COORDINATES, NOT ON THE OBJECT — and this is load-bearing.
   *
   * CatchView latches its boarding stop into `useState`, so its identity is stable across
   * renders. A caller that derives the stop inline (which the journey view does, from a
   * frozen plan) hands over a FRESH object every render, and an effect keyed on that
   * object would tear down and restart the 5-second vehicle poll on every tick — a request
   * storm that would trip our own rate limiter, then get reported as a feed outage.
   *
   * Two primitives cannot have that problem. A stop that genuinely moves is a different
   * stop and does restart the poll, which is correct.
   */
  const atLat = stop?.lat ?? null;
  const atLon = stop?.lon ?? null;
  useEffect(() => {
    if (!enabled || atLat == null || atLon == null || !routeId) return;
    const at = { lat: atLat, lon: atLon };
    const box: Bbox = [at.lon - BOX_LON, at.lat - BOX_LAT, at.lon + BOX_LON, at.lat + BOX_LAT];
    let alive = true;
    // Monotonic: a slow response must never overwrite a newer fix with an older one,
    // which would make the age jump backwards.
    let seq = 0;
    const poll = async () => {
      if (document.hidden) return;
      const mine = ++seq;
      try {
        const res = await api.vehicles(box);
        if (!alive || mine !== seq) return;
        let best: VehicleFix | null = null;
        let bestD = Infinity;
        for (const v of res.vehicles) {
          if (v.routeId !== routeId) continue;
          const d = haversineM({ lat: v.lat, lon: v.lon }, at);
          if (d < bestD) { bestD = d; best = { lat: v.lat, lon: v.lon, ts: v.ts }; }
        }
        if (best) { setFix(best); setEverSeen(true); }
      } catch { /* transient — the next tick retries, and the fix ages honestly meanwhile */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), VEH_POLL_MS);
    const onVis = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [routeId, atLat, atLon, enabled]);

  // ---------------- the live board row for THIS trip ----------------
  // Re-found by tripId on every arrivals refresh. When it is no longer there, the run has
  // left the live board and the verdict degrades to 'gone'.
  const live = arrivals?.departures.find((d) => d.tripId === tripId) ?? null;
  const arrivalMs = live?.liveEtaMs ?? null;

  // ---------------- the verdict ----------------
  // The walk the map drew to THIS stop, when it drew one. Matched on the stop id so a
  // verdict is never timed on somebody else's walk.
  const walkLeg = useStore((s) => s.walkLeg);
  const measuredWalk = stopId != null && walkLeg?.stopId === stopId ? walkLeg : null;
  const verdict = computeVerdict({
    nowMs: liveNow(), rider, stop, paceMps: paceMps(pace), arrivalMs, vehicle: fix,
    feedDown: staleFix, walk: measuredWalk,
  });

  return {
    verdict,
    live,
    arrivalMs,
    rider,
    fix,
    everSeen,
    ourFault,
    agencyFeedDown,
    // 'noGeo' covers two different absences; only one of them is about the rider.
    noStop: stop == null && rider != null,
    retryGeo: () => setGeoNonce((n) => n + 1),
  };
}

/**
 * The next departure of a route that the feed is ACTUALLY TRACKING — what a missed or
 * vanished run is replaced with. Never an invented time, and never a scheduled one
 * dressed up as tracked: `liveEtaMs` is the whole test.
 */
export function nextTrackedOf(
  arrivals: ArrivalsResponse | null,
  routeId: string | null,
  excludeTripId: string,
  nowMs: number,
): ArrivalsResponse['departures'][number] | null {
  return arrivals?.departures
    .filter((d) => d.routeId === routeId && d.tripId !== excludeTripId
      && d.liveEtaMs != null && d.liveEtaMs > nowMs)
    .sort((a, b) => (a.liveEtaMs as number) - (b.liveEtaMs as number))[0] ?? null;
}
