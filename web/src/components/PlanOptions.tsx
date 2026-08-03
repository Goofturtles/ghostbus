// THE OPTIONS LIST — several real ways to make this trip, ranked, instead of one verdict.
//
// The planner has always returned a menu (up to ten distinct trips, or up to five two-leg
// itineraries). Until now the UI picked one off it and threw the rest away, which is a
// strange thing for an app built on showing its working to do: the rider could not see
// that a choice had been made, let alone what it was made between.
//
// So the menu is on screen. Each row is a card in the route's own brand colour — real GTFS
// `route_color`, not a palette we invented — with the countdown to its boarding departure
// as the biggest thing on it.
//
// THREE MARKS, AND WHAT EACH IS ALLOWED TO MEAN:
//
//   live arc      the boarding departure is genuinely in the live feed (`liveEtaMs`).
//                 Nothing else earns it. Not an honest ETA — that is evidence, not a
//                 vehicle anybody can see — and not a live SECOND leg.
//   SCHEDULED     no live prediction. Said plainly rather than left to be inferred from
//                 the absence of the arc.
//   percentage    a number the observations paid for. `optionLikelihood` returns null for
//                 every row that has not earned one, and this file renders the ordinary
//                 evidence line in its place. There is no fallback number anywhere here.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RideCandidateDto } from '@shared/types';
import type { Likelihood } from '@/lib/likelihood';
import {
  type PlanOption, type OptionList, optionLegs, optionIsLive, optionLikelihood,
  optionBoardMs, toJourney,
} from '@/lib/journey';
import { useStore } from '@/store';
import { useTick } from '@/hooks/useTick';
import { liveNow } from '@/hooks/useLive';
import { fmtClock, fmtDistance, fmtServiceDate } from '@/lib/format';
import { parseHeadsign } from '@/lib/headsign';
import { RouteBadge, readableOn } from './Primitives';
import { splitClock } from './DepartureRow';
import { WalkerIcon, RouteIcon, FlagIcon, WarningIcon, ArrowRightIcon, ChevronIcon } from './icons';

/** Beyond this the countdown becomes a clock time — a two-day-out "2880 min" is noise.
 *  Same horizon the departure board uses, deliberately: one departure, one treatment. */
const COUNTDOWN_HORIZON_MIN = 90;

const min = (sec: number) => Math.max(1, Math.round(sec / 60));

/**
 * The live arc — a radio-wave glyph, drawn ONLY where `optionIsLive` is true.
 *
 * It is deliberately a component of its own with no conditional inside it: the caller has
 * to have decided, so there is no path where a "maybe live" value renders a faint one.
 */
