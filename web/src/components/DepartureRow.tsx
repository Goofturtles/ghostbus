import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DepartureDto } from '@shared/types';
import { RouteBadge } from './Primitives';
import { PinIcon, ChevronIcon, WarningIcon } from './icons';
import { useTick } from '@/hooks/useTick';
import { liveNow } from '@/hooks/useLive';
import { useStore, paceMps } from '@/store';
import { fmtClock, walkSeconds } from '@/lib/format';
import { parseHeadsign } from '@/lib/headsign';

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

/**
 * One departure, in the reference's two shapes. The DOM is identical at both
 * widths and CSS does the reflow (see `.dep-card` in app.css):
 *
 *   desktop — badge + route name / destination / next line, countdown and status
 *             stacked at the right, then a FULL-WIDTH action bar across the foot.
 *   phone   — badge + "route → destination" on ONE line, next line beneath, and a
 *             right column of countdown, status pill and a pill-shaped action.
 *
 * The action's wording is not decorative. On a live row the vehicle is genuinely
 * in the feed, so the reference's "Track" is a promise the data keeps. On a
 * scheduled row nothing is being tracked, so it stays "View route" — offering to
 * track a vehicle that no feed can see is the one thing this app refuses to do.
 */
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
  // "South - 310 Spadina towards Union Station" -> "Union Station". The direction
  // and the route number are already on screen (the stop line and the badge), and
  // repeating them here is what squeezed the destination into 96px and cut it
  // mid-word. Anything that does not match the agency's pattern is shown verbatim.
  const destination = parseHeadsign(dep.directionLabel).destination || dep.directionLabel;

  return (
    <article className={`dep-card ${isLive ? 'dep-is-live' : 'dep-is-sched'}`} role="listitem">
      <div className="dep-info">
        <div className="dep-id">
          <RouteBadge color={dep.color} short={short} size="md" />
          <span className="dep-route">{routeName}</span>
          <span className="dep-arrow" aria-hidden>→</span>
          {/* On the sidebar the destination owns its own line, so it wraps and is
              never cut. On a phone it shares the line with the route name and the
              right-hand columns hold reserved widths, so there it ellipsises —
              which is the reserved-width rule, not an accident. Both behaviours
              are set in CSS, on the same element. */}
          <span className="dep-dest">{destination}</span>
        </div>
        <div className="dep-next">
          {typeof nextMin === 'number' ? t('row.next', { min: Math.max(0, Math.round(nextMin)) }) : t('row.nextNone')}
        </div>
      </div>

      <div className="dep-times">
        <div className="dep-min tnum">
          {countdown ? (
            mins === 0 ? (
              <span className="dep-due">{t('row.due')}</span>
            ) : (
              <>
                <span className="dep-num">{mins}</span>
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

      <div className="dep-action">
        <button
          className={`dep-track ${isLive ? 'dep-track-live' : 'dep-track-sched'}`}
          onClick={() => (isLive ? onCatch?.(dep) : onOpen?.(dep))}
          aria-label={`${isLive ? t('row.track') : t('row.viewRoute')} — ${t('row.toward', { route: short, headsign: dep.directionLabel })}`}
        >
          <PinIcon width={15} height={15} aria-hidden />
          <span className="dep-track-label">{isLive ? t('row.track') : t('row.viewRoute')}</span>
          <ChevronIcon width={16} height={16} aria-hidden />
        </button>
      </div>

      {/* evidence — the brand: never a number without its receipts. The reference
          mockup shows illustrative rows with no evidence layer; dropping it to match
          the picture would delete the one thing GhostBus exists to do, so it stays,
          quiet, on its own full-width line. It wraps rather than truncating: the
          trust chip, the evidence line, the leave-by chip and the forecast chip can
          never collide, at any width or locale (French runs ~25% longer). */}
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
          <span className="evidence-chip">{t('eta.evidence', { spread: spreadMin, n: ev.n })}</span>
        ) : (
          <span className="evidence-chip evidence-thin">{t('eta.scheduleOnly')}</span>
        )}
        {showLeaveBy && <span className="leaveby-chip">{t('eta.leaveBy', { time: fmtClock(leaveByMs) })}</span>}

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
