// Catch Mode (Tier 0): the leave-by chip plus a live make-it verdict, recomputed
// continuously from BOTH moving positions — the rider's geolocation at their
// profile walking pace, and the vehicle's position from the live TTC feed.
//
// The guided walk/wait/board choreography and Focused Boarding Mode are Tier 2 and
// are deliberately absent. What is here is the decision and its receipts.
//
// Honesty contract (the state machine itself is in lib/catch.ts):
//   · "You'll make it" is only ever printed by computeVerdict() — never as static copy.
//   · A fix older than the measured feed cadence, or a vehicle feed that is not
//     healthy, stops the arithmetic dead: the screen says it cannot see the vehicle
//     rather than counting down from a memory.
//   · A run that leaves the live board says so and offers the next tracked one.
//   · No geolocation means no verdict at all — never a walk timed from a fallback
//     location dressed up as the rider's.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { api, type Bbox } from '@/lib/api';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useStore, paceMps } from '@/store';
import { fmtClock, fmtDistance } from '@/lib/format';
import { computeVerdict, haversineM, type Point, type VehicleFix, type VerdictKind } from '@/lib/catch';
import { RouteBadge } from './Primitives';
import { WalkerIcon, SignalIcon, ClockIcon, WarningIcon, LocateIcon } from './icons';

/** Same cadence as the map's vehicle layer. */
const VEH_POLL_MS = 5000;
/** Box around the boarding stop, roughly ±5.5 km. A vehicle further out than that
 *  is not one this rider is about to catch, and a bigger box is a bigger payload. */
const BOX_LAT = 0.05;
const BOX_LON = 0.065;
/** Show the fix age in seconds below this, in minutes above it. Sits above the
 *  ~106s a healthy fix reaches on this feed (see STALE_FIX_MS), so a perfectly
 *  good position is never described in minutes. */
const AGE_IN_SECONDS_BELOW = 120;

interface Props {
  /** The row the rider tapped. Identity only — the live numbers are re-read from
   *  the current board on every poll so this screen never renders a frozen copy. */
  dep: DepartureDto;
  onClose: () => void;
}