function LiveArc() {
  return (
    <svg className="opt-arc" width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <circle cx="3" cy="11" r="1.6" fill="currentColor" />
      <path d="M3 7.5a3.5 3.5 0 0 1 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 4a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The percentage, and the receipts underneath it.
 *
 * Tapping it discloses the basis — what the number is a probability OF, how many
 * observations paid for it, over what window, and the one thing it does not know. That
 * disclosure is not optional garnish: a bare "87%" beside a bus is exactly the kind of
 * confident-sounding figure this whole project exists to argue against, and the only thing
 * separating ours from one is that ours can be interrogated.
 */
function LikelihoodChip({ l }: { l: Likelihood }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = l.kind === 'connection'
    ? t('plan.pctConnection', { pct: l.percent })
    : t('plan.pctOnTime', { pct: l.percent });
  const defn = l.kind === 'connection'
    ? t('plan.pctConnectionDef')
    : t('plan.pctOnTimeDef', { min: Math.round(l.thresholdSec / 60) });
  const source = l.bucket === 'stop-hour'
    ? t('plan.pctBasisStop', { n: l.n, days: l.windowDays })
    : t('plan.pctBasisRoute', { n: l.n, days: l.windowDays });

  return (
    <>
      <button
        type="button"
        className={`pct-chip pct-${l.kind}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={t('plan.pctAria', { label, defn, source })}
      >
        <span className="pct-num tnum">{l.percent}%</span>
        <span className="pct-label">
          {l.kind === 'connection' ? t('plan.pctConnectionShort') : t('plan.pctOnTimeShort')}
        </span>
      </button>
      {open && (
        <p className="pct-detail">
          {defn} {source} {t('plan.pctMethod')}
        </p>
      )}
    </>
  );
}

/**
 * The evidence line for a leg — a grade letter where the sample earns one, the honest
 * sentence where it does not, and the ghost-risk chip on a genuinely elevated cell.
 *
 * Structurally the same claim the plan card has always made, kept here rather than
 * imported so the options list and the expanded detail agree by construction.
 */
function LegEvidence({ c }: { c: RideCandidateDto }) {
  const { t } = useTranslation();
  return (
    <>
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
    </>
  );
}

/** The route badges an option rides, in order, with the transfer arrow between them. */
function OptionRoutes({ legs }: { legs: RideCandidateDto[] }) {
  return (
    <span className="opt-routes">
      {legs.map((c, i) => (
        <span className="opt-route" key={`${c.tripId}-${i}`}>
          {i > 0 && <ArrowRightIcon className="opt-join" width={13} height={13} aria-hidden />}
          <RouteBadge color={c.color} short={c.shortName ?? c.routeId ?? '—'} size="sm" />
        </span>
      ))}
    </span>
  );
}

/** The expanded leg-by-leg detail — the same vocabulary the single plan card always used. */
function OptionDetail({ o, imperial, destinationName }: {
  o: PlanOption; imperial: boolean; destinationName: string;
}) {
  const { t } = useTranslation();

  if (o.kind === 'ride') {
    const p = o.plan;
    const c = p.candidate;
    const destination = parseHeadsign(c.directionLabel).destination || c.directionLabel;
    return (
      <ol className="plan-legs">
        <li className="plan-leg plan-leg-walk">
          <span className="plan-leg-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line">
              {t(p.toStop.kind === 'routed' ? 'plan.walkTo' : 'plan.walkToEst', {
                dist: fmtDistance(p.toStop.distanceM, imperial),
                min: min(p.toStop.seconds),
                stop: c.board.name ?? c.board.stopId,
              })}
            </p>
            <p className="plan-leg-sub">{t('plan.leaveBy', { time: fmtClock(p.leaveByMs) })}</p>
          </div>
        </li>
        <li className="plan-leg plan-leg-ride">
          <span className="plan-leg-glyph plan-leg-glyph-ride" aria-hidden><RouteIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line plan-ride-id">
              <RouteBadge color={c.color} short={c.shortName ?? c.routeId ?? '—'} size="sm" />
              <span className="plan-ride-dest">{destination}</span>
            </p>
            <p className="plan-leg-sub">
              {t('plan.rideDetail', {
                board: fmtClock(p.boardMs),
                alight: fmtClock(p.boardMs + p.rideSec * 1000),
                count: c.stopsRidden,
              })}
            </p>
            <p className="plan-leg-sub">{t('plan.alightAt', { stop: c.alight.name ?? c.alight.stopId })}</p>
            <LegEvidence c={c} />
          </div>
        </li>
        <li className="plan-leg plan-leg-walk">
          <span className="plan-leg-glyph" aria-hidden><FlagIcon width={18} height={18} /></span>
          <div className="plan-leg-text">
            <p className="plan-leg-line">
              {t(p.fromStop.kind === 'routed' ? 'plan.walkFrom' : 'plan.walkFromEst', {
                dist: fmtDistance(p.fromStop.distanceM, imperial),
                min: min(p.fromStop.seconds),
                dest: destinationName,
              })}
            </p>
          </div>
        </li>
      </ol>
    );
  }

  const p = o.plan;
  const it = p.itinerary;
  const board1 = p.leg1.candidate.board;
  // Two agencies is a fact about the RISK the rider is taking on, not trivia: two
  // schedules, and neither operator holds the other's vehicle for a late connection.
  const crossAgencyNote = it.crossAgency
    ? <p className="plan-arrive plan-cross-agency">{t('plan.twoLegCrossAgency')}</p>
    : null;
  const rideLeg = (c: RideCandidateDto, boardMs: number) => {
    const destination = parseHeadsign(c.directionLabel).destination || c.directionLabel;
    const rideSec = Math.max(0, Math.round((c.arrivalMs - c.departureMs) / 1000));
    return (
      <li className="plan-leg plan-leg-ride">
        <span className="plan-leg-glyph plan-leg-glyph-ride" aria-hidden><RouteIcon width={18} height={18} /></span>
        <div className="plan-leg-text">
          <p className="plan-leg-line plan-ride-id">
            <RouteBadge color={c.color} short={c.shortName ?? c.routeId ?? '—'} size="sm" />
            <span className="plan-ride-dest">{destination}</span>
          </p>
          <p className="plan-leg-sub">
            {t('plan.rideDetail', {
              board: fmtClock(boardMs), alight: fmtClock(boardMs + rideSec * 1000), count: c.stopsRidden,
            })}
          </p>
          <p className="plan-leg-sub">{t('plan.alightAt', { stop: c.alight.name ?? c.alight.stopId })}</p>
          <LegEvidence c={c} />
        </div>
      </li>
    );
  };

  return (
    <>
    {crossAgencyNote}
    <ol className="plan-legs">
      <li className="plan-leg plan-leg-walk">
        <span className="plan-leg-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
        <div className="plan-leg-text">
          <p className="plan-leg-line">
            {t(p.leg1.toStop.kind === 'routed' ? 'plan.walkTo' : 'plan.walkToEst', {
              dist: fmtDistance(p.leg1.toStop.distanceM, imperial),
              min: min(p.leg1.toStop.seconds),
              stop: board1.name ?? board1.stopId,
            })}
          </p>
          <p className="plan-leg-sub">{t('plan.leaveBy', { time: fmtClock(p.leaveByMs) })}</p>
        </div>
      </li>
      {rideLeg(it.legs[0], p.leg1.boardMs)}
      <li className="plan-leg plan-leg-walk plan-leg-transfer">
        <span className="plan-leg-glyph" aria-hidden><WalkerIcon width={18} height={18} /></span>
        <div className="plan-leg-text">
          <p className="plan-leg-line">
            {it.transfer.sameStop
              ? t('plan.transferStayAt', { stop: it.transfer.to.name ?? it.transfer.to.stopId })
              : t('plan.transferWalkTo', {
                dist: fmtDistance(it.transfer.distanceM, imperial),
                min: min(p.transferWalkSec),
                stop: it.transfer.to.name ?? it.transfer.to.stopId,
              })}
          </p>
          <p className="plan-leg-sub">{t('plan.transferWait', { min: min(p.transferWaitSec) })}</p>
        </div>
      </li>
      {rideLeg(it.legs[1], p.leg2.boardMs)}
      <li className="plan-leg plan-leg-walk">
        <span className="plan-leg-glyph" aria-hidden><FlagIcon width={18} height={18} /></span>
        <div className="plan-leg-text">
          <p className="plan-leg-line">
            {t('plan.walkFromEst', {
              dist: fmtDistance(p.leg2.fromStop.distanceM, imperial),
              min: min(p.leg2.fromStop.seconds),
              dest: destinationName,
            })}
          </p>
        </div>
      </li>
    </ol>
    </>
  );
}

function OptionCard({ o, expanded, onToggle, imperial, destinationName, now }: {
  o: PlanOption; expanded: boolean; onToggle: () => void;
  imperial: boolean; destinationName: string; now: number;
}) {
  const { t } = useTranslation();
  const startJourney = useStore((s) => s.startJourney);

  const legs = optionLegs(o);
  const lead = legs[0];
  const isLive = optionIsLive(o);
  const likelihood = optionLikelihood(o);
  const boardMs = optionBoardMs(o);
  const doorMs = o.plan.doorMs;
  const minsUntil = (boardMs - now) / 60000;
  const countdown = minsUntil <= COUNTDOWN_HORIZON_MIN;
  const mins = minsUntil < 0.5 ? 0 : Math.round(minsUntil);
  const sameDay = new Date(boardMs).toDateString() === new Date(now).toDateString();

  /**
   * THE CARD WEARS THE LEAD ROUTE'S OWN COLOUR — `route_color` out of the agency's
   * routes.txt, which is real published data about that route and not a decoration we
   * assigned. It is applied as a tint rather than a flood so the text on top keeps its
   * ordinary contrast, and the accent rail carries the colour at full strength.
   */
  const brand = `#${lead.color.replace('#', '')}`;
  const style = {
    '--opt-brand': brand,
    '--opt-on-brand': readableOn(lead.color),
  } as React.CSSProperties;

  const destination = parseHeadsign(lead.directionLabel).destination || lead.directionLabel;

  return (
    <li className={`opt-card ${isLive ? 'opt-is-live' : 'opt-is-sched'} ${expanded ? 'opt-open' : ''}`} style={style}>
      {/* `aria-current`, NOT `aria-expanded`. Selecting an option is a MOVE within a set,
          not a disclosure: the map follows the selection, so there is no state in which
          nothing is selected, and a keyboard user told "expanded" would go looking for a
          collapse that does not exist. "Current item in a set" is what this actually is. */}
      <button
        type="button"
        className="opt-main"
        onClick={onToggle}
        aria-current={expanded ? 'true' : undefined}
      >
        <span className="opt-rail" aria-hidden />

        <span className="opt-body">
          <span className="opt-top">
            <OptionRoutes legs={legs} />
            <span className={`pill ${isLive ? 'pill-live' : 'pill-sched'}`}>
              {isLive ? <LiveArc /> : null}
              {isLive ? t('status.live') : t('row.scheduledOnly')}
            </span>
          </span>

          <span className="opt-dest truncate">{destination}</span>

          <span className="opt-meta">
            {t('plan.doorToDoor', { min: min(o.plan.totalSec) })}
            {' · '}
            {t('plan.arriveAt', { time: fmtClock(doorMs) })}
            {!sameDay && <span className="plan-date"> · {fmtServiceDate(boardMs)}</span>}
          </span>
        </span>

        <span className="opt-when tnum">
          {countdown ? (
            mins === 0 ? (
              <span className="opt-due">{t('row.due')}</span>
            ) : (
              <>
                <span className="opt-num">{mins}</span>
                <span className="opt-unit">{t('row.min')}</span>
              </>
            )
          ) : (
            (() => {
              const [main, unit] = splitClock(fmtClock(boardMs));
              return (
                <>
                  <span className="opt-num opt-num-clock">{main}</span>
                  {unit && <span className="opt-unit">{unit}</span>}
                </>
              );
            })()
          )}
          <ChevronIcon className="opt-chev" width={16} height={16} aria-hidden />
        </span>
      </button>

      {/* The percentage where the observations paid for one; the plain evidence line where
          they did not. Never both, and never a substitute number. */}
      <div className="opt-evidence">
        {likelihood ? <LikelihoodChip l={likelihood} /> : <LegEvidence c={lead} />}
      </div>

      {expanded && (
        <div className="opt-detail">
          <OptionDetail o={o} imperial={imperial} destinationName={destinationName} />

          {/* What this plan is, and what it is not. Both stated, not implied — and the
              boarding sentence changes with whether the instant it is built on is a
              prediction or the timetable, because those are different claims. */}
          <p className="plan-basis">
            {t('plan.basisRide')}
            {' '}
            {(o.kind === 'ride' ? o.plan.boardIsPredicted : o.plan.leg1.boardIsPredicted)
              ? t('plan.basisPredicted')
              : t('plan.basisScheduled')}
            {o.kind === 'twoLeg' && ` ${t('plan.basisTransfer')}`}
            {' '}{t('plan.basisSingleRide')}
          </p>

          <button
            className="btn btn-primary opt-go"
            onClick={() => startJourney(toJourney(o, destinationName))}
          >
            <span className="opt-go-label">{t('plan.go')}</span>
            <span className="opt-go-sub">{t('plan.goSub', { time: fmtClock(o.plan.leaveByMs) })}</span>
          </button>
        </div>
      )}
    </li>
  );
}

export function PlanOptions({ list, selectedId, onSelect, imperial, destinationName, widened }: {
  list: OptionList;
  /** Which option is expanded. Owned by PlanView, because the MAP follows it too — the
   *  beaded walk path has to be the first leg of the option actually being read. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  imperial: boolean;
  destinationName: string;
  widened: boolean;
}) {
  const { t } = useTranslation();
  useTick(30_000);
  const now = liveNow();

  if (list.options.length === 0) return null;

  return (
    <section className="opt-section" aria-labelledby="gb-opt-head">
      <div className="section-head">
        <span className="eyebrow" id="gb-opt-head">
          {widened ? t('plan.nextServiceEyebrow') : t('plan.optionsEyebrow', { count: list.totalCount })}
        </span>
      </div>

      <ul className="opt-list">
        {list.options.map((o) => (
          <OptionCard
            key={o.id}
            o={o}
            expanded={selectedId === o.id}
            // Collapsing the open one would leave the map drawing a walk to a journey
            // nothing on screen is describing, so selecting is a move, never a toggle off.
            onToggle={() => onSelect(o.id)}
            imperial={imperial}
            destinationName={destinationName}
            now={now}
          />
        ))}
      </ul>

      {/* What is not on screen is counted, not hidden. */}
      {list.hiddenCount > 0 && (
        <p className="plan-fineprint">{t('plan.moreOptions', { count: list.hiddenCount })}</p>
      )}
    </section>
  );
}
