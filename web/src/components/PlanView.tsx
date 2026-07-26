// The Plan tab — a real single-ride planner.
//
// This tab used to render a PlaceholderView reading "Trip planning is designed — it
// isn't wired up in this build yet". It is wired up now, against /api/plan, and every
// number on screen comes from the agency's published schedule.
//
// THE SCOPE IS DELIBERATE AND STATED. GhostBus plans ONE ride: walk to a stop, stay on
// one vehicle, walk to where you are going. When a journey needs a transfer the planner
// says exactly that and offers a maps app instead. It never stitches two rides together
// and calls it a trip, because a fabricated connection is precisely the kind of
// confident-sounding fiction this whole project exists to argue against.
//
// The four outcomes are four different facts and are never collapsed into one shrug:
//   ride        · a real single-ride plan, below.
//   transfer    · nothing in the schedule rides from one end to the other.
//   noService   · a direct ride exists, but none departs in the window searched.
//   noStops…    · one end has no stop near it at all.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlanResponse } from '@shared/types';
import { api } from '@/lib/api';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useStore, paceMps } from '@/store';
import { fmtClock, fmtDistance, fmtServiceDate } from '@/lib/format';
import { pickBestRide, transitDirectionsUrl, type RidePlan } from '@/lib/plan';
import { parseHeadsign } from '@/lib/headsign';
import { RouteBadge } from './Primitives';
import {
  SearchIcon, WalkerIcon, RouteIcon, FlagIcon, ClockIcon, WarningIcon,
  ChevronIcon, CloseIcon, ArrowRightIcon,
} from './icons';

/** How far ahead the first request looks. Matches the departure board's own window. */
const FIRST_WINDOW_MIN = 90;
/** When nothing runs in the next 90 minutes, one wider request walks forward to the
 *  next real service day rather than eight day-by-day probes. */
const NEXT_SERVICE_WINDOW_MIN = 4320;

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'done'; res: PlanResponse; widened: boolean };