export function CatchView({ dep, onClose }: Props) {
  const { t } = useTranslation();
  useTick(1000);
  const arrivals = useLive((s) => s.arrivals);
  /**
   * TWO REASONS A FIX STOPS BEING EVIDENCE, and they must not share a sentence.
   *
   * For the VERDICT the distinction is irrelevant: either way the position we hold can no
   * longer be refreshed, so it stops counting. `staleFix` keeps that logic exactly as it
   * was.
   *
   * For the COPY the distinction is everything. This component used to fold both into one
   * flag and then reach for "the vehicle feed is down" — announcing an agency outage when
   * the real cause was our own rate limiter or our own restart. `ourFault` is what splits
   * the message, so we only ever say "the TTC feed is down" when our server is reachable
   * and its own health says exactly that. See DECISIONS §45.
   */
  const ourFault = useLive((s) => s.apiFailure != null);
  const agencyFeedDown = useLive((s) => s.apiFailure == null && s.health != null && s.health.feeds.vehicles.status !== 'ok');
  const staleFix = ourFault || agencyFeedDown;
  const pace = useStore((s) => s.pace);
  const imperial = useStore((s) => s.units) === 'imperial';
  const ref = useRef<HTMLDivElement>(null);

  // ---------------- the rider's own live position ----------------
  const [rider, setRider] = useState<Point | null>(null);
  const [geoNonce, setGeoNonce] = useState(0);
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setRider({ lat: p.coords.latitude, lon: p.coords.longitude }),
      // Denied, timed out, or position-unavailable all land here. The rider's
      // position is then simply unknown — we never substitute one.
      () => setRider(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [geoNonce]);

  // ---------------- the boarding stop ----------------
  // Latched on the first board that carries coordinates and then held. `arrivals`
  // is nulled outright whenever the selected stop changes, and re-deriving from it
  // would blink a "we can't see where you are" error at a rider whose location is
  // perfectly fine. This screen is anchored to the stop its departure was on.
  const [boarding, setBoarding] = useState<Point | null>(null);
  useEffect(() => {
    if (boarding || !arrivals || arrivals.lat == null || arrivals.lon == null) return;
    setBoarding({ lat: arrivals.lat, lon: arrivals.lon });
  }, [arrivals, boarding]);

  // ---------------- the live board row for THIS trip ----------------
  // Re-found by tripId on every arrivals refresh. When it is no longer there, the
  // run has left the live board and the verdict degrades to 'gone'.
  const live = arrivals?.departures.find((d) => d.tripId === dep.tripId) ?? null;
  const arrivalMs = live?.liveEtaMs ?? null;

  // The next departure of this route that the feed is actually tracking — offered
  // when this one is missed or has vanished. Never an invented time. Computed on
  // every tick rather than memoised on `arrivals`, so the offer cannot go stale
  // between the 30s board refreshes.
  const now = liveNow();
  const nextTracked = arrivals?.departures
    .filter((d) => d.routeId === dep.routeId && d.tripId !== dep.tripId && d.liveEtaMs != null && d.liveEtaMs > now)
    .sort((a, b) => (a.liveEtaMs as number) - (b.liveEtaMs as number))[0] ?? null;

  // ---------------- the vehicle's live position ----------------
  // The vehicle feed identifies vehicles by route, not by run, so this is the
  // closest tracked vehicle of this route to the boarding stop — labelled as
  // exactly that, never as "your bus". The last fix is kept so that when it stops
  // refreshing we can say how old it is instead of silently dropping it.
  const [fix, setFix] = useState<VehicleFix | null>(null);
  const [everSeen, setEverSeen] = useState(false);
  useEffect(() => {
    if (!boarding || !dep.routeId) return;
    const stop = boarding;
    const box: Bbox = [stop.lon - BOX_LON, stop.lat - BOX_LAT, stop.lon + BOX_LON, stop.lat + BOX_LAT];
    let alive = true;
    // Monotonic: a slow response must never overwrite a newer fix with an older
    // one, which would make the age jump backwards.
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
          if (v.routeId !== dep.routeId) continue;
          const d = haversineM({ lat: v.lat, lon: v.lon }, stop);
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
  }, [dep.routeId, boarding]);

  // ---------------- the verdict ----------------
  const mps = paceMps(pace);
  const v = computeVerdict({ nowMs: now, rider, stop: boarding, paceMps: mps, arrivalMs, vehicle: fix, feedDown: staleFix });
  // 'noGeo' covers two different absences; only one of them is about the rider.
  const noStop = boarding == null && rider != null;

  const short = dep.shortName ?? dep.routeId ?? '—';
  const nextLabel = nextTracked?.liveEtaMs != null ? fmtClock(nextTracked.liveEtaMs) : null;

  const headline = ((): string => {
    switch (v.kind) {
      case 'comfortable': return t('catch.vComfortable', { min: Math.max(1, Math.round((v.bufferSec ?? 0) / 60)) });
      case 'tight': return t('catch.vTight', { sec: Math.max(0, v.bufferSec ?? 0) });
      case 'missed': return t('catch.vMissed');
      case 'atStop': return t('catch.vAtStop');
      case 'unseen': return t('catch.vUnseen');
      case 'gone': return t('catch.vGone');
      default: return noStop ? t('catch.vNoStop') : t('catch.vNoGeo');
    }
  })();

  const detail = ((): string | null => {
    switch (v.kind) {
      case 'comfortable':
      case 'tight':
        return v.leaveByMs == null ? null : t('eta.leaveBy', { time: fmtClock(v.leaveByMs) });
      case 'missed':
      case 'gone':
        return nextLabel
          ? t('catch.vNextTracked', { route: short, time: nextLabel })
          : t('catch.vNoNextTracked', { route: short });
      case 'atStop': {
        const secs = v.bufferSec ?? 0;
        if (secs < -60) return t('catch.vAtStopLate', { route: short });
        if (secs < 60) return t('catch.vAtStopDue', { route: short });
        return t('catch.vAtStopIn', { route: short, min: Math.round(secs / 60) });
      }
      case 'unseen':
        // A down feed is not an old fix. Saying "last fix 1 min ago" about a
        // five-second-old position because the feed went down would be a lie in
        // the opposite direction from the one we are guarding against.
        if (ourFault) return t('catch.vUnseenApiDown');
        if (agencyFeedDown) return t('catch.vUnseenFeedDown');
        return everSeen && v.fixAgeSec != null
          ? t('catch.vUnseenAgo', { min: Math.max(1, Math.round(v.fixAgeSec / 60)) })
          : t('catch.vUnseenNever', { route: short });
      default:
        return noStop ? t('catch.vNoStopBody') : t('catch.vNoGeoBody');
    }
  })();

  // ---------------- polite announcement on every verdict change ----------------
  // Keyed on the verdict *kind*, not the countdown: announcing every second (or
  // every minute) would make the live region unusable.
  const [announced, setAnnounced] = useState('');
  const lastKind = useRef<VerdictKind | null>(null);
  // Returning to a state the rider was already in produces the identical string;
  // React would bail out of the re-render and the reader would say nothing. The
  // alternating zero-width space guarantees the text node actually changes.
  const nudge = useRef(0);
  useEffect(() => {
    if (v.kind === lastKind.current) return;
    lastKind.current = v.kind;
    nudge.current += 1;
    setAnnounced(`${headline}${detail ? `. ${detail}` : ''}${nudge.current % 2 ? '​' : ''}`);
  }, [v.kind, headline, detail]);

  // ---------------- modal keyboard contract ----------------
  // onClose is captured in a ref so that a re-render of App (which passes a fresh
  // inline arrow) cannot re-run this effect, re-capture the opener as a node
  // inside the dialog, and steal focus mid-catch.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, []);

  // ---------------- evidence ----------------
  const kmh = (mps * 3.6).toFixed(1);
  const ev = live?.evidence ?? dep.evidence;
  const grade = live?.grade ?? dep.grade ?? null;
  const freshness = ourFault
    ? t('catch.evApiDown')
    : agencyFeedDown
      ? t('catch.evFeedDown')
    : v.fixAgeSec == null
      ? t('catch.evNoFix')
      : v.fixAgeSec < AGE_IN_SECONDS_BELOW
        ? t('status.updatedAgo', { secs: v.fixAgeSec })
        : t('status.updatedMinAgo', { mins: Math.round(v.fixAgeSec / 60) });

  const vehicleLine = ourFault
    ? t('catch.evVehicleApiDown')
    : agencyFeedDown
      ? t('catch.evVehicleFeedDown')
    : v.vehicleDistM != null
      ? t('catch.evVehicle', { route: short, dist: fmtDistance(v.vehicleDistM, imperial) })
      : everSeen
        ? t('catch.evVehicleStale', { route: short })
        : t('catch.evVehicleNone', { route: short });

  return (
    <div className="sheet-scrim catch-scrim" onClick={onClose}>
      <div
        ref={ref}
        className="catch-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('catch.dialogLabel', { route: short, headsign: dep.directionLabel })}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="catch-head">
          <span className="catch-id">
            <RouteBadge color={dep.color} short={short} size="md" />
            <span className="catch-dest truncate">{dep.directionLabel}</span>
          </span>
          <button className="btn btn-quiet catch-close" onClick={onClose}>{t('catch.exit')}</button>
        </header>

        {/* Focusable so a keyboard-only rider can actually scroll the evidence:
            the only other focusable in here is Exit, so without this the Tab trap
            has nowhere to go and the arrow keys have nothing focused to scroll. */}
        <div className="catch-body scroll" tabIndex={0} role="group" aria-label={t('catch.bodyLabel')}>
          <section className={`catch-verdict verdict-${v.kind}`}>
            <span className="eyebrow">{t('catch.title')}</span>
            <h2 className="catch-headline balance">{headline}</h2>
            {detail && <p className="catch-detail balance">{detail}</p>}
            {v.kind === 'noGeo' && !noStop && (
              <button className="btn btn-primary catch-retry" onClick={() => setGeoNonce((n) => n + 1)}>
                <LocateIcon width={15} height={15} />
                <span>{t('catch.useLocation')}</span>
              </button>
            )}
          </section>

          {/* The verdict is spoken, not just painted. Announced on every change of
              state — see the effect above for why not on every tick. */}
          <p className="sr-only" role="status">{announced}</p>

          <section className="catch-evidence" aria-label={t('catch.evidenceLabel')}>
            <div className="cev">
              <span className="cev-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
              <div className="cev-text">
                <p className="cev-line">
                  {v.distanceM != null && v.walkSec != null
                    ? t('catch.evWalk', { dist: fmtDistance(v.distanceM, imperial), min: Math.max(1, Math.round(v.walkSec / 60)) })
                    : t('catch.evWalkUnknown')}
                </p>
                <p className="cev-sub">{t('catch.evWalkBasis', { kmh })}</p>
              </div>
            </div>

            <div className="cev">
              <span className="cev-glyph" aria-hidden><ClockIcon width={18} height={18} /></span>
              <div className="cev-text">
                <p className="cev-line">
                  {arrivalMs != null ? t('catch.evArrival', { time: fmtClock(arrivalMs) }) : t('catch.evArrivalGone')}
                </p>
                {/* The trust grade only exists when the API could back it with a
                    sample; otherwise the honest line is that this is schedule only. */}
                <p className="cev-sub">
                  {grade
                    ? t('eta.gradeDetail', { grade: grade.letter, n: grade.n, spread: grade.spreadMin })
                    : ev.bucket !== 'none'
                      ? t('eta.basedOn', { n: ev.n, days: ev.windowDays })
                      : t('eta.scheduleOnly')}
                </p>
              </div>
            </div>

            <div className="cev">
              <span className="cev-glyph" aria-hidden>
                {v.kind === 'unseen' ? <WarningIcon width={18} height={18} /> : <SignalIcon width={18} height={18} />}
              </span>
              <div className="cev-text">
                {/* A fix we have declared untrustworthy carries no distance — the
                    verdict already says we cannot see the vehicle, and printing
                    where it used to be would undercut that. */}
                <p className="cev-line">{vehicleLine}</p>
                <p className="cev-sub">{freshness}</p>
              </div>
            </div>
          </section>

          <p className="catch-basis">
            {t('catch.basis')}
            {/* The route-not-run caveat only makes sense when a vehicle is actually
                shown above it. */}
            {v.vehicleDistM != null && ` ${t('catch.basisVehicle')}`}
          </p>
        </div>
      </div>
    </div>
  );
}
