import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Departure } from '@shared/types';
import { RouteBadge } from './Primitives';
import { SignalIcon, ChevronIcon, GhostIcon } from './icons';
import { useTick } from '@/hooks/useTick';
import { useLive, liveNow } from '@/hooks/useLive';
import { useStore } from '@/store';

interface Props {
  dep: Departure;
  nextMin?: number | null;
  layout: 'bar' | 'compact';
  onCatch?: (d: Departure) => void;
  onOpen?: (d: Departure) => void;
}

export function DepartureRow({ dep, nextMin, layout, onCatch, onOpen }: Props) {
  const { t } = useTranslation();
  useTick(1000);
  const [showEvidence, setShowEvidence] = useState(false);
  const access = useStore((s) => s.access);
  const hideInacc = useStore((s) => s.hideInaccessible);

  const now = liveNow() + useLive.getState().skewMs * 0;
  const etaMin = Math.max(0, (dep.estimateMs - now) / 60000);
  const mins = etaMin < 0.5 ? 0 : Math.round(etaMin);
  const isLive = dep.freshness === 'live';
  const ev = dep.evidence;

  const notBoardable = access !== 'none' && dep.wheelchairAccessible === false;
  if (notBoardable && hideInacc) return null;

  const action =
    isLive ? (
      <button className="btn btn-primary dep-catch" onClick={() => onCatch?.(dep)}>
        <SignalIcon width={15} height={15} />
        {t('row.catch')}
        {layout === 'bar' && <ChevronIcon width={16} height={16} />}
      </button>
    ) : (
      <button className="btn btn-quiet dep-viewroute" onClick={() => onOpen?.(dep)}>
        {t('row.viewRoute')}
        <ChevronIcon width={16} height={16} />
      </button>
    );

  return (
    <article className={`dep-card ${layout === 'bar' ? 'dep-bar' : 'dep-compact'} ${notBoardable ? 'dep-inacc' : ''}`}>
      <div className="dep-main">
        <button className="dep-info" onClick={() => onOpen?.(dep)} aria-label={t('row.toward', { route: dep.routeShortName, headsign: dep.headsign })}>
          <div className="dep-line1">
            <RouteBadge color={dep.routeColor} short={dep.routeShortName} size="md" />
            <span className="dep-long truncate">{dep.routeLongName}</span>
          </div>
          <div className="dep-dest truncate">→ {dep.headsign}</div>
          <div className="dep-next truncate">
            {typeof nextMin === 'number' ? t('row.next', { min: Math.round(nextMin) }) : t('row.nextNone')}
          </div>
        </button>

        <div className="dep-times">
          <div className="dep-min tnum">
            {mins === 0 ? <span className="dep-due">{t('row.due')}</span> : mins}
            {mins > 0 && <span className="dep-unit">{t('row.min')}</span>}
          </div>
          <span className={`pill ${isLive ? 'pill-live' : 'pill-sched'}`}>
            {isLive ? <span className="live-dot" /> : null}
            {isLive ? t('status.live') : t('status.scheduled')}
          </span>
          {layout === 'compact' && <div className="dep-compact-action">{action}</div>}
        </div>
      </div>

      {/* evidence + forecast — the brand: never a number without its receipts */}
      <div className="dep-evidence-row">
        {ev.hasEvidence ? (
          <button className="evidence-chip" onClick={() => setShowEvidence((v) => !v)} aria-expanded={showEvidence}>
            <span className={`grade grade-${ev.grade}`}>{ev.grade}</span>
            <span className="truncate">
              {showEvidence
                ? t('eta.gradeDetail', { grade: ev.grade, n: ev.n, spread: ev.spreadMin })
                : t('eta.basedOn', { n: ev.n, days: ev.windowDays })}
            </span>
          </button>
        ) : (
          <span className="evidence-chip evidence-thin truncate">{t('eta.scheduleOnly')}</span>
        )}
        {notBoardable && <span className="inacc-chip">{t('access.notBoardable')}</span>}
      </div>

      {dep.forecast && (
        <div className={`forecast-chip fc-${dep.forecast.level}`}>
          <GhostIcon width={14} height={14} />
          <span className="truncate">
            {t(dep.forecast.level === 'high' ? 'forecast.high' : 'forecast.medium')} ·{' '}
            {t('forecast.detail', { v: dep.forecast.vanished, o: dep.forecast.of })}
            {dep.forecast.granularity === 'route-hour' ? ` · ${t('forecast.routeHour')}` : ''}
          </span>
        </div>
      )}

      {layout === 'bar' && <div className="dep-action">{action}</div>}
    </article>
  );
}