export function PlanView() {
  const { t } = useTranslation();
  useTick(30_000);
  const target = useStore((s) => s.planTarget);
  const recentTrips = useStore((s) => s.recentTrips);
  const setPlanTarget = useStore((s) => s.setPlanTarget);
  const openSearch = useStore((s) => s.openSearch);
  const pace = useStore((s) => s.pace);
  const imperial = useStore((s) => s.units) === 'imperial';
  const geo = useLive((s) => s.geo);
  const geoStatus = useLive((s) => s.geoStatus);
  const online = useLive((s) => s.online);

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Same monotonic guard the rest of the app uses: a slow reply for a destination the
  // rider has since changed must never overwrite the current plan.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!target || target.lat == null || target.lon == null || !geo) {
      seqRef.current += 1;
      setPhase({ kind: 'idle' });
      return;
    }
    const to = { lat: target.lat, lon: target.lon };
    const seq = ++seqRef.current;
    const ctrl = new AbortController();
    setPhase({ kind: 'loading' });

    (async () => {
      try {
        const first = await api.plan(geo, to, { windowMin: FIRST_WINDOW_MIN }, ctrl.signal);
        if (seq !== seqRef.current) return;
        // A direct ride exists but not in the next 90 minutes — reach forward to the
        // service day that actually has one instead of reporting a dead end.
        if (first.outcome === 'noService') {
          const wide = await api.plan(geo, to, { windowMin: NEXT_SERVICE_WINDOW_MIN }, ctrl.signal);
          if (seq !== seqRef.current) return;
          setPhase({ kind: 'done', res: wide, widened: true });
          return;
        }
        setPhase({ kind: 'done', res: first, widened: false });
      } catch {
        if (seq !== seqRef.current || ctrl.signal.aborted) return;
        setPhase({ kind: 'error' });
      }
    })();

    return () => { ctrl.abort(); };
  }, [target, geo]);

  const now = liveNow();
  const best = useMemo<RidePlan | null>(() => {
    if (phase.kind !== 'done' || phase.res.outcome !== 'ride') return null;
    return pickBestRide(phase.res.candidates, { nowMs: now, paceMps: paceMps(pace) });
    // `now` deliberately excluded: re-picking every tick would let the chosen ride
    // hop between options mid-read. useTick already re-renders the times below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pace]);

  const clear = useCallback(() => setPlanTarget(null), [setPlanTarget]);

  /**
   * A resolved plan takes the map with it: the selected stop becomes the plan's own
   * BOARDING stop.
   *
   * This is not decoration. On the desktop split the map stays mounted beside this
   * panel and draws its beaded walk path from the rider to whatever stop is selected
   * — so after a rider searches a stop across town, the map keeps drawing a walk to
   * it, and a 7 km dotted trail beside a trip plan reads as a suggested route. Moving
   * the selection to the boarding stop makes that path the plan's own first leg,
   * which is exactly what it is meant to depict.
   */
  const boardStop = best?.candidate.board ?? null;
  useEffect(() => {
    if (!boardStop) return;
    if (useStore.getState().selectedStopId === boardStop.stopId) return;
    useLive.getState().openStop(boardStop);
  }, [boardStop]);

  /**
   * AND THE MIRROR OF THAT: a plan that did NOT resolve takes the map's walk geometry away.
   *
   * Without this, the previous plan's first leg stayed drawn — a beaded walk path to a
   * boarding stop belonging to a different journey — sitting directly under the words
   * "this trip needs a transfer". A route-like line beside a message saying there is no
   * route is exactly the kind of confident-sounding fiction this tab exists to refuse.
   * Measured: the flow harness caught `walkNodes = 1` on the transfer screen.
   *
   * Every non-ride outcome counts, and so does a `ride` whose candidates are all
   * uncatchable (`best === null`) — the rider cannot make any of them, so there is no
   * first leg to depict.
   */
  const unresolved = phase.kind === 'done' && (phase.res.outcome !== 'ride' || best == null);
  useEffect(() => {
    useStore.getState().setPlanUnresolved(unresolved);
  }, [unresolved]);
  // Leaving the tab (or the app) must not strand the map in a plan-failed state.
  useEffect(() => () => { useStore.getState().setPlanUnresolved(false); }, []);

  return (
    <div className="plan-panel">
      <header className="plan-head">
        <h2 className="plan-title">{t('plan.title')}</h2>
        <p className="plan-sub">{t('plan.sub')}</p>
      </header>

      {/* The destination picker — the same search sheet the top bar opens. */}
      <div className="plan-dest">
        <button
          className="plan-dest-btn"
          aria-haspopup="dialog"
          onClick={() => openSearch('destination')}
        >
          <span className="plan-dest-glyph" aria-hidden><SearchIcon width={18} height={18} /></span>
          <span className="plan-dest-text truncate">
            {target ? target.name : t('plan.chooseDestination')}
          </span>
          <ChevronIcon width={17} height={17} aria-hidden />
        </button>
        {target && (
          <button className="plan-dest-clear" aria-label={t('plan.clearDestination')} onClick={clear}>
            <CloseIcon width={17} height={17} />
          </button>
        )}
      </div>

      {!target && <PlanIdle recents={recentTrips} />}

      {target && !geo && (
        <PlanState glyph={<WarningIcon width={24} height={24} />} title={t('plan.noGeoTitle')} body={t('plan.noGeoBody')} />
      )}

      {target && geo && phase.kind === 'loading' && (
        <div className="plan-legs" aria-hidden>
          {[0, 1, 2].map((i) => <div key={i} className="skeleton plan-skeleton" />)}
        </div>
      )}

      {target && geo && phase.kind === 'error' && (
        <PlanState
          glyph={<WarningIcon width={24} height={24} />}
          title={online ? t('plan.errorTitle') : t('offline.title')}
          body={online ? t('plan.errorBody') : t('offline.body')}
        />
      )}

      {target && geo && phase.kind === 'done' && (
        <PlanOutcomeView
          res={phase.res}
          widened={phase.widened}
          best={best}
          imperial={imperial}
          now={now}
          destinationName={target.name}
        />
      )}

      {geoStatus === 'default' && target && (
        <p className="plan-fineprint">{t('plan.defaultLocationNote')}</p>
      )}
    </div>
  );
}

function PlanIdle({ recents }: { recents: ReturnType<typeof useStore.getState>['recentTrips'] }) {
  const { t } = useTranslation();
  const openSearch = useStore((s) => s.openSearch);
  const setPlanTarget = useStore((s) => s.setPlanTarget);

  return (
    <>
      {recents.length > 0 && (
        <section className="gb-section plan-recents" aria-labelledby="gb-plan-recents">
          <div className="section-head">
            <span className="eyebrow" id="gb-plan-recents">{t('plan.recentTrips')}</span>
          </div>
          <ul className="saved-list">
            {recents.map((r) => (
              <li className="saved-row" key={r.stopId}>
                <button
                  className="saved-open"
                  disabled={r.lat == null || r.lon == null}
                  onClick={() => setPlanTarget({ ...r, ts: Date.now() })}
                >
                  <span className="saved-tile" aria-hidden><FlagIcon width={17} height={17} /></span>
                  <span className="saved-text">
                    <span className="saved-title">{r.name}</span>
                    <span className="saved-sub">{t('stop.code', { code: r.stopId })}</span>
                  </span>
                  <ArrowRightIcon width={17} height={17} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="state-card state-placeholder" role="status">
        <div className="state-glyph" aria-hidden><RouteIcon width={26} height={26} /></div>
        <h3 className="state-title">{t('plan.emptyTitle')}</h3>
        <p className="state-body">{t('plan.emptyBody')}</p>
        <button className="btn btn-primary plan-cta" onClick={() => openSearch('destination')}>
          <SearchIcon width={16} height={16} aria-hidden />
          <span>{t('plan.chooseDestination')}</span>
        </button>
      </div>
    </>
  );
}

function PlanState({ glyph, title, body, children }: {
  glyph: React.ReactNode; title: string; body: string; children?: React.ReactNode;
}) {
  return (
    <div className="state-card state-placeholder" role="status">
      <div className="state-glyph" aria-hidden>{glyph}</div>
      <h3 className="state-title">{title}</h3>
      <p className="state-body">{body}</p>
      {children}
    </div>
  );
}

function PlanOutcomeView({ res, widened, best, imperial, now, destinationName }: {
  res: PlanResponse;
  widened: boolean;
  best: RidePlan | null;
  imperial: boolean;
  now: number;
  destinationName: string;
}) {
  const { t } = useTranslation();

  if (res.outcome === 'transfer') {
    return (
      <PlanState
        glyph={<WarningIcon width={24} height={24} />}
        title={t('plan.transferTitle')}
        body={t('plan.transferBody')}
      >
        {/* Destination only — the rider's own position is the one thing this app
            promises never to hand to anyone else, and a maps app already knows it. */}
        <a
          className="btn btn-quiet plan-maps"
          href={transitDirectionsUrl(res.to)}
          target="_blank"
          rel="noreferrer noopener"
        >
          <ArrowRightIcon width={16} height={16} aria-hidden />
          <span>{t('plan.openInMaps')}</span>
        </a>
        <p className="plan-fineprint">{t('plan.transferFine')}</p>
      </PlanState>
    );
  }

  if (res.outcome === 'noStopsNearYou' || res.outcome === 'noStopsNearDestination') {
    return (
      <PlanState
        glyph={<WarningIcon width={24} height={24} />}
        title={res.outcome === 'noStopsNearYou' ? t('plan.noStopsYouTitle') : t('plan.noStopsDestTitle')}
        body={t('plan.noStopsBody', { m: res.radiusM })}
      />
    );
  }

  if (res.outcome === 'noService') {
    return (
      <PlanState
        glyph={<ClockIcon width={24} height={24} />}
        title={t('plan.noServiceTitle')}
        body={t('plan.noServiceBody')}
      />
    );
  }

  // outcome === 'ride'
  if (!best) {
    return (
      <PlanState
        glyph={<WalkerIcon width={24} height={24} />}
        title={t('plan.unreachableTitle')}
        body={t('plan.unreachableBody', { count: res.candidates.length })}
      />
    );
  }

  return <RidePlanCard plan={best} imperial={imperial} now={now} destinationName={destinationName} widened={widened} />;
}

function RidePlanCard({ plan, imperial, now, destinationName, widened }: {
  plan: RidePlan; imperial: boolean; now: number; destinationName: string; widened: boolean;
}) {
  const { t } = useTranslation();
  const c = plan.candidate;
  const short = c.shortName ?? c.routeId ?? '—';
  const destination = parseHeadsign(c.directionLabel).destination || c.directionLabel;
  const min = (sec: number) => Math.max(1, Math.round(sec / 60));
  const sameDay = new Date(plan.boardMs).toDateString() === new Date(now).toDateString();

  return (
    <section className="plan-result" aria-label={t('plan.resultLabel')}>
      {/* The headline claim, and the two things that qualify it. */}
      <div className="plan-summary">
        <span className="eyebrow">{widened ? t('plan.nextServiceEyebrow') : t('plan.summaryEyebrow')}</span>
        <p className="plan-total">{t('plan.doorToDoor', { min: min(plan.totalSec) })}</p>
        <p className="plan-arrive">
          {t('plan.arriveAt', { time: fmtClock(plan.doorMs) })}
          {!sameDay && <span className="plan-date"> · {fmtServiceDate(plan.boardMs)}</span>}
        </p>
      </div>

      <ol className="plan-legs">
        <li className="plan-leg plan-leg-walk">
          <span className="plan-leg-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line">
              {t('plan.walkTo', {
                dist: fmtDistance(plan.toStop.distanceM, imperial),
                min: min(plan.toStop.seconds),
                stop: c.board.name ?? c.board.stopId,
              })}
            </p>
            <p className="plan-leg-sub">{t('plan.leaveBy', { time: fmtClock(plan.leaveByMs) })}</p>
          </div>
        </li>

        <li className="plan-leg plan-leg-ride">
          <span className="plan-leg-glyph plan-leg-glyph-ride" aria-hidden><RouteIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line plan-ride-id">
              <RouteBadge color={c.color} short={short} size="sm" />
              <span className="plan-ride-dest">{destination}</span>
            </p>
            <p className="plan-leg-sub">
              {t('plan.rideDetail', {
                board: fmtClock(plan.boardMs),
                alight: fmtClock(plan.boardMs + plan.rideSec * 1000),
                count: c.stopsRidden,
              })}
            </p>
            <p className="plan-leg-sub">
              {t('plan.alightAt', { stop: c.alight.name ?? c.alight.stopId })}
            </p>
            {/* The evidence treatment the rest of the app uses: a letter only when the
                sample earns one, and the honest sentence when it does not. */}
            <p className="plan-leg-evidence">
              {c.grade ? (
                <>
                  <span className={`grade-chip grade-${c.grade.letter}`} role="img"
                    aria-label={t('eta.gradeAria', { grade: c.grade.letter, n: c.grade.n, spread: c.grade.spreadMin })}>
                    {c.grade.letter}
                  </span>
                  <span className="evidence-chip">{t('eta.evidence', { spread: c.grade.spreadMin, n: c.grade.n })}</span>
                </>
              ) : (
                <>
                  <span className="grade-chip grade-untracked" role="img" aria-label={t('eta.untracked')}>
                    {t('eta.untrackedMark')}
                  </span>
                  <span className="evidence-chip evidence-thin">{t('eta.scheduleOnly')}</span>
                </>
              )}
            </p>
            {c.ghostRisk && (
              <p className={`forecast-chip forecast-${c.ghostRisk.level}`}
                aria-label={t(c.ghostRisk.level === 'high' ? 'forecast.ariaHigh' : 'forecast.ariaElevated', {
                  v: c.ghostRisk.ghosts, o: c.ghostRisk.n, days: c.ghostRisk.windowDays,
                })}>
                <WarningIcon width={13} height={13} aria-hidden />
                <span>
                  {t(c.ghostRisk.level === 'high' ? 'forecast.chipHigh' : 'forecast.chipElevated', {
                    v: c.ghostRisk.ghosts, o: c.ghostRisk.n,
                  })}
                </span>
              </p>
            )}
          </div>
        </li>

        <li className="plan-leg plan-leg-walk">
          <span className="plan-leg-glyph" aria-hidden><FlagIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line">
              {t('plan.walkFrom', {
                dist: fmtDistance(plan.fromStop.distanceM, imperial),
                min: min(plan.fromStop.seconds),
                dest: destinationName,
              })}
            </p>
          </div>
        </li>
      </ol>

      {/* What this plan is, and what it is not. Both stated, not implied. */}
      <p className="plan-basis">
        {t('plan.basisRide')}
        {plan.boardIsPredicted ? ` ${t('plan.basisPredicted')}` : ` ${t('plan.basisScheduled')}`}
        {' '}{t('plan.basisSingleRide')}
      </p>
    </section>
  );
}
