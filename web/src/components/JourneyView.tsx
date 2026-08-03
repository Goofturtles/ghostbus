// GO — the journey the rider committed to, in progress.
//
// This is Catch Mode generalised from one departure to a whole trip. The verdict engine is
// the SAME one (hooks/useCatchEngine, which CatchView also uses): the rider's watched
// position, the vehicle poll around the boarding stop, and lib/catch.ts's pure arithmetic.
// Nothing about "do I make it?" is re-implemented here — only its framing changes, from a
// modal about one bus to a step inside a sequence.
//
// WHAT THIS SCREEN KNOWS, AND WHAT IT ONLY BELIEVES. It knows where the rider is (they
// granted it), where the vehicles are (the feed says so), and what the plan's clock says.
// It does NOT know whether they actually boarded, or got off, or gave up. So the
// highlighted step is stated as where the PLAN says they should be — never as "you are on
// the 504" — and the fine print says exactly that. An app that would not fabricate a
// departure time must not fabricate a rider's position in their own journey either.
//
// THE VERDICT IS OFFERED FOR THE FIRST RIDE ONLY, and that is a limit, not an oversight.
// A catch verdict is a claim about a walk GhostBus can time from a position it can see. It
// can see the rider standing at home before leg 1. It cannot see them stepping off leg 1
// at a transfer stop three kilometres away, so the later legs get the honest countdown
// instead — the live board's prediction where the run is tracked, the timetable where it
// is not, marked as such either way.

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, paceMps } from '@/store';
import { useLive, liveNow } from '@/hooks/useLive';
import { useTick } from '@/hooks/useTick';
import { useCatchEngine, nextTrackedOf } from '@/hooks/useCatchEngine';
import { journeyProgress, type Journey, type JourneyStep, optionLikelihood } from '@/lib/journey';
import { fmtClock, fmtDistance } from '@/lib/format';
import { RouteBadge, readableOn } from './Primitives';
import {
  WalkerIcon, RouteIcon, FlagIcon, ClockIcon, WarningIcon, LocateIcon, SignalIcon, CloseIcon,
} from './icons';

const min = (sec: number) => Math.max(1, Math.round(sec / 60));

/** Show a fix age in seconds below this, in minutes above it — same threshold CatchView
 *  uses, and above the ~106s a healthy fix reaches on this feed. */
const AGE_IN_SECONDS_BELOW = 120;

/**
 * The segmented progress bar — one span per step, each sized to its real share of the
 * journey and a ride span painted in its own route's brand colour.
 *
 * Drawn to scale from the plan's own instants, so a twenty-minute ride is twenty minutes
 * wide relative to a four-minute walk. That is the whole point of it: a bar whose segments
 * were equal would be a decoration, and this one is a measurement.
 */
function ProgressBar({ j, fraction }: { j: Journey; fraction: number }) {
  const { t } = useTranslation();
  const total = Math.max(1, j.doorMs - j.leaveByMs);
  return (
    <div
      className="jr-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-label={t('journey.progressLabel')}
    >
      {j.steps.map((s, i) => {
        const share = ((s.endMs - s.startMs) / total) * 100;
        const brand = s.candidate ? `#${s.candidate.color.replace('#', '')}` : undefined;
        return (
          <span
            key={i}
            className={`jr-seg jr-seg-${s.kind}`}
            style={{ flexGrow: Math.max(0.02, share), ...(brand ? { background: brand } : {}) }}
          />
        );
      })}
      <span className="jr-bar-now" style={{ left: `${fraction * 100}%` }} aria-hidden />
    </div>
  );
}

function StepGlyph({ kind }: { kind: JourneyStep['kind'] }) {
  if (kind === 'ride') return <RouteIcon width={18} height={18} />;
  if (kind === 'walkToDest') return <FlagIcon width={18} height={18} />;
  return <WalkerIcon width={18} height={18} />;
}

