// Catch Mode (Tier 0): the leave-by chip plus a live make-it verdict, recomputed
// continuously from BOTH moving positions — the rider's geolocation at their
// profile walking pace, and the vehicle's position from the live TTC feed.
//
// The guided walk/wait/board choreography and Focused Boarding Mode are Tier 2 and
// are deliberately absent. What is here is the decision and its receipts.
//
// Honesty contract (see lib/catch.ts for the state machine):
//   · "You'll make it" is only ever printed by computeVerdict() — never as static copy.
//   · A vehicle fix older than 90s stops the arithmetic dead; the screen says it
//     cannot see the vehicle instead of counting down from a memory.
//   · A run that leaves the live board says so and offers the next tracked one.
//   · No geolocation means no verdict at all — never a walk timed from a fallback
//     location dressed up as the rider's.
import { useEffect, useMemo, useRef, useState } from 'react';
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

/** Same cadence as the map's vehicle layer — the feed itself updates ~every 5s. */
const VEH_POLL_MS = 5000;
/** Box around the boarding stop, roughly ±5.5 km. A vehicle further out than that
 *  is not one this rider is about to catch, and a bigger box is a bigger payload. */
const BOX_LAT = 0.05;
const BOX_LON = 0.065;

type GeoState = 'pending' | 'granted' | 'unavailable';

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
  const pace = useStore((s) => s.pace);
  const imperial = useStore((s) => s.units) === 'imperial';
  const ref = useRef<HTMLDivElement>(null);

  // ---------------- the rider's own live position ----------------
  const [rider, setRider] = useState<Point | null>(null);
  const [geoState, setGeoState] = useState<GeoState>('pending');
  const [geoNonce, setGeoNonce] = useState(0);
  useEffect(() => {
    if (!('geolocation' in navigator)) { setGeoState('unavailable'); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => { setRider({ lat: p.coords.latitude, lon: p.coords.longitude }); setGeoState('granted'); },
      // Denied, timed out, or position-unavailable all land here. The rider's
      // position is then simply unknown — we never substitute one.
      () => { setRider(null); setGeoState('unavailable'); },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [geoNonce]);

  // ---------------- the live board row for THIS trip ----------------
  // Re-found by tripId on every arrivals refresh. When it is no longer there, the
  // run has left the live board and the verdict degrades to 'gone'.
  const live = useMemo(
    () => arrivals?.departures.find((d) => d.tripId === dep.tripId) ?? null,
    [arrivals, dep.tripId],
  );
  const arrivalMs = live?.liveEtaMs ?? null;
  const stop: Point | null = arrivals && arrivals.lat != null && arrivals.lon != null
    ? { lat: arrivals.lat, lon: arrivals.lon }
    : null;

  // The next departure of this route that the feed is actually tracking — offered
  // when this one is missed or has vanished. Never an invented time.
  const nextTracked = useMemo(() => {
    if (!arrivals) return null;
    const now = liveNow();
    return arrivals.departures
      .filter((d) => d.routeId === dep.routeId && d.tripId !== dep.tripId && d.liveEtaMs != null && d.liveEtaMs > now)
      .sort((a, b) => (a.liveEtaMs as number) - (b.liveEtaMs as number))[0] ?? null;
  }, [arrivals, dep.routeId, dep.tripId]);

  // ---------------- the vehicle's live position ----------------
  // The vehicle feed identifies vehicles by route, not by run, so this is the
  // closest tracked vehicle of this route to the boarding stop — labelled as
  // exactly that, never as "your bus". The last fix is kept so that when it stops
  // refreshing we can say how old it is instead of silently dropping it.
  const [fix, setFix] = useState<VehicleFix | null>(null);
  const [everSeen, setEverSeen] = useState(false);
  useEffect(() => {
    if (!stop || !dep.routeId) return;
    const box: Bbox = [stop.lon - BOX_LON, stop.lat - BOX_LAT, stop.lon + BOX_LON, stop.lat + BOX_LAT];
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const res = await api.vehicles(box);
        if (!alive) return;
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
  }, [dep.routeId, stop?.lat, stop?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------- the verdict ----------------
  const mps = paceMps(pace);
  const v = computeVerdict({ nowMs: liveNow(), rider, stop, paceMps: mps, arrivalMs, vehicle: fix });

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
      default: return t('catch.vNoGeo');
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
        return everSeen && v.fixAgeSec != null
          ? t('catch.vUnseenAgo', { min: Math.max(1, Math.round(v.fixAgeSec / 60)) })
          : t('catch.vUnseenNever', { route: short });
      default:
        return t('catch.vNoGeoBody');
    }
  })();

  // ---------------- polite announcement on every verdict change ----------------
  // Keyed on the verdict *kind*, not the countdown: announcing every second (or
  // every minute) would make the live region unusable.
  const [announced, setAnnounced] = useState('');
  const lastKind = useRef<VerdictKind | null>(null);
  useEffect(() => {
    if (v.kind === lastKind.current) return;
    lastKind.current = v.kind;
    setAnnounced(`${headline}${detail ? `. ${detail}` : ''}`);
  }, [v.kind, headline, detail]);

  // ---------------- modal keyboard contract (mirrors SettingsSheet) ----------------
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);

  // ---------------- evidence ----------------
  const kmh = (mps * 3.6).toFixed(1);
  const ev = live?.evidence ?? dep.evidence;
  const grade = live?.grade ?? dep.grade ?? null;
  const spreadMin = grade?.spreadMin ?? null;
  const freshness = v.fixAgeSec == null
    ? null
    : v.fixAgeSec < 90
      ? t('status.updatedAgo', { secs: v.fixAgeSec })
      : t('status.updatedMinAgo', { mins: Math.round(v.fixAgeSec / 60) });

  return (
    <div className="sheet-scrim catch-scrim" onClick={onClose}>
      <div
        ref={ref}
        className="catch-sheet glass"
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

        <div className="catch-body scroll">
          <section className={`catch-verdict verdict-${v.kind}`}>
            <span className="eyebrow">{t('catch.verdictLabel')}</span>
            <p className="catch-headline balance">{headline}</p>
            {detail && <p className="catch-detail balance">{detail}</p>}
            {v.kind === 'noGeo' && (
              <button className="btn btn-primary catch-retry" onClick={() => setGeoNonce((n) => n + 1)}>
                <LocateIcon width={15} height={15} />
                <span>{t('catch.useLocation')}</span>
              </button>
            )}
          </section>

          {/* The verdict is spoken, not just painted. Announced on every change of
              state — see the effect above for why not on every tick. */}
          <p className="sr-only" role="status" aria-live="polite">{announced}</p>

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
                <p className="cev-sub">
                  {grade && spreadMin != null
                    ? t('eta.gradeDetail', { grade: grade.letter, n: grade.n, spread: spreadMin })
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
                <p className="cev-line">
                  {v.vehicleDistM != null
                    ? t('catch.evVehicle', { route: short, dist: fmtDistance(v.vehicleDistM, imperial) })
                    : everSeen
                      ? t('catch.evVehicleStale', { route: short })
                      : t('catch.evVehicleNone', { route: short })}
                </p>
                <p className="cev-sub">{freshness ?? t('catch.evNoFix')}</p>
              </div>
            </div>
          </section>

          <p className="catch-basis">{t('catch.basis')}</p>
        </div>
      </div>
    </div>
  );
}
