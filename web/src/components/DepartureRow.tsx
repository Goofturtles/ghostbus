import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { RouteBadge } from './Primitives';
import { SignalIcon, ChevronIcon, WarningIcon } from './icons';
import { useTick } from '@/hooks/useTick';
import { liveNow } from '@/hooks/useLive';
import { useStore, paceMps } from '@/store';
import { fmtClock, walkSeconds } from '@/lib/format';

interface Props {
  dep: DepartureDto;
  /** Minutes until the *following* departure of this route, if any. */
  nextMin?: number | null;
  /** Walking distance from the rider to this stop, for the leave-by chip. */
  distanceM?: number;
  onCatch?: (d: DepartureDto) => void;
  onOpen?: (d: DepartureDto) => void;
}

/** Departures within this horizon show a live minute countdown; further-out
 *  scheduled service shows a clock time instead (a 2-day-out "2880 min" is noise). */
const COUNTDOWN_HORIZON_MIN = 90;

export function DepartureRow({ dep, nextMin, distanceM, onCatch, onOpen }: Props) {
  const { t } = useTranslation();
  useTick(1000);
  const pace = useStore((s) => s.pace);
  const [gradeOpen, setGradeOpen] = useState(false);

  const now = liveNow();
  const isLive = dep.liveEtaMs != null;
  const arrivalMs = dep.liveEtaMs ?? dep.honest.estimateMs ?? dep.scheduledMs;
  const minsUntil = (arrivalMs - now) / 60000;
  const countdown = minsUntil <= COUNTDOWN_HORIZON_MIN;
  const mins = minsUntil < 0.5 ? 0 : Math.round(minsUntil);

  const ev = dep.evidence;
  const hasEvidence = ev.bucket !== 'none' && dep.honest.bandLowMs != null && dep.honest.bandHighMs != null;
  const spreadMin = hasEvidence
    ? Math.max(0, Math.round(((dep.honest.bandHighMs as number) - (dep.honest.bandLowMs as number)) / 2 / 60000))
    : 0;
  // Both fields are absent unless the server could back them (see shared/types.ts).
  const grade = dep.grade ?? null;
  const risk = dep.ghostRisk ?? null;

  // Leave-by only makes sense for a near-term departure with a known walk distance.
  const walkSec = distanceM != null ? walkSeconds(distanceM, paceMps(pace)) : 0;
  const leaveByMs = arrivalMs - walkSec * 1000;
  const showLeaveBy = countdown && walkSec > 0 && leaveByMs > now - 60_000;

  const routeName = dep.longName ?? dep.shortName ?? dep.routeId ?? '';
  const short = dep.shortName ?? dep.routeId ?? '—';

  const action = isLive ? (
    <button className="btn btn-primary dep-catch" onClick={() => onCatch?.(dep)}>
      <SignalIcon width={15} height={15} />
      <span className="dep-action-label">{t('row.catch')}</span>
      <ChevronIcon width={16} height={16} />
    </button>
  ) : (
    <button className="btn btn-quiet dep-viewroute" onClick={() => onOpen?.(dep)} aria-label={t('row.viewRoute')}>
      <span className="dep-action-label">{t('row.viewRoute')}</span>
      <ChevronIcon width={16} height={16} />
    </button>
  );

  return (
    <article className="dep-card" role="listitem">
      <div className="dep-top">
        <button
          className="dep-info"
          onClick={() => onOpen?.(dep)}
          aria-label={t('row.toward', { route: short, headsign: dep.directionLabel })}
        >
          <div className="dep-line1">
            <RouteBadge color={dep.color} short={short} size="md" />
            <span className="dep-long truncate">{routeName}</span>
          </div>
          <div className="dep-dest truncate">→ {dep.directionLabel}</div>
          <div className="dep-next truncate">
            {typeof nextMin === 'number' ? t('row.next', { min: Math.max(0, Math.round(nextMin)) }) : t('row.nextNone')}
          </div>
        </button>

        <div className="dep-times">
          <div className="dep-min tnum">
            {countdown ? (
              mins === 0 ? (
                <span className="dep-due">{t('row.due')}</span>
              ) : (
                <>
                  {mins}
                  <span className="dep-unit">{t('row.min')}</span>
                </>
              )
            ) : (
              <span className="dep-clock">{fmtClock(arrivalMs)}</span>
            )}
          </div>
          <span className={`pill ${isLive ? 'pill-live' : 'pill-sched'}`}>
            {isLive ? <span className="live-dot" aria-hidden /> : null}
            {isLive ? t('status.live') : t('status.scheduled')}
          </span>
        </div>

        <div className="dep-action">{action}</div>
      </div>

      {/* evidence — the brand: never a number without its receipts.
          The row wraps rather than truncating a claim: the trust chip, the evidence
          line, the leave-by chip and the forecast chip can never collide, at any width
          or in any locale (French runs ~25% longer than English). */}
      <div className="dep-evidence-row">
        {grade ? (
          <button
            type="button"
            className={`grade-chip grade-${grade.letter}`}
            onClick={() => setGradeOpen((o) => !o)}
            aria-expanded={gradeOpen}
            aria-label={t('eta.gradeAria', { grade: grade.letter, n: grade.n, spread: grade.spreadMin })}
          >
            {grade.letter}
          </button>
        ) : (
          // No evidence bucket -> no letter, ever. A dash carries the fact visually and
          // the accessible name says it in words.
          <span className="grade-chip grade-untracked" role="img" aria-label={t('eta.untracked')}>
            {t('eta.untrackedMark')}
          </span>
        )}

        {hasEvidence ? (
          <span className="evidence-chip truncate">{t('eta.evidence', { spread: spreadMin, n: ev.n })}</span>
        ) : (
          <span className="evidence-chip evidence-thin truncate">{t('eta.scheduleOnly')}</span>
        )}
        {showLeaveBy && <span className="leaveby-chip truncate">{t('eta.leaveBy', { time: fmtClock(leaveByMs) })}</span>}

        {grade && gradeOpen && (
          <p className="grade-detail">
            {t('eta.gradeDetail', { grade: grade.letter, n: grade.n, spread: grade.spreadMin })}
          </p>
        )}

        {/* The forecast chip renders only when the API sends a risk it can back with a
            sample size — no ghostRisk field, no chip. */}
        {risk && (
          <p
            className={`forecast-chip forecast-${risk.level}`}
            aria-label={t(risk.level === 'high' ? 'forecast.ariaHigh' : 'forecast.ariaElevated', {
              v: risk.ghosts, o: risk.n, days: risk.windowDays,
            })}
          >
            <WarningIcon width={13} height={13} aria-hidden />
            <span>
              {t(risk.level === 'high' ? 'forecast.chipHigh' : 'forecast.chipElevated', {
                v: risk.ghosts, o: risk.n,
              })}
            </span>
          </p>
        )}
      </div>
    </article>
  );
}