/**
 * The live countdown for a ride that has not left yet.
 *
 * `liveEtaMs` is the ONLY thing that earns the live treatment. Where the run is not on the
 * live board this counts down to the instant the plan was built on and wears the SCHEDULED
 * chip — an honest countdown to a scheduled time, which is a different promise from a
 * countdown to a tracked vehicle and is labelled as one.
 */
function RideCountdown({ step, liveMs, now }: { step: JourneyStep; liveMs: number | null; now: number }) {
  const { t } = useTranslation();
  const target = liveMs ?? step.startMs;
  const secs = Math.round((target - now) / 1000);
  const isLive = liveMs != null;
  const label = secs <= 30 && secs >= -60
    ? t('row.due')
    : secs < -60
      ? t('journey.departed')
      : t('journey.inMin', { min: Math.max(1, Math.round(secs / 60)) });

  return (
    <p className={`jr-countdown ${isLive ? 'jr-countdown-live' : 'jr-countdown-sched'}`}>
      <span className="jr-count-num tnum">{label}</span>
      <span className={`pill ${isLive ? 'pill-live' : 'pill-sched'}`}>
        {isLive ? <span className="live-dot" aria-hidden /> : null}
        {isLive ? t('status.live') : t('row.scheduledOnly')}
      </span>
      <span className="jr-count-at">{t('journey.at', { time: fmtClock(target) })}</span>
    </p>
  );
}

