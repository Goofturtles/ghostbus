import { useTranslation } from 'react-i18next';
import type { ServiceAlert, Departure } from '@shared/types';
import { WarningIcon } from './icons';
import { RouteBadge } from './Primitives';
import { fmtClock } from '@/lib/format';
import { liveNow } from '@/hooks/useLive';

interface Props {
  alert: ServiceAlert;
  routeShort: string;
  routeColor: string;
  headsign: string;
  nextTracked?: Departure | null;
  layout: 'bar' | 'compact';
  onAlternatives?: () => void;
}

export function AlertCard({ alert, routeShort, routeColor, headsign, nextTracked, layout, onAlternatives }: Props) {
  const { t } = useTranslation();
  const when = fmtClock(alert.activeStart ?? alert.timestampMs);
  const secs = Math.max(0, Math.round((liveNow() - alert.timestampMs) / 1000));

  const btn = (
    <button className="btn alert-btn" onClick={onAlternatives}>
      {t('alert.viewAlternatives')}
    </button>
  );

  return (
    <article className="alert-card" role="status">
      <div className="alert-top">
        <div className="alert-glyph" aria-hidden><WarningIcon width={18} height={18} /></div>
        <div className="alert-body">
          {/* verifiable fact: an official cancellation says so; detected ghosts say "never arrived" */}
          <p className="alert-line1 truncate">
            {alert.effect === 'CANCELED' || alert.header.toLowerCase().includes('cancel')
              ? t('ghost.cancelled', { time: when })
              : t('ghost.neverArrived', { time: when })}
          </p>
          <p className="alert-trip truncate">
            <RouteBadge color={routeColor} short={routeShort} size="sm" />
            <span className="truncate">→ {headsign}</span>
          </p>
          <p className="alert-line2 truncate">
            {nextTracked
              ? `${t('ghost.nextTracked', { time: fmtClock(nextTracked.estimateMs) })} · ${t('status.updatedAgo', { secs })}`
              : t('status.updatedAgo', { secs })}
          </p>
          {layout === 'compact' && <div className="alert-compact-action">{btn}</div>}
        </div>
      </div>
      {layout === 'bar' && <div className="alert-action">{btn}</div>}
    </article>
  );
}