/** One step of the timeline. `state` is the plan's clock, never a claim about the rider. */
function StepRow({ step, state, imperial, children }: {
  step: JourneyStep;
  state: 'done' | 'now' | 'todo';
  imperial: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const c = step.candidate;
  const brand = c ? `#${c.color.replace('#', '')}` : undefined;

  const line = (() => {
    switch (step.kind) {
      case 'walkToStop':
        return t(step.walkKind === 'routed' ? 'plan.walkTo' : 'plan.walkToEst', {
          dist: fmtDistance(step.distanceM ?? 0, imperial),
          min: min(Math.round((step.endMs - step.startMs) / 1000)),
          stop: step.toName ?? '',
        });
      case 'transfer':
        return step.sameStop
          ? t('plan.transferStayAt', { stop: step.toName ?? '' })
          : t('plan.transferWalkTo', {
            dist: fmtDistance(step.distanceM ?? 0, imperial),
            min: min(Math.round((step.endMs - step.startMs) / 1000) - (step.waitSec ?? 0)),
            stop: step.toName ?? '',
          });
      case 'walkToDest':
        return t('plan.walkFromEst', {
          dist: fmtDistance(step.distanceM ?? 0, imperial),
          min: min(Math.round((step.endMs - step.startMs) / 1000)),
          dest: step.toName ?? '',
        });
      default:
        return null;
    }
  })();

  return (
    <li
      className={`jr-step jr-step-${step.kind} jr-${state}`}
      aria-current={state === 'now' ? 'step' : undefined}
      style={brand ? ({ '--jr-brand': brand, '--jr-on-brand': readableOn(c!.color) } as React.CSSProperties) : undefined}
    >
      <span className="jr-step-glyph" aria-hidden><StepGlyph kind={step.kind} /></span>
      <div className="jr-step-text">
        {state === 'now' && <span className="jr-nowtag">{t('journey.nowTag')}</span>}

        {step.kind === 'ride' && c ? (
          <>
            <p className="jr-step-line jr-ride-id">
              <RouteBadge color={c.color} short={c.shortName ?? c.routeId ?? '—'} size="sm" />
              <span className="jr-ride-dest truncate">{step.toName ?? ''}</span>
            </p>
            <p className="jr-step-sub">
              {t('plan.rideDetail', {
                board: fmtClock(step.startMs), alight: fmtClock(step.endMs), count: c.stopsRidden,
              })}
            </p>
          </>
        ) : (
          <>
            <p className="jr-step-line">{line}</p>
            {step.kind === 'transfer' && (
              <p className="jr-step-sub">{t('plan.transferWait', { min: min(step.waitSec ?? 0) })}</p>
            )}
            {step.kind === 'walkToStop' && (
              <p className="jr-step-sub">{t('plan.leaveBy', { time: fmtClock(step.startMs) })}</p>
            )}
          </>
        )}
        {children}
      </div>
    </li>
  );
}

export function JourneyView() {
  const { t } = useTranslation();
  useTick(1000);
  const j = useStore((s) => s.journey);
  const endJourney = useStore((s) => s.endJourney);
  const pace = useStore((s) => s.pace);
  const imperial = useStore((s) => s.units) === 'imperial';
  const arrivals = useLive((s) => s.arrivals);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * THE BOARDING STOP BECOMES THE SELECTED STOP, on purpose and exactly once.
   *
   * The live board this screen reads its first leg's prediction from is `useLive.arrivals`,
   * which is whatever stop is selected. Committing to a journey therefore selects the stop
   * the rider is walking to — which is also the stop the map should be drawing its walk to,
   * so the line under their feet and the verdict on screen describe the same walk.
   */
  const firstRide = j?.steps.find((s) => s.kind === 'ride')?.candidate ?? null;
  const boardStop = firstRide?.board ?? null;
  const boardStopId = boardStop?.stopId ?? null;
  useEffect(() => {
    if (!boardStop) return;
    if (useStore.getState().selectedStopId === boardStop.stopId) return;
    useLive.getState().openStop(boardStop);
  }, [boardStop]);

  // Escape leaves the journey — the same contract every other full-screen surface honours.
  const endRef = useRef(endJourney);
  endRef.current = endJourney;
  useEffect(() => {
    if (!j) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => !el.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); endRef.current(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [j]);

  const now = liveNow();
  // Hooks must run unconditionally, so the engine is wired before the early return and
  // simply disabled when there is no journey (or no stop to time a walk to).
  const engine = useCatchEngine({
    tripId: firstRide?.tripId ?? '',
    routeId: firstRide?.routeId ?? null,
    stop: boardStop && boardStop.lat != null && boardStop.lon != null
      ? { lat: boardStop.lat, lon: boardStop.lon } : null,
    stopId: boardStopId,
    enabled: j != null,
  });

  if (!j) return null;

  const progress = journeyProgress(j, now);
  const v = engine.verdict;
  const short = firstRide?.shortName ?? firstRide?.routeId ?? '—';
  const likelihood = optionLikelihood(j.option);

  // Which ride step is the FIRST one — the only one a walk verdict is honest about.
  const firstRideIndex = j.steps.findIndex((s) => s.kind === 'ride');
  // The verdict is live only while the rider has not yet boarded it.
  const beforeFirstRide = progress.index <= firstRideIndex - 1 || progress.index === -1;

  const headline = ((): string => {
    if (progress.index === -1) return t('journey.notLeftYet', { time: fmtClock(j.leaveByMs) });
    if (progress.index >= j.steps.length) return t('journey.arrived');
    if (!beforeFirstRide) {
      const s = progress.step;
      if (s?.kind === 'ride') return t('journey.onBoard', { route: s.candidate?.shortName ?? short });
      if (s?.kind === 'transfer') return t('journey.transferring', { stop: s.toName ?? '' });
      return t('journey.walkingToDest', { dest: j.destinationName });
    }
    switch (v.kind) {
      case 'comfortable': return t('catch.vComfortable', { min: Math.max(1, Math.round((v.bufferSec ?? 0) / 60)) });
      case 'tight': return t('catch.vTight', { sec: Math.max(0, v.bufferSec ?? 0) });
      case 'missed': return t('catch.vMissed');
      case 'atStop': return t('catch.vAtStop');
      case 'unseen': return t('catch.vUnseen');
      case 'gone': return t('catch.vGone');
      default: return engine.noStop ? t('catch.vNoStop') : t('catch.vNoGeo');
    }
  })();

  const nextTracked = nextTrackedOf(arrivals, firstRide?.routeId ?? null, firstRide?.tripId ?? '', now);
  const detail = ((): string | null => {
    if (progress.index === -1) return t('journey.leaveIn', { min: Math.max(0, Math.round((j.leaveByMs - now) / 60000)) });
    if (progress.index >= j.steps.length) return t('journey.arrivedBody', { dest: j.destinationName });
    if (!beforeFirstRide) return t('journey.planClockNote');
    switch (v.kind) {
      case 'comfortable':
      case 'tight':
        return v.leaveByMs == null ? null : t('eta.leaveBy', { time: fmtClock(v.leaveByMs) });
      case 'missed':
      case 'gone':
        return nextTracked?.liveEtaMs != null
          ? t('catch.vNextTracked', { route: short, time: fmtClock(nextTracked.liveEtaMs) })
          : t('catch.vNoNextTracked', { route: short });
      case 'atStop': {
        const secs = v.bufferSec ?? 0;
        if (secs < -60) return t('catch.vAtStopLate', { route: short });
        if (secs < 60) return t('catch.vAtStopDue', { route: short });
        return t('catch.vAtStopIn', { route: short, min: Math.round(secs / 60) });
      }
      case 'unseen':
        if (engine.ourFault) return t('catch.vUnseenApiDown');
        if (engine.agencyFeedDown) return t('catch.vUnseenFeedDown');
        return engine.everSeen && v.fixAgeSec != null
          ? t('catch.vUnseenAgo', { min: Math.max(1, Math.round(v.fixAgeSec / 60)) })
          : t('catch.vUnseenNever', { route: short });
      default:
        return engine.noStop ? t('catch.vNoStopBody') : t('catch.vNoGeoBody');
    }
  })();

  const kmh = (paceMps(pace) * 3.6).toFixed(1);
  const freshness = engine.ourFault
    ? t('catch.evApiDown')
    : engine.agencyFeedDown
      ? t('catch.evFeedDown')
      : v.fixAgeSec == null
        ? t('catch.evNoFix')
        : v.fixAgeSec < AGE_IN_SECONDS_BELOW
          ? t('status.updatedAgo', { secs: v.fixAgeSec })
          : t('status.updatedMinAgo', { mins: Math.round(v.fixAgeSec / 60) });

  return (
    <div className="jr-scrim">
      <div
        ref={ref}
        className="jr-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('journey.dialogLabel', { dest: j.destinationName })}
      >
        <header className="jr-head">
          <div className="jr-head-text">
            <span className="eyebrow">{t('journey.eyebrow')}</span>
            <h2 className="jr-dest truncate">{j.destinationName}</h2>
          </div>
          <button className="btn btn-quiet jr-exit" onClick={endJourney}>
            <CloseIcon width={16} height={16} aria-hidden />
            <span>{t('journey.exit')}</span>
          </button>
        </header>

        <div className="jr-body scroll" tabIndex={0} role="group" aria-label={t('journey.bodyLabel')}>
          <section className={`jr-verdict verdict-${beforeFirstRide ? v.kind : 'plan'}`}>
            <h3 className="jr-headline balance">{headline}</h3>
            {detail && <p className="jr-detail balance">{detail}</p>}
            {beforeFirstRide && v.kind === 'noGeo' && !engine.noStop && (
              <button className="btn btn-primary jr-retry" onClick={engine.retryGeo}>
                <LocateIcon width={15} height={15} aria-hidden />
                <span>{t('catch.useLocation')}</span>
              </button>
            )}
          </section>

          <p className="sr-only" role="status">{`${headline}${detail ? `. ${detail}` : ''}`}</p>

          <ProgressBar j={j} fraction={progress.fraction} />
          <p className="jr-summary">
            {t('plan.doorToDoor', { min: min(j.totalSec) })}
            {' · '}
            {t('plan.arriveAt', { time: fmtClock(j.doorMs) })}
          </p>

          {/* The percentage travels with the journey — it is the same claim the option
              card made, and a rider who committed on the strength of it should still be
              able to see what it was. Absent where it was absent there. */}
          {likelihood && (
            <p className="jr-pct">
              <span className="pct-num tnum">{likelihood.percent}%</span>
              <span className="pct-label">
                {likelihood.kind === 'connection' ? t('plan.pctConnectionShort') : t('plan.pctOnTimeShort')}
              </span>
              <span className="jr-pct-basis">
                {likelihood.bucket === 'stop-hour'
                  ? t('plan.pctBasisStop', { n: likelihood.n, days: likelihood.windowDays })
                  : t('plan.pctBasisRoute', { n: likelihood.n, days: likelihood.windowDays })}
              </span>
            </p>
          )}

          <ol className="jr-steps">
            {j.steps.map((s, i) => {
              const state = progress.index === -1
                ? 'todo'
                : i < progress.index ? 'done' : i === progress.index ? 'now' : 'todo';
              const isFirstRide = i === firstRideIndex;
              // The live prediction for the first ride comes from the board this screen
              // selected; later rides have no board loaded, so they count down to the
              // instant the plan was built on and say SCHEDULED.
              const liveMs = isFirstRide ? engine.arrivalMs : null;
              return (
                <StepRow key={i} step={s} state={state as 'done' | 'now' | 'todo'} imperial={imperial}>
                  {s.kind === 'ride' && s.startMs > now && (
                    <RideCountdown step={s} liveMs={liveMs} now={now} />
                  )}
                </StepRow>
              );
            })}
          </ol>

          {/* The receipts behind the verdict, for as long as the verdict is one. */}
          {beforeFirstRide && (
            <section className="catch-evidence" aria-label={t('catch.evidenceLabel')}>
              <div className="cev">
                <span className="cev-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
                <div className="cev-text">
                  <p className="cev-line">
                    {v.distanceM != null && v.walkSec != null
                      ? t(v.walkKind === 'routed' ? 'catch.evWalk' : 'catch.evWalkEst', {
                        dist: fmtDistance(v.distanceM, imperial),
                        min: Math.max(1, Math.round(v.walkSec / 60)),
                      })
                      : t('catch.evWalkUnknown')}
                  </p>
                  <p className="cev-sub">
                    {t(v.walkKind === 'routed' ? 'catch.evWalkBasisRouted' : 'catch.evWalkBasis', { kmh })}
                  </p>
                </div>
              </div>

              <div className="cev">
                <span className="cev-glyph" aria-hidden><ClockIcon width={18} height={18} /></span>
                <div className="cev-text">
                  <p className="cev-line">
                    {engine.arrivalMs != null
                      ? t('catch.evArrival', { time: fmtClock(engine.arrivalMs) })
                      : t('journey.evScheduledBoarding', { time: fmtClock(j.steps[firstRideIndex]?.startMs ?? j.leaveByMs) })}
                  </p>
                  <p className="cev-sub">
                    {firstRide?.grade
                      ? t('eta.gradeDetail', {
                        grade: firstRide.grade.letter, n: firstRide.grade.n, spread: firstRide.grade.spreadMin,
                      })
                      : firstRide && firstRide.evidence.bucket !== 'none'
                        ? t('eta.basedOn', { n: firstRide.evidence.n, days: firstRide.evidence.windowDays })
                        : t('eta.scheduleOnly')}
                  </p>
                </div>
              </div>

              <div className="cev">
                <span className="cev-glyph" aria-hidden>
                  {v.kind === 'unseen' ? <WarningIcon width={18} height={18} /> : <SignalIcon width={18} height={18} />}
                </span>
                <div className="cev-text">
                  <p className="cev-line">
                    {engine.ourFault
                      ? t('catch.evVehicleApiDown')
                      : engine.agencyFeedDown
                        ? t('catch.evVehicleFeedDown')
                        : v.vehicleDistM != null
                          ? t('catch.evVehicle', { route: short, dist: fmtDistance(v.vehicleDistM, imperial) })
                          : engine.everSeen
                            ? t('catch.evVehicleStale', { route: short })
                            : t('catch.evVehicleNone', { route: short })}
                  </p>
                  <p className="cev-sub">{freshness}</p>
                </div>
              </div>
            </section>
          )}

          {/* The limit of this screen, stated on it. */}
          <p className="catch-basis">{t('journey.basis')}</p>
        </div>
      </div>
    </div>
  );
}
